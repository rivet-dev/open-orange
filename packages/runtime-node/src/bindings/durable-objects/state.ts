import {
	isWebSocketPairEndpoint,
	type WebSocket,
	type WebSocketRequestResponsePair,
} from "../../globals/websocket.js";
import {
	type OutputGate,
	runWithOutputGate,
} from "../../internal/output-gate.js";
import type { RivetActorConnection } from "../../internal/rivetkit.js";
import { runWithWorkerTmp, WorkerTmp } from "../../internal/worker-tmp.js";
import { cancelTimers, observeTimers } from "../../globals/timers.js";
import { observeOutboundWork } from "../../internal/outbound-work.js";
import type {
	DurableObjectAbortOptions,
	DurableObjectFacets,
	DurableObjectState,
	DurableObjectStorage,
} from "../../modules/cloudflare-workers/durable-object.js";
import { workerContextExports } from "../../modules/cloudflare-workers/env.js";
import { containerForDurableObject } from "../../modules/cloudflare-sandbox/container.js";
import { createEnvironment } from "../create-env.js";
import { createDurableObjectAbortError } from "./abort.js";
import type {
	DurableObjectAlarmController,
	DurableObjectAlarmSynchronization,
} from "./alarm-storage.js";
import type { ConfiguredDurableObjectClass } from "./classes.js";
import {
	DurableObjectInputGate,
	type DurableObjectTurnDatabase,
} from "./gates.js";
import type { DurableObjectId } from "./id.js";
import { DurableObjectAcceptedWebSocketHost } from "./accepted-websocket-host.js";
import { DurableObjectHibernatableWebSocketStore } from "./hibernatable-websockets.js";
import { DurableObjectHibernationLifecycle } from "./hibernation-lifecycle.js";
import type { DurableObjectHibernationSettings } from "./hibernation-settings.js";
import { DurableObjectOrderCoordinator } from "./ordering.js";
import { DurableObjectRpcContinuationStore } from "./rpc/continuations.js";
import { createDurableObjectStorage } from "./storage.js";
import { DurableObjectWebSocketUpgradeStore } from "./websocket-upgrades.js";

const generationBrand = Symbol("OpenOrangeDurableObjectGeneration");
const startupBlockTimeoutMilliseconds = 30_000;

export interface DurableObjectStateRuntime {
	/** A string for a facet whose parent passed a string `id`. */
	readonly id?: DurableObjectId | string;
	/** `ctx.props`. Workerd gives an object without props `{}`. */
	readonly props?: unknown;
	/** The forks behind a root object, oldest first, for `ctx.orange.forkChain`. */
	forkChain?(): readonly DurableObjectForkLink[];
	keepAwake?(promise: Promise<unknown>): void;
	requestReset?(error: Error): void;
	waitUntil?(promise: Promise<unknown>): void;
}

/** One fork behind an object: the object it was forked from, and when. See orange-fork.ts. */
export interface DurableObjectForkLink {
	readonly forkedAt: number;
	readonly id: DurableObjectId;
	readonly name?: string;
}

/** `ctx.orange`: OpenOrange's extensions to DurableObjectState. Cloudflare has no `orange`. */
export interface DurableObjectStateOrange {
	readonly forkChain: readonly DurableObjectForkLink[];
}

/** Lifetime controls that only Orange's own internal objects use. */
export interface InternalObjectLifetime {
	/** Keeps the actor from idle sleep until `promise` settles. */
	keepAwake(promise: Promise<unknown>): void;
	/** Aborts when this object stops running: on sleep, destroy, abort, or reset. */
	readonly retired: AbortSignal;
}

const internalObjectLifetimes = new WeakMap<object, InternalObjectLifetime>();

/** The lifetime controls of the object constructed with `state`. */
export function internalObjectLifetime(state: object): InternalObjectLifetime {
	const lifetime = internalObjectLifetimes.get(state);
	if (lifetime === undefined) {
		throw new Error("The Durable Object state has no Orange lifetime controls");
	}
	return lifetime;
}

