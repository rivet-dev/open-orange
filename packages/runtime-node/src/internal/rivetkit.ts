import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { fetch as undiciFetch, type RequestInit } from "undici";

import { rivetGatewayCredential, rivetToken } from "./rivet-credentials.js";
import { durableStreamActorName } from "./durable-stream.js";
import { servicesPoolName, startServices, type ServicesProcess } from "./services-process.js";
import {
	assertPinnedRivetKitBuild,
	type InstalledRivetKitBuild,
} from "./rivetkit-build.js";
import { isRecord } from "../bindings/unknown-values.js";

export interface RivetWebSocket {
	addEventListener(
		type: string,
		listener: (event: unknown) => void | Promise<void>,
	): void;
	binaryType: "arraybuffer" | "blob";
	close(code?: number, reason?: string): void;
	readonly readyState: number;
	removeEventListener(
		type: string,
		listener: (event: unknown) => void | Promise<void>,
	): void;
	send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void;
}

export interface RivetActorConnection {
	readonly id: string;
	readonly isHibernatable: boolean;
	state: unknown;
}

export type RivetSqliteBindings = unknown[] | Record<string, unknown>;

export interface RivetSqliteExecuteResult {
	columns: string[];
	rows: unknown[][];
	changes: number;
	lastInsertRowId?: number | null;
}

export interface RivetSynchronousSqliteExecutor {
	execSync(
		sql: string,
		callback?: (row: unknown[], columns: string[]) => void,
	): void;
	executeSync(
		sql: string,
		params?: RivetSqliteBindings,
	): RivetSqliteExecuteResult;
}

export interface RivetSynchronousSqliteTransaction
	extends RivetSynchronousSqliteExecutor {
	commitSync(): void;
	rollbackSync(): void;
}

export interface RivetSqliteDatabase extends RivetSynchronousSqliteExecutor {
	beginTransactionSync(
		timeoutMs?: number,
		name?: string,
	): RivetSynchronousSqliteTransaction;
	/** Ticket of the latest local commit. Synchronous writes return before they are durable. */
	commitTicket(): number;
	/** Resolves once `ticket` and every earlier commit are durable. Rejects once the database broke. */
	whenDurable(ticket: number): Promise<void>;
	/** Restarts the actor from durable state; every later write fails. */
	abortGeneration?(reason: string): void;
}

export interface RivetNativeDatabaseProvider {
	open(actorId: string): Promise<RivetSqliteDatabase>;
}

export interface RivetDatabaseProviderContext {
	actorId: string;
	nativeDatabaseProvider?: RivetNativeDatabaseProvider;
}

// RivetKit opens an actor's SQLite in deferred-commit mode only when its database provider carries
// this symbol. Deferred commits return before writes are durable, which is safe here because the
// Durable Object output gate waits on `whenDurable()`. Other actors keep durable-on-return commits.
// https://github.com/rivet-dev/rivet/blob/a00b07f483aa3fb07ab403614bcb79d7a8be0322/rivetkit-typescript/packages/rivetkit/src/registry/native.ts#L4020-L4046
export const rivetSqliteDeferredCommits = Symbol.for(
	"rivetkit.sqlite.deferredCommits",
);

export interface RivetDatabaseProvider {
	readonly [rivetSqliteDeferredCommits]?: true;
	createClient(
		context: RivetDatabaseProviderContext,
	): Promise<RivetSqliteDatabase>;
	onMigrate(client: RivetSqliteDatabase): void | Promise<void>;
}

export interface RivetActorRequestContext {
	actorId?: string;
	conn?: RivetActorConnection;
	conns?: ReadonlyMap<string, RivetActorConnection>;
	db?: RivetSqliteDatabase;
	destroy?(): void;
	keepAwake?<Value>(promise: Promise<Value>): Promise<Value>;
	key?: string[];
	request?: Request;
	schedule?: RivetActorSchedule;
	sleep?(): void;
	vars: unknown;
	waitUntil?(promise: Promise<unknown>): void;
}

export interface RivetScheduledEventInfo {
	action: string;
	args: unknown[];
	id: string;
	runAt: number;
}

