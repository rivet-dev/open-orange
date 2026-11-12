import { AsyncResource } from "node:async_hooks";
import { configureContainerClasses } from "./modules/cloudflare-sandbox/container.js";
import {
	createServer,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { Duplex } from "node:stream";
import { pathToFileURL } from "node:url";

import { Ai } from "./bindings/ai/ai.js";
import { aiApiKeyWarning, createAiBackend } from "./bindings/ai/backend.js";
import { AnalyticsEngineDataset } from "./bindings/analytics-engine.js";
import { Hyperdrive } from "./bindings/hyperdrive.js";
import { createAssets, type Assets } from "./bindings/assets/assets.js";
import { CacheActorBackend, cacheEnabledFromEnvironment } from "./bindings/cache/client.js";
import { D1Database } from "./bindings/d1/database.js";
import {
	cacheClassName,
	d1DatabaseClassName,
	internalObjectClass,
	internalObjectDisplayName,
	internalObjectFetcher,
	internalObjectMigrationTag,
	kvNamespaceClassName,
	rateLimitClassName,
	r2BucketClassName,
} from "./bindings/internal-objects.js";
import { KVNamespace } from "./bindings/kv/namespace.js";
import { RateLimit } from "./bindings/ratelimit/binding.js";
import { R2ActorBackend } from "./bindings/r2/actor-backend.js";
import { R2Bucket } from "./bindings/r2/bucket.js";
import { R2S3Backend, r2S3SettingsFromEnvironment } from "./bindings/r2/s3-backend.js";
import { type QueueActorCaller, WorkerQueue } from "./bindings/queues/producer.js";
import { createLocalSecretSource, createSecretsStoreSecret } from "./bindings/secrets-store.js";
import { createUnsafeEval } from "./bindings/unsafe-eval.js";
import { createUnsupportedBinding, unsupportedBindingMessage } from "./bindings/unsupported.js";
import { browserFromSettings } from "./bindings/browser/browser.js";
import { SendEmail } from "./bindings/email/send-email.js";
import {
	inboundEmailAuthorized,
	inboundEmailPath,
	inboundSecretSetting,
	unauthorizedInboundEmail,
} from "./events/email.js";
import { smtpSenderFromSettings } from "./bindings/email/smtp.js";
import { createWorkerVersionMetadata } from "./bindings/version-metadata.js";
import { Workflow } from "./bindings/workflows/binding.js";
import {
	configureWorkflowEngines,
	type WorkflowEngineObject,
	workflowEngineClassName,
} from "./bindings/workflows/engine-object.js";
import { AgentOsWorkerLoaderBackend, workerLoaderPoolSize } from "./bindings/worker-loader/agentos.js";
import {
	DynamicWorkerPool,
	WorkerLoader,
	workerLoaderVmBundlePath,
	type WorkerLoaderBackend,
} from "./bindings/worker-loader/loader.js";
import { createDispatchNamespace } from "./bindings/dispatch-namespace.js";
import type { EnvironmentBinding } from "./bindings/create-env.js";
import type { ConfiguredDurableObjectClass } from "./bindings/durable-objects/classes.js";
import {
	configureDurableObjectStorageNames,
	createDurableObjectNamespace,
	type DurableObjectNamespace,
	type ResolveDurableObjectActor,
} from "./bindings/durable-objects/namespace.js";
import {
	createDurableObjectActorResolver,
	durableObjectActorName,
} from "./bindings/durable-objects/actor-routing.js";
import { startDurableObjectRegistry } from "./bindings/durable-objects/lifecycle.js";
import {
	registerDevSession,
	signalRivetEngineStopAfterLastDevSession,
	stopRivetEngineAfterLastDevSession,
} from "./internal/ports.js";
import type { StartDurableObjectRegistryOptions } from "./bindings/durable-objects/lifecycle.js";
import { cloudflareMigrationRoute } from "./bindings/durable-objects/cloudflare-import.js";
import {
	createDurableObjectFacetHost,
	durableObjectFacetClassName,
} from "./bindings/durable-objects/facets.js";
import {
	createDurableObjectActorDefinitions,
	createDurableObjectFacetActorDefinition,
} from "./bindings/durable-objects/registry.js";
import {
	isRivetActorNotFound,
	type RivetActorClient,
	type RivetInternalActorDefinition,
} from "./internal/rivetkit.js";
import {
	createCronActorDefinition,
	cronActorKey,
	cronActorName,
	syncCronTriggers,
	syncCronTriggersInBackground,
	type CronJob,
} from "./internal-actors/cron.js";
import { createQueueActorDefinition, queueActorName } from "./internal-actors/queue.js";
import {
	createTailActorDefinition,
	createTailAppender,
	tailActorName,
	tailSegmentsFromEnvironment,
	type TailAppender,
	type TailSegments,
} from "./internal-actors/tail.js";
import { resolveServicesBinary, servicesPoolName } from "./internal/services-process.js";
import type { ScheduledResult } from "./events/scheduled.js";
import { createServiceStub } from "./bindings/service.js";
import { remoteServiceBackend } from "./session/client.js";
import { createMissingWorkerDurableObjectNamespace } from "./session/durable-objects.js";
import { dispatchTail } from "./events/tail.js";
import { configureTailConsumers } from "./internal/tail-trace.js";
import { startSessionServer, type SessionServer } from "./session/server.js";
import {
	cronActorKeyScope,
	primaryRivetPoolName,
	SessionWorkers,
	workerNotFoundMessage,
} from "./session/workers.js";
import { connectingIp, inboundRequestCf } from "./events/inbound-cf.js";
import { openOrangeInternalHeaderPrefix } from "./bindings/durable-objects/transport-head.js";
import { configureCacheStorage } from "./globals/cache.js";
import { encodeBody, outgoingBodyCoding } from "./globals/content-encoding.js";
import { bodyChunkBytes, Headers, Request, Response } from "./globals/http.js";
import { setRequestSignalPassthrough } from "./internal/request-signal-passthrough.js";
import type { WebSocket } from "./globals/websocket.js";
import { runRuntimeCloseHooks } from "./internal/close-hooks.js";
import { takeRivetCredentials } from "./internal/rivet-credentials.js";
import { metricsPortFromEnvironment, startMetricsServer } from "./internal/metrics-server.js";
import { publishWorkerVarSettings, runtimeSettings } from "./internal/runtime-settings.js";

const cronsSetting = "ORANGE_CRONS";
import {
	closeUncoupledWorkerWebSocket,
	NetworkWebSocketUpgrades,
	writeRejectedUpgrade,
	writeUpgradeFailure,
} from "./internal/network-websockets.js";
import { drainWebSockets } from "./internal/websocket-drain.js";
import { acceptedWebSocketDrainClosers } from "./bindings/durable-objects/accepted-websocket-host.js";
import {
	parseRuntimeParentMessage,
	type RuntimeBindingConfiguration,
	type RuntimeChildMessage,
	type RuntimeSessionWorker,
	type RuntimeStartMessage,
	type RuntimeStoppedMessage,
} from "./process-protocol.js";
import {
	loadWorkerEntrypoint,
	type LoadedWorkerEntrypoint,
	type ScheduledEvent,
	type ServiceBindingOptions,
} from "./runtime.js";

function send(message: RuntimeChildMessage): void {
	if (process.send !== undefined && process.connected) {
		process.send(message);
	}
}

function errorDetails(error: unknown): { message: string; stack?: string } {
	if (error instanceof Error) {
		const group: unknown = Reflect.get(error, "group");
		const code: unknown = Reflect.get(error, "code");
		const classification =
			typeof group === "string" && typeof code === "string"
				? ` [${group}/${code}]`
				: "";
		const cause = error.cause instanceof Error
			? `\nCaused by: ${error.cause.stack ?? error.cause.message}`
			: "";
		return {
			message: `${error.message}${classification}`,
			...(error.stack === undefined
				? {}
				: { stack: `${error.stack}${classification}${cause}` }),
		};
	}
	return { message: String(error) };
}

function requestBody(
	request: IncomingMessage,
): ReadableStream<Uint8Array> | undefined {
	const method = request.method?.toUpperCase() ?? "GET";
	if (method === "GET" || method === "HEAD") return undefined;
	const iterator: AsyncIterator<unknown> = request.iterator({
		destroyOnReturn: false,
	});
	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			const result = await iterator.next();
			if (result.done === true) {
				controller.close();
			} else if (typeof result.value === "string") {
				controller.enqueue(Buffer.from(result.value));
			} else if (result.value instanceof Uint8Array) {
				controller.enqueue(result.value);
			} else {
				throw new TypeError("Node HTTP server produced an invalid request chunk");
			}
		},
		cancel() {
			request.resume();
		},
	});
}

