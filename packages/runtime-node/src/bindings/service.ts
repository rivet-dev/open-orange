import { readerOf } from "../internal/stream-methods.js";
import {
	createExecutionContext,
	currentExecutionContext,
	releaseExecutionContext,
	runInExecutionContext,
	type ExecutionContext,
} from "../context.js";
import { createLoopbackDurableObjectClass } from "./durable-objects/durable-object-class.js";
import { isDurableObjectStub } from "./durable-objects/namespace.js";
import { isCapnWebRpcStub } from "./durable-objects/rpc/capnweb.js";
import { defaultQueueHandler, dispatchQueue } from "../events/queue.js";
import { defaultScheduledHandler, dispatchScheduled } from "../events/scheduled.js";
import { validateServedResponse } from "../events/fetch.js";
import type { QueueEnvelope } from "./queues/envelope.js";
import { deserializeWorkerdWire } from "./queues/workerd-wire.js";
import { decodeBody, manualBodyCoding } from "../globals/content-encoding.js";
import {
	copyBodyChunk,
	Headers,
	Request,
	requestBodyLength,
	Response,
	requestBodyCanRewind,
	setResponseUrlList,
	type RequestInfo,
	type RequestInit,
} from "../globals/http.js";
import { URL } from "../globals/url.js";
import { AbortController, ReadableStream } from "../globals/native.js";
import { waitForOutputGate } from "../internal/output-gate.js";
import {
	fetchTraceEvent,
	finishEventTrace,
	startEventTrace,
	traceEventException,
	traceFetchResponse,
	type TraceEventRecord,
} from "../internal/tail-trace.js";
import {
	connectInProcess,
	type Socket,
	type SocketAddress,
	type SocketOptions,
} from "../modules/cloudflare-sockets/socket.js";
import { extendsDurableObject } from "../modules/cloudflare-workers/durable-object.js";
import { isWorkerEntrypointClass } from "../modules/cloudflare-workers/worker-entrypoint.js";
import {
	callLocal,
	createStub,
	failedOutcome,
	registerForeignStub,
	transferError,
	type CallOutcome,
	type Capability,
	type LookupRules,
} from "../rpc/loopback.js";

// The Worker that service bindings call into. Service bindings are created
// before the Worker module loads, so they resolve it lazily.
export interface LoopbackWorker {
	readonly environment: Record<string, unknown>;
	readonly exports: Record<string, unknown>;
	readonly contextExports: object;
}

export class LoopbackServices {
	#worker: LoopbackWorker | undefined;

	attach(worker: LoopbackWorker): void {
		this.#worker = worker;
	}

	worker(): LoopbackWorker {
		if (this.#worker === undefined) {
			throw new Error("Service bindings cannot be used before the Worker module loads");
		}
		return this.#worker;
	}

	binding(entrypoint: string | undefined, props?: unknown): object {
		return createServiceStub(localServiceBackend(this, entrypoint ?? "default"), props);
	}
}

// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/worker-rpc.c%2B%2B#L2371-L2389
const entrypointReservedNames: ReadonlySet<string> = new Set([
	"alarm",
	"connect",
	"constructor",
	"dup",
	"fetch",
	"webSocketClose",
	"webSocketError",
	"webSocketMessage",
]);

function exportedEntrypoint(services: LoopbackServices, name: string): unknown {
	const worker = services.worker();
	if (!Object.hasOwn(worker.exports, name)) {
		throw new TypeError(`Worker has no entrypoint named "${name}"`);
	}
	return worker.exports[name];
}

interface EntrypointInstance {
	readonly context: ExecutionContext;
	readonly drain: () => Promise<unknown>;
	readonly environment: Record<string, unknown>;
	readonly isClass: boolean;
	readonly target: object;
}

