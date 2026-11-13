// Workers RPC between a parent runtime and a dynamic Worker process. Cap'n Web
// carries the messages as newline-delimited JSON frames on the child's stdin
// and stdout. Values use the Durable
// Object RPC envelope, and every stub, RpcTarget, or function travels as a
// capability whose calls go through Orange's loopback RPC rules on the side
// that owns it.

import { EventEmitter } from "node:events";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

import { currentExecutionContext } from "../../context.js";
import {
	isCapnWebRpcStub,
	isCapnWebRpcTarget,
	openCapnWebRpcSessionWithStats,
	type CapnWebRpcTransport,
	type CapnWebStub,
} from "../durable-objects/rpc/capnweb.js";
import { DurableObjectRpcTarget } from "../durable-objects/rpc/target.js";
import { isDurableObjectStub } from "../durable-objects/namespace.js";
import { isServiceStub } from "../service.js";
import {
	createStub,
	failedOutcome,
	pipelineCapability,
	RpcStub,
	type CallOutcome,
	type Capability,
} from "../../rpc/loopback.js";
import { isRecord } from "../unknown-values.js";
import { decodeLoaderEnvelope, encodeLoaderEnvelope, type LoaderValueEnvelope } from "./codec.js";

const rpcMessageKey = "openOrangeWorkerLoaderRpc";

export interface FramePort {
	on(event: "message", listener: (message: unknown) => void): unknown;
}

// Writes one frame. JSON.stringify never emits a raw newline, so a newline
// always ends a frame.
export function writeFrame(stream: Pick<Writable, "write">, message: object): void {
	stream.write(`${JSON.stringify(message)}\n`);
}

// Emits "message" for each frame on `stream`. A line that is not a JSON object
// goes to `onText`, so stray output cannot break the RPC stream.
export function readFrames(stream: Readable, onText: (line: string) => void): FramePort {
	const port = new EventEmitter();
	const lines = createInterface({ crlfDelay: Infinity, input: stream });
	lines.on("line", (line) => {
		let message: unknown;
		try {
			message = JSON.parse(line);
		} catch {
			onText(line);
			return;
		}
		if (typeof message === "object" && message !== null) port.emit("message", message);
		else onText(line);
	});
	return port;
}

// A Cap'n Web transport over a frame stream.
export class FramedRpcTransport implements CapnWebRpcTransport {
	readonly #queue: string[] = [];
	readonly #waiters: { resolve(message: string): void; reject(error: unknown): void }[] = [];
	readonly #send: (message: object) => void;
	#failure: unknown;

	constructor(port: FramePort, send: (message: object) => void) {
		this.#send = send;
		port.on("message", (message: unknown) => {
			if (typeof message !== "object" || message === null) return;
			const text: unknown = Reflect.get(message, rpcMessageKey);
			if (typeof text !== "string") return;
			const waiter = this.#waiters.shift();
			if (waiter === undefined) this.#queue.push(text);
			else waiter.resolve(text);
		});
	}