// Dynamic Workers run only in agentOS VMs. All Worker Loader bindings share one
// backend.
let sharedWorkerLoaderBackend: WorkerLoaderBackend | undefined;
function workerLoaderBackend(): WorkerLoaderBackend {
	sharedWorkerLoaderBackend ??= new AgentOsWorkerLoaderBackend({
		bundlePath: () => workerLoaderVmBundlePath(import.meta.url),
		onDiagnostic(message): void {
			send({ message, type: "background-error" });
		},
		poolSize: workerLoaderPoolSize(runtimeSettings()),
	});
	return sharedWorkerLoaderBackend;
}

// One pool bounds the dynamic Workers of every Worker Loader binding.
let sharedWorkerLoaderPool: DynamicWorkerPool | undefined;
function workerLoaderPool(warn: (message: string) => void): DynamicWorkerPool {
	sharedWorkerLoaderPool ??= DynamicWorkerPool.fromSettings(runtimeSettings(), warn);
	return sharedWorkerLoaderPool;
}

function requestHeaders(request: IncomingMessage): Headers {
	const headers = new Headers();
	for (const [name, value] of Object.entries(request.headers)) {
		// Orange's internal headers carry trusted metadata such as request.cf, so
		// a client must never be able to supply one.
		if (name.startsWith(openOrangeInternalHeaderPrefix)) continue;
		if (Array.isArray(value)) {
			for (const entry of value) {
				headers.append(name, entry);
			}
		} else if (value !== undefined) {
			headers.append(name, value);
		}
	}
	const ip = connectingIp(request);
	if (ip !== undefined && !headers.has("cf-connecting-ip")) {
		headers.set("cf-connecting-ip", ip);
	}
	return headers;
}

// A deployed Worker sits behind the cluster's gateway, which ends TLS. Its
// X-Forwarded-Proto is the scheme the client used, which is what request.url
// shows on Cloudflare. `orange dev` takes requests directly, so it ignores the header.
function requestUrl(request: IncomingMessage, host: string, trustForwardedProto: boolean): string {
	const authority = request.headers.host ?? host;
	const forwarded = request.headers["x-forwarded-proto"];
	const proto = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(",")[0]?.trim().toLowerCase();
	const scheme = trustForwardedProto && proto === "https" ? "https" : "http";
	return `${scheme}://${authority}${request.url ?? "/"}`;
}

async function writeResponse(
	response: ServerResponse,
	workerResponse: Awaited<ReturnType<LoadedWorkerEntrypoint["dispatch"]>>["response"],
): Promise<void> {
	response.statusCode = workerResponse.status;
	if (workerResponse.statusText.length > 0) {
		response.statusMessage = workerResponse.statusText;
	}
	// An encoded body has a different length, so workerd streams it without one.
	const coding = outgoingBodyCoding(workerResponse);
	for (const [name, value] of workerResponse.headers) {
		if (name === "set-cookie") continue;
		if (coding !== undefined && name === "content-length") continue;
		response.setHeader(name, value);
	}
	const setCookies = workerResponse.headers.getSetCookie();
	if (setCookies.length > 0) {
		response.setHeader("set-cookie", setCookies);
	}
	if (workerResponse.body === null) {
		response.end();
		return;
	}

	const body =
		coding === undefined
			? workerResponse.body
			: encodeBody(workerResponse.body, coding);
	const reader = body.getReader();
	let completed = false;
	const onClose = (): void => {
		if (!completed) void reader.cancel("HTTP response client disconnected");
	};
	response.once("close", onClose);
	try {
		for (;;) {
			const result = await reader.read();
			if (result.done) break;
			// Workerd sends any ArrayBuffer or ArrayBufferView chunk of a body.
			const bytes = bodyChunkBytes(result.value);
			if (bytes.byteLength === 0) continue;
			if (!response.write(bytes)) {
				const writable = await new Promise<boolean>((resolveWritable) => {
					const cleanup = (): void => {
						response.off("close", closed);
						response.off("drain", drained);
					};
					const closed = (): void => {
						cleanup();
						resolveWritable(false);
					};
					const drained = (): void => {
						cleanup();
						resolveWritable(true);
					};
					response.once("close", closed);
					response.once("drain", drained);
				});
				if (!writable) return;
			}
		}
		completed = true;
		response.end();
	} finally {
		response.off("close", onClose);
		reader.releaseLock();
	}
}

function reportWaitUntil(
	waitUntil: Awaited<ReturnType<LoadedWorkerEntrypoint["dispatch"]>>["waitUntil"],
): void {
	void waitUntil.then((outcomes) => {
		for (const outcome of outcomes) {
			if (outcome.status === "rejected") {
				send({
					...errorDetails(outcome.reason),
					type: "background-error",
				});
			}
		}
	});
}

// Each traced event goes to the Durable Streams stream of each consumer, after the event ends.
// The consumer's `openorange:tail` actor reads its stream and calls its tail() handler. Errors
// from appends and tail() handlers appear in the dev output.
function configureWorkerTailConsumers(
	message: RuntimeStartMessage,
	segments: TailSegments,
	streams: () => Promise<RivetActorClient>,
): TailAppender | undefined {
	const tailConsumers = message.tailConsumers ?? [];
	if (tailConsumers.length === 0) return undefined;
	const appender = createTailAppender({
		consumers: tailConsumers,
		reportError(error): void {
			send({ ...errorDetails(error), type: "background-error" });
		},
		segments,
		streams,
		workerName: message.workerName ?? message.session?.self ?? null,
	});
	configureTailConsumers({
		scriptName: message.workerName ?? message.session?.self ?? null,
		deliver: (record) => appender.deliver(record),
	});
	return appender;
}