export interface RivetScheduledFireInfo {
	firedAt: number;
	id: string;
	kind: "at" | "cron" | "every";
	name?: string;
	scheduledAt: number;
}

export interface RivetActorSchedule {
	at(timestamp: number, action: string, ...args: unknown[]): Promise<string>;
	cancel(id: string): Promise<boolean>;
	list(): Promise<RivetScheduledEventInfo[]>;
}

export interface RivetCronSetOptions {
	action: string;
	args?: unknown[];
	expression: string;
	name: string;
	timezone?: string;
}

export interface RivetCronJobInfo {
	name: string;
	nextRunAt: number;
}

// RivetKit cron jobs. A due job calls `action` with `args` and then a
// RivetScheduledFireInfo of kind "cron".
// https://github.com/rivet-dev/rivet/blob/a00b07f483aa3fb07ab403614bcb79d7a8be0322/rivetkit-typescript/packages/rivetkit/src/actor/config.ts#L125-L153
// https://github.com/rivet-dev/rivet/blob/a00b07f483aa3fb07ab403614bcb79d7a8be0322/rivetkit-typescript/packages/rivetkit/src/registry/native.ts#L5556-L5571
export interface RivetActorCron {
	delete(name: string): Promise<boolean>;
	list(): Promise<RivetCronJobInfo[]>;
	set(options: RivetCronSetOptions): Promise<void>;
}

export type RivetActorAction = (
	context: RivetActorRequestContext,
	...args: unknown[]
) => unknown | Promise<unknown>;

export interface RivetActorDefinitionInput {
	actions: Readonly<Record<string, RivetActorAction>>;
	db: RivetDatabaseProvider;
	createVars(context?: RivetActorRequestContext): unknown | Promise<unknown>;
	onRequest(
		context: RivetActorRequestContext,
		request: Request,
	): Response | Promise<Response>;
	onDestroy?(context: RivetActorRequestContext): void | Promise<void>;
	onDisconnect?(
		context: RivetActorRequestContext,
		connection: RivetActorConnection,
	): void | Promise<void>;
	onSleep?(context: RivetActorRequestContext): void | Promise<void>;
	onWebSocket(
		context: RivetActorRequestContext,
		webSocket: RivetWebSocket,
	): void | Promise<void>;
	// Runs once, when the actor is created with its input, before createVars.
	onCreate?(context: RivetActorRequestContext, input: unknown): Promise<void>;
	// Runs once instead of onCreate, when the actor is a fork of another actor, before createVars.
	onFork?(context: RivetActorRequestContext, fork: RivetActorFork): Promise<void>;
	options: {
		actionTimeout?: number;
		canHibernateWebSocket: boolean;
		createVarsTimeout?: number;
		name?: string;
		sleepTimeout?: number;
	};
}

// Rivet runs cron and alarm fires as actions. Its default 60 second action timeout rejects the
// fire without stopping the handler, and the actor can then sleep and close its database under
// it. Orange sets no limit on these handlers, so this is the largest timeout a timer can hold.
export const unlimitedActionTimeoutMs = 2 ** 31 - 1;

/** The fork that a forked actor's `onFork` runs for. */
export interface RivetActorFork {
	/** The source actor's ID. */
	readonly actorId: string;
	/** The `input` passed to the fork. It comes from the caller, so validate it. */
	readonly input: unknown;
}

export interface RivetActorDefinition {
	readonly config: {
		readonly actions: Readonly<Record<string, unknown>>;
		readonly createVars: RivetActorDefinitionInput["createVars"];
		readonly db: RivetActorDefinitionInput["db"];
		readonly onRequest: RivetActorDefinitionInput["onRequest"];
		readonly onDestroy?: RivetActorDefinitionInput["onDestroy"];
		readonly onDisconnect?: RivetActorDefinitionInput["onDisconnect"];
		readonly onSleep?: RivetActorDefinitionInput["onSleep"];
		readonly onWebSocket: RivetActorDefinitionInput["onWebSocket"];
		readonly options: RivetActorDefinitionInput["options"];
	};
}