	send(message: string): void {
		if (this.#failure !== undefined) throw this.#failure;
		this.#send({ [rpcMessageKey]: message });
	}

	receive(): Promise<string> {
		const queued = this.#queue.shift();
		if (queued !== undefined) return Promise.resolve(queued);
		if (this.#failure !== undefined) return Promise.reject(this.#failure);
		return new Promise((resolve, reject) => this.#waiters.push({ reject, resolve }));
	}

	abort(): void {}

	// Rejects every pending and later receive, which fails the session's calls.
	fail(error: unknown): void {
		if (this.#failure !== undefined) return;
		this.#failure = error;
		for (const waiter of this.#waiters.splice(0)) waiter.reject(error);
	}
}

export function openLoaderSession(
	transport: FramedRpcTransport,
	localMain?: object,
): { main: CapnWebStub; stats(): { exports: number; imports: number } } {
	return openCapnWebRpcSessionWithStats(transport, localMain);
}

function isCapability(value: object): boolean {
	return (
		typeof value === "function" ||
		isServiceStub(value) ||
		isDurableObjectStub(value) ||
		isCapnWebRpcStub(value) ||
		isCapnWebRpcTarget(value)
	);
}

// `onCapability` receives each capability the envelope sends, as it is made.
export function encodeLoaderValue(
	value: unknown,
	onCapability?: (target: LoaderCapabilityTarget) => void,
): LoaderValueEnvelope {
	return encodeLoaderEnvelope(value, {
		substitute(candidate) {
			if (candidate instanceof LoaderCapabilityTarget || !isCapability(candidate)) {
				return undefined;
			}
			// RpcStub wraps any object or function at runtime. Its constructor type
			// admits only RpcTarget and functions, so it is called through Reflect.
			const target = new LoaderCapabilityTarget(Reflect.construct(RpcStub, [candidate]));
			onCapability?.(target);
			return target;
		},
	});
}

// `retain` duplicates received stubs. Cap'n Web releases the stubs in call
// parameters when the call returns, and the receiver may keep them longer.
export function decodeLoaderValue(envelope: unknown, retain: boolean): unknown {
	return decodeLoaderEnvelope(envelope, {
		revive(_kind, value) {
			if (!isCapnWebRpcStub(value)) return value;
			const stub = retain ? duplicate(value) : value;
			return createStub(new RemoteCapability(stub));
		},
	});
}

function duplicate(stub: object): object {
	const dup: unknown = Reflect.get(stub, "dup");
	if (typeof dup !== "function") throw new Error("Cap'n Web stub cannot be duplicated");
	const copy: unknown = Reflect.apply(dup, stub, []);
	if ((typeof copy !== "object" || copy === null) && typeof copy !== "function") {
		throw new Error("Cap'n Web stub dup() did not return a stub");
	}
	return copy;
}

const domExceptionKind = "DOMException";

interface EncodedError {
	kind?: string;
	message: string;
	name: string;
	properties: Record<string, unknown>;
	stack?: string;
}

function errorRecord(error: unknown): EncodedError {
	if (!(error instanceof Error)) {
		return { message: String(error), name: "Error", properties: {} };
	}
	const properties: Record<string, unknown> = {};
	for (const key of Object.keys(error)) properties[key] = Reflect.get(error, key);
	return {
		...(error instanceof DOMException ? { kind: domExceptionKind } : {}),
		message: error.message,
		name: error.name,
		properties,
		...(error.stack === undefined ? {} : { stack: error.stack }),
	};
}

export type LoaderReply = { error: LoaderValueEnvelope } | { value: LoaderValueEnvelope };

export function encodeLoaderError(error: unknown): LoaderReply {
	const record = errorRecord(error);
	try {
		return { error: encodeLoaderValue(record) };
	} catch {
		return { error: encodeLoaderValue({ ...record, properties: {} }) };
	}
}

const errorConstructors: Record<string, ErrorConstructor> = {
	Error,
	EvalError,
	RangeError,
	ReferenceError,
	SyntaxError,
	TypeError,
	URIError,
};

function parseEncodedError(value: unknown): EncodedError {
	if (!isRecord(value)) throw new TypeError("Dynamic Worker error record must be an object");
	const { kind, message, name, properties, stack } = value;
	if (
		(kind !== undefined && typeof kind !== "string") ||
		typeof message !== "string" ||
		typeof name !== "string" ||
		!isRecord(properties) ||
		(stack !== undefined && typeof stack !== "string")
	) {
		throw new TypeError("Dynamic Worker error record has invalid fields");
	}
	return { kind, message, name, properties, stack };
}

function decodeLoaderError(envelope: unknown): Error {
	const record = parseEncodedError(decodeLoaderValue(envelope, false));
	let error: Error;
	if (record.kind === domExceptionKind) {
		error = new DOMException(record.message, record.name);
	} else {
		error = new (errorConstructors[record.name] ?? Error)(record.message);
		if (error.name !== record.name) {
			Object.defineProperty(error, "name", {
				configurable: true,
				enumerable: false,
				value: record.name,
				writable: true,
			});
		}
	}
	for (const [key, value] of Object.entries(record.properties)) Reflect.set(error, key, value);
	return error;
}

export function decodeLoaderReply(reply: unknown): unknown {
	if (typeof reply !== "object" || reply === null) {
		throw new TypeError("Dynamic Worker sent an invalid RPC reply");
	}
	if (Object.hasOwn(reply, "error")) throw decodeLoaderError(Reflect.get(reply, "error"));
	return decodeLoaderValue(Reflect.get(reply, "value"), false);
}

// Calls `path` on a local value through a loopback stub and returns the
// encoded result.
export async function invokeLocal(
	target: object,
	path: unknown,
	args: unknown,
): Promise<LoaderReply> {
	try {
		if (!Array.isArray(path) || !path.every((name) => typeof name === "string")) {
			throw new TypeError("Dynamic Worker RPC path is invalid");
		}
		const decodedArgs = args === undefined ? undefined : decodeLoaderValue(args, true);
		if (decodedArgs !== undefined && !Array.isArray(decodedArgs)) {
			throw new TypeError("Dynamic Worker RPC arguments are invalid");
		}
		let holder: unknown = target;
		let member: unknown = target;
		for (const name of path) {
			holder = member;
			member = Reflect.get(Object(member), name);
		}
		let result: unknown;
		if (decodedArgs === undefined) {
			result = await member;
		} else {
			if (typeof member !== "function") {
				throw new TypeError(`"${path.join(".")}" is not a function.`);
			}
			result = await Reflect.apply(member, holder, decodedArgs);
		}
		// A loopback result owns the stubs it holds through a non-enumerable disposer. That disposer can
		// end a Durable Object session that the functions in the result still call through, so it runs
		// once the other process has released the last capability in this reply.
		let dispose: unknown;
		if (typeof result === "object" && result !== null && Object.hasOwn(result, Symbol.dispose)) {
			dispose = Reflect.get(result, Symbol.dispose);
			Reflect.deleteProperty(result, Symbol.dispose);
		}
		const disposeResult = (): void => {
			if (typeof dispose === "function") Reflect.apply(dispose, result, []);
		};
		let held = 0;
		try {
			const value = encodeLoaderValue(result, (capability) => {
				held += 1;
				capability.onDispose(() => {
					held -= 1;
					if (held === 0) disposeResult();
				});
			});
			if (held === 0) disposeResult();
			return { value };
		} catch (error: unknown) {
			disposeResult();
			throw error;
		}
	} catch (error: unknown) {
		return encodeLoaderError(error);
	}
}

// The local end of a capability sent to the other process.
export class LoaderCapabilityTarget extends DurableObjectRpcTarget {
	#onDispose: (() => void) | undefined;
	readonly #stub: object;

	constructor(stub: object) {
		super();
		this.#stub = stub;
	}

	onDispose(listener: () => void): void {
		this.#onDispose = listener;
	}

	invoke(path: unknown, args: unknown): Promise<LoaderReply> {
		return invokeLocal(this.#stub, path, args);
	}

	[Symbol.dispose](): void {
		const dispose: unknown = Reflect.get(this.#stub, Symbol.dispose);
		if (typeof dispose === "function") Reflect.apply(dispose, this.#stub, []);
		this.#onDispose?.();
	}
}

// The remote end of a capability: calls go over Cap'n Web to the owning
// process's LoaderCapabilityTarget.
export class RemoteCapability implements Capability {
	readonly #stub: object;
	#released = false;

	constructor(stub: object) {
		this.#stub = stub;
	}

	call(path: readonly string[], args: readonly unknown[] | undefined): CallOutcome {
		if (this.#released) return failedOutcome(new Error("RPC stub used after being disposed."));
		const context = currentExecutionContext();
		const value = (async (): Promise<unknown> => {
			const envelope = args === undefined ? undefined : encodeLoaderValue([...args]);
			const invoke: unknown = Reflect.get(this.#stub, "invoke");
			if (typeof invoke !== "function") throw new Error("Dynamic Worker capability is invalid");
			const reply: unknown = await Reflect.apply(invoke, this.#stub, [[...path], envelope]);
			return decodeLoaderReply(reply);
		})();
		value.catch(() => undefined);
		const pipeline = value.then((result) => pipelineCapability(result, context));
		pipeline.catch(() => undefined);
		return { pipeline, value };
	}

	dup(): Capability {
		return new RemoteCapability(duplicate(this.#stub));
	}

	dispose(): void {
		if (this.#released) return;
		this.#released = true;
		const dispose: unknown = Reflect.get(this.#stub, Symbol.dispose);
		if (typeof dispose === "function") Reflect.apply(dispose, this.#stub, []);
	}
}