// With a local Engine, the session's first Worker starts the session's one Rivet Services, when
// any Worker of the session has `tail_consumers`. On a cluster, Services is its own deployment.
function hostsTailServices(message: RuntimeStartMessage): boolean {
	if (message.rivetEndpoint !== undefined) return false;
	const usesTail =
		(message.tailConsumers ?? []).length > 0 ||
		(message.session?.workers ?? []).some((worker) => (worker.tailConsumers ?? []).length > 0);
	return usesTail && (message.session === undefined || message.session.workers[0]?.name === message.session.self);
}

// Whether a Worker of the session, or this Worker, lists this Worker in `tail_consumers`.
function isTailConsumer(message: RuntimeStartMessage): boolean {
	const self = message.workerName ?? message.session?.self;
	if (self === undefined) return false;
	return (
		(message.tailConsumers ?? []).includes(self) ||
		(message.session?.workers ?? []).some((worker) => worker.tailConsumers?.includes(self) === true)
	);
}

type RunScheduled = (event: ScheduledEvent) => Promise<ScheduledResult>;

// Wrangler serves `/cdn-cgi/local/scheduled` in front of the Worker and its
// assets, and `/__scheduled` with `--test-scheduled`.
// https://github.com/cloudflare/workers-sdk/blob/be87ff0382c53a294e948e49419d25d653c50e86/packages/miniflare/src/workers/core/scheduled.ts#L1-L23
// https://github.com/cloudflare/workers-sdk/blob/be87ff0382c53a294e948e49419d25d653c50e86/packages/wrangler/templates/middleware/middleware-scheduled.ts#L4-L11
function scheduledRoute(
	request: Request,
	testScheduled: boolean,
): ((runScheduled: RunScheduled) => Promise<Response>) | undefined {
	const url = new URL(request.url);
	const cron = url.searchParams.get("cron") ?? "";
	if (url.pathname === "/cdn-cgi/local/scheduled") {
		return async (runScheduled) => {
			const time = Number.parseInt(url.searchParams.get("time") ?? "", 10);
			const result = await runScheduled({
				cron,
				scheduledTime: Number.isNaN(time) ? Date.now() : time,
			});
			const status = result.outcome === "ok" ? 200 : 500;
			if (url.searchParams.get("format") === "json") {
				return new Response(
					JSON.stringify({ noRetry: result.noRetry, outcome: result.outcome }),
					{ headers: { "content-type": "application/json" }, status },
				);
			}
			return new Response(result.outcome, { status });
		};
	}
	if (testScheduled && url.pathname === "/__scheduled") {
		return async (runScheduled) => {
			const result = await runScheduled({ cron, scheduledTime: Date.now() });
			return result.outcome === "ok"
				? new Response("Ran scheduled event")
				: new Response("Internal Server Error", { status: 500 });
		};
	}
	return undefined;
}
interface RuntimeBindings {
	bindings: EnvironmentBinding[];
	durableObjectNamespaces: Map<string, unknown>;
	// OpenOrange's own Durable Object classes that back KV, D1, Rate Limiting,
	// and R2 bindings.
	internalClassNames: Set<string>;
	// Internal classes that the session's storage identity names. See sharedStorageIdentity.
	sharedClassNames: Set<string>;
	// True when a binding sends to an `openorange:queue` actor.
	producesToQueues: boolean;
	serviceBindings: ServiceBindingOptions[];
	// Workflow class names by Workflow name.
	workflowClassNames: Map<string, string>;
	workerLoaders: WorkerLoader[];
}