// A message that `nextBatch({ completable: true })` returned. It stays in the
// actor's queue storage until `complete()` resolves.
export interface RivetCompletableQueueMessage {
	readonly body: unknown;
	readonly name: string;
	complete(): Promise<void>;
}

export interface RivetActorQueue {
	nextBatch(options: {
		completable: true;
		count: number;
		names: readonly string[];
		signal?: AbortSignal;
		timeout?: number;
	}): Promise<RivetCompletableQueueMessage[]>;
	send(name: string, body: unknown): Promise<unknown>;
	waitForAvailable(
		names: readonly string[],
		options?: { signal?: AbortSignal },
	): Promise<void>;
}

// RivetKit's raw SQLite client from `rivetkit/db`. `execute` binds positional `?` parameters.
export interface RivetRawDatabase {
	execute(query: string, ...args: unknown[]): Promise<Record<string, unknown>[]>;
	transaction<T>(callback: (tx: RivetRawDatabase) => Promise<T> | T): Promise<T>;
}

export type RivetRawDatabaseProvider = object;

export interface RivetInternalActorSchedule {
	after(durationMs: number, action: string, ...args: unknown[]): Promise<string>;
}

// The context RivetKit passes to the actions and the `run` handler of an
// OpenOrange internal actor.
export interface RivetInternalActorContext<State = Record<string, unknown>> {
	readonly abortSignal: AbortSignal;
	readonly cron: RivetActorCron;
	// Present when the definition sets `db`.
	readonly db: RivetRawDatabase;
	// Destroys the actor after the current action returns.
	destroy(): void;
	readonly key: readonly string[];
	readonly queue: RivetActorQueue;
	readonly schedule: RivetInternalActorSchedule;
	state: State;
}

export type RivetInternalActorAction<State = Record<string, unknown>> = (
	context: RivetInternalActorContext<State>,
	...args: unknown[]
) => unknown;

// Internal actors are plain RivetKit actors that OpenOrange defines itself,
// without the Durable Object shim. They use RivetKit features the shim does not
// expose, such as `run` loops, actor queues, and cron jobs.
export interface RivetInternalActorDefinitionInput<State> {
	actions: Readonly<Record<string, RivetInternalActorAction<State>>>;
	createState?(context: unknown, input: unknown): State | Promise<State>;
	db?: RivetRawDatabaseProvider;
	// Runs once, when the actor is created with its input.
	onCreate?(context: RivetInternalActorContext<State>, input: unknown): Promise<void>;
	options?: {
		actionTimeout?: number;
		sleepTimeout?: number;
		maxQueueMessageSize?: number;
		maxQueueSize?: number;
		maxSchedules?: number;
		name?: string;
	};
	queues?: Readonly<Record<string, object>>;
	run?(context: RivetInternalActorContext<State>): Promise<void>;
}

export interface RivetInternalActorDefinition {
	readonly config: {
		readonly actions: Readonly<Record<string, unknown>>;
	};
}

export interface RivetRegistry {
	// RivetKit's Prometheus metrics for this runner.
	prometheusMetrics(): Promise<Response>;
	shutdown(): Promise<void>;
	startAndWait(): Promise<void>;
}

// The registry that the pinned RivetKit's `setup()` returns.
interface RivetKitRegistry {
	routes: { prometheusMetrics(request?: Request): Promise<Response> };
	shutdown(): Promise<void>;
	startAndWait(): Promise<void>;
}

// The methods of the pinned RivetKit `ActorHandleRaw` that Orange calls. Orange
// keeps this narrow view because importing RivetKit's declarations pulls in its
// wasm and Standard Schema types. The pinned webSocket() returns a standard WebSocket.
// https://github.com/rivet-dev/rivet/blob/a00b07f483aa3fb07ab403614bcb79d7a8be0322/rivetkit-typescript/packages/rivetkit/src/client/actor-handle.ts
export interface RivetActorHandle {
	action(options: { args: unknown[]; name: string }): Promise<unknown>;
	fetch(request: Request): Promise<Response>;
	webSocket(path: string): Promise<RivetWebSocket>;
}