// Flag-gated DurableObjectState members that workerd defines and Orange does
// not implement.
const unimplementedStateMembers = new Set([
	"configureReadReplication",
	"primaryStub",
	"restore",
	"version",
]);

function stateUnsupported(name: string): Error {
	const error = new Error(`DurableObjectState.${name} is not implemented`);
	error.name = "NotSupportedError";
	return error;
}

function withStartupTimeout<Result>(promise: Promise<Result>): Promise<Result> {
	return new Promise<Result>((resolve, reject) => {
		const timer = setTimeout(() => {
			reject(
				new Error(
					"A call to blockConcurrencyWhile() in a Durable Object waited for too long. The call was canceled and the Durable Object was reset.",
				),
			);
		}, startupBlockTimeoutMilliseconds);
		timer.unref();
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error: unknown) => {
				clearTimeout(timer);
				reject(error);
			},
		);
	});
}

export class DurableObjectStateController {
	readonly #database: DurableObjectTurnDatabase | undefined;
	readonly #hibernationLifecycle: DurableObjectHibernationLifecycle | undefined;
	readonly #inputGate: DurableObjectInputGate;
	readonly #runtime: DurableObjectStateRuntime;
	readonly #startupBlocks: Promise<unknown>[] = [];
	// One /tmp for the object's lifetime, as workerd runs every request to an actor in one IoContext.
	// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/io/io-context.h#L219-L221
	readonly #tmp = new WorkerTmp();
	#abortError: Error | undefined;
	#active = true;
	// The keepAwake() task that runs while a timer or outbound work of the object is pending.
	#actorHeld: PromiseWithResolvers<void> | undefined;
	#actorHolds = 0;
	#constructionComplete = false;
	readonly #resetController = new AbortController();
	readonly #retiredController = new AbortController();

