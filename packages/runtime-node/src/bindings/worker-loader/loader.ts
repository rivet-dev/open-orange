// `env.LOADER` for a `worker_loaders` binding. Dynamic Worker code is
// untrusted, so each one runs as a Node.js process in an agentOS VM, never on
// the host. It shares no globals, module state, or env with the parent
// Worker. Workers RPC between the processes uses Cap'n Web over framed stdio.

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { posix } from "node:path";
import type { Readable } from "node:stream";

import { Request, type RequestInfo, type RequestInit } from "../../globals/http.js";
import { URL } from "../../globals/url.js";
import { createStub, type CallOutcome, type Capability } from "../../rpc/loopback.js";
import { linkModules, type DynamicModule, type DynamicModuleType } from "./modules.js";
import {
	decodeLoaderReply,
	encodeLoaderValue,
	FramedRpcTransport,
	openLoaderSession,
	readFrames,
	RemoteCapability,
} from "./session.js";
import type { CapnWebStub } from "../durable-objects/rpc/capnweb.js";
import { errorMessage, isRecord } from "../unknown-values.js";
import { WorkerLoaderMetrics } from "./metrics.js";

export interface WorkerFile {
	content: string | Uint8Array;
	path: string;
}

// A running dynamic Worker process. Stdin and stdout carry the framed RPC
// stream.
export interface WorkerChild {
	readonly stdout: Readable;
	write(text: string): void;
	kill(): void;
	// `reason` reads like "code 1" or "signal SIGKILL".
	onExit(listener: (reason: string) => void): void;
}

// The agentOS VM that hosts one dynamic Worker.
export interface WorkerHost {
	readonly root: string;
	// Where the dynamic Worker imports each runtime module from.
	readonly moduleRewrites: Readonly<Record<string, string>>;
	writeFiles(files: readonly WorkerFile[]): Promise<void>;
	spawn(): Promise<WorkerChild>;
	// Runs once the dynamic Worker has loaded or failed to load.
	loaded(): void;
	// Runs once the loaded dynamic Worker first has no call in flight, or when
	// it fails to load.
	settled(): void;
	// Disposes the VM. Runs when the process exits or fails to start.
	remove(): Promise<void>;
}

// Where dynamic Worker processes run. `network` is false for
// `globalOutbound: null` or a Fetcher, which never need direct network access.
export interface WorkerLoaderBackend {
	open(network: boolean): Promise<WorkerHost>;
}

export interface WorkerLoaderOptions {
	backend: WorkerLoaderBackend;
	pool: DynamicWorkerPool;
	onDiagnostic(message: string): void;
}

// Workerd caps a Dynamic Worker's code at 64 MiB and its env at 1 MiB. Those are Cloudflare quotas,
// which Orange does not copy.
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/worker-loader.c%2B%2B#L14-L22

const NativeWasmModule: Function = Reflect.get(Reflect.get(globalThis, "WebAssembly"), "Module");

const moduleKeys = ["js", "cjs", "text", "data", "json", "py", "wasm"] as const;

function pythonUnsupported(): TypeError {
	return new TypeError(
		"OpenOrange does not support Python dynamic Workers. Load JavaScript modules instead.",
	);
}

function copyBytes(value: unknown, name: string): Uint8Array {
	if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
	if (ArrayBuffer.isView(value)) {
		return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
	}
	if (value instanceof NativeWasmModule) {
		throw new TypeError(
			`OpenOrange cannot send the compiled WebAssembly.Module "${name}" to a dynamic Worker process. Pass its bytes as { wasm: ArrayBuffer } instead.`,
		);
	}
	throw new TypeError(`Module "${name}" must contain an ArrayBuffer or ArrayBufferView.`);
}