// Rivet stateless handles route fetch() and webSocket() to the same resolved
// actor query, which lets Orange keep both private RPC transports actor-local.
// https://github.com/rivet-dev/actors/blob/512d245b8dc28234e1b029747c9284f06be964dc/rivetkit-typescript/packages/rivetkit/src/client/actor-handle.ts#L618-L700
// https://github.com/rivet-dev/actors/blob/512d245b8dc28234e1b029747c9284f06be964dc/rivetkit-typescript/packages/rivetkit/src/client/actor-handle.ts#L902-L925

export interface RivetActorClient {
	// Creates the actor and fails when one with this key already exists.
	create(
		actorName: string,
		key: readonly string[],
		input?: unknown,
	): Promise<RivetActorHandle>;
	dispose(): Promise<void>;
	/**
	 * Whether an actor has the key, without creating one. A call through `get()` to a missing
	 * actor retries for seconds before it fails; this answers in one request.
	 */
	exists(actorName: string, key: readonly string[]): Promise<boolean>;
	/**
	 * Forks the actor `sourceActorId` to a new actor with `key`, and returns its ID. The new actor
	 * starts on a copy of the source's storage as of its last durable commit and runs `onFork` with
	 * `input`. A key that is in use fails with `actor.duplicate_key`.
	 */
	fork(
		actorName: string,
		sourceActorId: string,
		key: readonly string[],
		input: unknown,
	): Promise<string>;
	/** The ID of the actor with the key. Fails with `actor.not_found` when none has it. */
	resolve(actorName: string, key: readonly string[]): Promise<string>;
	// Looks up an existing actor. Calls through the handle fail when it does not exist.
	get(actorName: string, key: readonly string[]): RivetActorHandle;
	getOrCreate(
		actorName: string,
		key: readonly string[],
		createWithInput?: unknown,
	): RivetActorHandle;
}

export interface CreateRivetActorClientOptions {
	endpoint: string;
	namespace: string;
	// The envoy pool that creates new actors. Defaults to RivetKit's default pool.
	poolName?: string;
}

export interface CreateRivetRegistryOptions {
	installedBuild?: InstalledRivetKitBuild;
	engineHost: string;
	enginePort: number;
	// An external Engine, such as `https://<namespace>:<token>@api.rivet.dev`.
	// With it, the registry starts no local Engine.
	endpoint?: string;
	namespace: string;
	// The envoy pool that serves this registry's actors.
	poolName?: string;
	// Start Rivet Services, which hosts Durable Streams, beside the local Engine.
	services?: { binaryPath: string; logDirectory: string };
	use: Readonly<
		Record<string, RivetActorDefinition | RivetInternalActorDefinition>
	>;
}

// The runtime takes RIVET_TOKEN out of the environment, so RivetKit gets it explicitly.
function tokenOption(): { token?: string } {
	const token = rivetToken();
	return token === undefined ? {} : { token };
}

function gatewayTokenOption(): { token?: string } {
	const token = rivetGatewayCredential();
	return token === undefined ? {} : { token };
}

// RivetKit rejects a namespace option when the endpoint URL already names one.
function namespaceOption(
	endpoint: string | undefined,
	namespace: string,
): { namespace?: string } {
	return endpoint !== undefined && new URL(endpoint).username.length > 0 ? {} : { namespace };
}

// The exports of the pinned RivetKit build that Orange calls. RivetKit's own
// declarations are generic over actor schemas, so Orange keeps these narrow views.
interface RivetKitModule {
	actor(input: RivetActorDefinitionInput): RivetActorDefinition;
	actor<State>(
		input: RivetInternalActorDefinitionInput<State>,
	): RivetInternalActorDefinition;
	setup(options: Record<string, unknown>): RivetKitRegistry;
}

interface RivetKitDbModule {
	db(options: {
		onMigrate(database: RivetRawDatabase): Promise<void>;
	}): RivetRawDatabaseProvider;
}


interface RivetKitClient {
	create(
		actorName: string,
		key: string[],
		options?: { input: unknown },
	): Promise<RivetActorHandle>;
	dispose(): Promise<void>;
	fork(
		actorName: string,
		actorId: string,
		options: { input: unknown; key: string[] },
	): Promise<{ resolve(): Promise<string> }>;
	get(actorName: string, key: string[]): RivetActorHandle & { resolve(): Promise<string> };
	getOrCreate(
		actorName: string,
		key: string[],
		options?: { createWithInput: unknown },
	): RivetActorHandle;
}

