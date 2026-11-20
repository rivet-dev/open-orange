import { AsyncResource } from "node:async_hooks";
import { Buffer } from "node:buffer";
import type { WebSocketValue } from "../globals/websocket.js";

interface SyncReference {
	applySync(receiver: undefined, args: unknown[]): unknown;
}
interface WireSocket {
	_socketId: string;
	_applicationReadDemand: boolean;
	_bridgeReadRpcInFlight?: boolean;
	_pendingBridgeWriteBytes?: number;
	writableLength?: number;
	readableLength: number;
	read(size?: number): unknown;
	bytesWritten: number;
	write: (chunk: unknown, encoding?: unknown, callback?: unknown) => boolean;
	pause(): void;
	resume(): void;
	destroy(error?: Error): unknown;
}
interface NodeSocket {
	_socket: WireSocket;
	_receiver: { write(bytes: Uint8Array): unknown };
}
interface TransportSocket extends WebSocketValue {
	onmessage: ((event: { data: unknown }) => void) | null;
	onopen: ((event: unknown) => void) | null;
	onclose: ((event: unknown) => void) | null;
	onerror: ((event: unknown) => void) | null;
	sendSync(bytes: ArrayBuffer | ArrayBufferView | string): void;
	receiveSync(timeoutMs: number): Uint8Array;
}
type Incoming = { type: string; event: unknown; data?: Uint8Array };
const maxMessageBytes = 32 * 1024 * 1024,
	maxReadBytes = 64 * 1024,
	maxWriteBytes = 256 * 1024;
function reference(name: string): SyncReference {
	const value = Reflect.get(globalThis, name);
	if (typeof value?.applySync !== "function")
		throw Error("Synchronous WASM transport requires existing guest socket I/O");
	return value;
}
function bytes(value: unknown): Uint8Array {
	if (value instanceof ArrayBuffer) return new Uint8Array(value);
	if (ArrayBuffer.isView(value))
		return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
	if (typeof value === "string") return Buffer.from(value, "base64");
	if (
		value &&
		typeof value === "object" &&
		Reflect.get(value, "__agentOSType") === "bytes" &&
		typeof Reflect.get(value, "base64") === "string"
	)
		return Buffer.from(Reflect.get(value, "base64"), "base64");
	throw Error("Invalid guest socket byte response");
}

// Keep raw frame admission ordered; the platform write contract still governs
// errors delivered by the WebSocket sender and its automatic control frames.
export function installWasmProtocolWriter(
	target: Pick<WireSocket, "_socketId" | "bytesWritten" | "write" | "destroy">,
	write: SyncReference,
	isSynchronous: () => boolean,
	queueInOwnerContext: (callback: () => void) => void,
): void {
	let failed: Error | undefined;
	let destroyQueued = false;
	target.write = (chunk, encoding, callback) => {
		const cb = typeof encoding === "function" ? encoding : callback;
		const data =
			typeof chunk === "string"
				? Buffer.from(
						chunk,
						typeof encoding === "string" ? (encoding as BufferEncoding) : undefined,
					)
				: bytes(chunk);
		try {
			if (failed) throw failed;
			let offset = 0;
			while (offset < data.byteLength) {
				const part = data.subarray(offset, Math.min(data.byteLength, offset + maxWriteBytes));
				const count = write.applySync(undefined, [target._socketId, part]);
				if (
					typeof count !== "number" ||
					!Number.isSafeInteger(count) ||
					count <= 0 ||
					count > part.byteLength
				)
					throw Error("Invalid guest socket write count");
				offset += count;
				target.bytesWritten += count;
			}
		} catch (cause) {
			failed ??= cause instanceof Error ? cause : new Error(String(cause));
			const error = failed;
			const shouldDestroy = !destroyQueued;
			destroyQueued = true;
			queueInOwnerContext(() => {
				try {
					if (typeof cb === "function") cb(error);
				} finally {
					if (shouldDestroy) target.destroy(error);
				}
			});
			// SQL callers must observe failure on their synchronous Rust stack. Normal
			// WebSocket control writes follow Writable's asynchronous error contract.
			if (isSynchronous()) throw error;
			return false;
		}
		if (typeof cb === "function") cb();
		return true;
	};
}