// Mirrors workerd's extractSource(): a string module's type comes from its
// name, and an object module names its type with exactly one key.
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/worker-loader.c%2B%2B#L227-L368
function normalizeModules(mainModule: string, modules: unknown): DynamicModule[] {
	if (!isRecord(modules)) throw new TypeError("Dynamic Worker code must have a modules object.");
	const entries = Object.entries(modules);
	if (entries.length === 0) {
		throw new TypeError("Dynamic Worker code must contain at least one module.");
	}
	const pythonMain = mainModule.endsWith(".py");
	const result: DynamicModule[] = [];
	let totalSize = 0;
	const add = (name: string, type: DynamicModuleType, content: string | Uint8Array): void => {
		totalSize += typeof content === "string" ? Buffer.byteLength(content) : content.byteLength;
		result.push({ content, name, type });
	};
	for (const [name, value] of entries) {
		const normalized = posix.normalize(name);
		if (normalized.startsWith("../") || normalized === ".." || normalized.startsWith("/")) {
			throw new TypeError(`Module name ${JSON.stringify(name)} is outside the Worker bundle.`);
		}
		if (typeof value === "string") {
			if (name.endsWith(".py")) {
				if (!pythonMain) {
					throw new TypeError(
						`Module "${name}" is a Python module, but the main module isn't a Python module.`,
					);
				}
				throw pythonUnsupported();
			}
			if (name.endsWith(".js")) {
				add(name, "esm", value);
				continue;
			}
			const generic = `Module name must end with '.js' or '.py' (or the content must be an object indicating the type explicitly). Got: ${name}`;
			if (name.endsWith(".ts") || name.endsWith(".tsx") || name.endsWith(".jsx")) {
				throw new TypeError(
					`${generic}. If you're trying to load TypeScript, bundle it first with '@cloudflare/worker-bundler' and pass the generated JavaScript modules.`,
				);
			}
			throw new TypeError(generic);
		}
		if (value instanceof NativeWasmModule) {
			copyBytes(value, name);
		}
		if (!isRecord(value)) {
			throw new TypeError(`Module "${name}" must be a string or a module object.`);
		}
		const present = moduleKeys.filter((key) => value[key] !== undefined);
		if (present.length !== 1) {
			throw new TypeError(
				`Each module must contain exactly one of 'js', 'cjs', 'text', 'data', 'json', 'py', or 'wasm'. Module '${name}' contained ${present.length} properties.`,
			);
		}
		const key = present[0];
		const content = value[key ?? "js"];
		switch (key) {
			case "js":
			case "cjs":
			case "text":
				if (typeof content !== "string") {
					throw new TypeError(`Module "${name}" property '${key}' must be a string.`);
				}
				add(name, key === "js" ? "esm" : key, content);
				break;
			case "json":
				add(name, "json", JSON.stringify(content));
				break;
			case "data":
				add(name, "data", copyBytes(content, name));
				break;
			case "wasm":
				add(name, "wasm", copyBytes(content, name));
				break;
			case "py":
				if (!pythonMain) {
					throw new TypeError(
						`Module "${name}" is a Python module, but the main module isn't a Python module.`,
					);
				}
				throw pythonUnsupported();
			case undefined:
				throw new TypeError(`Module "${name}" is empty.`);
		}
	}
	if (pythonMain) throw pythonUnsupported();
	if (!result.some((module) => module.name === mainModule)) {
		throw new TypeError(`Main module "${mainModule}" is not in the modules object.`);
	}
	return result;
}

interface PreparedCode {
	env: unknown;
	mainModule: string;
	modules: DynamicModule[];
	outbound: unknown;
}

function prepareCode(code: unknown): PreparedCode {
	if (!isRecord(code)) throw new TypeError("Dynamic Worker code must be an object.");
	if (typeof code.compatibilityDate !== "string") {
		throw new TypeError("Dynamic Worker code must have a compatibilityDate string.");
	}
	if (typeof code.mainModule !== "string") {
		throw new TypeError("Dynamic Worker code must have a mainModule string.");
	}
	const modules = normalizeModules(code.mainModule, code.modules);
	const env = code.env ?? {};
	if (!isRecord(env)) throw new TypeError("Dynamic Worker env must be an object.");
	let outbound: unknown;
	if (code.globalOutbound === undefined) outbound = "network";
	else if (code.globalOutbound === null) outbound = "blocked";
	else outbound = code.globalOutbound;
	return { env, mainModule: code.mainModule, modules, outbound };
}

interface LoaderSession {
	main: CapnWebStub;
	stats(): { exports: number; imports: number };
}

export const maxWorkersSetting = "ORANGE_WORKER_LOADER_MAX_WORKERS";
export const idleTimeoutSetting = "ORANGE_WORKER_LOADER_IDLE_TIMEOUT_MS";
export const queueTimeoutSetting = "ORANGE_WORKER_LOADER_QUEUE_TIMEOUT_MS";
export const maxQueuedSetting = "ORANGE_WORKER_LOADER_MAX_QUEUED";
const defaultMaxWorkers = 32;
const defaultIdleTimeoutMs = 30_000;
const defaultQueueTimeoutMs = 5_000;
const defaultMaxQueued = 256;
const warnRatio = 0.8;
const retryAfterSeconds = 1;

export type WorkerLoaderLimitCode = "queue_full" | "queue_timeout";