interface RivetKitClientModule {
	createClient(options: Record<string, unknown>): RivetKitClient;
}

const requireFromOrange = createRequire(import.meta.url);
const hostNavigatorDescriptor = Object.getOwnPropertyDescriptor(
	globalThis,
	"navigator",
);

function loadRivetKitSpecifier<Module>(specifier: string): Module {
	const workerNavigatorDescriptor = Object.getOwnPropertyDescriptor(
		globalThis,
		"navigator",
	);
	try {
		if (hostNavigatorDescriptor === undefined) {
			Reflect.deleteProperty(globalThis, "navigator");
		} else {
			Object.defineProperty(globalThis, "navigator", hostNavigatorDescriptor);
		}
		// SAFETY: assertPinnedRivetKitBuild() checked that the installed RivetKit is the pinned
		// build, and the Module views above describe that build's exports. require() is untyped.
		return requireFromOrange(specifier) as Module;
	} finally {
		if (workerNavigatorDescriptor === undefined) {
			Reflect.deleteProperty(globalThis, "navigator");
		} else {
			Object.defineProperty(globalThis, "navigator", workerNavigatorDescriptor);
		}
	}
}

let actorWebSocketsUseWs = false;

// RivetKit's client opens one WebSocket to the gateway for each Durable Object WebSocket. It uses
// the global WebSocket when there is one, and the `ws` package otherwise, and it decides once.
// Measured on Node.js 24.21 with 2,000 idle connections: the built-in WebSocket holds 35.6 KB of
// heap for each connection, and `ws` holds 3.6 KB. So RivetKit decides here, while the global is
// hidden. The loader is `dist/tsup/common/websocket.cjs`, which is not a package export, so its
// file is found beside the client's. With a RivetKit build that has no such file, RivetKit keeps
// the built-in WebSocket: everything works, each socket holds more memory, and Orange warns once.
// https://github.com/rivet-dev/rivet/blob/a00b07f483aa3fb07ab403614bcb79d7a8be0322/rivetkit-typescript/packages/rivetkit/src/common/websocket.ts
function useWsForActorWebSockets(): void {
	if (actorWebSocketsUseWs) return;
	actorWebSocketsUseWs = true;
	const fallBack = (reason: string): void => {
		console.warn(
			`[open-orange] RivetKit opens Durable Object WebSockets with the built-in WebSocket, which holds about 10 times more memory for each socket than \`ws\`: ${reason}`,
		);
	};
	let importWebSocket: unknown;
	try {
		const clientEntrypoint = requireFromOrange.resolve("rivetkit/client");
		// RivetKit resolves `ws` from its own files. Without it, the client would have no WebSocket.
		createRequire(clientEntrypoint).resolve("ws");
		const loader: unknown = requireFromOrange(
			join(dirname(clientEntrypoint), "..", "common", "websocket.cjs"),
		);
		importWebSocket = isRecord(loader) ? loader.importWebSocket : undefined;
	} catch (error: unknown) {
		fallBack(error instanceof Error ? error.message : String(error));
		return;
	}
	if (typeof importWebSocket !== "function") {
		fallBack("RivetKit's WebSocket loader has no importWebSocket()");
		return;
	}
	const descriptor = Object.getOwnPropertyDescriptor(globalThis, "WebSocket");
	if (descriptor !== undefined && !Reflect.deleteProperty(globalThis, "WebSocket")) {
		fallBack("the global WebSocket cannot be hidden");
		return;
	}
	try {
		// The loader reads the global before its first await.
		void Promise.resolve(Reflect.apply(importWebSocket, undefined, [])).catch(() => {});
	} finally {
		if (descriptor !== undefined) Object.defineProperty(globalThis, "WebSocket", descriptor);
	}
}

function loadRivetKitPackage(): RivetKitModule {
	assertPinnedRivetKitBuild();
	return loadRivetKitSpecifier("rivetkit");
}