function instantiate(
	services: LoopbackServices,
	name: string,
	props: unknown,
	trace?: TraceEventRecord,
): EntrypointInstance {
	const worker = services.worker();
	const exported = exportedEntrypoint(services, name);
	const controller = createExecutionContext({
		entrypointCall: { caller: currentExecutionContext() },
		exports: worker.contextExports,
		props,
	});
	const context = controller.context;
	if (trace !== undefined) startEventTrace(context, trace, name);
	// The callee's event ends once its waitUntil() tasks settle, which removes its /tmp.
	const drain = async (): Promise<unknown> => {
		const outcomes = await controller.drainWaitUntil();
		finishEventTrace(context);
		controller.end();
		return outcomes;
	};
	if (isWorkerEntrypointClass(exported)) {
		return {
			context,
			drain,
			environment: worker.environment,
			isClass: true,
			target: runInExecutionContext(context, () =>
				Reflect.construct(exported, [context, worker.environment]),
			),
		};
	}
	if ((typeof exported === "object" && exported !== null) || typeof exported === "function") {
		return {
			context,
			drain,
			environment: worker.environment,
			isClass: false,
			target: exported,
		};
	}
	throw new TypeError(`Worker export "${name}" is not an entrypoint`);
}

// An object-syntax handler receives `(arg, env, ctx)`, so RPC inserts env and
// ctx after the single client argument.
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/worker-rpc.c%2B%2B#L1723-L1800
function invokeInsertingEnvCtx(
	methodName: string,
	member: Function,
	holder: object,
	args: unknown[],
	environment: Record<string, unknown>,
	context: ExecutionContext,
): unknown {
	const arity = Math.max(member.length, 3);
	if (arity !== 3) {
		throw new TypeError(
			`Cannot call handler function "${methodName}" over RPC because it has the wrong number of arguments. A simple function handler can only be called over RPC if it has exactly the arguments (arg, env, ctx), where only the first argument comes from the client. To support multi-argument RPC functions, use class-based syntax (extending WorkerEntrypoint) instead.`,
		);
	}
	if (args.length !== 1) {
		throw new TypeError(
			`Attempted to call RPC function "${methodName}" with the wrong number of arguments. When calling a top-level handler function that is not declared as part of a class, you must always send exactly one argument. In order to support variable numbers of arguments, the server must use class-based syntax (extending WorkerEntrypoint) instead.`,
		);
	}
	return Reflect.apply(member, holder, [args[0], environment, context]);
}

// Each top-level call on a service binding is a new event with its own
// execution context and, for class entrypoints, a new instance.
class EntrypointCapability implements Capability {
	constructor(
		readonly services: LoopbackServices,
		readonly name: string,
		readonly props: unknown,
	) {}

	call(path: readonly string[], args: readonly unknown[] | undefined): CallOutcome {
		let instance: EntrypointInstance;
		try {
			instance = instantiate(this.services, this.name, this.props);
		} catch (error: unknown) {
			return failedOutcome(error);
		}
		const rules: LookupRules = {
			allowInstanceProperties: !instance.isClass,
			reserved: entrypointReservedNames,
		};
		const insertEnvCtx = !instance.isClass && path.length === 1;
		// The event ends after its waitUntil() tasks, once the caller no longer
		// needs the callee. Its leftover stubs are then disposed.
		let ended = false;
		const end = (): void => {
			if (ended) return;
			ended = true;
			void instance.drain().then(() => releaseExecutionContext(instance.context));
		};
		const outcome = callLocal(
			instance.target,
			path,
			args,
			rules,
			{
				context: instance.context,
				end,
				run: (callback) => runInExecutionContext(instance.context, callback),
			},
			insertEnvCtx
				? (member, holder, received) =>
						invokeInsertingEnvCtx(
							path[0] ?? "",
							member,
							holder,
							received,
							instance.environment,
							instance.context,
						)
				: undefined,
		);
		return outcome;
	}

	dup(): Capability {
		return this;
	}

	dispose(): void {}
}

function missingMethod(name: string): TypeError {
	return new TypeError(`The RPC receiver does not implement the method "${name}".`);
}