async function createBindings(
	message: RuntimeStartMessage,
	workerBundle: Uint8Array,
	assets: Assets | undefined,
	resolveActor: ResolveDurableObjectActor,
	resolveClient: () => RivetActorClient,
	callQueue: QueueActorCaller,
	sessionWorkers: SessionWorkers,
	resolvePoolClient: (poolName: string) => RivetActorClient,
): Promise<RuntimeBindings> {
	const source = createLocalSecretSource({ directory: message.projectRoot });
	const bindings: EnvironmentBinding[] = [];
	const durableObjectNamespaces = new Map<string, unknown>();
	const serviceBindings: ServiceBindingOptions[] = [];
	const workflowClassNames = new Map<string, string>();
	let producesToQueues = false;
	const workerLoaders: WorkerLoader[] = [];
	const internalNamespaces = new Map<string, DurableObjectNamespace>();
	const sharedClassNames = new Set<string>();
	const poolResolvers = new Map<string, ResolveDurableObjectActor>();
	const internalNamespace = (className: string): DurableObjectNamespace => {
		let namespace = internalNamespaces.get(className);
		if (namespace === undefined) {
			namespace = createDurableObjectNamespace({
				className,
				deploymentIdentity: sharedClassNames.has(className)
					? sharedStorageIdentity(message)
					: message.deploymentIdentity,
				resolveActor,
			});
			internalNamespaces.set(className, namespace);
		}
		return namespace;
	};
	// KV namespaces, D1 databases, R2 buckets, and rate limiters with the same ID are
	// one resource for every Worker of a session, as in a multi-Worker Miniflare.
	const sharedNamespace = (className: string): DurableObjectNamespace => {
		sharedClassNames.add(className);
		return internalNamespace(className);
	};
	const selfName = message.session?.self;
	for (const configuration of message.bindingConfigurations) {
		if (
			configuration.type === "service" &&
			configuration.service !== undefined &&
			configuration.service !== selfName
		) {
			bindings.push({
				name: configuration.binding,
				value: createServiceStub(
					remoteServiceBackend({
						entrypoint: configuration.entrypoint ?? "default",
						missing: "service",
						service: configuration.service,
						workers: sessionWorkers,
					}),
					configuration.props,
				),
			});
			continue;
		}
		if (configuration.type === "service") {
			serviceBindings.push({
				binding: configuration.binding,
				...(configuration.entrypoint === undefined
					? {}
					: { entrypoint: configuration.entrypoint }),
				...(configuration.props === undefined ? {} : { props: configuration.props }),
			});
			continue;
		}
		let value: unknown;
		switch (configuration.type) {
			case "ai": {
				const log = (line: string): void => {
					process.stderr.write(`[ai] ${line}\n`);
				};
				value = new Ai(createAiBackend({ log, source }));
				const warning = await aiApiKeyWarning(configuration.binding, source);
				if (warning !== undefined) send({ message: warning, type: "warning" });
				break;
			}
			case "analytics_engine":
				value = new AnalyticsEngineDataset();
				break;
			case "hyperdrive":
				value = new Hyperdrive(configuration.connectionString);
				break;
			case "assets":
				if (assets === undefined) {
					throw new Error(
						`Assets binding ${configuration.binding} requires assets configuration`,
					);
				}
				value = assets.binding();
				break;
			case "json":
			case "plain_text":
				value = configuration.value;
				break;
			case "secrets_store_secret":
				value = createSecretsStoreSecret(configuration.binding, source);
				break;
			case "unsafe_eval":
				value = createUnsafeEval();
				break;
			case "kv_namespace":
				value = new KVNamespace(
					internalObjectFetcher(
						sharedNamespace(kvNamespaceClassName),
						configuration.namespaceId,
					),
				);
				break;
			case "d1":
				value = new D1Database(
					internalObjectFetcher(
						sharedNamespace(d1DatabaseClassName),
						configuration.databaseId,
					),
				);
				break;
			case "ratelimit":
				value = new RateLimit(
					internalObjectFetcher(
						sharedNamespace(rateLimitClassName),
						configuration.namespaceId,
					),
					configuration.simple,
				);
				break;
			case "r2_bucket": {
				const s3 = r2S3SettingsFromEnvironment(configuration.bucketName, runtimeSettings());
				value = new R2Bucket(
					s3 === undefined
						? new R2ActorBackend(
								internalObjectFetcher(
									sharedNamespace(r2BucketClassName),
									configuration.bucketName,
								),
							)
						: new R2S3Backend(s3),
				);
				break;
			}
			case "queue":
				producesToQueues = true;
				value = new WorkerQueue({
					call: callQueue,
					...(configuration.deliveryDelay === undefined
						? {}
						: { deliveryDelay: configuration.deliveryDelay }),
					queueName: configuration.queueName,
				});
				break;
			case "browser":
				value =
					browserFromSettings(runtimeSettings()) ??
					createUnsupportedBinding(unsupportedBindingMessage("browser", configuration.binding));
				break;
			case "send_email": {
				const sender = smtpSenderFromSettings(runtimeSettings());
				value =
					sender === undefined
						? createUnsupportedBinding(unsupportedBindingMessage("send_email", configuration.binding))
						: new SendEmail(configuration, sender);
				break;
			}
			case "unsupported":
				value = createUnsupportedBinding(configuration.message);
				break;
			case "worker_loader": {
				const loader = new WorkerLoader({
					backend: workerLoaderBackend(),
					pool: workerLoaderPool((message) => send({ message, type: "warning" })),
					onDiagnostic(diagnostic): void {
						send({ message: diagnostic, type: "background-error" });
					},
				});
				workerLoaders.push(loader);
				value = loader;
				break;
			}
			case "durable_object_namespace": {
				// The class runs in the other Worker's runtime. Its actors live in
				// that Worker's envoy pool on the session's shared Engine.
				const target = sessionWorkers.configured(configuration.scriptName);
				if (target === undefined) {
					value = createMissingWorkerDurableObjectNamespace(
						configuration.className,
						configuration.scriptName,
					);
					break;
				}
				let poolResolver = poolResolvers.get(target.poolName);
				if (poolResolver === undefined) {
					poolResolver = createDurableObjectActorResolver(() =>
						resolvePoolClient(target.poolName),
					);
					poolResolvers.set(target.poolName, poolResolver);
				}
				value = createDurableObjectNamespace({
					className: configuration.className,
					deploymentIdentity: target.deploymentIdentity,
					resolveActor: poolResolver,
				});
				break;
			}
			case "dispatch_namespace":
				value = createDispatchNamespace(sessionWorkers);
				break;
			case "version_metadata":
				value = createWorkerVersionMetadata({
					builtAt: new Date(message.builtAt),
					normalizedConfiguration: message.normalizedConfiguration,
					workerBundle,
				});
				break;
			case "workflow": {
				if (configuration.scriptName !== undefined) {
					// The Workflow runs in the runtime of the Worker that defines it.
					const scriptName = configuration.scriptName;
					const target = sessionWorkers.configured(scriptName);
					let namespace: DurableObjectNamespace<WorkflowEngineObject> | undefined;
					value = new Workflow({
						name: configuration.name,
						namespace: () => {
							if (target === undefined) throw new Error(workerNotFoundMessage(scriptName));
							let poolResolver = poolResolvers.get(target.poolName);
							if (poolResolver === undefined) {
								poolResolver = createDurableObjectActorResolver(() =>
									resolvePoolClient(target.poolName),
								);
								poolResolvers.set(target.poolName, poolResolver);
							}
							namespace ??= createDurableObjectNamespace<WorkflowEngineObject>({
								className: workflowEngineClassName,
								deploymentIdentity: target.deploymentIdentity,
								resolveActor: poolResolver,
							});
							return namespace;
						},
					});
					break;
				}
				const existing = workflowClassNames.get(configuration.name);
				if (existing !== undefined && existing !== configuration.className) {
					throw new Error(
						`Workflow ${JSON.stringify(configuration.name)} is bound to both ${existing} and ${configuration.className}`,
					);
				}
				workflowClassNames.set(configuration.name, configuration.className);
				// Registers the engine class in this Worker's runtime.
				internalNamespace(workflowEngineClassName);
				const namespace = createDurableObjectNamespace<WorkflowEngineObject>({
					className: workflowEngineClassName,
					deploymentIdentity: message.deploymentIdentity,
					resolveActor,
				});
				value = new Workflow({
					name: configuration.name,
					namespace: () => namespace,
				});
				break;
			}
		}
		bindings.push({ name: configuration.binding, value });
	}
	configureDurableObjectStorageNames(message.deploymentIdentity, message.durableObjectManifest?.classes ?? []);
	for (const binding of message.durableObjectManifest?.bindings ?? []) {
		const namespace = createDurableObjectNamespace({
			className: binding.className,
			deploymentIdentity: message.deploymentIdentity,
			resolveActor,
		});
		bindings.push({ name: binding.binding, value: namespace });
		if (!durableObjectNamespaces.has(binding.className)) {
			durableObjectNamespaces.set(binding.className, namespace);
		}
	}
	// Workerd exposes each Durable Object class in ctx.exports as its namespace,
	// including a class that has no binding.
	// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/tests/importable-exports-test.js#L29-L31
	for (const { className } of message.durableObjectManifest?.classes ?? []) {
		if (!durableObjectNamespaces.has(className)) {
			durableObjectNamespaces.set(
				className,
				createDurableObjectNamespace({
					className,
					deploymentIdentity: message.deploymentIdentity,
					resolveActor,
				}),
			);
		}
	}
	return {
		bindings,
		durableObjectNamespaces,
		internalClassNames: new Set(internalNamespaces.keys()),
		sharedClassNames,
		producesToQueues,
		serviceBindings,
		workflowClassNames,
		workerLoaders,
	};
}

// The identity that names a session's shared storage objects. A Worker outside a
// session, or the session's primary Worker, uses its own identity.
function sharedStorageIdentity(message: { deploymentIdentity: string; session?: { storageIdentity: string } }): string {
	return message.session?.storageIdentity ?? message.deploymentIdentity;
}