// A new dynamic Worker needs a slot, and every running one holds a slot until it stops. With every
// slot busy, a new one waits in line; this error refuses it when the line is full or its wait
// passes the queue timeout. Like the overloaded error of a Cloudflare Durable Object, it carries
// `overloaded` and `retryable`, and the runtime answers it with 503 and Retry-After when the
// Worker does not catch it.
// https://developers.cloudflare.com/durable-objects/best-practices/error-handling/
export class WorkerLoaderLimitError extends RangeError {
	readonly code: WorkerLoaderLimitCode;
	readonly overloaded = true;
	readonly retryable = true;
	readonly retryAfterSeconds = retryAfterSeconds;

	constructor(code: WorkerLoaderLimitCode, message: string) {
		super(message);
		this.name = "WorkerLoaderLimitError";
		this.code = code;
	}
}

// Node.js runs a setTimeout() delay above this after 1 ms.
const maxTimerDelayMs = 2_147_483_647;

export function positiveIntegerSetting(
	settings: Readonly<Record<string, string | undefined>>,
	name: string,
	fallback: number,
	max: number,
	min = 1,
): number {
	const raw = settings[name];
	if (raw === undefined || raw.trim() === "") return fallback;
	const value = Number(raw);
	if (!Number.isSafeInteger(value) || value < min || value > max) {
		throw new RangeError(`${name} must be an integer from ${min} to ${max}. Got: ${JSON.stringify(raw)}`);
	}
	return value;
}

export function workerLoaderIdleTimeoutMs(settings: Readonly<Record<string, string | undefined>>): number {
	return positiveIntegerSetting(settings, idleTimeoutSetting, defaultIdleTimeoutMs, maxTimerDelayMs);
}

export function workerLoaderMaxWorkers(settings: Readonly<Record<string, string | undefined>>): number {
	return positiveIntegerSetting(settings, maxWorkersSetting, defaultMaxWorkers, Number.MAX_SAFE_INTEGER);
}

interface SlotWaiter {
	grant(): void;
	fail(error: Error): void;
}

export interface DynamicWorkerPoolLimits {
	idleTimeoutMs: number;
	maxQueued: number;
	maxWorkers: number;
	queueTimeoutMs: number;
}

// Bounds the dynamic Workers that run at once across every Worker Loader binding of the runtime.
// Each one is an agentOS VM and a Node.js process. At the limit, a new Worker stops the least
// recently used idle one. A Worker with a call in flight is never stopped. With none idle, new
// Workers wait in line, first come first served, until a slot frees or the queue timeout passes.
export class DynamicWorkerPool {
	readonly idleTimeoutMs: number;
	readonly maxQueued: number;
	readonly maxWorkers: number;
	readonly queueTimeoutMs: number;
	readonly metrics: WorkerLoaderMetrics;
	// Least recently used first.
	readonly #live = new Set<DynamicWorker>();
	// First in line first.
	readonly #queue = new Map<DynamicWorker, SlotWaiter>();
	readonly #warn: (message: string) => void;
	#pumping = false;
	#warnedLive = false;
	#warnedQueue = false;