// Rivet's gateway authenticates every call to an Orange actor with the caller's Rivet token
// and its grants, so Orange actors accept any caller that the gateway admits.
export function createRivetActorDefinition(
	input: RivetActorDefinitionInput,
): RivetActorDefinition {
	return loadRivetKitPackage().actor(input);
}

export function createRivetInternalActorDefinition<State = Record<string, unknown>>(
	input: RivetInternalActorDefinitionInput<State>,
): RivetInternalActorDefinition {
	return loadRivetKitPackage().actor(input);
}

// A raw SQLite provider for an internal actor. `migrate` runs on every actor start, so it must
// be idempotent.
export function createRivetRawDatabaseProvider(
	migrate: (database: RivetRawDatabase) => Promise<void>,
): RivetRawDatabaseProvider {
	assertPinnedRivetKitBuild();
	return loadRivetKitSpecifier<RivetKitDbModule>("rivetkit/db").db({ onMigrate: migrate });
}


export function createRivetRegistry(
	options: CreateRivetRegistryOptions,
): RivetRegistry {
	assertPinnedRivetKitBuild(options.installedBuild);
	const registry = loadRivetKitSpecifier<RivetKitModule>("rivetkit").setup({
			...(options.endpoint === undefined
				? {
						engineHost: options.engineHost,
						enginePort: options.enginePort,
						startEngine: true,
						...tokenOption(),
					}
				: {
						endpoint: options.endpoint,
						startEngine: false,
						// The runtime took RIVET_TOKEN out of the environment, so RivetKit cannot read it.
						...(new URL(options.endpoint).password.length > 0 ? {} : tokenOption()),
					}),
			// RivetKit 3 reads the pool under `node` and silently drops the 2.x `envoy` key.
			...(options.poolName === undefined ? {} : { node: { poolName: options.poolName } }),
			...namespaceOption(options.endpoint, options.namespace),
			noWelcome: true,
			// Orange starts Services itself, as it starts the Engine (see services-process.ts).
			startServices: false,
			shutdown: {
				disableSignalHandlers: true,
				gracePeriodMs: 5_000,
			},
			// RivetKit's 64 KiB default caps an action request, such as a Queues sendBatch(). The
			// Engine takes at most 32 MiB in one message from a runner, so that is the cap.
			// https://github.com/rivet-dev/actors/blob/cf8679c670bc1e0e22252a6daf0523b9a1771ed6/engine/packages/pegboard-envoy/src/routes.rs#L186
			maxIncomingMessageSize: 32 * 1024 * 1024,
			// "local" runs SQLite in this process and stores its pages in the Engine,
			// so the data survives a runner that restarts on an empty disk.
			sqlite: "local",
			use: options.use,
		});
	let services: ServicesProcess | undefined;
	const engineHost = options.engineHost.includes(":")
		? `[${options.engineHost}]`
		: options.engineHost;
	return {
		prometheusMetrics: () => registry.routes.prometheusMetrics(),
		async shutdown(): Promise<void> {
			try {
				await registry.shutdown();
			} finally {
				await services?.stop();
			}
		},
		async startAndWait(): Promise<void> {
			if (options.endpoint !== undefined) {
				await registry.startAndWait();
				return;
			}
			const startedAt = Date.now();
			const endpoint = `http://${engineHost}:${options.enginePort}`;
			// Services boots while the registry starts.
			services =
				options.services === undefined
					? undefined
					: startServices({
							...options.services,
							endpoint,
							namespace: options.namespace,
							token: rivetToken() ?? "default",
						});
			try {
				await Promise.all([registry.startAndWait(), services?.ready]);
			} catch (error: unknown) {
				await services?.stop();
				throw error;
			}
			if (services !== undefined) {
				// Streams of a Services process that a crash or a kill ended stay routed to it until
				// the Engine's lost threshold passes, as Orange's own actors do.
				await sleepActorsOfExitedHosts({
					actorNames: [durableStreamActorName],
					endpoint,
					namespace: options.namespace,
					poolName: servicesPoolName,
					startedAt,
				});
			}
			await sleepActorsOfExitedHosts({
				actorNames: Object.keys(options.use),
				endpoint: `http://${engineHost}:${options.enginePort}`,
				namespace: options.namespace,
				// RivetKit resolves the envoy pool the same way when none is given.
				poolName: options.poolName ?? process.env.RIVET_POOL ?? "default",
				startedAt,
			});
		},
	};
}

