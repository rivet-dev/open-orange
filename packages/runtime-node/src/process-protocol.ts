export interface RuntimeSecretsStoreBinding {
	binding: string;
	secretName: string;
	storeId: string;
	type: "secrets_store_secret";
}

export interface RuntimeVersionMetadataBinding {
	binding: string;
	type: "version_metadata";
}

// A service binding to one of this Worker's own entrypoints, or to another
// Worker of the `orange dev` session when `service` names it.
export interface RuntimeServiceBinding {
	binding: string;
	entrypoint?: string;
	props?: unknown;
	service?: string;
	type: "service";
}

// `env.LOADER` for a `worker_loaders` entry: loads dynamic Workers at runtime.
export interface RuntimeWorkerLoaderBinding {
	binding: string;
	type: "worker_loader";
}

// A Durable Object namespace whose class another Worker exports (`script_name`).
export interface RuntimeDurableObjectNamespaceBinding {
	binding: string;
	className: string;
	scriptName: string;
	type: "durable_object_namespace";
}

// A Workers for Platforms dispatch namespace. `get(name)` calls the Worker of
// the `orange dev` session with that name.
export interface RuntimeDispatchNamespaceBinding {
	binding: string;
	namespace: string;
	type: "dispatch_namespace";
}

export interface RuntimeUnsafeEvalBinding {
	binding: string;
	type: "unsafe_eval";
}

export interface RuntimePlainTextBinding {
	binding: string;
	type: "plain_text";
	value: string;
}

export interface RuntimeJsonBinding {
	binding: string;
	type: "json";
	value: unknown;
}

// `env.AI`: Workers AI on an OpenAI-compatible provider.
export interface RuntimeAiBinding {
	binding: string;
	type: "ai";
}

// `env.HYPERDRIVE`, connected straight to the database of `connectionString`.
export interface RuntimeHyperdriveBinding {
	binding: string;
	connectionString: string;
	type: "hyperdrive";
}

export interface RuntimeAnalyticsEngineBinding {
	binding: string;
	type: "analytics_engine";
}

// A KV namespace backed by an OpenOrange internal Durable Object. Bindings
// with the same namespace ID share data.
export interface RuntimeKvNamespaceBinding {
	binding: string;
	namespaceId: string;
	type: "kv_namespace";
}

// A D1 database backed by an OpenOrange internal Durable Object. Bindings with
// the same database ID share data.
export interface RuntimeD1DatabaseBinding {
	binding: string;
	databaseId: string;
	type: "d1";
}

// A Rate Limiting binding backed by an OpenOrange internal Durable Object.
// Bindings with the same namespace ID share counters.
export interface RuntimeRateLimitBinding {
	binding: string;
	namespaceId: string;
	simple: { limit: number; period: number };
	type: "ratelimit";
}

// An R2 bucket. It is backed by an OpenOrange internal Durable Object, or by an
// S3-compatible store when ORANGE_R2_<BUCKET>_S3_ENDPOINT is set. Bindings
// with the same bucket name share data.
export interface RuntimeR2BucketBinding {
	binding: string;
	bucketName: string;
	type: "r2_bucket";
}

// A Queues producer. Bindings with the same queue name send to one queue.
export interface RuntimeQueueBinding {
	binding: string;
	// The producer's `delivery_delay` in seconds.
	deliveryDelay?: number;
	queueName: string;
	type: "queue";
}

// A `queues.consumers` entry, with Cloudflare's defaults applied.
export interface RuntimeQueueConsumer {
	deadLetterQueue?: string;
	maxBatchSize: number;
	// Seconds.
	maxBatchTimeout: number;
	maxRetries: number;
	queueName: string;
	// Seconds.
	retryDelay: number;
}

// `env.ASSETS` for `assets.binding`: a Fetcher that serves the assets directory.
export interface RuntimeAssetsBinding {
	binding: string;
	type: "assets";
}

// A Workflow binding. Instances of the Workflow `name` run the exported
// `className` on the RivetKit workflow engine.
export interface RuntimeWorkflowBinding {
	binding: string;
	className: string;
	name: string;
	// The Worker of the session that runs the Workflow, when it is not this one.
	scriptName?: string;
	type: "workflow";
}

// A Browser Rendering binding. It reaches the Chrome DevTools Protocol endpoint in
// ORANGE_BROWSER_CDP_URL.
export interface RuntimeBrowserBinding {
	binding: string;
	type: "browser";
}

