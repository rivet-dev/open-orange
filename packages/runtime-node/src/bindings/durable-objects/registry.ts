
import { reportError } from "../../globals/global-scope.js";
import { holdOutgoingFrames } from "../../internal/output-gate.js";
import {
	createRivetActorDefinition,
	type RivetActorAction,
	type RivetActorFork,
	type RivetActorRequestContext,
	type RivetScheduledFireInfo,
	type RivetSqliteDatabase,
	type RivetWebSocket,
	unlimitedActionTimeoutMs,
} from "../../internal/rivetkit.js";
import {
	type DurableObjectAlarmController,
	type DurableObjectAlarmRecord,
	DurableObjectAlarmScheduler,
	DurableObjectAlarmStore,
	durableObjectAlarmAction,
} from "./alarm-storage.js";
import { createDurableObjectAbortError } from "./abort.js";
import type { ConfiguredDurableObjectClass } from "./classes.js";
import {
	type DurableObjectFacetCloneActor,
	exportDurableObjectFacet,
	forkDurableObjectFacet,
	importDurableObjectFacet,
	readDurableObjectFacetForkState,
	readDurableObjectFacetExportChunk,
	releaseDurableObjectFacetExport,
	storeForkedDurableObjectFacet,
} from "./facet-clone.js";
import {
	createDurableObjectFacets,
	type DurableObjectFacetHost,
	durableObjectFacetActions,
	durableObjectFacetAlarmController,
	durableObjectFacetChanged,
	readDurableObjectFacet,
	storeDurableObjectFacet,
} from "./facets.js";
import { durableObjectActorName } from "./actor-routing.js";
import { handleDurableObjectFetch } from "./fetch.js";
import { DurableObjectTurnDatabase } from "./gates.js";
import type { HibernationHeldReport, HibernationHold } from "./hibernation-lifecycle.js";
import { DurableObjectHibernationSettings } from "./hibernation-settings.js";
import { DurableObjectOrderCoordinator } from "./ordering.js";
import {
	readDurableObjectMetadata,
	writeDurableObjectMetadata,
} from "./metadata.js";
import { durableObjectPrivateRoutes, generationRetiredError } from "./routes.js";
import {
	DurableObjectRpcHttpTarget,
	handleDurableObjectRpcHttp,
} from "./rpc/http.js";
import {
	createDurableObjectMethodHandler,
	durableObjectRpcContinuationParameter,
} from "./rpc/methods.js";
import { DurableObjectRpcSessionTarget } from "./rpc/session.js";
import { attachDurableObjectRpcSessionWebSocket } from "./rpc/websocket.js";
import {
	cloudflareImportIsPending,
	cloudflareImportIsDone,
	cloudflareImportIsUnfinished,
	durableObjectWakeAction,
	type DurableObjectWakeResult,
	importDurableObjectFromCloudflare,
	isInternalImportFailure,
	unfinishedCloudflareImportError,
} from "./cloudflare-import.js";
import { isMigratingFromCloudflare } from "./migration-mode.js";
import {
	createDurableObjectIdScope,
	isDurableObjectJurisdiction,
	type DurableObjectId,
} from "./id.js";
import {
	durableObjectNamespaceKey,
} from "./namespace.js";
import {
	createDurableObjectGeneration,
	type DurableObjectGeneration,
	disposeDurableObjectGeneration,
	hibernateDurableObjectGeneration,
	requireDurableObjectGeneration,
} from "./state.js";
import { durableObjectDatabaseProvider } from "./storage.js";
import {
	attachDurableObjectWebSocket,
	disconnectDurableObjectWebSocket,
	prepareDurableObjectWebSocket,
} from "./websocket.js";
import { DurableObjectAcceptedWebSocketHost } from "./accepted-websocket-host.js";

export { durableObjectPrivateRoutes } from "./routes.js";

export interface DurableObjectRouteHandlers {
	fetch(
		generation: DurableObjectGeneration,
		request: Request,
	): Response | Promise<Response>;
	rpc(
		generation: DurableObjectGeneration,
		request: Request,
	): Response | Promise<Response>;
	rpcWebSocket(
		generation: DurableObjectGeneration,
		request: Request,
		webSocket: RivetWebSocket,
	): void | Promise<void>;
	webSocket(
		generation: DurableObjectGeneration,
		request: Request,
		webSocket: RivetWebSocket,
		keepAwake?: (promise: Promise<void>) => void,
	): void | Promise<void>;
}

export interface CreateDurableObjectActorDefinitionsOptions {
	bindings?: Readonly<Record<string, unknown>>;
	classStorage?: ReadonlyMap<string, DurableObjectClassStorageConfiguration>;
	classes: ReadonlyMap<string, ConfiguredDurableObjectClass>;
	deploymentIdentity: string;
	/** The display name of a class by class name. Defaults to the class name. */
	displayNames?: ReadonlyMap<string, string>;
	/** Gives each Durable Object `ctx.facets`. Without it, `ctx.facets` throws. */
	facetHost?: DurableObjectFacetHost;
	routes?: DurableObjectRouteHandlers;
}

export interface DurableObjectClassStorageConfiguration {
	migrationTag: string;
	storageBackend: "sqlite";
}

// Bounds how long a reset waits for committed writes, so a dead storage backend cannot keep a
// broken object alive.
const resetDurabilityTimeoutMs = 5_000;

// Resolves when `promise` settles or after `timeoutMs`, whichever comes first.
function settleWithin(promise: Promise<unknown>, timeoutMs: number): Promise<void> {
	return new Promise((resolveSettled) => {
		const timeout = setTimeout(resolveSettled, timeoutMs);
		const settle = (): void => {
			clearTimeout(timeout);
			resolveSettled();
		};
		promise.then(settle, settle);
	});
}