// Runs one RPC call that another Worker of the session sent to an entrypoint
// of this Worker. Like a call through a local binding, it is a new event with
// its own execution context and, for a class entrypoint, a new instance. The
// result is returned as is, because the RPC transport serializes it.
export async function invokeEntrypointMethod(
	services: LoopbackServices,
	name: string,
	props: unknown,
	methodName: string,
	args: readonly unknown[] | undefined,
): Promise<unknown> {
	const instance = instantiate(services, name, props);
	try {
		return await runInExecutionContext(instance.context, async () => {
			if (entrypointReservedNames.has(methodName) || Reflect.has(Object.prototype, methodName)) {
				throw missingMethod(methodName);
			}
			// A class entrypoint exposes only its prototype members over RPC.
			if (instance.isClass && Object.hasOwn(instance.target, methodName)) {
				throw missingMethod(methodName);
			}
			if (!Reflect.has(instance.target, methodName)) throw missingMethod(methodName);
			const member: unknown = Reflect.get(instance.target, methodName);
			if (args === undefined) return member;
			if (typeof member !== "function") {
				throw new TypeError(`"${methodName}" is not a function.`);
			}
			return instance.isClass
				? await Reflect.apply(member, instance.target, [...args])
				: await invokeInsertingEnvCtx(
						methodName,
						member,
						instance.target,
						[...args],
						instance.environment,
						instance.context,
					);
		});
	} finally {
		void instance.drain();
	}
}

function clientDisconnected(): DOMException {
	return new DOMException("The client has disconnected", "AbortError");
}

// The callee sees its own request signal, which aborts when the caller's
// signal aborts or the caller cancels the response body. The signal does not
// carry over to requests the callee builds from it.
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/tests/request-signal-enabled.js#L116-L243
export async function fetchEntrypoint(
	services: LoopbackServices,
	name: string,
	props: unknown,
	request: Request,
): Promise<Response> {
	const instance = instantiate(services, name, props, fetchTraceEvent(request));
	const callerSignal = request.signal;
	const callee = new AbortController();
	// As on workerd, the callee gets redirect "manual", whatever the caller's request had.
	// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/global-scope.c%2B%2B#L355-L357
	const calleeRequest = new Request(request, { redirect: "manual", signal: null });
	// Workerd sends a stream's declared expectedLength as Content-Length.
	// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/tests/streams-test.js#L19-L96
	const bodyLength = requestBodyLength(request);
	if (bodyLength !== undefined && !calleeRequest.headers.has("content-length")) {
		calleeRequest.headers.set("content-length", String(bodyLength));
	}
	// A stream with no declared length goes out chunked, as over HTTP.
	if (
		bodyLength === undefined &&
		!requestBodyCanRewind(request) &&
		!calleeRequest.headers.has("content-length") &&
		!calleeRequest.headers.has("transfer-encoding")
	) {
		calleeRequest.headers.set("transfer-encoding", "chunked");
	}
	Object.defineProperty(calleeRequest, "signal", {
		configurable: true,
		enumerable: true,
		value: callee.signal,
	});
	const disconnect = (): void => callee.abort(clientDisconnected());
	const handled = runInExecutionContext(instance.context, async (): Promise<Response> => {
		const fetch: unknown = Reflect.get(instance.target, "fetch");
		if (typeof fetch !== "function") {
			throw new Error("Handler does not export a fetch() function.");
		}
		const response: unknown = instance.isClass
			? await Reflect.apply(fetch, instance.target, [calleeRequest])
			: await Reflect.apply(fetch, instance.target, [
					calleeRequest,
					instance.environment,
					instance.context,
				]);
		if (!(response instanceof Response)) {
			throw new TypeError("Incorrect type for Promise: the Promise did not resolve to 'Response'.");
		}
		validateServedResponse(response);
		traceFetchResponse(instance.context, response.status);
		return response;
	}).catch((error: unknown) => {
		traceEventException(instance.context, error);
		return Promise.reject(transferError(error));
	});
	void handled.then(
		() => instance.drain(),
		() => instance.drain(),
	);
	const aborted = Promise.withResolvers<never>();
	aborted.promise.catch(() => undefined);
	const onAbort = (): void => {
		disconnect();
		aborted.reject(callerSignal.reason);
	};
	if (callerSignal.aborted) onAbort();
	else callerSignal.addEventListener("abort", onAbort, { once: true });
	try {
		const response = await Promise.race([handled, aborted.promise]);
		if (response.status === 101) return response;
		// Workerd sends a manually encoded body as it is, and the caller's
		// fetch() decodes it.
		const coding = manualBodyCoding(response);
		const body =
			coding === undefined || response.body === null
				? response.body
				: decodeBody(response.body, coding);
		// The caller always gets its own Response, never the callee's object.
		if (body === null) {
			return new Response(null, {
				headers: response.headers,
				status: response.status,
				statusText: response.statusText,
			});
		}
		const reader = readerOf(body);
		// The caller reads the body as bytes, as from a network response, so it
		// supports BYOB reads whatever kind of stream the callee returned.
		return new Response(
			new ReadableStream({
				type: "bytes",
				async pull(controller: ReadableByteStreamController) {
					for (;;) {
						const result = await reader.read();
						if (result.done) {
							controller.close();
							return;
						}
						const bytes = copyBodyChunk(result.value);
						if (bytes.byteLength === 0) continue;
						controller.enqueue(bytes);
						return;
					}
				},
				// The caller's cancel completes once the callee is disconnected. It
				// does not wait for the callee's stream to finish canceling.
				cancel(reason: unknown) {
					disconnect();
					reader.cancel(reason).catch(() => undefined);
				},
			}),
			{ headers: response.headers, status: response.status, statusText: response.statusText },
		);
	} finally {
		callerSignal.removeEventListener("abort", onAbort);
	}
}