export interface RuntimeRunnerDependencies {
	startRegistry?(
		options: StartDurableObjectRegistryOptions,
	): ReturnType<typeof startDurableObjectRegistry>;
}

export async function startRuntime(
	message: RuntimeStartMessage,
	dependencies: RuntimeRunnerDependencies = {},
): Promise<{
	close(reason: RuntimeStoppedMessage["reason"]): Promise<void>;
	host: string;
	port: number;
	sessionWorkers: SessionWorkers;
}> {
	takeRivetCredentials({ endpoint: message.rivetEndpoint });
	setRequestSignalPassthrough(message.requestSignalPassthrough === true);
	const sessionWorkers = new SessionWorkers(message.session);
	const cronKeyScope = cronActorKeyScope(message.session);
	// In a shared pool, a fixed-name internal actor carries the name of the Worker that hosts it.
	const hostedBy = (base: string, workerName: string | undefined): string =>
		message.session?.sharedPool === true && workerName !== undefined ? `${base}@${workerName}` : base;
	const cronName = hostedBy(cronActorName, message.session?.self);
	const workerBundle = await readFile(message.bundlePath);
	// node:fs maps /bundle to this directory. Orange runs one bundled main module, so it holds
	// that one file, named `worker`, and any files from `find_additional_modules`.
	const bundleRoot = await mkdtemp(join(dirname(message.bundlePath), "bundle-"));
	for (const module of message.additionalModules ?? []) {
		const target = join(bundleRoot, module.name);
		await mkdir(dirname(target), { recursive: true });
		await copyFile(module.path, target);
	}
	await writeFile(join(bundleRoot, "worker"), workerBundle);
	Reflect.set(
		globalThis,
		Symbol.for("open-orange.node-fs.bundle-root"),
		bundleRoot,
	);
	// Each event's private /tmp lives in this directory too.
	Reflect.set(
		globalThis,
		Symbol.for("open-orange.node-fs.tmp-parent"),
		dirname(message.bundlePath),
	);
	let durableObjectRegistry:
		| Awaited<ReturnType<typeof startDurableObjectRegistry>>
		| undefined;
	const assets = message.assets === undefined ? undefined : createAssets(message.assets);
	const registryClient = (): RivetActorClient => {
		if (durableObjectRegistry === undefined) {
			throw new Error("Durable Object registry is not ready");
		}
		return durableObjectRegistry.client;
	};
	const resolveActor = createDurableObjectActorResolver(registryClient);
	const poolClient = (poolName: string): RivetActorClient => {
		if (durableObjectRegistry === undefined) {
			throw new Error("Durable Object registry is not ready");
		}
		if (durableObjectRegistry.clientForPool === undefined) {
			throw new Error("Durable Object registry cannot reach other Workers");
		}
		return durableObjectRegistry.clientForPool(poolName);
	};
	// A queue is shared by the session. Its actor runs in the envoy pool of the
	// Worker that consumes it, so batches reach that Worker's queue() handler.
	const callQueue: QueueActorCaller = (queueName, action, args) => {
		const consumer = message.session?.workers.find((worker) =>
			worker.queueConsumers?.includes(queueName),
		);
		const client =
			consumer === undefined || consumer.name === message.session?.self
				? registryClient()
				: poolClient(consumer.poolName);
		return client
			.getOrCreate(hostedBy(queueActorName, consumer?.name ?? message.session?.self), [queueName])
			.action({ args: [...args], name: action });
	};
	// Bindings read Orange settings such as ORANGE_R2_<BUCKET>_S3_* from the
	// runtime settings, so the Worker's vars and secrets must be published first.
	publishWorkerVarSettings(message.bindingConfigurations);
	const runtimeBindings = await createBindings(
		message,
		workerBundle,
		assets,
		resolveActor,
		registryClient,
		callQueue,
		sessionWorkers,
		poolClient,
	);
	const worker = await loadWorkerEntrypoint({
		bindings: runtimeBindings.bindings,
		durableObjectNamespaces: runtimeBindings.durableObjectNamespaces,
		serviceBindings: runtimeBindings.serviceBindings,
		...(message.durableObjectManifest === undefined
			? {}
			: { durableObjectManifest: message.durableObjectManifest }),
		// From the bundle root, as workerd's main module sits beside its other modules, so a
		// relative import() reaches a find_additional_modules module.
		importWorker: () => import(pathToFileURL(join(bundleRoot, "worker")).href),
	});
	// Appends run after the event's response, outside its context, so they never start the registry
	// inside a request.
	const tailSegments = tailSegmentsFromEnvironment(process.env);
	// Resolved before anything starts, so a missing binary fails the start with its own error.
	const tailServices = hostsTailServices(message)
		? {
				binaryPath: resolveServicesBinary(createRequire(import.meta.url).resolve("rivetkit")),
				logDirectory: join(message.rivetStoragePath, ".rivetkit", "var", "logs", "rivet-services"),
			}
		: undefined;
	const tailAppender = configureWorkerTailConsumers(message, tailSegments, async () => {
		await AsyncResource.bind(startRegistry)();
		return poolClient(servicesPoolName);
	});
	const tailConsumer = isTailConsumer(message);
	// `ORANGE_CRONS=off` stops the Worker's crons here, for example while Cloudflare still runs them
	// during a migration. Orange then deletes their jobs, as for crons removed from the configuration.
	const crons = runtimeSettings()[cronsSetting] === "off" ? [] : (message.crons ?? []);
	const externalEngine = message.rivetEndpoint !== undefined;
	// The cron actor is registered only when the Worker has crons, or when an
	// earlier configuration may have left jobs that must be deleted. A local
	// Engine's data lives beside this marker, so the marker says whether jobs
	// were left. An external Engine outlives the runner's disk, so a runner
	// without crons always checks.
	const cronJobsMarker = join(
		message.rivetStoragePath,
		["open-orange-cron-jobs", ...cronKeyScope.map(encodeURIComponent)].join("-"),
	);
	const staleCronJobs = crons.length === 0 && (externalEngine || existsSync(cronJobsMarker));
	let cronNextRuns: CronJob[] = [];
	// Errors from scheduled() and its waitUntil() promises appear in the dev output.
	const runScheduled: RunScheduled = async (event) => {
		const result = await worker.dispatchScheduled(event);
		for (const error of result.errors) {
			send({ ...errorDetails(error), type: "background-error" });
		}
		return result;
	};
	const queueConsumers = message.queueConsumers ?? [];
	const internalActors: Record<string, RivetInternalActorDefinition> = {};
	// With no crons, the cron actor runs only to delete the jobs that an earlier
	// configuration left.
	if (crons.length > 0 || staleCronJobs) {
		internalActors[cronName] = createCronActorDefinition({ crons, runScheduled });
	}
	if (runtimeBindings.producesToQueues || queueConsumers.length > 0) {
		internalActors[hostedBy(queueActorName, message.session?.self)] = createQueueActorDefinition({
			consumers: new Map(queueConsumers.map((consumer) => [consumer.queueName, consumer])),
			dispatch: (queueName, envelopes, metadata) =>
				worker.queue(queueName, envelopes, metadata),
			async forward(queueName, envelopes): Promise<void> {
				await callQueue(queueName, "enqueue", [
					envelopes.map((envelope) => ({ delayMs: 0, envelope })),
				]);
			},
			reportError(error): void {
				send({ ...errorDetails(error), type: "background-error" });
			},
		});
	}
	const selfName = message.workerName ?? message.session?.self;
	if (tailConsumer && selfName !== undefined) {
		internalActors[hostedBy(tailActorName, message.session?.self)] = createTailActorDefinition({
			dispatch: (records) => dispatchTail(worker.services.worker(), records),
			reportError(error): void {
				send({ ...errorDetails(error), type: "background-error" });
			},
			segments: tailSegments,
			streams: () => poolClient(servicesPoolName),
		});
	}
	if (runtimeBindings.workflowClassNames.size > 0) {
		configureWorkflowEngines({
			classNames: runtimeBindings.workflowClassNames,
			contextExports: worker.contextExports,
			workerExports: worker.exports,
		});
	}
	const cacheEnabled = cacheEnabledFromEnvironment(runtimeSettings());
	const internalClassNames = new Set(runtimeBindings.internalClassNames);
	if (cacheEnabled) internalClassNames.add(cacheClassName);
	let closing = false;
	let registryStart: Promise<void> | undefined;
	// The registry starts with the runtime when the Worker has Durable Objects,
	// storage bindings, or internal actors. Otherwise the first Cache API call
	// starts it, so a Worker that never uses the cache does not start a Rivet Engine.
	const startRegistry = (): Promise<void> => {
		if (closing) return Promise.reject(new Error("The runtime is shutting down"));
		registryStart ??= (async () => {
			process.env.RIVETKIT_STORAGE_PATH = message.rivetStoragePath;
			registerDevSession(message.rivetStoragePath);
			configureContainerClasses(message.durableObjectManifest?.classes ?? []);
			const classStorage = new Map(
				(message.durableObjectManifest?.classes ?? []).map((configuredClass) => [
					configuredClass.className,
					{
						migrationTag: configuredClass.migrationTag,
						storageBackend: configuredClass.storageBackend,
					},
				]),
			);
			const classes = new Map<string, ConfiguredDurableObjectClass>(
				worker.durableObjectClasses,
			);
			const displayNames = new Map<string, string>();
			for (const className of internalClassNames) {
				classStorage.set(className, {
					migrationTag: internalObjectMigrationTag,
					storageBackend: "sqlite",
				});
				classes.set(className, internalObjectClass(className));
				displayNames.set(className, internalObjectDisplayName(className));
			}
			// A facet needs a parent Durable Object of the Worker, so a Worker without its own
			// classes does not register the facet actor.
			const facetHost =
				worker.durableObjectClasses.size === 0
					? undefined
					: createDurableObjectFacetHost({
							actorName: durableObjectActorName(
								message.deploymentIdentity,
								durableObjectFacetClassName,
							),
							client: registryClient,
							deploymentIdentity: message.deploymentIdentity,
							workerExports: worker.exports,
						});
			const sharedIdentity = sharedStorageIdentity(message);
			const sharedClasses = new Map<string, ConfiguredDurableObjectClass>();
			const sharedClassStorage = new Map<string, { migrationTag: string; storageBackend: "sqlite" }>();
			if (sharedIdentity !== message.deploymentIdentity) {
				for (const className of runtimeBindings.sharedClassNames) {
					const sharedClass = classes.get(className);
					if (sharedClass === undefined) continue;
					sharedClasses.set(className, sharedClass);
					sharedClassStorage.set(className, { migrationTag: internalObjectMigrationTag, storageBackend: "sqlite" });
					classes.delete(className);
					classStorage.delete(className);
				}
			}
			const registrations = new Map(
				createDurableObjectActorDefinitions({
					bindings: worker.environment,
					classStorage,
					classes,
					deploymentIdentity: message.deploymentIdentity,
					displayNames,
					...(facetHost === undefined ? {} : { facetHost }),
				}),
			);
			if (sharedClasses.size > 0) {
				const shared = createDurableObjectActorDefinitions({
					bindings: worker.environment,
					classStorage: sharedClassStorage,
					classes: sharedClasses,
					deploymentIdentity: sharedIdentity,
					displayNames,
				});
				for (const [name, registration] of shared) registrations.set(name, registration);
			}
			const facets =
				facetHost === undefined
					? undefined
					: createDurableObjectFacetActorDefinition({
							bindings: worker.environment,
							facetHost,
						});
			const registry = await (
				dependencies.startRegistry ?? startDurableObjectRegistry
			)({
				internalActors: {
					...internalActors,
					...(facets === undefined ? {} : { [facets.actorName]: facets.definition }),
				},
				...(message.rivetClientOnly === true ? { clientOnly: true } : {}),
				...(message.rivetEndpoint === undefined ? {} : { endpoint: message.rivetEndpoint }),
				namespace: message.rivetNamespace,
				poolName:
					message.session?.workers.find((entry) => entry.name === message.session?.self)
						?.poolName ?? primaryRivetPoolName,
				// Every Worker of a session finds the one Engine of the session's storage.
				// The port is a local concern, so the absolute storage path seeds it:
				// projects whose Workers share a name and environment get other ports.
				portSeed: resolve(message.rivetStoragePath),
				registrations,
				...(tailServices === undefined ? {} : { services: tailServices }),
				storagePath: message.rivetStoragePath,
			});
			durableObjectRegistry = registry;
			// A queue actor that slept or ran in an earlier `orange dev` process starts
			// its consumer loop again only when something wakes it.
			for (const consumer of queueConsumers) {
				callQueue(consumer.queueName, "wake", []).catch((error: unknown) => {
					send({ ...errorDetails(error), type: "background-error" });
				});
			}
			// The same holds for the tail actor, which then reads the events that its stream
			// got while this Worker was not running.
			if (tailConsumer && selfName !== undefined) {
				await registry.client
					.getOrCreate(hostedBy(tailActorName, message.session?.self), [selfName])
					.action({ args: [], name: "wake" })
					.catch((error: unknown) => {
						send({ ...errorDetails(error), type: "background-error" });
					});
			}
			// From inside the registry start, so it must not wait for that start.
			await (async () => await tailAppender?.prepare(poolClient(servicesPoolName)))().catch((error: unknown) => {
				send({ ...errorDetails(error), type: "background-error" });
			});
		})().catch((error: unknown) => {
			registryStart = undefined;
			throw error;
		});
		return registryStart;
	};
	if (
		message.durableObjectManifest !== undefined ||
		runtimeBindings.internalClassNames.size > 0 ||
		Object.keys(internalActors).length > 0 ||
		tailAppender !== undefined ||
		tailServices !== undefined ||
		message.bindingConfigurations.some(
			(binding) =>
				binding.type === "durable_object_namespace" ||
				(binding.type === "workflow" && binding.scriptName !== undefined),
		)
	) {
		await startRegistry();
	}
	if (cacheEnabled) {
		// Bound to startup, so an engine started by a request does not inherit
		// that request's async context.
		const startRegistryOutsideRequest = AsyncResource.bind(startRegistry);
		const cacheNamespace = createDurableObjectNamespace({
			className: cacheClassName,
			deploymentIdentity: message.deploymentIdentity,
			resolveActor,
		});
		configureCacheStorage((cacheName) => {
			const fetcher = internalObjectFetcher(cacheNamespace, cacheName);
			return new CacheActorBackend({
				async fetch(input, init) {
					await startRegistryOutsideRequest();
					return await fetcher.fetch(input, init);
				},
			});
		});
	}
	const closeRegistry = async (): Promise<void> => {
		// Appends need the registry, so they get a moment before it closes.
		await tailAppender?.close(2_000);
		closing = true;
		await registryStart?.catch(() => undefined);
		await durableObjectRegistry?.close();
	};
	const webSocketUpgrades = new NetworkWebSocketUpgrades();
	const reportRequest = (
		incoming: IncomingMessage,
		status: number,
		startedAt: number,
	): void => {
		send({
			durationMs: performance.now() - startedAt,
			method: incoming.method ?? "GET",
			path: incoming.url ?? "/",
			status,
			type: "request",
		});
	};
	const server = createServer((incoming, outgoing) => {
		const startedAt = performance.now();
		void (async () => {
			try {
				const requestAbort = new AbortController();
				incoming.once("aborted", () => requestAbort.abort());
				outgoing.once("close", () => {
					if (!outgoing.writableEnded) requestAbort.abort();
					// A client that disconnects before the response starts gets no log line.
					if (outgoing.headersSent) {
						reportRequest(incoming, outgoing.statusCode, startedAt);
					}
				});
				const body = requestBody(incoming);
				const request = new Request(requestUrl(incoming, message.host, message.trustForwardedProto === true), {
					...(body === undefined ? {} : { body }),
					cf: inboundRequestCf(incoming),
					headers: requestHeaders(incoming),
					method: incoming.method ?? "GET",
					signal: requestAbort.signal,
				});
				// `orange dev` is the mode without an external Engine. It takes mail as `wrangler dev` does,
				// and checks ORANGE_EMAIL_INBOUND_SECRET when it is set. A deployed Worker takes mail only
				// with the secret, so nobody can forge its mail. Nobody may fire its crons over HTTP.
				const localDevelopment = message.rivetEndpoint === undefined;
				if (request.method === "POST" && new URL(request.url).pathname === inboundEmailPath) {
					const secret = runtimeSettings()[inboundSecretSetting];
					const configured = secret !== undefined && secret.length > 0;
					if (localDevelopment || configured) {
						await writeResponse(
							outgoing,
							configured && !inboundEmailAuthorized(request, secret)
								? unauthorizedInboundEmail()
								: await worker.dispatchEmail(request),
						);
						return;
					}
				}
				const scheduled = localDevelopment
					? scheduledRoute(request, message.testScheduled === true)
					: undefined;
				if (scheduled !== undefined) {
					await writeResponse(outgoing, await scheduled(runScheduled));
					return;
				}
				const migration = cloudflareMigrationRoute(request, worker.environment);
				if (migration !== undefined) {
					await writeResponse(outgoing, await migration);
					return;
				}
				// Awaiting when there are no assets would start the Worker inside a promise
				// reaction, where Node.js runs nextTick callbacks only after the microtask queue.
				const assetResponse = assets === undefined ? undefined : await assets.route(request);
				if (assetResponse !== undefined) {
					await writeResponse(outgoing, assetResponse);
					return;
				}
				const dispatch = await worker.dispatch(request, undefined);
				const sent = writeResponse(outgoing, dispatch.response);
				// The event and its /tmp live until the response is sent and waitUntil() settles.
				void Promise.allSettled([sent, dispatch.waitUntil]).then(() => dispatch.end());
				await sent;
				reportWaitUntil(dispatch.waitUntil);
			} catch (error: unknown) {
				send({ ...errorDetails(error), type: "request-error" });
				if (!outgoing.headersSent) {
					outgoing.statusCode = 500;
					outgoing.setHeader("content-type", "text/plain; charset=utf-8");
				}
				if (outgoing.headersSent) {
					outgoing.destroy(error instanceof Error ? error : undefined);
				} else {
					outgoing.end("Internal Server Error");
				}
			}
		})();
	});
	server.on("upgrade", (incoming, socket, head) => {
		const startedAt = performance.now();
		void (async () => {
			let workerSocket: WebSocket | null = null;
			try {
				const request = new Request(requestUrl(incoming, message.host, message.trustForwardedProto === true), {
					cf: inboundRequestCf(incoming),
					headers: requestHeaders(incoming),
					method: incoming.method ?? "GET",
				});
				// An asset is never a WebSocket, so the upgrade fails with its response.
				const assetResponse = assets === undefined ? undefined : await assets.route(request);
				if (assetResponse !== undefined) {
					await writeRejectedUpgrade(socket, assetResponse);
					reportRequest(incoming, assetResponse.status, startedAt);
					return;
				}
				const dispatch = await worker.dispatch(request, undefined);
				reportWaitUntil(dispatch.waitUntil);
				// The event and its /tmp live until the socket closes and waitUntil() settles.
				endFetchEventWhenSocketCloses(socket, dispatch.waitUntil, dispatch.end);
				const response = dispatch.response;
				if (response.status !== 101 || response.webSocket === null) {
					await writeRejectedUpgrade(socket, response);
					reportRequest(incoming, response.status, startedAt);
					return;
				}
				workerSocket = response.webSocket;
				webSocketUpgrades.coupleResponse(
					incoming,
					socket,
					head,
					response,
					workerSocket,
					(error) => send({ ...errorDetails(error), type: "request-error" }),
					() => reportRequest(incoming, 101, startedAt),
				);
			} catch (error: unknown) {
				if (workerSocket !== null) closeUncoupledWorkerWebSocket(workerSocket);
				send({ ...errorDetails(error), type: "request-error" });
				writeUpgradeFailure(socket);
				reportRequest(incoming, 500, startedAt);
			}
		})();
	});
	try {
		await new Promise<void>((resolveListen, rejectListen) => {
			server.once("error", rejectListen);
			server.listen(message.port, message.host, () => {
				server.off("error", rejectListen);
				resolveListen();
			});
		});
	} catch (error: unknown) {
		await closeRegistry();
		throw error;
	}
	// A Rivet cluster scrapes the runner's metrics. A local Engine has no scraper.
	const metricsPort = externalEngine ? metricsPortFromEnvironment(process.env) : undefined;
	const metricsServer =
		metricsPort === undefined
			? undefined
			: await startMetricsServer(metricsPort, async () => {
					if (durableObjectRegistry === undefined) {
						return new Response("registry not started\n", { status: 503 });
					}
					return await durableObjectRegistry.prometheusMetrics();
				});
	// The cron actor runs in this process.
	const cronSync = new AbortController();
	if (durableObjectRegistry !== undefined && (crons.length > 0 || staleCronJobs)) {
		const registry = durableObjectRegistry;
		const key = [...cronActorKey, ...cronKeyScope];
		const sync = async (): Promise<void> => {
			if (crons.length > 0) {
				// Written before the sync, so a crash mid-sync still leaves the marker.
				if (!externalEngine) {
					await mkdir(message.rivetStoragePath, { recursive: true });
					await writeFile(cronJobsMarker, "");
				}
				cronNextRuns = await syncCronTriggers(registry.client.getOrCreate(cronName, key), crons);
				return;
			}
			try {
				await syncCronTriggers(registry.client.get(cronName, key), crons);
			} catch (error: unknown) {
				// No cron actor means no jobs to delete.
				if (!isRivetActorNotFound(error)) throw error;
			}
			await rm(cronJobsMarker, { force: true });
		};
		if (externalEngine) {
			// The Engine is not this process's to fix, so a failed sync must not
			// stop the Worker from serving requests.
			void syncCronTriggersInBackground(sync, cronSync.signal, (error) =>
				send({ ...errorDetails(error), type: "background-error" }),
			);
		} else {
			try {
				await sync();
			} catch (error: unknown) {
				server.close();
				await closeRegistry();
				throw error;
			}
		}
	}
	const address = server.address();
	if (address === null || typeof address === "string") {
		await closeRegistry();
		throw new Error("Runtime HTTP server did not expose a TCP address");
	}
	let sessionServer: SessionServer | undefined;
	if ((message.session?.workers.length ?? 0) > 1) {
		try {
			sessionServer = await startSessionServer({
				host: "127.0.0.1",
				reportError: (error) => send({ ...errorDetails(error), type: "request-error" }),
				services: worker.services,
				token: sessionWorkers.token,
			});
		} catch (error: unknown) {
			server.close();
			await closeRegistry();
			throw error;
		}
	}
	send({
		cronNextRuns,
		host: message.host,
		...(sessionServer === undefined ? {} : { internalAddress: sessionServer.address }),
		port: address.port,
		type: "ready",
	});
	let closePromise: Promise<void> | undefined;
	return {
		host: message.host,
		port: address.port,
		sessionWorkers,
		close(reason): Promise<void> {
			closePromise ??= (async () => {
				cronSync.abort();
				for (const loader of runtimeBindings.workerLoaders) loader.close();
				const serverClose = new Promise<void>((resolveClose, rejectClose) => {
					server.close((error) => {
						if (error === undefined) {
							resolveClose();
						} else {
							rejectClose(error);
						}
					});
				});
				// Accepted Durable Object sockets drain first, while their actors still run. Without
				// any, this ends at once.
				await drainWebSockets(acceptedWebSocketDrainClosers());
				const webSocketClose = webSocketUpgrades.close();
				const hooksClose = runRuntimeCloseHooks().then((results) => {
					for (const result of results) {
						if (result.status === "rejected") send({ ...errorDetails(result.reason), type: "background-error" });
					}
				});
				await Promise.all([
					serverClose,
					webSocketClose,
					sessionServer?.close(),
					metricsServer?.close(),
					closeRegistry(),
					hooksClose,
				]);
				await rm(bundleRoot, { force: true, recursive: true });
				send({ reason, type: "stopped" });
			})();
			return closePromise;
		},
	};
}