	constructor(
		runtime: DurableObjectStateRuntime = {},
		inputGate = new DurableObjectInputGate(),
		database?: DurableObjectTurnDatabase,
		hibernationLifecycle?: DurableObjectHibernationLifecycle,
	) {
		this.#database = database;
		this.#hibernationLifecycle = hibernationLifecycle;
		this.#inputGate = inputGate;
		this.#runtime = runtime;
		// A pending setTimeout() or setInterval() callback prevents hibernation, as Cloudflare's docs
		// say. In workerd, each timer of an actor is a waitUntil() task, and the idle timeout starts
		// only after those tasks end.
		// https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/
		// https://github.com/cloudflare/workerd/blob/v1.20260903.1/src/workerd/io/io-context.c%2B%2B#L949-L956
		// Measured on `wrangler dev` 4.129, 6 objects for each case: an object with a 60 second
		// setTimeout() ran until the timer did and hibernated after it, one with a 3 second
		// setInterval() never hibernated, and one whose timer was cleared hibernated as usual.
		// Real Cloudflare was not tested.
		if (hibernationLifecycle !== undefined) {
			observeTimers(this.#tmp, (timer) => this.#holdActor(hibernationLifecycle.holdTimer(timer)));
			observeOutboundWork(this.#tmp, (work) => this.#holdActor(hibernationLifecycle.hold(work)));
		}
	}

	// Rivet sleeps an actor that has no connection after 10 seconds, and the sleep drops the
	// object's pending timers. Workerd keeps an object with a pending timer or outbound work, with or
	// without a WebSocket. Measured on `wrangler dev` 4.129: an object with no WebSocket ran a 25
	// second setTimeout() in the same instance. One keepAwake() task covers all work in progress.
	#holdActor(release: () => void): () => void {
		if (this.#active && this.#actorHolds++ === 0) {
			this.#actorHeld = Promise.withResolvers<void>();
			try {
				this.#runtime.keepAwake?.(this.#actorHeld.promise);
			} catch {
				// A stopping actor takes no more tasks, and it drops the work with the object.
			}
		}
		let released = false;
		return () => {
			if (released) return;
			released = true;
			release();
			if (--this.#actorHolds === 0) this.#releaseActor();
		};
	}

	#releaseActor(): void {
		this.#actorHeld?.resolve();
		this.#actorHeld = undefined;
	}

	// Aborts with the error that reset this generation, so work bound to it,
	// such as RPC sessions and stub lanes, can fail with the same error.
	get resetSignal(): AbortSignal {
		return this.#resetController.signal;
	}

	get id(): DurableObjectId | string {
		this.#assertActive();
		if (this.#runtime.id === undefined) {
			throw new Error("DurableObjectState.id is not initialized");
		}
		return this.#runtime.id;
	}

	get props(): unknown {
		this.#assertActive();
		return this.#runtime.props ?? {};
	}

	/** Undefined for an object that cannot fork, such as a facet. */
	get orange(): DurableObjectStateOrange | undefined {
		this.#assertActive();
		const forkChain = this.#runtime.forkChain;
		if (forkChain === undefined) return undefined;
		return {
			get forkChain(): readonly DurableObjectForkLink[] {
				return Object.freeze(forkChain().map((link) => Object.freeze({ ...link })));
			},
		};
	}

	get retiredSignal(): AbortSignal {
		return this.#retiredController.signal;
	}

	keepAwake(promise: Promise<unknown>): void {
		this.#assertActive();
		if (this.#runtime.keepAwake === undefined) {
			throw new Error("DurableObjectState keepAwake() is not initialized");
		}
		this.#hibernationLifecycle?.preventSleepUntil(promise, "keep-awake");
		this.#runtime.keepAwake(promise);
	}

	waitUntil(promise: Promise<unknown>): void {
		this.#assertActive();
		if (this.#runtime.waitUntil === undefined) {
			throw new Error("DurableObjectState.waitUntil() is not initialized");
		}
		// The object does not hibernate while its waitUntil() work runs.
		this.#hibernationLifecycle?.preventSleepUntil(promise, "wait-until");
		this.#runtime.waitUntil(promise);
	}

	blockConcurrencyWhile<Result>(
		callback: () => Promise<Result>,
	): Promise<Result> {
		this.#assertActive();
		if (typeof callback !== "function") {
			throw new TypeError("blockConcurrencyWhile() requires a callback");
		}
		const run = (): Promise<Result> => {
			let callbackResult: Promise<Result>;
			try {
				callbackResult = Promise.resolve(callback());
			} catch (error: unknown) {
				callbackResult = Promise.reject(error);
			}
			return withStartupTimeout(callbackResult);
		};
		// Workerd stops nesting at 64 to protect its native stack. Orange nests in JavaScript, so it
		// has no such limit.
		if (!this.#constructionComplete) {
			const tracked = run();
			this.#startupBlocks.push(tracked);
			return tracked;
		}
		// After startup, a critical section holds new events at the input gate. Workerd resets
		// the object when the callback fails.
		// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/actor-state.c%2B%2B#L1181-L1184
		return this.#inputGate.runCriticalSection(run).catch((error: unknown) => {
			this.#reset(error instanceof Error ? error : new Error(String(error)));
			throw error;
		});
	}

	async finishConstruction(): Promise<void> {
		this.#constructionComplete = true;
		// Workerd holds the input lock until every constructor-time critical
		// section completes and resets the object if one fails or exceeds 30s.
		// https://github.com/cloudflare/workerd/blob/23263780e6ba38c7f230497a6abc1a4ff72124fb/src/workerd/api/actor-state.c%2B%2B#L1182-L1185
		// Rivet's createVars callback is itself the startup admission boundary, so
		// awaiting the captured callbacks there provides the same initial barrier.
		await Promise.all(this.#startupBlocks);
	}

	abort(reason?: string, options: DurableObjectAbortOptions = {}): never {
		this.#assertActive();
		if (reason !== undefined && typeof reason !== "string") {
			throw new TypeError("DurableObjectState.abort() reason must be a string");
		}
		if (
			typeof options !== "object" ||
			options === null ||
			(options.retryAlarm !== undefined &&
				typeof options.retryAlarm !== "boolean")
		) {
			throw new TypeError("DurableObjectState.abort() options are invalid");
		}
		this.#reset(
			createDurableObjectAbortError(reason, options.retryAlarm ?? true),
		);
		throw this.#abortError;
	}

	runEvent<Result>(
		operation: () => Result | Promise<Result>,
	): Promise<Result> {
		const event = this.#runEvent(operation);
		// Workerd starts the hibernation timer only after the last in-flight request ends.
		// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/server/server.c%2B%2B#L541-L562
		this.#hibernationLifecycle?.preventSleepUntil(event, "event");
		return event;
	}

	async #runEvent<Result>(
		operation: () => Result | Promise<Result>,
	): Promise<Result> {
		this.#assertActive();
		for (
			let held = this.#inputGate.held();
			held !== undefined;
			held = this.#inputGate.held()
		) {
			await held;
		}
		this.#assertActive();
		let outcome: { error: unknown; ok: false } | { ok: true; value: Result };
		try {
			outcome = { ok: true, value: await this.runInObject(operation) };
		} catch (error: unknown) {
			outcome = { error, ok: false };
		}
		// Workerd releases an event's result, or the error escaping it, only after the writes made
		// before it are durable. A broken gate replaces the result with its error.
		// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/http.c%2B%2B#L1433-L1443
		// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/io/worker-entrypoint.c%2B%2B#L515-L524
		try {
			await this.#database?.waitForOutputGate();
		} catch (error: unknown) {
			throw this.#abortError ?? error;
		}
		if (this.#abortError !== undefined) throw this.#abortError;
		if (!outcome.ok) throw outcome.error;
		return outcome.value;
	}

	/** The object's output gate, or undefined when it has no storage. */
	get outputGate(): OutputGate | undefined {
		return this.#database?.outputGate;
	}

	/**
	 * Runs object code with the object's /tmp and under its output gate, so outgoing fetches, RPC
	 * calls, and WebSocket messages wait for the confirmed writes made before them.
	 */
	runInObject<Result>(operation: () => Result): Result {
		const database = this.#database;
		if (database === undefined) return runWithWorkerTmp(this.#tmp, operation);
		return runWithWorkerTmp(this.#tmp, () => runWithOutputGate(database.outputGate, operation));
	}

	/** Stops the object and resolves once its open turn committed. */
	dispose(): Promise<void> {
		this.#active = false;
		// Work of an object that is gone must not keep its actor awake, and its timers don't run.
		cancelTimers(this.#tmp);
		this.#releaseActor();
		this.#tmp.end();
		this.#retiredController.abort(new Error("Durable Object generation is no longer active"));
		// A failed commit already broke the object, and its next generation loads durable state.
		return this.#database?.commitTurn().catch(() => {}) ?? Promise.resolve();
	}

	/**
	 * Fails this object's in-flight and later work with `error` and discards its open turn, like
	 * abort(), but keeps the actor running so its owner can build the next object in place.
	 */
	retire(error: Error): void {
		this.#reset(error, false);
	}

	// Workerd's ctx.abort() shuts storage down first, which discards the open implicit
	// transaction, and then resets the object.
	// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/actor-state.c%2B%2B#L1205-L1214
	#reset(error: Error, resetActor = true): void {
		if (this.#abortError !== undefined) return;
		this.#abortError = error;
		cancelTimers(this.#tmp);
		this.#tmp.end();
		this.#resetController.abort(error);
		this.#retiredController.abort(error);
		if (!resetActor) {
			this.#database?.retire(error);
			return;
		}
		if (this.#database !== undefined) {
			// Later calls and the alarm runner see the abort error itself, as in workerd, so
			// `retryAlarm: false` still applies.
			this.#database.breakObject(error, error);
			return;
		}
		try {
			this.#runtime.requestReset?.(error);
		} catch (resetError: unknown) {
			error.cause = resetError;
		}
	}

	#assertActive(): void {
		// A call that waited on an object that ctx.abort() reset fails with the abort error, as in
		// workerd, even after RivetKit disposed the generation.
		if (this.#abortError !== undefined) throw this.#abortError;
		if (!this.#active) {
			throw new Error("Durable Object generation is no longer active");
		}
		const broken = this.#database?.broken;
		if (broken !== undefined) throw broken;
	}
}

class InitialDurableObjectState implements DurableObjectState {
	readonly #controller: DurableObjectStateController;
	readonly #facets: DurableObjectFacets | undefined;
	readonly #storage: DurableObjectStorage | undefined;
	readonly #webSockets: DurableObjectHibernatableWebSocketStore;
	readonly #className: string | undefined;
	#container: object | undefined;

	constructor(
		className: string | undefined,
		controller: DurableObjectStateController,
		webSockets: DurableObjectHibernatableWebSocketStore,
		inputGate: DurableObjectInputGate,
		database?: DurableObjectTurnDatabase,
		alarmScheduler?: DurableObjectAlarmSynchronization,
		facets?: DurableObjectFacets,
	) {
		this.#className = className;
		this.#controller = controller;
		this.#facets = facets;
		this.#storage =
			database === undefined
				? undefined
				: createDurableObjectStorage(database, inputGate, alarmScheduler);
		this.#webSockets = webSockets;
	}

	waitUntil(promise: Promise<unknown>): void {
		this.#controller.waitUntil(promise);
	}

	// A Durable Object shares its Worker's ctx.exports.
	get exports(): object {
		const exports = workerContextExports();
		if (exports === undefined) throw stateUnsupported("exports");
		return exports;
	}

	get props(): unknown {
		return this.#controller.props;
	}

	// OpenOrange's extensions. A getter on the prototype, so the state's own keys stay workerd's.
	get orange(): DurableObjectStateOrange | undefined {
		return this.#controller.orange;
	}

	// The Cloudflare types say DurableObjectId, but workerd returns the string for a facet that
	// its parent started with a string `id`.
	// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/actor-state.c%2B%2B#L1161-L1171
	get id(): DurableObjectId {
		// SAFETY: only a facet with a string `id` returns a string, which workerd does too.
		return this.#controller.id as DurableObjectId;
	}

	get storage(): DurableObjectStorage {
		if (this.#storage === undefined) {
			throw new Error("DurableObjectState.storage is not initialized");
		}
		return this.#storage;
	}

	// Classes listed under wrangler `containers` get a Container backed by the
	// ORANGE_SANDBOX_PROVIDER sandbox provider. Any other class has no container
	// and reads `undefined`, as workerd's optional `container` does:
	// https://github.com/cloudflare/workerd/blob/ebf43c5fcdc99a436a95f00384dfed671c75da2e/src/workerd/api/actor-state.h#L673-L675
	get container(): object | undefined {
		if (this.#container !== undefined) return this.#container;
		if (this.#className === undefined) return undefined;
		this.#container = containerForDurableObject(this.#className, String(this.id), () => this.storage);
		return this.#container;
	}

	get facets(): DurableObjectFacets {
		if (this.#facets === undefined) throw stateUnsupported("facets");
		return this.#facets;
	}

	blockConcurrencyWhile<Result>(
		callback: () => Promise<Result>,
	): Promise<Result> {
		return this.#controller.blockConcurrencyWhile(callback);
	}

	acceptWebSocket(webSocket: WebSocket, tags?: string[]): void {
		if (!isWebSocketPairEndpoint(webSocket)) {
			throw new TypeError("WebSocket is not a local pair endpoint");
		}
		this.#webSockets.acceptWebSocket(webSocket, tags);
	}

	getWebSockets(tag?: string): WebSocket[] {
		return this.#webSockets.getWebSockets(tag);
	}

	setWebSocketAutoResponse(
		maybeRequestResponse?: WebSocketRequestResponsePair,
	): void {
		this.#webSockets.setAutoResponse(maybeRequestResponse);
	}

	getWebSocketAutoResponse(): WebSocketRequestResponsePair | null {
		return this.#webSockets.getAutoResponse();
	}

	getWebSocketAutoResponseTimestamp(
		webSocket: WebSocket,
	): Date | null {
		if (!isWebSocketPairEndpoint(webSocket)) {
			throw new TypeError("WebSocket is not a local pair endpoint");
		}
		return this.#webSockets.getAutoResponseTimestamp(webSocket);
	}

	setHibernatableWebSocketEventTimeout(timeoutMs?: number): void {
		this.#webSockets.setEventTimeout(timeoutMs);
	}

	getHibernatableWebSocketEventTimeout(): number | null {
		return this.#webSockets.getEventTimeout();
	}

	getTags(webSocket: WebSocket): string[] {
		if (!isWebSocketPairEndpoint(webSocket)) {
			throw new TypeError("WebSocket is not a local pair endpoint");
		}
		return this.#webSockets.getTags(webSocket);
	}

	abort(reason?: string, options?: DurableObjectAbortOptions): void {
		this.#controller.abort(reason, options);
	}
}

function createInitialDurableObjectState(
	className: string | undefined,
	controller: DurableObjectStateController,
	webSockets: DurableObjectHibernatableWebSocketStore,
	inputGate: DurableObjectInputGate,
	database?: DurableObjectTurnDatabase,
	alarmScheduler?: DurableObjectAlarmSynchronization,
	facets?: DurableObjectFacets,
): DurableObjectState {
	const target = new InitialDurableObjectState(
		className,
		controller,
		webSockets,
		inputGate,
		database,
		alarmScheduler,
		facets,
	);
	const boundMethods = new Map<PropertyKey, Function>();
	return new Proxy(target, {
		get(state, property): unknown {
			if (Reflect.has(state, property)) {
				const value: unknown = Reflect.get(state, property, state);
				if (typeof value !== "function") return value;
				const existing = boundMethods.get(property);
				if (existing !== undefined) return existing;
				const bound = value.bind(state);
				boundMethods.set(property, bound);
				return bound;
			}
			// A name that workerd's DurableObjectState does not define, such as
			// `tracing`, reads as undefined.
			// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/actor-state.h#L723-L760
			if (
				typeof property !== "string" ||
				!unimplementedStateMembers.has(property)
			) {
				return undefined;
			}
			throw stateUnsupported(property);
		},
	});
}

export interface DurableObjectGeneration {
	readonly alarmController: DurableObjectAlarmController | undefined;
	readonly className: string;
	/** The object's storage with its turn transaction, or undefined when it has none. */
	readonly database: DurableObjectTurnDatabase | undefined;
	readonly environment: Record<string, unknown>;
	readonly hibernationLifecycle: DurableObjectHibernationLifecycle;
	readonly hibernatableWebSockets: DurableObjectHibernatableWebSocketStore;
	readonly instance: object;
	readonly orderCoordinator: DurableObjectOrderCoordinator;
	readonly rpcContinuations: DurableObjectRpcContinuationStore;
	readonly ready: Promise<void>;
	readonly state: DurableObjectState;
	readonly stateController: DurableObjectStateController;
	readonly webSocketUpgrades: DurableObjectWebSocketUpgradeStore;
	/** The actor's accepted sockets, which outlive this object. */
	readonly webSocketHost: DurableObjectAcceptedWebSocketHost;
}

interface BrandedDurableObjectGeneration extends DurableObjectGeneration {
	readonly [generationBrand]: true;
}

export interface CreateDurableObjectGenerationOptions {
	alarmScheduler?: DurableObjectAlarmController;
	bindings: Readonly<Record<string, unknown>>;
	className: string;
	database?: DurableObjectTurnDatabase;
	facets?: DurableObjectFacets;
	hibernatableConnections?: Iterable<RivetActorConnection>;
	hibernationSettings?: DurableObjectHibernationSettings;
	orderCoordinator?: DurableObjectOrderCoordinator;
	stateRuntime?: DurableObjectStateRuntime;
	userClass: ConfiguredDurableObjectClass;
	webSocketHost?: DurableObjectAcceptedWebSocketHost;
}

export function createDurableObjectGeneration(
	options: CreateDurableObjectGenerationOptions,
): DurableObjectGeneration {
	const environment = createEnvironment(
		Object.entries(options.bindings).map(([name, value]) => ({ name, value })),
	);
	const webSocketHost = options.webSocketHost ?? new DurableObjectAcceptedWebSocketHost();
	const hibernatableWebSockets = new DurableObjectHibernatableWebSocketStore(
		options.hibernationSettings,
		(value) => webSocketHost.setAutoResponse(value),
	);
	const inputGate = new DurableObjectInputGate();
	const hibernationLifecycle = new DurableObjectHibernationLifecycle();
	const stateController = new DurableObjectStateController(
		options.stateRuntime,
		inputGate,
		options.database,
		hibernationLifecycle,
	);
	const state = createInitialDurableObjectState(
		options.className,
		stateController,
		hibernatableWebSockets,
		inputGate,
		options.database,
		options.alarmScheduler,
		options.facets,
	);
	internalObjectLifetimes.set(state, {
		keepAwake: (promise) => stateController.keepAwake(promise),
		retired: stateController.retiredSignal,
	});
	for (const connection of options.hibernatableConnections ?? []) {
		if (connection.isHibernatable) {
			hibernatableWebSockets.restoreConnection(connection);
		}
	}
	const instance: unknown = stateController.runInObject(() =>
		Reflect.construct(options.userClass, [state, environment]),
	);
	if (typeof instance !== "object" || instance === null) {
		throw new TypeError(
			`Durable Object class ${options.className} did not construct an object`,
		);
	}
	options.alarmScheduler?.finishConstruction(instance);
	const ready = stateController.finishConstruction();
	const generation: BrandedDurableObjectGeneration = {
		[generationBrand]: true,
		alarmController: options.alarmScheduler,
		className: options.className,
		database: options.database,
		environment,
		hibernationLifecycle,
		hibernatableWebSockets,
		instance,
		orderCoordinator:
			options.orderCoordinator ?? new DurableObjectOrderCoordinator(),
		rpcContinuations: new DurableObjectRpcContinuationStore(),
		ready,
		state,
		stateController,
		webSocketHost,
		webSocketUpgrades: new DurableObjectWebSocketUpgradeStore(),
	};
	return generation;
}

export async function disposeDurableObjectGeneration(
	generation: DurableObjectGeneration,
): Promise<void> {
	const committed = generation.stateController.dispose();
	generation.hibernationLifecycle.dispose();
	generation.webSocketUpgrades.dispose();
	generation.hibernatableWebSockets.dispose();
	await generation.rpcContinuations.dispose();
	await committed;
}

export async function hibernateDurableObjectGeneration(
	generation: DurableObjectGeneration,
): Promise<void> {
	const committed = generation.stateController.dispose();
	generation.hibernationLifecycle.dispose();
	generation.webSocketUpgrades.dispose((socket) =>
		generation.hibernatableWebSockets.isResponseSocketHibernatable(socket),
	);
	generation.hibernatableWebSockets.releaseForSleep();
	await generation.rpcContinuations.dispose();
	await committed;
}

function isDurableObjectGeneration(
	value: unknown,
): value is BrandedDurableObjectGeneration {
	return (
		typeof value === "object" &&
		value !== null &&
		Reflect.get(value, generationBrand) === true
	);
}

export function requireDurableObjectGeneration(
	value: unknown,
): DurableObjectGeneration {
	if (!isDurableObjectGeneration(value)) {
		throw new Error(
			"Rivet actor callback is missing its Durable Object generation",
		);
	}
	return value;
}