// A service binding's connect() opens a socket to the entrypoint's connect()
// handler. The handler gets the other end of the socket, and the handler's end
// closes when the handler's promise settles.
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/global-scope.c%2B%2B#L220-L262
export function connectEntrypoint(
	services: LoopbackServices,
	name: string,
	props: unknown,
	address: string | SocketAddress,
	options: SocketOptions | undefined,
): Socket {
	// A Durable Object's connection opens after its earlier writes are durable.
	// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/sockets.c%2B%2B#L456-L461
	const outputLock = waitForOutputGate();
	return connectInProcess(address, options, async (accept) => {
		await outputLock;
		const instance = instantiate(services, name, props);
		try {
			const connect: unknown = Reflect.get(instance.target, "connect");
			if (typeof connect !== "function") {
				throw new Error("Handler does not export a connect() function.");
			}
			const socket = accept();
			await runInExecutionContext(instance.context, () =>
				instance.isClass
					? Reflect.apply(connect, instance.target, [socket])
					: Reflect.apply(connect, instance.target, [
							socket,
							instance.environment,
							instance.context,
						]),
			);
		} finally {
			void instance.drain();
		}
	});
}

// Where a service stub's calls go: an entrypoint of this Worker, or an
// entrypoint of another Worker of the `orange dev` session.
export interface ServiceStubBackend {
	connect(
		address: string | SocketAddress,
		options: SocketOptions | undefined,
		props: unknown,
	): Socket;
	fetch(request: Request, props: unknown): Promise<Response>;
	// Undefined for another Worker of the `orange dev` session.
	queue?(queueName: string, messages: unknown, metadata: unknown): Promise<ServiceQueueResult>;
	// The RPC stub that serves every member other than fetch() and connect().
	root(props: unknown): object;
	// Undefined for another Worker of the `orange dev` session.
	scheduled?(options: unknown, props: unknown): Promise<ServiceScheduledResult>;
}

export interface ServiceScheduledResult {
	noRetry: boolean;
	outcome: "exception" | "ok";
}

// `Fetcher.scheduled()`: the time defaults to now and the cron to an empty string.
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/http.c%2B%2B#L2753
async function scheduledEntrypoint(
	services: LoopbackServices,
	name: string,
	options: unknown,
	props: unknown,
): Promise<ServiceScheduledResult> {
	const option = (key: string): unknown =>
		typeof options === "object" && options !== null ? Reflect.get(options, key) : undefined;
	const time = option("scheduledTime");
	const cron = option("cron");
	const worker = services.worker();
	const { noRetry, outcome } = await dispatchScheduled({
		cron: typeof cron === "string" ? cron : "",
		environment: worker.environment,
		exports: worker.contextExports,
		handler: defaultScheduledHandler(exportedEntrypoint(services, name)),
		props,
		scheduledTime: time === undefined ? Date.now() : new Date(time as Date | number).getTime(),
	});
	return { noRetry, outcome };
}