// A Send Email binding. It sends through the SMTP server in ORANGE_EMAIL_SMTP_URL, and only to
// and from the addresses that its configuration allows, as on Cloudflare.
export interface RuntimeSendEmailBinding {
	allowedDestinationAddresses?: string[];
	allowedSenderAddresses?: string[];
	binding: string;
	destinationAddress?: string;
	type: "send_email";
}

// A configured binding OpenOrange cannot back. `env[binding]` throws `message`
// when used.
export interface RuntimeUnsupportedBinding {
	binding: string;
	bindingType: string;
	message: string;
	type: "unsupported";
}

export type RuntimeBindingConfiguration =
	| RuntimeAiBinding
	| RuntimeAnalyticsEngineBinding
	| RuntimeAssetsBinding
	| RuntimeBrowserBinding
	| RuntimeD1DatabaseBinding
	| RuntimeDispatchNamespaceBinding
	| RuntimeDurableObjectNamespaceBinding
	| RuntimeHyperdriveBinding
	| RuntimeJsonBinding
	| RuntimeKvNamespaceBinding
	| RuntimePlainTextBinding
	| RuntimeRateLimitBinding
	| RuntimeR2BucketBinding
	| RuntimeQueueBinding
	| RuntimeSecretsStoreBinding
	| RuntimeSendEmailBinding
	| RuntimeServiceBinding
	| RuntimeUnsafeEvalBinding
	| RuntimeUnsupportedBinding
	| RuntimeVersionMetadataBinding
	| RuntimeWorkerLoaderBinding
	| RuntimeWorkflowBinding;

export interface RuntimeDurableObjectManifest {
	bindings: { binding: string; className: string }[];
	classes: {
		className: string;
		migrationTag: string;
		storageName?: string;
		storageBackend: "sqlite";
		container?: { images: Record<string, { reference: string; sandbox: boolean }> };
	}[];
	latestMigrationTag: string;
}

export type RuntimeAssetsHtmlHandling =
	| "auto-trailing-slash"
	| "drop-trailing-slash"
	| "force-trailing-slash"
	| "none";

export type RuntimeAssetsNotFoundHandling = "404-page" | "none" | "single-page-application";

// Wrangler's `assets` configuration, resolved like its router and asset
// Worker configuration.
export interface RuntimeAssetsConfiguration {
	// The absolute path of the assets directory.
	directory: string;
	// False for an assets-only Worker, which has no `main`.
	hasUserWorker: boolean;
	htmlHandling: RuntimeAssetsHtmlHandling;
	// `run_worker_first: true`.
	invokeUserWorkerAheadOfAssets: boolean;
	// The `assets_navigation_prefers_asset_serving` compatibility flag.
	navigationPrefersAssetServing: boolean;
	notFoundHandling: RuntimeAssetsNotFoundHandling;
	// `run_worker_first` route patterns. Negated `!/` patterns go to assets.
	staticRouting?: { assetWorker: string[]; userWorker: string[] };
}

// A Worker of the `orange dev` session. The session's Workers share one Rivet
// Engine, and each serves its own actors from its own envoy pool.
export interface RuntimeSessionWorker {
	deploymentIdentity: string;
	// Where the session's other Workers call this Worker, once it is ready.
	internalAddress?: RuntimeInternalAddress;
	name: string;
	poolName: string;
	// The queues whose consumer this Worker declares.
	queueConsumers?: string[];
	// The Workers whose tail() handlers get this Worker's tail events.
	tailConsumers?: string[];
}

export interface RuntimeInternalAddress {
	host: string;
	port: number;
}

export interface RuntimeSessionConfiguration {
	// The name of this Worker in `workers`, if it has one.
	self?: string;
	// Every Worker joins one envoy pool, as under `orange serve` on a cluster. Internal actors
	// with a fixed name, cron and queue, then carry their Worker's name, so the Engine sends
	// each to the runtime that hosts it.
	sharedPool?: boolean;
	// The deployment identity of the session's primary Worker. Every runtime uses it to
	// find the session's one Rivet Engine, and it names the session's shared D1, KV, R2,
	// and rate limiter objects.
	storageIdentity: string;
	// Authenticates calls between the session's runtimes.
	token: string;
	workers: RuntimeSessionWorker[];
}