const defaultRouteHandlers: DurableObjectRouteHandlers = {
	fetch: handleDurableObjectFetch,
	rpc: (generation, request) => {
		const target = new DurableObjectRpcHttpTarget(
			createDurableObjectMethodHandler(generation),
			{ continuations: generation.rpcContinuations },
		);
		return handleDurableObjectRpcHttp(request, target);
	},
	rpcWebSocket: async (generation, request, webSocket) => {
		const token = new URL(request.url).searchParams.get(
			durableObjectRpcContinuationParameter,
		);
		const target = new DurableObjectRpcSessionTarget(
			createDurableObjectMethodHandler(generation),
			generation.rpcContinuations,
			token === null ? undefined : { expiresAt: 0, token },
		);
		// An open RPC session holds the object, so it does not hibernate.
		generation.hibernationLifecycle.preventSleepUntil(
			new Promise<void>((resolve) => {
				webSocket.addEventListener("close", () => resolve());
				webSocket.addEventListener("error", () => resolve());
			}),
			"rpc-session",
		);
		// Results of calls on stubs that the object returned are outputs of the object.
		await attachDurableObjectRpcSessionWebSocket(
			holdOutgoingFrames(
				webSocket,
				generation.stateController.outputGate,
				reportError,
			),
			target,
			generation.stateController.resetSignal,
		);
	},
	webSocket: attachDurableObjectWebSocket,
};

// After ctx.abort(), sleep, or destroy, RivetKit can still route a request to the retired
// generation until the actor stops. The object never runs an RPC batch that arrives there, and
// the caller retries it so that it reaches the next generation, as a call after abort() reaches a
// new instance in workerd. The batch body is read first: an envoy without the late-frame fix
// aborts the response when a request chunk arrives after the request completed.
// https://github.com/rivet-dev/rivet/pull/5911
async function generationRetiredResponse(request: Request): Promise<Response> {
	await request.arrayBuffer();
	const [group, code] = generationRetiredError.split(".");
	return new Response(
		JSON.stringify({ code, group, message: "The Durable Object instance is restarting." }),
		{
			headers: { "content-type": "application/json", "x-rivet-error": generationRetiredError },
			status: 503,
		},
	);
}

export function dispatchDurableObjectPrivateRequest(
	generation: DurableObjectGeneration,
	request: Request,
	routes: DurableObjectRouteHandlers,
): Response | Promise<Response> {
	const path = new URL(request.url).pathname;
	if (generation.stateController.retiredSignal.aborted && path === durableObjectPrivateRoutes.rpc) {
		return generationRetiredResponse(request);
	}
	if (path === durableObjectPrivateRoutes.fetch) {
		return routes.fetch(generation, request);
	}
	if (path === durableObjectPrivateRoutes.rpc) {
		return routes.rpc(generation, request);
	}
	if (path === durableObjectPrivateRoutes.webSocketPrepare) {
		return prepareDurableObjectWebSocket(generation, request);
	}
	if (path === durableObjectPrivateRoutes.webSocketDisconnect) {
		return disconnectDurableObjectWebSocket(generation, request);
	}
	return new Response("Not Found", { status: 404 });
}

export function dispatchDurableObjectPrivateWebSocket(
	generation: DurableObjectGeneration,
	request: Request,
	webSocket: RivetWebSocket,
	routes: DurableObjectRouteHandlers,
	keepAwake?: (promise: Promise<void>) => void,
): void | Promise<void> {
	const receivedPath = new URL(request.url).pathname;
	// RivetKit prefixes every actor WebSocket request with `/websocket` before
	// forwarding it to onWebSocket, so remove that transport routing segment.
	// https://github.com/rivet-dev/actors/blob/512d245b8dc28234e1b029747c9284f06be964dc/rivetkit-typescript/packages/rivetkit/src/client/raw-utils.ts#L132-L158
	const path = receivedPath.startsWith("/websocket/")
		? receivedPath.slice("/websocket".length)
		: receivedPath;
	if (path === durableObjectPrivateRoutes.rpc) {
		return routes.rpcWebSocket(generation, request, webSocket);
	}
	if (path === durableObjectPrivateRoutes.webSocket) {
		return routes.webSocket(generation, request, webSocket, keepAwake);
	}
	webSocket.close(1008, `Unknown OpenOrange Durable Object route: ${path}`);
}

/** The class and identity that one actor generation constructs. */
interface DurableObjectActorObject {
	readonly className: string;
	/** Facet tree depth. 0 for a root Durable Object. */
	readonly depth: number;
	/** A string for a facet whose parent passed a string `id`. */
	readonly id: DurableObjectId | string | undefined;
	/** `ctx.props`. A facet gets the props of its class; other objects get `{}`. */
	readonly props?: unknown;
	readonly userClass: ConfiguredDurableObjectClass;
}

// A reset error can wrap its cause in workerd's generic text, so log the whole cause chain.
function logDurableObjectReset(
	object: DurableObjectActorObject,
	actorId: string | undefined,
	error: Error,
): void {
	console.error(
		`[durable-object] resetting class=${object.className} id=${object.id?.toString() ?? "none"} actor=${actorId ?? "none"} error=${JSON.stringify(describeErrorChain(error))}`,
	);
}

function describeErrorChain(error: unknown): string {
	const parts: string[] = [];
	let current = error;
	while (current !== undefined && parts.length < 5) {
		if (!(current instanceof Error)) {
			parts.push(String(current));
			break;
		}
		parts.push(`${current.name}: ${current.message}`);
		current = current.cause;
	}
	return parts.join(" <- ");
}