export interface ServiceQueueResult {
	ackAll: boolean;
	explicitAcks: string[];
	outcome: "exception" | "ok";
	retryBatch: { delaySeconds?: number; retry: boolean };
	retryMessages: Array<{ delaySeconds?: number; msgId: string }>;
}

// `Fetcher.queue()`: one message must have exactly one of `body` and `serializedBody`.
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/http.c%2B%2B#L2702
function serviceQueueEnvelopes(messages: unknown): QueueEnvelope[] {
	if (!Array.isArray(messages)) throw new TypeError("queue() messages must be an array");
	return messages.map((message: unknown) => {
		if (typeof message !== "object" || message === null) {
			throw new TypeError("queue() messages must be objects");
		}
		const body: unknown = Reflect.get(message, "body");
		const serialized: unknown = Reflect.get(message, "serializedBody");
		if ((body === undefined) === (serialized === undefined)) {
			throw new TypeError("Expected one of body or serializedBody for each message");
		}
		const attempts: unknown = Reflect.get(message, "attempts");
		return {
			attempts: (typeof attempts === "number" ? attempts : 1) - 1,
			body: "",
			contentType: "v8",
			id: String(Reflect.get(message, "id")),
			timestamp: new Date(Reflect.get(message, "timestamp") as Date | number).getTime(),
			decoded: {
				value: serialized === undefined ? structuredClone(body) : deserializeWorkerdWire(wireBytes(serialized)),
			},
		};
	});
}

function wireBytes(value: unknown): Uint8Array {
	if (value instanceof ArrayBuffer) return new Uint8Array(value);
	if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
	throw new TypeError("serializedBody must be an ArrayBuffer or a view of one");
}

async function queueEntrypoint(
	services: LoopbackServices,
	name: string,
	queueName: string,
	messages: unknown,
	metadata: unknown,
): Promise<ServiceQueueResult> {
	const exception: ServiceQueueResult = {
		ackAll: false,
		explicitAcks: [],
		outcome: "exception",
		retryBatch: { retry: false },
		retryMessages: [],
	};
	let envelopes: QueueEnvelope[];
	try {
		envelopes = serviceQueueEnvelopes(messages);
	} catch (error: unknown) {
		// workerd fails the event when a body can't be read, and a call without a body rejects.
		if (error instanceof TypeError && error.message.startsWith("Expected one of")) throw error;
		return exception;
	}
	const worker = services.worker();
	const metrics: unknown = typeof metadata === "object" && metadata !== null ? Reflect.get(metadata, "metrics") : undefined;
	const metric = (key: string): unknown =>
		typeof metrics === "object" && metrics !== null ? Reflect.get(metrics, key) : undefined;
	const oldest = metric("oldestMessageTimestamp");
	const result = await dispatchQueue({
		envelopes,
		environment: worker.environment,
		exports: worker.contextExports,
		handler: defaultQueueHandler(exportedEntrypoint(services, name)),
		metadata: {
			metrics: {
				backlogBytes: Number(metric("backlogBytes") ?? 0),
				backlogCount: Number(metric("backlogCount") ?? 0),
				...(oldest === undefined ? {} : { oldestMessageTimestamp: new Date(oldest as Date | number) }),
			},
		},
		queueName,
	});
	return {
		ackAll: result.ackAll,
		explicitAcks: [...result.explicitAcks],
		outcome: result.errors.length > 0 ? "exception" : "ok",
		retryBatch: result.retryBatch,
		retryMessages: [...result.retries].map(([msgId, options]) => ({ ...options, msgId })),
	};
}

interface ServiceStubTarget {
	readonly backend: ServiceStubBackend;
	readonly props: unknown;
}