interface SleepActorsOfExitedHostsOptions {
	actorNames: readonly string[];
	endpoint: string;
	namespace: string;
	poolName: string;
	startedAt: number;
}

// The local Engine outlives `orange dev`. When an earlier `orange dev` exited without a
// graceful shutdown, for example after SIGKILL, the Engine keeps routing its running actors
// to that dead envoy until the envoy lost threshold passes. Requests in that window fail
// after the gateway's retry budget. A sleeping actor is not routed to an envoy, so its next
// request waits for the Engine to restart it on this process's envoy instead.
// Only actors of this process's envoy pool are swept. In a multi-Worker session, actors
// with the same name in another Worker's pool run on that Worker's live envoy.
async function sleepActorsOfExitedHosts(
	options: SleepActorsOfExitedHostsOptions,
): Promise<void> {
	// RivetKit authenticates to a local Engine with RIVET_TOKEN or the token `default`.
	const authorization = `Bearer ${rivetToken() ?? "default"}`;
	const staleActorIds: string[] = [];
	for (const name of options.actorNames) {
		let cursor: string | undefined;
		do {
			const url = new URL("/actors", options.endpoint);
			url.searchParams.set("namespace", options.namespace);
			url.searchParams.set("name", name);
			if (cursor !== undefined) url.searchParams.set("cursor", cursor);
			const page = parseEngineActorPage(
				await requestEngineApi(url, { headers: { authorization } }),
			);
			for (const actor of page.actors) {
				// Actors that this process's envoy started became connectable after startup.
				if (
					actor.pool === options.poolName &&
					actor.connectableTs !== null &&
					actor.connectableTs < options.startedAt
				) {
					staleActorIds.push(actor.actorId);
				}
			}
			cursor = page.actors.length > 0 ? page.cursor : undefined;
		} while (cursor !== undefined);
	}
	await Promise.all(
		staleActorIds.map(async (actorId) => {
			const url = new URL(
				`/actors/${encodeURIComponent(actorId)}/sleep`,
				options.endpoint,
			);
			url.searchParams.set("namespace", options.namespace);
			await requestEngineApi(url, {
				body: "{}",
				headers: { authorization, "content-type": "application/json" },
				method: "POST",
			});
		}),
	);
}

interface EngineActor {
	actorId: string;
	connectableTs: number | null;
	pool: string;
}

interface EngineActorPage {
	actors: EngineActor[];
	cursor: string | undefined;
}

function parseEngineActorPage(page: unknown): EngineActorPage {
	const actors = isRecord(page) ? page.actors : undefined;
	const pagination = isRecord(page) ? page.pagination : undefined;
	if (!Array.isArray(actors) || !isRecord(pagination)) {
		throw new Error("The Rivet Engine returned an invalid actor list");
	}
	return {
		actors: actors.map(parseEngineActor),
		cursor: typeof pagination.cursor === "string" ? pagination.cursor : undefined,
	};
}

function parseEngineActor(actor: unknown): EngineActor {
	if (
		!isRecord(actor) ||
		typeof actor.actor_id !== "string" ||
		typeof actor.pool !== "string" ||
		(actor.connectable_ts !== null && typeof actor.connectable_ts !== "number")
	) {
		throw new Error("The Rivet Engine returned an invalid actor");
	}
	return {
		actorId: actor.actor_id,
		connectableTs: actor.connectable_ts,
		pool: actor.pool,
	};
}

// The Engine's depot answers `unavailable` or `overloaded` while it cannot open a volume yet, and
// opens it again after a backoff of up to 5 s. Both callers read or put an actor to sleep, so they
// can send the same request again.
// https://github.com/rivet-dev/rivet/blob/e5ed3911ebff8ddc35c08b3f6c6eb3f795d042f9/engine/packages/depot-worker/src/command/volume_host.rs#L400-L407
// https://github.com/rivet-dev/rivet/blob/e5ed3911ebff8ddc35c08b3f6c6eb3f795d042f9/engine/packages/depot-worker/src/command/volume_host.rs#L474-L494
const engineStorageRetryMs = 20_000;