/** What differs between a Durable Object class actor and the generic facet actor. */
interface DurableObjectActorShape {
	readonly actions: Readonly<Record<string, RivetActorAction>>;
	readonly alarms: "facet" | "scheduled";
	readonly displayName: string;
	/** Stores the create input in the actor's SQLite. Runs once, before the first object. */
	onCreate(database: RivetSqliteDatabase, input: unknown): void;
	/** Runs instead of `onCreate` in an actor that is a fork of another one. */
	onFork?(database: RivetSqliteDatabase, fork: RivetActorFork): void;
	/**
	 * Whether the actor holds its object in a slot: built at the first call, replaced in place by
	 * facet resets, and empty while a clone destination has no class.
	 */
	readonly resetsInProcess: boolean;
	resolveObject(
		context: RivetActorRequestContext | undefined,
	): DurableObjectActorObject;
}

function createActorDefinition(
	bindings: Readonly<Record<string, unknown>>,
	facetHost: DurableObjectFacetHost | undefined,
	routes: DurableObjectRouteHandlers,
	shape: DurableObjectActorShape,
) {
	const orderCoordinator = new DurableObjectOrderCoordinator();
	const buildGeneration = async (
		context: RivetActorRequestContext | undefined,
		webSocketHost: DurableObjectAcceptedWebSocketHost,
	): Promise<DurableObjectGeneration> => {
		const object = shape.resolveObject(context);
		let alarmScheduler: DurableObjectAlarmController | undefined;
		// Workerd drops a broken object without running more of its code, and the next event
		// gets a fresh instance from durable state. RivetKit's provider-level abort breaks the
		// database, so nothing more is persisted, and restarts the actor from durable state.
		// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/actor-state.c%2B%2B#L1205-L1214
		// Workerd's shutdown fails only commits that have not started. In-flight commits of earlier
		// turns keep running and stay in the database the next instance opens. Deferred commits return
		// before they are durable, and abortGeneration() discards the ones still in flight, so the
		// reset waits for them first. The turn database is already broken, so no write can start.
		// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/io/actor-sqlite.c%2B%2B#L987-L991
		const requestReset = (error?: Error): void => {
			if (error !== undefined) {
				logDurableObjectReset(object, context?.actorId, error);
			}
			const db = context?.db;
			if (db === undefined) return;
			const reason = error?.message ?? "reset";
			void settleWithin(
				db.whenDurable(db.commitTicket()),
				resetDurabilityTimeoutMs,
			).then(() => db.abortGeneration?.(reason));
		};
		const keepAwake = (promise: Promise<unknown>): void => {
			if (context?.keepAwake === undefined) {
				throw new Error(
					"The pinned RivetKit runtime did not provide keepAwake()",
				);
			}
			void context.keepAwake(promise);
		};
		const waitUntil = (promise: Promise<unknown>): void => {
			if (context?.waitUntil === undefined) {
				throw new Error(
					"The pinned RivetKit runtime did not provide waitUntil()",
				);
			}
			context.waitUntil(promise);
		};
		const database =
			context?.db === undefined
				? undefined
				: new DurableObjectTurnDatabase(context.db, requestReset);
		if (database !== undefined && shape.alarms === "facet") {
			alarmScheduler = durableObjectFacetAlarmController;
		} else if (database !== undefined) {
			const schedule = context?.schedule;
			if (schedule === undefined) {
				throw new Error(
					"The pinned RivetKit runtime did not provide its actor scheduler",
				);
			}
			const alarmStore = new DurableObjectAlarmStore(() => database);
			const scheduler = new DurableObjectAlarmScheduler(
				schedule,
				false,
				alarmStore,
			);
			await scheduler.restore();
			alarmScheduler = scheduler;
		}
		const generation = createDurableObjectGeneration({
			alarmScheduler,
			bindings,
			className: object.className,
			database,
			...(facetHost === undefined ||
			database === undefined ||
			context?.actorId === undefined ||
			object.id === undefined
				? {}
				: {
						facets: createDurableObjectFacets(facetHost, {
							actorId: context.actorId,
							className: object.className,
							database,
							depth: object.depth,
							id: object.id,
							waitUntil,
						}),
					}),
			// A hibernated object's accepted sockets are back before its constructor runs, as in
			// workerd, so the constructor sees them in ctx.getWebSockets().
			hibernatableConnections: webSocketHost.connections(),
			hibernationSettings: new DurableObjectHibernationSettings(database),
			orderCoordinator,
			stateRuntime: {
				...(object.id === undefined ? {} : { id: object.id }),
				keepAwake,
				props: object.props ?? {},
				requestReset,
				waitUntil,
			},
			userClass: object.userClass,
			webSocketHost,
		});
		await generation.ready;
		webSocketHost.rebind(generation);
		return generation;
	};
	return createRivetActorDefinition({
		actions: shape.actions,
		db: durableObjectDatabaseProvider,
		createVars: async (context) => {
			if (shape.resetsInProcess) {
				return new DurableObjectGenerationSlot(
					requireActorContext(context),
					buildGeneration,
					readDurableObjectFacet(context?.db) !== undefined,
				);
			}
			// A copy can outlast createVarsTimeout, because its time depends on the object's size. So an
			// object that still needs its copy starts at once, and its first calls wait in a slot for the
			// copy and the user constructor. The constructor keeps its own 30-second limit.
			if (
				isMigratingFromCloudflare() &&
				shape.alarms === "scheduled" &&
				cloudflareImportIsPending(context?.db, shape.resolveObject(context), bindings)
			) {
				const slot = new DurableObjectGenerationSlot(
					requireActorContext(context),
					async (slotContext, webSocketHost) => {
						const copy = importDurableObjectFromCloudflare(slotContext?.db, shape.resolveObject(slotContext), bindings);
						await (slotContext?.keepAwake === undefined ? copy : slotContext.keepAwake(copy));
						return await buildGeneration(slotContext, webSocketHost);
					},
					true,
				);
				slotsThatCopy.add(slot);
				return slot;
			}
			// The actor stays up and only its calls fail, so a restart does not loop while the operator acts.
			if (
				shape.alarms === "scheduled" &&
				!isMigratingFromCloudflare() &&
				cloudflareImportIsUnfinished(context?.db)
			) {
				const error = unfinishedCloudflareImportError(shape.resolveObject(context));
				return new DurableObjectGenerationSlot(
					requireActorContext(context),
					() => Promise.reject(error),
					true,
				);
			}
			// The first object is built here, so a constructor that fails fails the actor's start.
			const slot = new DurableObjectGenerationSlot(context, buildGeneration, true);
			await slot.use(() => undefined);
			return slot;
		},
		onRequest: (context, request) =>
			withDurableObjectGeneration(context.vars, (generation) =>
				dispatchDurableObjectPrivateRequest(generation, request, routes),
			),
		onDestroy: (context) => {
			disposeDurableObjectWebSocketHost(context.vars);
			return withBuiltDurableObjectGeneration(context.vars, disposeDurableObjectGeneration);
		},
		onSleep: (context) => {
			disposeDurableObjectWebSocketHost(context.vars);
			return withBuiltDurableObjectGeneration(context.vars, hibernateDurableObjectGeneration);
		},
		onWebSocket: (context, webSocket) => {
			const request = context.request;
			if (request === undefined) {
				webSocket.close(1008, "OpenOrange Durable Object request is missing");
				return;
			}
			return withDurableObjectGeneration(context.vars, (generation) =>
				dispatchDurableObjectPrivateWebSocket(
					generation,
					request,
					webSocket,
					routes,
					context.keepAwake === undefined
						? undefined
						: (promise) => {
								void context.keepAwake?.(promise);
							},
				),
			);
		},
		// Workerd hibernates an idle WebSocket actor after ten seconds. Override
		// Rivet's 30-second default so Orange follows the same lifecycle cadence.
		// https://github.com/cloudflare/workerd/blob/5f8e6964ddf897da379f4030499d21ffcf492da0/src/workerd/server/server.c%2B%2B#L988-L1013
		// https://github.com/rivet-dev/actors/blob/3848076c011ad2f881bca9821e4d5c725aa9f15e/rivetkit-typescript/packages/rivetkit/src/actor/config.ts#L1107-L1115
		// Orange owns the Cloudflare-compatible 30-second constructor critical
		// section timeout. Rivet's outer createVars timeout must be slightly longer
		// so the compatible diagnostic wins instead of its five-second default.
		// https://github.com/rivet-dev/actors/blob/0ed739a2e9ac989a707ceba1255674675f510e33/rivetkit-typescript/packages/rivetkit/src/actor/config.ts#L1248-L1260
		// `options.name` is RivetKit's display name for the actor. The registry
		// key stays the hashed actor name, so routing and
		// stored actor keys do not change.
		// https://github.com/rivet-dev/actors/blob/32022a9b4a165b67be46382324f4e10055c5c9e9/rivetkit-typescript/packages/rivetkit/src/registry/config/index.ts#L445-L460
		options: {
			actionTimeout: unlimitedActionTimeoutMs,
			// Rivet's WebSocket hibernation is paused until a re-architecture, so a socket from
			// acceptWebSocket() is a normal Rivet socket, and its object stays awake while it is open.
			canHibernateWebSocket: false,
			createVarsTimeout: 31_000,
			name: shape.displayName,
			sleepTimeout: 10_000,
		},
		onCreate: async (context, input) => {
			const db = requireActorDatabase(context);
			shape.onCreate(db, input);
			await db.whenDurable(db.commitTicket());
		},
		...(shape.onFork === undefined
			? {}
			: {
					onFork: async (context: RivetActorRequestContext, fork: RivetActorFork) => {
						const db = requireActorDatabase(context);
						shape.onFork?.(db, fork);
						await db.whenDurable(db.commitTicket());
					},
				}),
	});
}