// The callbacks live as long as the WebSocket, so they hold only the socket and `end`, not the
// request, response, and IncomingMessage of the upgrade.
function endFetchEventWhenSocketCloses(
	socket: Duplex,
	waitUntil: Promise<unknown>,
	end: () => void,
): void {
	const closed = socket.destroyed
		? Promise.resolve()
		: new Promise<void>((resolveClosed) => socket.once("close", () => resolveClosed()));
	void Promise.all([closed, waitUntil]).then(end);
}

export async function runRuntimeProcess(): Promise<void> {
	let runtime: Awaited<ReturnType<typeof startRuntime>> | undefined;
	let latestSessionWorkers: RuntimeSessionWorker[] | undefined;
	let resolveCompletion: (() => void) | undefined;
	const completion = new Promise<void>((resolveValue) => {
		resolveCompletion = resolveValue;
	});
	// Workerd emits an unhandledrejection event instead of terminating the
	// isolate. Until Orange implements that global event, preserve the runtime
	// lifetime and surface the rejection through the existing dev diagnostic.
	// https://github.com/cloudflare/cloudflare-docs/blob/e65ba8b1fa64a5dc7c5c42a96c455398945cdf5e/src/content/docs/workers/runtime-apis/web-standards.mdx#L147-L151
	process.on("unhandledRejection", (reason: unknown) => {
		send({ ...errorDetails(reason), type: "background-error" });
	});
	// Workerd logs an exception that escapes an async task and keeps serving
	// other events, so one throwing callback must not end the runtime process.
	// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/io/io-context.c%2B%2B#L1291-L1307
	process.on("uncaughtException", (error: unknown) => {
		send({ ...errorDetails(error), type: "background-error" });
	});

	async function stop(reason: RuntimeStoppedMessage["reason"]): Promise<void> {
		if (runtime !== undefined) {
			await runtime.close(reason);
		}
		// `orange dev` exits after this process, so the Engine must exit first.
		await stopRivetEngineAfterLastDevSession();
		resolveCompletion?.();
	}

	process.on("message", (rawMessage: unknown) => {
		void (async () => {
			const message = parseRuntimeParentMessage(rawMessage);
			if (message.type === "session-workers") {
				latestSessionWorkers = message.workers;
				runtime?.sessionWorkers.update(message.workers);
				return;
			}
			if (message.type === "shutdown") {
				await stop("parent");
				return;
			}
			if (runtime !== undefined) {
				throw new Error("Runtime process received more than one start message");
			}
			runtime = await startRuntime(message);
			// The session may have changed while this runtime started.
			if (latestSessionWorkers !== undefined) {
				runtime.sessionWorkers.update(latestSessionWorkers);
			}
		})().catch((error: unknown) => {
			send({ ...errorDetails(error), type: "fatal" });
			process.exitCode = 1;
			resolveCompletion?.();
		});
	});
	process.once("SIGINT", () => void stop("SIGINT"));
	process.once("SIGTERM", () => void stop("SIGTERM"));
	// The IPC channel closes when the parent dies, so the runtime stops with it.
	process.once("disconnect", () => void stop("parent"));
	// Runs on every exit, also one during startup before a registry exists.
	process.once("exit", signalRivetEngineStopAfterLastDevSession);
	await completion;
	if (process.connected) {
		process.disconnect();
	}
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
	await runRuntimeProcess();
	process.exit(process.exitCode ?? 0);
}