export interface RuntimeStartMessage {
	// Files that `find_additional_modules` adds under `/bundle`.
	additionalModules?: { name: string; path: string }[];
	assets?: RuntimeAssetsConfiguration;
	bindingConfigurations: RuntimeBindingConfiguration[];
	builtAt: string;
	bundlePath: string;
	// `triggers.crons` expressions in Cloudflare syntax.
	crons?: string[];
	deploymentIdentity: string;
	// The `request_signal_passthrough` compatibility flag.
	requestSignalPassthrough?: boolean;
	// `orange serve`: request.url takes its scheme from X-Forwarded-Proto.
	trustForwardedProto?: boolean;
	durableObjectManifest?: RuntimeDurableObjectManifest;
	host: string;
	// Where `cloudflare:*` and workerd-specific `node:*` imports resolve, for
	// modules that a Worker Loader loads at runtime.
	moduleRewrites?: Record<string, string>;
	normalizedConfiguration: string;
	port: number;
	projectRoot: string;
	queueConsumers?: RuntimeQueueConsumer[];
	// Call actors on the Engine without hosting any.
	rivetClientOnly?: boolean;
	// An external Engine. Without it, the runtime starts a local Engine.
	rivetEndpoint?: string;
	rivetNamespace: string;
	rivetStoragePath: string;
	// `--test-scheduled`: serve Wrangler's `/__scheduled` route.
	testScheduled?: boolean;
	// Absent when `orange dev` runs one Worker.
	session?: RuntimeSessionConfiguration;
	// The Workers whose tail() handlers get this Worker's tail events.
	tailConsumers?: string[];
	type: "start";
	// The Worker's `name`, which its tail events report as `scriptName`.
	workerName?: string;
}

export interface RuntimeShutdownMessage {
	type: "shutdown";
}

// The session's Workers, sent again whenever one of them becomes ready.
export interface RuntimeSessionWorkersMessage {
	type: "session-workers";
	workers: RuntimeSessionWorker[];
}

export type RuntimeParentMessage =
	| RuntimeSessionWorkersMessage
	| RuntimeShutdownMessage
	| RuntimeStartMessage;

export interface RuntimeReadyMessage {
	// Each cron trigger's next run as Rivet stores it, in epoch milliseconds.
	cronNextRuns?: { cron: string; nextRunAt: number }[];
	host: string;
	// Present when the runtime serves calls from other Workers of its session.
	internalAddress?: RuntimeInternalAddress;
	port: number;
	type: "ready";
}

export interface RuntimeDiagnosticMessage {
	message: string;
	stack?: string;
	type: "background-error" | "request-error";
}

export interface RuntimeFatalMessage {
	message: string;
	stack?: string;
	type: "fatal";
}

// One finished HTTP request or WebSocket upgrade, for the request log.
export interface RuntimeRequestMessage {
	durationMs: number;
	method: string;
	path: string;
	status: number;
	type: "request";
}

// A startup problem the Worker can run with, such as a missing Workers AI key.
export interface RuntimeWarningMessage {
	message: string;
	type: "warning";
}

export interface RuntimeStoppedMessage {
	reason: "parent" | "SIGHUP" | "SIGINT" | "SIGTERM";
	type: "stopped";
}

export type RuntimeChildMessage =
	| RuntimeDiagnosticMessage
	| RuntimeFatalMessage
	| RuntimeReadyMessage
	| RuntimeRequestMessage
	| RuntimeStoppedMessage
	| RuntimeWarningMessage;

// `orange dev` forks the runtime from this same package, so both peers build
// their messages from these types. The receiver checks the message kind and
// trusts the kind's payload shape. Each table must list every kind.
const parentMessageTypes: Record<RuntimeParentMessage["type"], true> = {
	"session-workers": true,
	shutdown: true,
	start: true,
};

const childMessageTypes: Record<RuntimeChildMessage["type"], true> = {
	"background-error": true,
	fatal: true,
	ready: true,
	request: true,
	"request-error": true,
	stopped: true,
	warning: true,
};

function parseMessage<Message extends { type: string }>(
	types: Record<Message["type"], true>,
	value: unknown,
	error: string,
): Message {
	if (typeof value !== "object" || value === null || !("type" in value)) {
		throw new TypeError(error);
	}
	const { type } = value;
	if (typeof type !== "string" || !Object.hasOwn(types, type)) throw new TypeError(error);
	// SAFETY: Both IPC peers are OpenOrange processes built from this module, and the
	// discriminant was checked above. TypeScript cannot narrow a union from a runtime key set.
	return value as Message;
}

export function parseRuntimeParentMessage(value: unknown): RuntimeParentMessage {
	return parseMessage(parentMessageTypes, value, "Runtime parent sent an invalid IPC message");
}

export function parseRuntimeChildMessage(value: unknown): RuntimeChildMessage {
	return parseMessage(childMessageTypes, value, "OpenOrange runtime sent an invalid IPC message");
}