async function requestEngineApi(url: URL, init: RequestInit): Promise<unknown> {
	const deadline = Date.now() + engineStorageRetryMs;
	for (let attempt = 0; ; attempt++) {
		const response = await undiciFetch(url, init);
		if (response.ok) return response.json();
		const text = await response.text();
		if (!isTransientEngineStorageError(text) || Date.now() > deadline) {
			throw new Error(
				`Rivet Engine request ${init.method ?? "GET"} ${url.pathname} failed with status ${response.status}: ${text}`,
			);
		}
		await delay(Math.min(100 * 2 ** attempt, 2_000));
	}
}

function isTransientEngineStorageError(body: string): boolean {
	try {
		const error: unknown = JSON.parse(body);
		return isRecord(error) && error.group === "depot" && (error.code === "unavailable" || error.code === "overloaded");
	} catch {
		return false;
	}
}

export function createRivetActorClient(
	options: CreateRivetActorClientOptions,
): RivetActorClient {
	assertPinnedRivetKitBuild();
	// Gateway calls that are in flight when the client is disposed, or that Worker code starts
	// afterwards, fail at once. The local Engine waits for every open gateway call before it exits,
	// so one call that never ends would hold `orange dev` until the Engine's forced shutdown.
	const disposed = new AbortController();
	useWsForActorWebSockets();
	const client = loadRivetKitSpecifier<RivetKitClientModule>("rivetkit/client").createClient({
		devtools: false,
		disableMetadataLookup: true,
		encoding: "bare",
		endpoint: options.endpoint,
		fetch: (...[input, init]: Parameters<typeof globalThis.fetch>) =>
			globalThis.fetch(input, {
				...init,
				signal:
					init?.signal == null
						? disposed.signal
						: AbortSignal.any([init.signal, disposed.signal]),
			}),
		...namespaceOption(options.endpoint, options.namespace),
		...(new URL(options.endpoint).password.length > 0 ? {} : gatewayTokenOption()),
		...(options.poolName === undefined ? {} : { poolName: options.poolName }),
	});
	return {
		create: async (actorName, key, input) =>
			client.create(actorName, [...key], ...(input === undefined ? [] : [{ input }])),
		dispose: async () => {
			disposed.abort(new Error("The OpenOrange runtime stopped"));
			await client.dispose();
		},
		exists: async (actorName, key) => {
			try {
				await client.get(actorName, [...key]).resolve();
				return true;
			} catch (error: unknown) {
				if (isRivetActorNotFound(error)) return false;
				throw error;
			}
		},
		fork: async (actorName, sourceActorId, key, input) =>
			await (await client.fork(actorName, sourceActorId, { input, key: [...key] })).resolve(),
		get: (actorName, key) => client.get(actorName, [...key]),
		resolve: async (actorName, key) => await client.get(actorName, [...key]).resolve(),
		getOrCreate: (actorName, key, createWithInput) =>
			client.getOrCreate(
				actorName,
				[...key],
				...(createWithInput === undefined ? [] : [{ createWithInput }]),
			),
	};
}

// RivetKit's client rejects a call through `get()` with this error when no
// actor has the key.
export function isRivetActorNotFound(error: unknown): boolean {
	return rivetActorErrorCode(error) === "not_found";
}

/** Whether the Engine's storage refused a request for now, such as during a volume transition. */
export function isRivetStorageOverloaded(error: unknown): boolean {
	return (
		error instanceof Error &&
		Reflect.get(error, "group") === "depot" &&
		Reflect.get(error, "code") === "overloaded"
	);
}

/** The code of a RivetKit `actor.*` error, such as `duplicate_key` or `fork_too_deep`. */
export function rivetActorErrorCode(error: unknown): string | undefined {
	if (!(error instanceof Error) || Reflect.get(error, "group") !== "actor") return undefined;
	const code: unknown = Reflect.get(error, "code");
	return typeof code === "string" ? code : undefined;
}