function durableObjectClassShape(
	className: string,
	displayName: string,
	deploymentIdentity: string,
	storage: DurableObjectClassStorageConfiguration | undefined,
	userClass: ConfiguredDurableObjectClass,
): DurableObjectActorShape {
	if (storage !== undefined && storage.storageBackend !== "sqlite") {
		throw new Error(
			`Durable Object class ${className} uses unsupported storage backend ${String(storage.storageBackend)}`,
		);
	}
	return {
		actions: {
			...(isMigratingFromCloudflare()
				? {
						// Waits for the copy of an object that needs one. A failed copy is returned, not thrown,
						// because RivetKit replaces the message of a thrown error, and the reason is what the
						// operator needs.
						[durableObjectWakeAction]: async (context: RivetActorRequestContext): Promise<DurableObjectWakeResult> => {
							try {
								// The copy runs when the first call builds the object. Until the copy is done, this
								// wake starts it or waits for it, so it counts the copy as its own. After that, an
								// earlier call, such as an app request, made the copy, even if the object hibernated.
								const copied =
									context.vars instanceof DurableObjectGenerationSlot &&
									slotsThatCopy.has(context.vars) &&
									!cloudflareImportIsDone(context.db);
								await withDurableObjectGeneration(context.vars, () => undefined);
								return { copied, ok: true };
							} catch (error: unknown) {
								return { error: error instanceof Error ? error.message : String(error), internal: isInternalImportFailure(error), ok: false };
							}
						},
					}
				: {}),
			[durableObjectAlarmAction]: async (context, ...args) => {
				await withDurableObjectGeneration(context.vars, async (generation) => {
					const controller = generation.alarmController;
					if (controller === undefined) {
						throw new Error(
							"Durable Object alarm action is missing its storage controller",
						);
					}
					const invocation = parseDurableObjectAlarmInvocation(args);
					await controller.dispatch(
						generation.instance,
						invocation.record,
						invocation.retryCount,
						invocation.fire,
						(operation) => generation.stateController.runEvent(operation),
					);
				});
			},
		},
		alarms: "scheduled",
		displayName,
		// Workerd persists the name of the ID that started the object, so `ctx.id.name` survives
		// eviction and an alarm wake-up. Orange keeps it in the actor's SQLite from create input.
		// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/server/server.c%2B%2B#L1229-L1238
		onCreate: (database, input) => {
			const name = durableObjectNameFromInput(input);
			if (name !== undefined) writeDurableObjectMetadata(database, "name", name);
		},
		resetsInProcess: false,
		resolveObject: (context) => ({
			className,
			depth: 0,
			id: durableObjectIdFromActorKey(
				context?.key,
				context?.db === undefined
					? undefined
					: readDurableObjectMetadata(context.db, "name"),
				deploymentIdentity,
				className,
			),
			userClass,
		}),
	};
}