function localServiceBackend(services: LoopbackServices, name: string): ServiceStubBackend {
	return {
		connect: (address, options, props) =>
			connectEntrypoint(services, name, props, address, options),
		fetch: (request, props) => fetchEntrypoint(services, name, props, request),
		queue: (queueName, messages, metadata) => queueEntrypoint(services, name, queueName, messages, metadata),
		root: (props) => createStub(new EntrypointCapability(services, name, props)),
		scheduled: (options, props) => scheduledEntrypoint(services, name, options, props),
	};
}

const redirectStatuses: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 20;

// A Fetcher's fetch() follows redirects through the same target like
// workerd's fetch(): it drops Authorization when a redirect leaves the
// origin, sends a buffer-backed body again on 307 and 308, and rejects a
// stream body that would have to be sent again.
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/http.c%2B%2B#L2031-L2150
export async function fetchFollowingRedirects(
	request: Request,
	send: (request: Request) => Promise<Response>,
): Promise<Response> {
	let current = request;
	let replayable =
		request.body !== null && requestBodyCanRewind(request) ? request.clone() : undefined;
	const urls = [request.url];
	for (;;) {
		const hasBody = current.body !== null;
		const response = await send(current);
		const location = response.headers.get("location");
		if (
			current.redirect !== "follow" ||
			!redirectStatuses.has(response.status) ||
			location === null
		) {
			if (response.status !== 101) setResponseUrlList(response, urls);
			return response;
		}
		let target: URL;
		try {
			target = new URL(location, current.url);
		} catch {
			throw new TypeError("Invalid Location header; unable to follow redirect.");
		}
		if (urls.length - 1 >= MAX_REDIRECTS) throw new TypeError("Too many redirects.");
		const headers = new Headers(current.headers);
		if (target.origin !== new URL(current.url).origin) headers.delete("authorization");
		if (response.status !== 303 && hasBody && replayable === undefined) {
			throw new TypeError(
				"A request with a one-time-use body (it was initialized from a stream, not a buffer) encountered a redirect requiring the body to be retransmitted. To avoid this error in the future, construct this request from a buffer-like body initializer.",
			);
		}
		const changesToGet =
			(response.status === 303 && current.method !== "HEAD") ||
			((response.status === 301 || response.status === 302) && current.method === "POST");
		let body: ReadableStream<Uint8Array> | null = null;
		if (changesToGet || response.status === 303) {
			replayable = undefined;
		} else if (replayable !== undefined) {
			// Clone first: cloning tees the body and replaces the source stream.
			const next = replayable;
			replayable = next.clone();
			body = next.body;
		}
		urls.push(target.href);
		const init: RequestInit = {
			body,
			headers,
			method: changesToGet ? "GET" : current.method,
			redirect: current.redirect,
		};
		if (body !== null) Reflect.set(init, "duplex", "half");
		current = new Request(target.href, init);
	}
}

const serviceStubs = new WeakMap<object, ServiceStubTarget>();

// `env.SERVICE` for a service binding, and `ctx.exports.Name`. HTTP goes to
// the entrypoint's fetch() handler, and every other name is an RPC method.
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/worker-rpc.c%2B%2B#L2290-L2370
export class ServiceStub {
	constructor() {
		throw new TypeError("Illegal constructor");
	}

	// Cap'n Web on Workers sends native stubs by reference, and recognizes one by this check or by the
	// prototype of the `cloudflare:workers` RpcStub. A Durable Object stub passes this check on workerd.
	// A stub that a Durable Object call returned passes it here because Orange's Cap'n Web needs
	// that stub to keep its own prototype.
	// https://github.com/cloudflare/capnweb/blob/770eec594df59bc44b5e45582f20ed91ea9ffb60/src/core.ts
	static [Symbol.hasInstance](value: unknown): boolean {
		if ((typeof value !== "object" || value === null) && typeof value !== "function") return false;
		return (
			Object.prototype.isPrototypeOf.call(ServiceStub.prototype, value) ||
			isDurableObjectStub(value) ||
			isCapnWebRpcStub(value)
		);
	}
}