/** Guest-only protocol transport. The kernel sees ordinary TCP bytes, never SQL. */
export function adaptWasmRivetWebSocket(value: WebSocketValue): WebSocketValue {
	// Deferred I/O keeps the connection context, even when captured by a synchronous caller.
	const queueInOwnerContext = AsyncResource.bind((callback: () => void) => queueMicrotask(callback));
	const read = reference("_netSocketReadRaw"),
		write = reference("_netSocketWriteSyncRaw"),
		poll = reference("_netSocketPollRaw");
	let wire: WireSocket | undefined, receiver: NodeSocket["_receiver"] | undefined;
	let prepared = false,
		receiving = false,
		synchronousWriteDepth = 0,
		flushQueued = false,
		restoreDemand = false,
		queuedBytes = 0;
	let preparationTimer: ReturnType<typeof setTimeout> | undefined;
	const incoming: Incoming[] = [],
		early: Incoming[] = [];
	const handlers = new Map<string, unknown>();
	const listeners = new Map<string, Map<unknown, boolean>>();
	const bound = new Map<PropertyKey, unknown>();
	const emit = (type: string, event: unknown) => {
		// Resolve callbacks at delivery: WASM clears them before dropping its closures.
		const handler = handlers.get(`on${type}`);
		if (typeof handler === "function") handler.call(transport, event);
		for (const [listener, once] of [...(listeners.get(type) ?? [])]) {
			if (once) listeners.get(type)?.delete(listener);
			if (typeof listener === "function") listener.call(transport, event);
			else if (
				listener &&
				typeof listener === "object" &&
				typeof Reflect.get(listener, "handleEvent") === "function"
			)
				Reflect.get(listener, "handleEvent").call(listener, event);
		}
	};
	const enqueue = (queue: Incoming[], item: Incoming) => {
		const length = item.data?.byteLength ?? 0;
		if (
			length > maxMessageBytes ||
			queuedBytes + length > maxMessageBytes ||
			incoming.length + early.length >= 1024
		)
			throw Error("WASM transport message byte limit exceeded");
		queue.push(item);
		queuedBytes += length;
	};
	const shift = (queue: Incoming[]) => {
		const item = queue.shift()!;
		queuedBytes -= item.data?.byteLength ?? 0;
		return item;
	};
	const resume = () => {
		if (!wire) return;
		wire._applicationReadDemand = restoreDemand;
		const wanted = restoreDemand;
		restoreDemand = false;
		if (wanted) wire.resume();
	};
	const flush = () => {
		if (flushQueued) return;
		flushQueued = true;
		queueInOwnerContext(() => {
			flushQueued = false;
			try {
				while (incoming.length) {
					const item = shift(incoming);
					emit(item.type, item.event);
				}
			} finally {
				resume();
			}
		});
	};
	const ready = () => {
		if (!prepared || !wire || !receiver || value.readyState !== 1)
			throw Error("WASM protocol socket is not open");
		return { wire, receiver };
	};
	const sendSync = (data: ArrayBuffer | ArrayBufferView | string) => {
		ready();
		synchronousWriteDepth++;
		try {
			value.send(data);
		} finally {
			synchronousWriteDepth--;
		}
	};
	const receiveSync = (timeoutMs: number): Uint8Array => {
		if (!Number.isFinite(timeoutMs) || timeoutMs < 0)
			throw Error("Invalid synchronous protocol deadline");
		const { wire, receiver } = ready(),
			deadline = Date.now() + timeoutMs;
		restoreDemand ||= wire._applicationReadDemand;
		wire.pause();
		wire._applicationReadDemand = false;
		receiving = true;
		try {
			while (!incoming.length) {
				const remaining = deadline - Date.now();
				if (remaining <= 0) throw Error("Synchronous WASM protocol deadline exceeded");
				if (wire._bridgeReadRpcInFlight) throw Error("Guest socket has a read in flight");
				let data: unknown;
				wire._bridgeReadRpcInFlight = true;
				try {
					// read() delivers buffered bytes through the platform WebSocket's
					// existing data listener. Never overtake them with a kernel read.
					if (wire.readableLength > 0) {
						const before = wire.readableLength;
						wire.read(Math.min(before, maxReadBytes));
						wire._applicationReadDemand = false;
						if (wire.readableLength >= before)
							throw Error("Guest socket buffered read made no progress");
						continue;
					}
					data = read.applySync(undefined, [wire._socketId, maxReadBytes]);
					if (
						data === "__agentos_net_timeout__" ||
						(data && typeof data === "object" && Reflect.get(data, "kind") === "wouldBlock")
					) {
						const event = poll.applySync(undefined, [wire._socketId, Math.min(remaining, 10)]);
						if (!event || typeof event !== "object") continue;
						const type = Reflect.get(event, "type");
						if (type === "data") data = Reflect.get(event, "data");
						else if (type === "end" || type === "close" || type === "error")
							throw Error("WASM protocol socket ended while waiting");
						else continue;
					}
				} finally {
					wire._bridgeReadRpcInFlight = false;
				}
				if (data === null || data === "__agentos_net_close__")
					throw Error("WASM protocol socket ended while waiting");
				receiver.write(bytes(data));
			}
			if (incoming[0]!.type !== "message")
				throw Error("WASM protocol connection ended while waiting");
			return shift(incoming).data!;
		} finally {
			receiving = false;
			// A queued normal read pump must not overtake already captured frames.
			if (incoming.length || flushQueued) flush();
			else resume();
		}
	};
	const transport = new Proxy(value as TransportSocket, {
		get(target, name) {
			if (name === "sendSync") return sendSync;
			if (name === "receiveSync") return receiveSync;
			if (name === "readyState")
				return !prepared && target.readyState === 1 ? 0 : target.readyState;
			if (typeof name === "string" && ["onopen", "onmessage", "onclose", "onerror"].includes(name))
				return handlers.get(name) ?? null;
			if (name === "addEventListener")
				return (type: string, listener: unknown, options?: object | boolean) => {
					if (!listeners.has(type)) listeners.set(type, new Map());
					if (!listeners.get(type)!.has(listener))
						listeners
							.get(type)!
							.set(
								listener,
								Boolean(options && typeof options === "object" && Reflect.get(options, "once")),
							);
				};
			if (name === "removeEventListener")
				return (type: string, listener: unknown) => {
					listeners.get(type)?.delete(listener);
				};
			if (name === "dispatchEvent")
				return (event: { type: string }) => {
					emit(event.type, event);
					return true;
				};
			if (name === "close")
				return (code?: number, reason?: string) => {
					if (preparationTimer) clearTimeout(preparationTimer);
					preparationTimer = undefined;
					target.close(code, reason);
				};
			const item = Reflect.get(target, name, target);
			if (typeof item !== "function") return item;
			if (!bound.has(name)) bound.set(name, item.bind(target));
			return bound.get(name);
		},
		set(target, name, item) {
			if (
				typeof name === "string" &&
				["onopen", "onmessage", "onclose", "onerror"].includes(name)
			) {
				handlers.set(name, item);
				return true;
			}
			return Reflect.set(target, name, item, target);
		},
	});
	const fail = (error: unknown) => {
		emit("error", { type: "error", error, message: String(error) });
		value.close();
	};
	value.addEventListener(
		"open",
		(event: unknown) => {
			const deadline = Date.now() + 10_000;
			const prepare = () => {
				preparationTimer = undefined;
				try {
					if (value.readyState !== 1) return;
					const candidate = value as unknown as NodeSocket;
					const node = (
						candidate._receiver ? candidate : Reflect.get(candidate, "_socket")
					) as NodeSocket;
					wire = node?._socket;
					receiver = node?._receiver;
					if (!wire || !receiver || typeof wire._socketId !== "string")
						throw Error("Platform WebSocket lacks a guest byte stream");
					if (value.extensions)
						throw Error("Synchronous WASM transport requires uncompressed protocol frames");
					// A 101 response can precede completion of the original async write's
					// accounting. Keep open and early frames private until it settles.
					if (wire._pendingBridgeWriteBytes || wire.writableLength) {
						if (Date.now() >= deadline) throw Error("WebSocket handshake write deadline exceeded");
						preparationTimer = setTimeout(prepare, 1);
						return;
					}
					const target = wire;
					installWasmProtocolWriter(target, write, () => receiving || synchronousWriteDepth > 0, queueInOwnerContext);
					prepared = true;
					emit("open", event);
					while (early.length) {
						const item = shift(early);
						emit(item.type, item.event);
					}
				} catch (error) {
					fail(error);
				}
			};
			prepare();
		},
		{ once: true },
	);
	value.addEventListener("message", (event: unknown) => {
		try {
			const item = { type: "message", event, data: bytes(Reflect.get(event as object, "data")) };
			if (!prepared) enqueue(early, item);
			else if (receiving || incoming.length || flushQueued) {
				enqueue(incoming, item);
				if (!receiving) flush();
			} else emit("message", event);
		} catch (error) {
			fail(error);
		}
	});
	for (const type of ["close", "error"])
		value.addEventListener(type, (event: unknown) => {
			if (preparationTimer) clearTimeout(preparationTimer);
			preparationTimer = undefined;
			if (!prepared) {
				while (early.length) shift(early);
			}
			if (receiving || incoming.length || flushQueued) {
				enqueue(incoming, { type, event });
				if (!receiving) flush();
			} else emit(type, event);
		});
	return transport;
}