type DurableObjectGenerationBuilder = (
	context: RivetActorRequestContext | undefined,
	webSocketHost: DurableObjectAcceptedWebSocketHost,
) => Promise<DurableObjectGeneration>;

/**
 * Holds the actor's object, so the actor can drop and rebuild it while the actor runs. A facet's
 * abort() and class change replace it. Restarting the actor instead would leave a window in which
 * its stopping generation still admits calls whose storage is already closed. An idle object with
 * accepted WebSockets hibernates: the slot drops it, keeps the sockets, and builds a new one at the
 * next event.
 *
 * A facet's object is built at the first call, as workerd constructs a facet when its parent calls
 * it, so a clone that reads a sleeping facet runs none of its code. A clone destination has no
 * class and no object until its parent's next get() binds one.
 */
// The slots whose object copies itself from Cloudflare before it is built.
const slotsThatCopy = new WeakSet<DurableObjectGenerationSlot>();

class DurableObjectGenerationSlot {
	readonly webSocketHost: DurableObjectAcceptedWebSocketHost;
	readonly #build: DurableObjectGenerationBuilder;
	readonly #context: RivetActorRequestContext | undefined;
	#bound: boolean;
	// True from a hibernation until the next object starts to build.
	#hibernated = false;
	// Undefined while no object is built or being built.
	#current: Promise<DurableObjectGeneration> | undefined;
	// The object while no replacement is pending, so calls reach it without a promise turn.
	#settled: DurableObjectGeneration | undefined;

	constructor(
		context: RivetActorRequestContext | undefined,
		build: DurableObjectGenerationBuilder,
		bound: boolean,
	) {
		this.#build = build;
		this.#context = context;
		this.#bound = bound;
		this.webSocketHost = new DurableObjectAcceptedWebSocketHost({
			// The report timer runs only when the lines would be printed.
			...(softHibernationLogs()
				? { held: (generation, report) => logHibernationHeld(context, generation, report) }
				: {}),
			hibernate: (generation) => this.#hibernate(generation),
			sleep: () => context?.sleep?.(),
			wake: async () => {
				await this.use(() => undefined);
			},
		});
	}

	get running(): DurableObjectGeneration | undefined {
		return this.#settled;
	}