export function createServiceStub(backend: ServiceStubBackend, props: unknown): object {
	const root = backend.root(props);
	const members: Record<string, unknown> = {
		connect(address: string | SocketAddress, options?: SocketOptions): Socket {
			return backend.connect(address, options, props);
		},
		fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
			try {
				const request = new Request(input, init);
				// A Durable Object's request leaves after its earlier writes are durable.
				// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/http.c%2B%2B#L1969-L1986
				const outputLock = waitForOutputGate();
				const send = (current: Request): Promise<Response> =>
					backend.fetch(current, props);
				return outputLock === undefined
					? fetchFollowingRedirects(request, send)
					: outputLock.then(() => fetchFollowingRedirects(request, send));
			} catch (error: unknown) {
				return Promise.reject(error);
			}
		},
		queue(queueName: string, messages: unknown, metadata?: unknown): Promise<ServiceQueueResult> {
			if (backend.queue === undefined) {
				return Promise.reject(new TypeError("queue() can't reach another Worker of the session"));
			}
			return backend.queue(queueName, messages, metadata);
		},
		scheduled(options?: unknown): Promise<ServiceScheduledResult> {
			if (backend.scheduled === undefined) {
				return Promise.reject(new TypeError("scheduled() can't reach another Worker of the session"));
			}
			return backend.scheduled(options, props);
		},
		getRpcMethodForTestOnly(method: string): unknown {
			return Reflect.get(root, method);
		},
	};
	// Calling an export stub with options binds props, as with
	// `ctx.exports.Name({ props })`.
	const target = (options?: { props?: unknown }): object =>
		createServiceStub(backend, options?.props);
	const stub = new Proxy(target, {
		apply(_target, _thisArg, args: unknown[]): unknown {
			const options: unknown = args[0];
			return createServiceStub(
				backend,
				typeof options === "object" && options !== null
					? Reflect.get(options, "props")
					: undefined,
			);
		},
		get(_target, property): unknown {
			if (typeof property === "symbol") {
				return property === Symbol.toStringTag ? "ServiceStub" : undefined;
			}
			if (Object.hasOwn(members, property)) return members[property];
			if (property === "then") return undefined;
			return Reflect.get(root, property);
		},
		getPrototypeOf(): object {
			return ServiceStub.prototype;
		},
		has(_target, property): boolean {
			return typeof property === "string" && Object.hasOwn(members, property);
		},
	});
	serviceStubs.set(stub, { backend, props });
	return stub;
}

export function isServiceStub(value: object): boolean {
	return serviceStubs.has(value);
}

registerForeignStub({
	clone(value: object): object {
		const target = serviceStubs.get(value);
		return target === undefined ? value : createServiceStub(target.backend, target.props);
	},
	is: isServiceStub,
});

function hasHandlerMembers(value: object): boolean {
	return Object.values(value).some((member) => typeof member === "function");
}

// Builds `ctx.exports`: entrypoints become loopback service stubs, Durable
// Object classes resolve to their namespace bindings or, without one, to a
// loopback class that facets accept, and other exports keep their module value.
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/global-scope.h#L156-L200
export function createContextExports(
	services: LoopbackServices,
	exports: Record<string, unknown>,
	durableObjectNamespaces: ReadonlyMap<string, unknown>,
): object {
	const result: Record<string, unknown> = {};
	for (const [name, value] of Object.entries(exports)) {
		const namespace = durableObjectNamespaces.get(name);
		if (namespace !== undefined) {
			result[name] = namespace;
		} else if (
			typeof value === "function" &&
			typeof value.prototype === "object" &&
			value.prototype !== null &&
			extendsDurableObject(value.prototype)
		) {
			result[name] = createLoopbackDurableObjectClass(name);
		} else if (
			isWorkerEntrypointClass(value) ||
			(typeof value === "object" && value !== null && hasHandlerMembers(value))
		) {
			result[name] = services.binding(name);
		} else {
			result[name] = value;
		}
	}
	return result;
}