	constructor(limits: DynamicWorkerPoolLimits, warn: (message: string) => void, metrics = new WorkerLoaderMetrics()) {
		this.idleTimeoutMs = limits.idleTimeoutMs;
		this.maxQueued = limits.maxQueued;
		this.maxWorkers = limits.maxWorkers;
		this.queueTimeoutMs = limits.queueTimeoutMs;
		this.metrics = metrics;
		metrics.slotGauges = () => ({ live: this.#live.size, maxWorkers: this.maxWorkers, queued: this.#queue.size });
		this.#warn = warn;
	}

	static fromSettings(
		settings: Readonly<Record<string, string | undefined>>,
		warn: (message: string) => void,
		metrics?: WorkerLoaderMetrics,
	): DynamicWorkerPool {
		return new DynamicWorkerPool(
			{
				idleTimeoutMs: workerLoaderIdleTimeoutMs(settings),
				maxQueued: positiveIntegerSetting(settings, maxQueuedSetting, defaultMaxQueued, Number.MAX_SAFE_INTEGER, 0),
				maxWorkers: workerLoaderMaxWorkers(settings),
				queueTimeoutMs: positiveIntegerSetting(settings, queueTimeoutSetting, defaultQueueTimeoutMs, maxTimerDelayMs),
			},
			warn,
			metrics,
		);
	}

	get queued(): number {
		return this.#queue.size;
	}

	// Resolves once `worker` holds a slot.
	acquire(worker: DynamicWorker): Promise<void> {
		const queuedAt = performance.now();
		return new Promise((resolveSlot, rejectSlot) => {
			let timer: NodeJS.Timeout | undefined;
			this.#queue.set(worker, {
				fail: (error) => {
					clearTimeout(timer);
					rejectSlot(error);
				},
				grant: () => {
					clearTimeout(timer);
					this.metrics.queueWait.observe((performance.now() - queuedAt) / 1_000);
					resolveSlot();
				},
			});
			this.#pump();
			if (!this.#queue.has(worker)) return;
			// Only the Workers behind those that got a slot count toward the queue limit.
			if (this.#queue.size > this.maxQueued) {
				this.#queue.delete(worker);
				rejectSlot(
					this.#refuse(
						"queue_full",
						`OpenOrange cannot start another dynamic Worker: all ${this.maxWorkers} slots are busy and ${this.#queue.size} Workers already wait for one, the most ${maxQueuedSetting} allows. Retry later, or raise ${maxWorkersSetting} or ${maxQueuedSetting}.`,
					),
				);
				return;
			}
			if (!this.#warnedQueue && this.#queue.size >= Math.ceil(this.maxQueued * warnRatio)) {
				this.#warnedQueue = true;
				this.#warn(
					`${this.#queue.size} dynamic Workers wait for a slot, and past ${this.maxQueued} new ones fail with WorkerLoaderLimitError. Raise ${maxWorkersSetting} or ${maxQueuedSetting}, or add runners.`,
				);
			}
			timer = setTimeout(() => {
				if (!this.#queue.delete(worker)) return;
				this.#queueShrank();
				rejectSlot(
					this.#refuse(
						"queue_timeout",
						`OpenOrange cannot start another dynamic Worker: it waited ${this.queueTimeoutMs} ms for one of ${this.maxWorkers} busy slots. Retry later, or raise ${maxWorkersSetting} or ${queueTimeoutSetting}.`,
					),
				);
			}, this.queueTimeoutMs);
			timer.unref();
		});
	}

	// Takes a Worker that stops before it gets a slot out of line.
	cancel(worker: DynamicWorker, error: Error): void {
		const waiter = this.#queue.get(worker);
		if (waiter === undefined) return;
		this.#queue.delete(worker);
		this.#queueShrank();
		waiter.fail(error);
	}

	touch(worker: DynamicWorker): void {
		if (this.#live.delete(worker)) this.#live.add(worker);
	}

	// A Worker may have become idle, so a Worker in line may take its slot.
	idle(): void {
		if (this.#queue.size > 0) this.#pump();
	}

	remove(worker: DynamicWorker): void {
		this.#live.delete(worker);
		if (this.#live.size < Math.ceil(this.maxWorkers * warnRatio)) this.#warnedLive = false;
		this.#pump();
	}

	#refuse(code: WorkerLoaderLimitCode, message: string): WorkerLoaderLimitError {
		this.metrics.reject(code);
		return new WorkerLoaderLimitError(code, message);
	}

	#queueShrank(): void {
		if (this.#queue.size < Math.ceil(this.maxQueued * warnRatio)) this.#warnedQueue = false;
	}

	// Hands free slots to Workers in line, in order. Stopping an idle Worker frees its slot, and
	// its removal must not start a second pass.
	#pump(): void {
		if (this.#pumping) return;
		this.#pumping = true;
		try {
			for (const [worker, waiter] of this.#queue) {
				if (!this.#freeSlot()) break;
				this.#queue.delete(worker);
				this.#live.add(worker);
				this.#warnLive();
				waiter.grant();
			}
			this.#queueShrank();
		} finally {
			this.#pumping = false;
		}
	}

	#freeSlot(): boolean {
		if (this.#live.size < this.maxWorkers) return true;
		for (const candidate of this.#live) {
			if (!candidate.idle) continue;
			candidate.evict();
			return this.#live.size < this.maxWorkers;
		}
		return false;
	}

	#warnLive(): void {
		if (this.#warnedLive || this.#live.size < Math.ceil(this.maxWorkers * warnRatio)) return;
		this.#warnedLive = true;
		this.#warn(
			`${this.#live.size} of ${this.maxWorkers} dynamic Workers are running. At the limit, a new one stops the least recently used idle one, or waits up to ${this.queueTimeoutMs} ms for a slot and then fails with WorkerLoaderLimitError. Raise ${maxWorkersSetting} to allow more.`,
		);
	}
}

// One loaded dynamic Worker: workerd's WorkerStubImpl. The process starts as
// soon as the Worker is requested, and calls wait for it.
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/server/server.c%2B%2B#L5225-L5276
//
// It stops when it has been idle for the pool's idle timeout, when the pool needs its slot, or,
// for an unnamed Worker, when no stub references it. Idle means no call is in flight, the parent
// holds no result stub or stream from it, no body or stream flows between the two in either
// direction, and no call from the Worker to the parent is in flight. A stub that is still held
// loads the Worker again on its next call.
class DynamicWorker {
	readonly #getCode: () => Promise<PreparedCode>;
	readonly #label: string;
	readonly #onExit: () => void;
	readonly #options: WorkerLoaderOptions;
	#running: Promise<LoaderSession> | undefined;
	#abortReason: string | undefined;
	#child: WorkerChild | undefined;
	// Imports the parent holds for live entrypoint stubs. Those do not keep the Worker busy.
	#entrypointImports = 0;
	// Exports the parent holds once the Worker has started: its main object and the env and
	// outbound capabilities. Any more is a stream the Worker sends, such as a response body
	// (Cap'n Web exports the pipe on the receiving side), or a call from the Worker to the parent.
	#baseExports = 0;
	#evicted = false;
	#exited = false;
	#idleCheck = false;
	#idleTimer: NodeJS.Timeout | undefined;
	#inFlight = 0;
	// The host of a Worker that has loaded and whose first calls are in flight.
	#settling: WorkerHost | undefined;
	#lastUsed = 0;
	#orphaned = false;
	#session: LoaderSession | undefined;
	#terminated = false;

	constructor(
		label: string,
		getCode: () => Promise<PreparedCode>,
		options: WorkerLoaderOptions,
		onExit: () => void,
	) {
		this.#getCode = getCode;
		this.#label = label;
		this.#onExit = onExit;
		this.#options = options;
	}

	start(): void {
		this.#running = this.#start();
		this.#running.catch(() => undefined);
	}

	// Settles when the process has loaded the Worker or failed to.
	get ready(): Promise<unknown> {
		return this.#running ?? Promise.resolve();
	}

	// Stopped by the pool or refused a slot, so a held stub may load the Worker again.
	get evicted(): boolean {
		return this.#evicted;
	}

	get idle(): boolean {
		if (this.#session === undefined || this.#exited || this.#inFlight > 0) return false;
		const { exports, imports } = this.#session.stats();
		// The session's main stub is one import.
		return imports - 1 - this.#entrypointImports <= 0 && exports <= this.#baseExports;
	}

	async #start(): Promise<LoaderSession> {
		let host: WorkerHost | undefined;
		const { pool } = this.#options;
		try {
			try {
				await pool.acquire(this);
			} catch (error: unknown) {
				// A stub that is still held asks for a slot again on its next call.
				if (error instanceof WorkerLoaderLimitError) this.#evicted = true;
				throw error;
			}
			const startedAt = performance.now();
			const prepared = await this.#getCode();
			host = await this.#options.backend.open(prepared.outbound === "network");
			const bundleRoot = posix.join(host.root, "bundle");
			const moduleRoot = posix.join(host.root, "modules");
			const files: WorkerFile[] = prepared.modules.map((module) => ({
				content: module.content,
				path: posix.join(bundleRoot, module.name),
			}));
			const linked = await linkModules(prepared.modules, prepared.mainModule, host.moduleRewrites);
			for (const [file, source] of linked.files) {
				files.push({ content: source, path: posix.join(moduleRoot, file) });
			}
			await host.writeFiles(files);
			const envelope = encodeLoaderValue({
				bundleRoot,
				env: prepared.env,
				mainFile: linked.mainFile,
				moduleNames: linked.moduleNames,
				moduleRewrites: host.moduleRewrites,
				moduleRoot,
				outbound: prepared.outbound,
			});
			const child = await host.spawn();
			this.#child = child;
			if (this.#terminated) child.kill();
			const frames = readFrames(child.stdout, (line) => process.stdout.write(`${line}\n`));
			frames.on("message", (message: unknown) => {
				this.#checkIdle();
				if (typeof message !== "object" || message === null) return;
				const stdout: unknown = Reflect.get(message, "openOrangeWorkerLoaderStdout");
				if (typeof stdout === "string") process.stdout.write(stdout);
				const abortReason: unknown = Reflect.get(message, "openOrangeWorkerLoaderAbort");
				if (typeof abortReason === "string") this.#abortReason = abortReason;
				const diagnostic: unknown = Reflect.get(message, "openOrangeWorkerLoaderDiagnostic");
				if (typeof diagnostic === "string") {
					this.#options.onDiagnostic(`Dynamic Worker ${this.#label}: ${diagnostic}`);
				}
			});
			const transport = new FramedRpcTransport(frames, (message) => {
				this.#checkIdle();
				child.write(`${JSON.stringify(message)}\n`);
			});
			const session = openLoaderSession(transport);
			const removeHost = host;
			child.onExit((reason) => {
				this.#exited = true;
				clearTimeout(this.#idleTimer);
				transport.fail(this.#exitError(reason));
				this.#options.pool.remove(this);
				this.#onExit();
				void removeHost.remove();
			});
			const reply = await session.main.start(envelope);
			if (reply !== undefined && reply !== null) decodeLoaderReply(reply);
			this.#baseExports = session.stats().exports;
			this.#session = session;
			this.#lastUsed = performance.now();
			pool.metrics.workerStart.observe((this.#lastUsed - startedAt) / 1_000);
			this.#armIdleTimer(pool.idleTimeoutMs);
			this.#checkIdle();
			if (this.#inFlight === 0) host.settled();
			else this.#settling = host;
			return session;
		} catch (error: unknown) {
			host?.settled();
			this.terminate();
			// A running child frees the slot when it exits. Without one, nothing else frees it.
			if (this.#child === undefined) {
				this.#exited = true;
				this.#options.pool.remove(this);
				this.#onExit();
				await host?.remove().catch((removeError: unknown) => {
					this.#options.onDiagnostic(
						`Dynamic Worker ${this.#label} failed to start, and its VM failed to stop: ${errorMessage(removeError)}`,
					);
				});
			}
			throw error;
		} finally {
			host?.loaded();
		}
	}

	// A message in either direction can end the last call or stream, which leaves the Worker
	// idle. Only Workers in line for a slot need to know at once, so the check runs only then,
	// at most once per turn of the event loop.
	#checkIdle(): void {
		if (this.#idleCheck || this.#options.pool.queued === 0) return;
		this.#idleCheck = true;
		setImmediate(() => {
			this.#idleCheck = false;
			if (this.idle) this.#options.pool.idle();
		});
	}

	// Like workerd, an isolate that abortIsolate() ended fails its calls with an internal error,
	// and the reason goes only to the log under the same reference.
	#exitError(reason: string): Error {
		if (this.#abortReason === undefined) {
			return new Error(`Dynamic Worker ${this.#label} exited unexpectedly (${reason}).`);
		}
		const reference = randomUUID();
		this.#options.onDiagnostic(
			`Dynamic Worker ${this.#label} called abortIsolate(${JSON.stringify(this.#abortReason)}); reference = ${reference}`,
		);
		return new Error(`internal error; reference = ${reference}`);
	}

	#armIdleTimer(delayMs: number): void {
		clearTimeout(this.#idleTimer);
		this.#idleTimer = setTimeout(() => {
			const quietMs = performance.now() - this.#lastUsed;
			const idleTimeoutMs = this.#options.pool.idleTimeoutMs;
			if (quietMs < idleTimeoutMs) this.#armIdleTimer(idleTimeoutMs - quietMs);
			else if (this.idle) this.evict();
			// A held result stub or stream keeps the Worker; look again later.
			else this.#armIdleTimer(idleTimeoutMs);
		}, delayMs);
		this.#idleTimer.unref();
	}

	// Counts `call` as in flight until it settles.
	track<T>(call: Promise<T>): Promise<T> {
		this.#inFlight += 1;
		this.#options.pool.touch(this);
		const settle = (): void => {
			this.#inFlight -= 1;
			this.#lastUsed = performance.now();
			if (this.#inFlight === 0) {
				this.#settling?.settled();
				this.#settling = undefined;
			}
			if (this.#orphaned && this.idle) this.evict();
			else this.#checkIdle();
		};
		void call.then(settle, settle);
		return call;
	}

	// No stub references this unnamed Worker any more, so it stops once idle. A Worker in line for
	// a slot leaves the line, unless a call waits on it: the call holds no stub.
	release(): void {
		this.#orphaned = true;
		if (this.#inFlight === 0) {
			this.#options.pool.cancel(this, new Error(`Dynamic Worker ${this.#label} has no stub left.`));
		}
		if (this.idle) this.evict();
	}

	evict(): void {
		if (this.#evicted || this.#exited) return;
		this.#evicted = true;
		clearTimeout(this.#idleTimer);
		this.#options.pool.remove(this);
		this.#onExit();
		this.terminate();
	}

	// A capability for `getEntrypoint(name, { props })`.
	entrypoint(name: string | undefined, props: unknown): Promise<RemoteCapability> {
		const running = this.#running ?? Promise.reject(new Error("Dynamic Worker is not started"));
		const propsEnvelope = props === undefined ? undefined : encodeLoaderValue(props);
		const remote = running.then(async ({ main }) => {
			const stub = await main.entrypoint(name, propsEnvelope);
			if ((typeof stub !== "object" || stub === null) && typeof stub !== "function") {
				throw new Error("Dynamic Worker returned an invalid entrypoint");
			}
			this.#entrypointImports += 1;
			return new RemoteCapability(stub);
		});
		remote.catch(() => undefined);
		return remote;
	}

	// Releases an entrypoint stub that `entrypoint()` made.
	dropEntrypoint(remote: Promise<RemoteCapability>): void {
		remote.then(
			(capability) => {
				capability.dispose();
				this.#entrypointImports -= 1;
				if (this.#orphaned && this.idle) this.evict();
				else this.#checkIdle();
			},
			() => undefined,
		);
	}

	terminate(): void {
		this.#terminated = true;
		this.#options.pool.cancel(this, new Error("The Worker Loader has stopped."));
		if (this.#child !== undefined && !this.#exited) this.#child.kill();
	}
}

// Returns the live Worker for a stub, loading it again if the pool stopped it.
type AcquireWorker = () => DynamicWorker;

// Runs a callback after the object it was registered with is collected.
const collected = new FinalizationRegistry<() => void>((onCollected) => onCollected());

interface BoundEntrypoint {
	remote: Promise<RemoteCapability>;
	worker: DynamicWorker;
}

// Forwards calls to an entrypoint of the live Worker. Each call fails with the
// startup error if the Worker cannot load.
class LazyCapability implements Capability {
	readonly #acquire: AcquireWorker;
	// Shared with the cleanup callback, which must not reference this object.
	readonly #cell: { bound: BoundEntrypoint };
	readonly #name: string | undefined;
	readonly #props: unknown;

	constructor(acquire: AcquireWorker, name: string | undefined, props: unknown) {
		this.#acquire = acquire;
		this.#name = name;
		this.#props = props;
		const worker = acquire();
		const cell = { bound: { remote: worker.entrypoint(name, props), worker } };
		this.#cell = cell;
		collected.register(this, () => cell.bound.worker.dropEntrypoint(cell.bound.remote));
	}

	#current(): BoundEntrypoint {
		const bound = this.#cell.bound;
		if (!bound.worker.evicted) return bound;
		bound.worker.dropEntrypoint(bound.remote);
		const worker = this.#acquire();
		this.#cell.bound = { remote: worker.entrypoint(this.#name, this.#props), worker };
		return this.#cell.bound;
	}

	call(path: readonly string[], args: readonly unknown[] | undefined): CallOutcome {
		let bound: BoundEntrypoint;
		try {
			bound = this.#current();
		} catch (error: unknown) {
			const failed = Promise.reject(error);
			failed.catch(() => undefined);
			return { pipeline: failed, value: failed };
		}
		const outcome = bound.remote.then((capability) => capability.call(path, args));
		const value = bound.worker.track(outcome.then((result) => result.value));
		const pipeline = outcome.then((result) => result.pipeline);
		value.catch(() => undefined);
		pipeline.catch(() => undefined);
		return { pipeline, value };
	}

	dup(): Capability {
		return this;
	}

	dispose(): void {}
}

function notSupported(message: string): Error {
	const error = new Error(message);
	error.name = "NotSupportedError";
	return error;
}

// A Fetcher for a dynamic Worker entrypoint: fetch() sends a Request and
// every other name is an RPC method.
function createEntrypointStub(capability: Capability): object {
	const root = createStub(capability);
	return new Proxy(root, {
		get(target, property, receiver): unknown {
			if (property === "fetch") {
				return (input: RequestInfo | URL, init?: RequestInit): Promise<unknown> => {
					try {
						const request = new Request(input, init);
						return Promise.resolve(capability.call(["fetch"], [request]).value);
					} catch (error: unknown) {
						return Promise.reject(error);
					}
				};
			}
			if (property === "connect") {
				return (): never => {
					throw notSupported(
						"OpenOrange does not support connect() on a dynamic Worker entrypoint. Use fetch() or RPC methods instead.",
					);
				};
			}
			return Reflect.get(target, property, receiver);
		},
	});
}

// How stubs reach one dynamic Worker. `hold` counts a stub that references it.
interface WorkerHandle {
	acquire: AcquireWorker;
	hold(stub: object): void;
}

export class WorkerStub {
	readonly #handle: WorkerHandle;

	constructor(handle: WorkerHandle) {
		this.#handle = handle;
		// The Worker starts loading at once. With every slot busy, it waits in line, and its calls
		// wait with it.
		handle.acquire();
		handle.hold(this);
	}

	getEntrypoint(name?: string | null, options?: { props?: unknown }): object {
		const entrypoint = name === undefined || name === null || name === "default" ? undefined : name;
		const capability = new LazyCapability(this.#handle.acquire, entrypoint, options?.props);
		this.#handle.hold(capability);
		return createEntrypointStub(capability);
	}

	getDurableObjectClass(): never {
		throw notSupported(
			"OpenOrange does not support getDurableObjectClass() on dynamic Workers yet. Keep Durable Object state in the parent Worker and call the dynamic Worker through getEntrypoint().",
		);
	}
}

// Like workerd, an unnamed Worker lives while a stub or entrypoint references it. Workerd
// refcounts it; Orange counts the stubs that the garbage collector has not collected.
// https://github.com/cloudflare/workerd/blob/80c80a712532b012cbeaef4d08ff6ab15407e960/src/workerd/server/server.c%2B%2B#L4840-L4877
class UnnamedWorkerHandle implements WorkerHandle {
	readonly #create: () => DynamicWorker;
	#current: DynamicWorker | undefined;
	#holders = 0;

	constructor(create: () => DynamicWorker) {
		this.#create = create;
	}

	acquire = (): DynamicWorker => {
		if (this.#current === undefined || this.#current.evicted) this.#current = this.#create();
		return this.#current;
	};

	hold(stub: object): void {
		this.#holders += 1;
		collected.register(stub, () => {
			this.#holders -= 1;
			if (this.#holders === 0) this.#current?.release();
		});
	}
}

// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/worker-loader.c%2B%2B#L79-L135
export class WorkerLoader {
	// Workerd keeps one isolate per name in each loader binding, and an unnamed
	// get() or load() always starts a new one.
	// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/server/server.c%2B%2B#L5120-L5160
	readonly #named = new Map<string, DynamicWorker>();
	readonly #all = new Set<DynamicWorker>();
	readonly #options: WorkerLoaderOptions;

	constructor(options: WorkerLoaderOptions) {
		this.#options = options;
	}

	get(name: string | null | undefined, getCode: () => unknown): WorkerStub {
		if (typeof getCode !== "function") {
			throw new TypeError("WorkerLoader.get() requires a code callback.");
		}
		const prepare = async (): Promise<PreparedCode> => prepareCode(await getCode());
		if (name === null || name === undefined) {
			return new WorkerStub(new UnnamedWorkerHandle(() => this.#create("(anonymous)", prepare, () => undefined)));
		}
		const key = String(name);
		// A stub loads its name again with its own callback after the pool stopped the Worker, as
		// Cloudflare may call `getCode` again for a name at any time.
		return new WorkerStub({ acquire: () => this.#namedWorker(key, prepare), hold: () => undefined });
	}

	#namedWorker(key: string, prepare: () => Promise<PreparedCode>): DynamicWorker {
		const existing = this.#named.get(key);
		if (existing !== undefined && !existing.evicted) return existing;
		const worker: DynamicWorker = this.#create(key, prepare, () => {
			if (this.#named.get(key) === worker) this.#named.delete(key);
		});
		this.#named.set(key, worker);
		// Orange forgets a Worker that failed to load, so the next get()
		// with this name calls its code callback again.
		worker.ready.catch(() => {
			if (this.#named.get(key) === worker) this.#named.delete(key);
		});
		return worker;
	}

	// Like workerd, load() copies the code before it returns, so later changes
	// to the caller's buffers do not reach the Worker, and invalid code throws here.
	load(code: unknown): WorkerStub {
		const prepared = prepareCode(code);
		return new WorkerStub(
			new UnnamedWorkerHandle(() => this.#create("(anonymous)", async () => prepared, () => undefined)),
		);
	}

	#create(
		label: string,
		getCode: () => Promise<PreparedCode>,
		onExit: () => void,
	): DynamicWorker {
		const worker: DynamicWorker = new DynamicWorker(
			JSON.stringify(label),
			getCode,
			this.#options,
			() => {
				this.#all.delete(worker);
				onExit();
			},
		);
		this.#all.add(worker);
		worker.start();
		return worker;
	}

	// Stops every dynamic Worker process. The runtime calls this on shutdown.
	close(): void {
		for (const worker of this.#all) worker.terminate();
	}
}

// The agentOS build of the child and its runtime modules. See
// `buildWorkerLoaderVmBundle`.
export function workerLoaderVmBundlePath(runnerUrl: string): string {
	for (const relative of ["./worker-loader-vm/", "../../../dist/runtime/worker-loader-vm/"]) {
		const candidate = new globalThis.URL(relative, runnerUrl);
		if (existsSync(new globalThis.URL("manifest.json", candidate))) return candidate.pathname;
	}
	throw new Error(
		"OpenOrange cannot find the agentOS Worker Loader bundle. Run `pnpm build`.",
	);
}