	use<Result>(
		operation: (generation: DurableObjectGeneration) => Result,
	): Result | Promise<Awaited<Result>> {
		if (this.#settled !== undefined) return operation(this.#settled);
		const current = this.#current ?? this.#start(this.#context);
		return current.then(
			async (generation): Promise<Awaited<Result>> => await operation(generation),
		);
	}

	/** Runs `operation` only when an object exists or is being built. */
	useBuilt<Result>(
		operation: (generation: DurableObjectGeneration) => Result,
	): Result | Promise<Awaited<Result> | undefined> | undefined {
		if (this.#current === undefined) return undefined;
		return this.use(operation);
	}

	/**
	 * Reads storage for a clone. With an object, the read runs as one of its events after its open
	 * turn commits, so it never sees a transaction in progress. Without one, nothing else writes.
	 */
	async readStorage<Result>(read: () => Result): Promise<Result> {
		const current = this.#current;
		if (current === undefined) return read();
		const generation = await current;
		return await generation.stateController.runEvent(() => {
			generation.database?.commitTurn();
			return read();
		});
	}

	/**
	 * Fails the running object's in-flight and later calls with `reason`, runs `prepare`, then
	 * constructs the class stored in the actor's SQLite over the same storage. Calls that arrive
	 * meanwhile wait for the new object, and replacements run in call order.
	 */
	replace(
		context: RivetActorRequestContext,
		reason: string,
		prepare?: () => Promise<void>,
	): Promise<void> {
		const previous = this.#current;
		this.#settled = undefined;
		this.#bound = true;
		const next = (async () => {
			await this.#retire(previous, reason);
			await prepare?.();
			return await this.#build(context, this.webSocketHost);
		})();
		this.#track(next);
		return next.then(() => undefined);
	}

	/** Fails the running object's calls with `reason` and leaves the slot without a class. */
	async clear(reason: string): Promise<void> {
		const previous = this.#current;
		this.#settled = undefined;
		this.#current = undefined;
		this.#bound = false;
		await this.#retire(previous, reason);
	}

	#start(context: RivetActorRequestContext | undefined): Promise<DurableObjectGeneration> {
		if (!this.#bound) {
			return Promise.reject(
				new Error("Durable Object facet has no class. Its parent must call ctx.facets.get() first."),
			);
		}
		if (this.#hibernated) {
			this.#hibernated = false;
			logSoftHibernation(context, "woke");
		}
		const next = this.#build(context, this.webSocketHost);
		this.#track(next);
		return next;
	}

	// Workerd drops an idle object's instance and keeps its accepted sockets, and the next event
	// constructs a new instance. Orange cannot drop the actor, because Rivet would close the sockets.
	// https://github.com/cloudflare/workerd/blob/80c80a712532b012cbeaef4d08ff6ab15407e960/src/workerd/server/server.c%2B%2B#L988-L1028
	#hibernate(generation: DurableObjectGeneration): true | Map<HibernationHold, number> {
		// A replacement of the object is pending.
		if (this.#settled !== generation) return new Map();
		const unclaimedUpgrades = generation.webSocketUpgrades.unclaimedUpgrades;
		const rpcResults = generation.rpcContinuations.size;
		if (unclaimedUpgrades > 0 || rpcResults > 0) {
			return new Map<HibernationHold, number>([
				["unclaimed-upgrade", unclaimedUpgrades],
				["rpc-result", rpcResults],
			]);
		}
		this.#settled = undefined;
		this.#current = undefined;
		this.#hibernated = true;
		this.webSocketHost.hibernate();
		void hibernateDurableObjectGeneration(generation).catch(reportError);
		logSoftHibernation(this.#context, "hibernated");
		return true;
	}

	#track(next: Promise<DurableObjectGeneration>): void {
		this.#current = next;
		// A failed construction fails the calls that wait for it. The next call builds again.
		next.then(
			(generation) => {
				if (this.#current === next) this.#settled = generation;
			},
			() => {
				if (this.#current === next) this.#current = undefined;
			},
		);
	}

	async #retire(
		previous: Promise<DurableObjectGeneration> | undefined,
		reason: string,
	): Promise<void> {
		// A reset object's accepted sockets close, even while it hibernates.
		this.webSocketHost.closeAll(1011, "Durable Object was reset");
		const old = await previous?.catch(() => undefined);
		if (old === undefined) return;
		old.stateController.retire(createDurableObjectAbortError(reason, true));
		await disposeDurableObjectGeneration(old);
	}
}

function withDurableObjectGeneration<Result>(
	vars: unknown,
	operation: (generation: DurableObjectGeneration) => Result,
): Result | Promise<Awaited<Result>> {
	if (vars instanceof DurableObjectGenerationSlot) return vars.use(operation);
	return operation(requireDurableObjectGeneration(vars));
}

// Lifecycle hooks have nothing to do for a facet whose object was never built.
function withBuiltDurableObjectGeneration<Result>(
	vars: unknown,
	operation: (generation: DurableObjectGeneration) => Result,
): Result | Promise<Awaited<Result> | undefined> | undefined {
	if (vars instanceof DurableObjectGenerationSlot) return vars.useBuilt(operation);
	return operation(requireDurableObjectGeneration(vars));
}

// With Rivet's info logs, as its own actor lifecycle transitions, so an operator or a test can see
// that an object hibernated while its actor kept running.
function softHibernationLogs(): boolean {
	const level = process.env.RIVET_LOG_LEVEL?.toLowerCase();
	return level === "info" || level === "debug" || level === "trace";
}

function logSoftHibernation(
	context: RivetActorRequestContext | undefined,
	event: "hibernated" | "woke",
): void {
	if (!softHibernationLogs()) return;
	console.log(`[durable-object] soft hibernation actor_id=${context?.actorId ?? "none"} event=${event}`);
}

// Names what keeps an idle object from hibernating, with a count for each cause, so a developer
// can find it. For example: `held_by=timer:1 timers=setInterval(3000ms):1`.
function logHibernationHeld(
	context: RivetActorRequestContext | undefined,
	generation: DurableObjectGeneration,
	report: HibernationHeldReport,
): void {
	const list = (counts: ReadonlyMap<string, number>): string =>
		[...counts]
			.filter(([, count]) => count > 0)
			.map(([name, count]) => `${name}:${count}`)
			.join(",");
	const timers = list(report.timers);
	console.log(
		`[durable-object] soft hibernation actor_id=${context?.actorId ?? "none"} event=held class=${generation.className} idle_ms=${report.idleMilliseconds} held_by=${list(report.holds)}${timers === "" ? "" : ` timers=${timers}`}`,
	);
}

function disposeDurableObjectWebSocketHost(vars: unknown): void {
	if (vars instanceof DurableObjectGenerationSlot) vars.webSocketHost.dispose();
}

/**
 * The running object of an actor's `vars`. Throws while the object hibernates. Only tests use it:
 * they check the instance and state that `createVars()` built, which no public path exposes.
 */
export function runningDurableObjectGeneration(vars: unknown): DurableObjectGeneration {
	if (!(vars instanceof DurableObjectGenerationSlot)) return requireDurableObjectGeneration(vars);
	const generation = vars.running;
	if (generation === undefined) throw new Error("The Durable Object is not running");
	return generation;
}

function requireDurableObjectGenerationSlot(vars: unknown): DurableObjectGenerationSlot {
	if (!(vars instanceof DurableObjectGenerationSlot)) {
		throw new Error("Rivet facet actor is missing its object slot");
	}
	return vars;
}

// One generic actor definition hosts every facet. Its SQLite names the exported class to
// construct, so any exported class works without a binding or migration.
function durableObjectFacetShape(
	facetHost: DurableObjectFacetHost,
): DurableObjectActorShape {
	return {
		actions: {
			[durableObjectFacetActions.bind]: async (context, input) => {
				const db = requireActorDatabase(context);
				if (!durableObjectFacetChanged(db, input)) return;
				// The old object's open turn is discarded first, so the new class commits alone.
				// It is durable before the new object runs, so the actor constructs it after it sleeps.
				await requireDurableObjectGenerationSlot(context.vars).replace(
					context,
					"Facet class or ID changed.",
					async () => {
						storeDurableObjectFacet(db, input);
						await db.whenDurable(db.commitTicket());
					},
				);
			},
			[durableObjectFacetActions.clonedBy]: (context) => {
				const actor = facetCloneActor(context, facetHost);
				return requireDurableObjectGenerationSlot(context.vars).readStorage(() =>
					readDurableObjectFacetForkState(actor),
				);
			},
			[durableObjectFacetActions.destroy]: (context) => {
				if (context.destroy === undefined) {
					throw new Error("The pinned RivetKit runtime did not provide destroy()");
				}
				context.destroy();
			},
			[durableObjectFacetActions.export]: (context) => {
				const slot = requireDurableObjectGenerationSlot(context.vars);
				return exportDurableObjectFacet(facetCloneActor(context, facetHost), (read) =>
					slot.readStorage(read),
				);
			},
			[durableObjectFacetActions.exportChunk]: (_context, snapshotId, index, confirmed) =>
				readDurableObjectFacetExportChunk(snapshotId, index, confirmed),
			[durableObjectFacetActions.exportRelease]: (_context, snapshotId) => {
				releaseDurableObjectFacetExport(snapshotId);
			},
			[durableObjectFacetActions.fork]: (context, request) => {
				const slot = requireDurableObjectGenerationSlot(context.vars);
				return forkDurableObjectFacet(facetCloneActor(context, facetHost), request, (read) =>
					slot.readStorage(read),
				);
			},
			[durableObjectFacetActions.import]: (context, request) => {
				const slot = requireDurableObjectGenerationSlot(context.vars);
				return importDurableObjectFacet(
					facetCloneActor(context, facetHost),
					request,
					(read) => slot.readStorage(read),
					() => slot.clear("Facet was cloned-over."),
				);
			},
			[durableObjectFacetActions.reset]: (context, reason) =>
				requireDurableObjectGenerationSlot(context.vars).replace(
					context,
					typeof reason === "string" ? reason : "Facet was aborted.",
				),
		},
		alarms: "facet",
		displayName: "Durable Object facets (Orange)",
		onCreate: storeDurableObjectFacet,
		onFork: storeForkedDurableObjectFacet,
		resetsInProcess: true,
		resolveObject: (context) => {
			const facet = readDurableObjectFacet(context?.db);
			if (facet === undefined) {
				throw new Error("Durable Object facet has no class. Its parent must call ctx.facets.get() first.");
			}
			return {
				...facet,
				userClass: facetHost.classByName(facet.className),
			};
		},
	};
}

function requireActorContext(
	context: RivetActorRequestContext | undefined,
): RivetActorRequestContext {
	if (context === undefined) {
		throw new Error("The pinned RivetKit runtime did not provide the actor context");
	}
	return context;
}

// Reads nothing, so it is safe while the object has a storage transaction open.
function facetCloneActor(
	context: RivetActorRequestContext,
	host: DurableObjectFacetHost,
): DurableObjectFacetCloneActor {
	if (context.actorId === undefined) {
		throw new Error("The pinned RivetKit runtime did not provide the actor ID");
	}
	return { actorId: context.actorId, database: requireActorDatabase(context), host };
}

function requireActorDatabase(
	context: RivetActorRequestContext,
): RivetSqliteDatabase {
	if (context.db === undefined) {
		throw new Error("The pinned RivetKit runtime did not provide the actor database");
	}
	return context.db;
}

function durableObjectNameFromInput(input: unknown): string | undefined {
	if (input === undefined || input === null) return undefined;
	const name =
		typeof input === "object" && input !== null
			? Reflect.get(input, "name")
			: undefined;
	if (typeof name !== "string") {
		throw new TypeError("RivetKit provided an invalid Durable Object create input");
	}
	return name;
}

function durableObjectIdFromActorKey(
	key: readonly string[] | undefined,
	name: unknown,
	deploymentIdentity: string,
	className: string,
): DurableObjectId | undefined {
	if (key === undefined) return undefined;
	if (name !== undefined && typeof name !== "string") {
		throw new TypeError("Durable Object name metadata is invalid");
	}
	const namespaceKey = durableObjectNamespaceKey(deploymentIdentity, className);
	// The key: [jurisdiction?, hex]. See actor-routing.ts.
	const hex = key.at(-1);
	const jurisdiction = key.length === 2 ? key[0] : undefined;
	if ((key.length !== 1 && key.length !== 2) || hex === undefined) {
		throw new TypeError("RivetKit provided an invalid Durable Object actor key");
	}
	if (jurisdiction !== undefined && !isDurableObjectJurisdiction(jurisdiction)) {
		throw new TypeError("RivetKit Durable Object key jurisdiction is invalid");
	}
	const id = createDurableObjectIdScope({ namespaceKey }).idFromString(hex, name);
	if (id.jurisdiction !== jurisdiction) {
		throw new TypeError(
			"RivetKit Durable Object key jurisdiction does not match its ID",
		);
	}
	return id;
}

function isScheduledFireInfo(
	value: unknown,
): value is RivetScheduledFireInfo {
	const scheduledAt =
		typeof value === "object" && value !== null
			? Reflect.get(value, "scheduledAt")
			: undefined;
	const firedAt =
		typeof value === "object" && value !== null
			? Reflect.get(value, "firedAt")
			: undefined;
	return (
		typeof value === "object" &&
		value !== null &&
		Reflect.get(value, "kind") === "at" &&
		typeof Reflect.get(value, "id") === "string" &&
		typeof scheduledAt === "number" &&
		Number.isSafeInteger(scheduledAt) &&
		scheduledAt > 0 &&
		typeof firedAt === "number" &&
		Number.isSafeInteger(firedAt) &&
		firedAt > 0
	);
}

// Rivet appends ScheduledFireInfo after the configured action arguments. Keep
// this parse strict so an application action cannot impersonate an alarm fire.
// https://github.com/rivet-dev/actors/blob/0ed739a2e9ac989a707ceba1255674675f510e33/rivetkit-typescript/packages/rivetkit/src/registry/native.ts#L5302-L5337
function parseDurableObjectAlarmInvocation(args: unknown[]): {
	fire: RivetScheduledFireInfo;
	record: DurableObjectAlarmRecord;
	retryCount: number;
} {
	const [scheduledTime, token, retryCount, fire] = args;
	if (
		args.length !== 4 ||
		typeof scheduledTime !== "number" ||
		!Number.isSafeInteger(scheduledTime) ||
		scheduledTime <= 0 ||
		typeof token !== "string" ||
		token.length === 0 ||
		typeof retryCount !== "number" ||
		!Number.isSafeInteger(retryCount) ||
		!isScheduledFireInfo(fire)
	) {
		throw new TypeError(
			"RivetKit dispatched an invalid Durable Object alarm action",
		);
	}
	return {
		fire,
		record: { scheduledTime, token },
		retryCount,
	};
}

// Rivet invokes onSleep before hibernating a generation and onDestroy before
// permanently destroying one; both must revoke generation-scoped capabilities.
// https://github.com/rivet-dev/actors/blob/512d245b8dc28234e1b029747c9284f06be964dc/rivetkit-typescript/packages/rivetkit/src/registry/native.ts#L4696-L4728

// Orange registers a keepAwake lifetime for every user socket, including one from
// acceptWebSocket(), because Rivet's hibernation is off. Internal Cap'n Web sessions
// already keep their callback active. Connection state stays native.
// https://github.com/rivet-dev/actors/blob/512d245b8dc28234e1b029747c9284f06be964dc/rivetkit-typescript/packages/rivetkit/src/actor/config.ts#L1233-L1243
// https://github.com/rivet-dev/actors/blob/3848076c011ad2f881bca9821e4d5c725aa9f15e/rivetkit-typescript/packages/rivetkit/src/registry/native.ts#L3478-L3497
// https://github.com/rivet-dev/actors/blob/3848076c011ad2f881bca9821e4d5c725aa9f15e/rivetkit-typescript/packages/rivetkit/src/registry/native.ts#L3305-L3323

export type DurableObjectActorDefinition = ReturnType<
	typeof createActorDefinition
>;

export interface DurableObjectActorRegistration {
	actorName: string;
	className: string;
	definition: DurableObjectActorDefinition;
	migrationTag?: string;
	storageBackend: "sqlite";
	userClass: ConfiguredDurableObjectClass;
}

export function createDurableObjectActorDefinitions(
	options: CreateDurableObjectActorDefinitionsOptions,
): ReadonlyMap<string, DurableObjectActorRegistration> {
	const bindings = options.bindings ?? {};
	const routes = options.routes ?? defaultRouteHandlers;
	const registrations = new Map<string, DurableObjectActorRegistration>();
	if (options.classStorage !== undefined) {
		for (const className of options.classStorage.keys()) {
			if (!options.classes.has(className)) {
				throw new Error(
					`SQLite migration references undiscovered Durable Object class ${className}`,
				);
			}
		}
	}
	for (const [className, userClass] of options.classes) {
		const storage = options.classStorage?.get(className);
		if (options.classStorage !== undefined && storage === undefined) {
			throw new Error(
				`Durable Object class ${className} is missing its applied storage migration`,
			);
		}
		const actorName = durableObjectActorName(
			options.deploymentIdentity,
			className,
		);
		if (registrations.has(actorName)) {
			throw new Error(`Duplicate Durable Object actor name ${actorName}`);
		}
		registrations.set(actorName, {
			actorName,
			className,
			definition: createActorDefinition(
				bindings,
				options.facetHost,
				routes,
				durableObjectClassShape(
					className,
					options.displayNames?.get(className) ?? className,
					options.deploymentIdentity,
					storage,
					userClass,
				),
			),
			...(storage === undefined
				? {}
				: { migrationTag: storage.migrationTag }),
			storageBackend: storage?.storageBackend ?? "sqlite",
			userClass,
		});
	}
	return registrations;
}

export interface CreateDurableObjectFacetActorDefinitionOptions {
	bindings?: Readonly<Record<string, unknown>>;
	facetHost: DurableObjectFacetHost;
	routes?: DurableObjectRouteHandlers;
}

/** The one actor definition that hosts every Durable Object facet of a deployment. */
export function createDurableObjectFacetActorDefinition(
	options: CreateDurableObjectFacetActorDefinitionOptions,
): Pick<DurableObjectActorRegistration, "actorName" | "definition"> {
	return {
		actorName: options.facetHost.actorName,
		definition: createActorDefinition(
			options.bindings ?? {},
			options.facetHost,
			options.routes ?? defaultRouteHandlers,
			durableObjectFacetShape(options.facetHost),
		),
	};
}
