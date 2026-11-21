// A WebSocket between a parent runtime and a dynamic Worker process. A 101 response cannot travel
// as an RPC value, so the reply to the call carries a capability for its WebSocket instead. Each
// process couples its own WebSocketPair endpoint to a LoaderWebSocket, and the two LoaderWebSockets
// call each other's sink once per message and once to close.
//
// The WebSocket API has no backpressure, so each side counts the bytes that its peer has not taken
// yet and closes the socket above the limit. A text message travels as UTF-8 bytes, so the size of
// its RPC frame depends only on its byte length.

import { Response } from "../../globals/http.js";
import { coupleWebSocket, WebSocketPair, type WebSocketTransport } from "../../globals/websocket.js";
import { isCapnWebRpcStub, type CapnWebStub } from "../durable-objects/rpc/capnweb.js";
import { DurableObjectRpcTarget } from "../durable-objects/rpc/target.js";
import { isRecord } from "../unknown-values.js";
import { WorkerLoaderLimitError } from "./errors.js";

export const maxWebSocketBufferSetting = "ORANGE_WORKER_LOADER_MAX_WEBSOCKET_BUFFER_BYTES";
export const defaultMaxWebSocketBufferBytes = 4 * 1024 * 1024;
// Cap'n Web ends a session that receives a message above 32 MiB, and base64 adds a third.
export const maxWebSocketBufferBytesCap = 16 * 1024 * 1024;

// One limit for the process: the runtime's setting in the parent, and the value that the parent
// passed at start in the dynamic Worker.
let maxBufferBytes = defaultMaxWebSocketBufferBytes;

export function setMaxWebSocketBufferBytes(bytes: number): void {
	maxBufferBytes = bytes;
}

export function webSocketBufferLimitReached(bytes: number): boolean {
	return bytes > maxBufferBytes;
}

// The limit error of a socket that this process closed, for whoever holds its other end.
export function webSocketBufferLimitError(): WorkerLoaderLimitError {
	return new WorkerLoaderLimitError(
		`A dynamic Worker WebSocket held more than ${maxBufferBytes} bytes that its peer had not taken, so OpenOrange closed it. Set ${maxWebSocketBufferSetting} to raise the limit.`,
	);
}

const open = 1;
const closed = 3;
// A WebSocket close reason holds at most 123 bytes.
export const webSocketBufferLimitCloseReason = `${maxWebSocketBufferSetting} exceeded`;
const maxCloseReasonBytes = 123;

type Listener = (event: unknown) => void | Promise<void>;

// A Cap'n Web stub is a proxy of a function.
function isStub(value: unknown): value is CapnWebStub {
	return ((typeof value === "object" && value !== null) || typeof value === "function") && isCapnWebRpcStub(value);
}

function duplicateStub(stub: object): CapnWebStub {
	const dup: unknown = Reflect.get(stub, "dup");
	if (typeof dup !== "function") throw new Error("Cap'n Web stub cannot be duplicated");
	// SAFETY: dup() of a Cap'n Web stub returns a stub of the same target.
	return Reflect.apply(dup, stub, []) as CapnWebStub;
}

class LoaderWebSocket implements WebSocketTransport {
	binaryType: "arraybuffer" | "blob" = "arraybuffer";
	// Settles when the socket has closed, for any reason.
	readonly closed: Promise<void>;
	readonly sink = new LoaderWebSocketSink(this);
	readonly #listeners = new Map<string, Set<Listener>>();
	// Calls made before the peer's sink arrived.
	readonly #outbox: ((peer: CapnWebStub) => void)[] = [];
	#bufferedBytes = 0;
	#peer: CapnWebStub | undefined;
	#readyState = open;
	#resolveClosed: () => void = () => undefined;

	constructor() {
		this.closed = new Promise((resolve) => {
			this.#resolveClosed = resolve;
		});
	}

	get readyState(): number {
		return this.#readyState;
	}

	addEventListener(type: string, listener: Listener): void {
		let listeners = this.#listeners.get(type);
		if (listeners === undefined) {
			listeners = new Set();
			this.#listeners.set(type, listeners);
		}
		listeners.add(listener);
	}

	removeEventListener(type: string, listener: Listener): void {
		this.#listeners.get(type)?.delete(listener);
	}

	send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
		if (this.#readyState !== open) return;
		const text = typeof data === "string";
		let payload: Uint8Array;
		if (typeof data === "string") payload = Buffer.from(data);
		else if (ArrayBuffer.isView(data)) payload = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
		else if (data instanceof Blob) throw new TypeError("A dynamic Worker WebSocket cannot send a Blob.");
		else payload = new Uint8Array(data);
		const bytes = payload.byteLength;
		this.#bufferedBytes += bytes;
		if (webSocketBufferLimitReached(this.#bufferedBytes)) {
			this.#overflow();
			return;
		}
		this.#post((peer) => {
			Promise.resolve(peer.message(payload, text)).then(
				() => {
					this.#bufferedBytes -= bytes;
				},
				() => this.lost(),
			);
		});
	}

	close(code?: number, reason?: string): void {
		this.#finish({ code: code ?? 1005, reason: reason ?? "" }, undefined);
	}

	// The local end went away without a close frame, so the peer sees 1006 too.
	terminate(): void {
		this.#finish({ code: 1006, reason: "" }, undefined);
	}

	// The peer's sink arrives in the reply on the side that receives the response, and in open() on
	// the side that sent it.
	connect(peer: CapnWebStub): void {
		if (this.#peer !== undefined) throw new Error("The dynamic Worker WebSocket is already connected.");
		this.#peer = peer;
		for (const post of this.#outbox.splice(0)) post(peer);
	}

	receive(data: string | Uint8Array): void {
		if (this.#readyState === open) this.#dispatch("message", { data });
	}

	receiveClose(code: number, reason: string): void {
		this.#finish(undefined, { code, reason, wasClean: code !== 1006 });
	}

	// The other process stopped, so no close call will arrive.
	lost(): void {
		this.#finish(undefined, { code: 1006, reason: "", wasClean: false });
	}

	#overflow(): void {
		const error = webSocketBufferLimitError();
		process.stderr.write(`${error.name}: ${error.message}\n`);
		this.#dispatch("error", { error });
		const close = { code: 1011, reason: webSocketBufferLimitCloseReason };
		this.#finish(close, { ...close, wasClean: false });
	}

	// Closes once. `tell` goes to the peer, and `event` goes to the local WebSocket.
	#finish(
		tell: { code: number; reason: string } | undefined,
		event: { code: number; reason: string; wasClean: boolean } | undefined,
	): void {
		if (this.#readyState === closed) return;
		this.#readyState = closed;
		if (tell === undefined) this.#outbox.length = 0;
		// Each side releases the other's sink, so an open socket is all that keeps the Worker busy.
		this.#post((peer) => {
			const release = (): void => peer[Symbol.dispose]();
			if (tell === undefined) release();
			else Promise.resolve(peer.close(tell.code, tell.reason)).then(release, release);
		});
		if (event !== undefined) this.#dispatch("close", event);
		this.#resolveClosed();
	}

	#post(call: (peer: CapnWebStub) => void): void {
		if (this.#peer === undefined) this.#outbox.push(call);
		else call(this.#peer);
	}

	#dispatch(type: string, event: unknown): void {
		for (const listener of [...(this.#listeners.get(type) ?? [])]) {
			try {
				Promise.resolve(listener(event)).catch(reportListenerError);
			} catch (error: unknown) {
				reportListenerError(error);
			}
		}
	}
}

function reportListenerError(error: unknown): void {
	process.stderr.write(
		`A dynamic Worker WebSocket listener failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
	);
}

// What the other process calls. Only these methods are reachable over RPC.
class LoaderWebSocketSink extends DurableObjectRpcTarget {
	readonly #socket: LoaderWebSocket;

	constructor(socket: LoaderWebSocket) {
		super();
		this.#socket = socket;
	}

	open(peer: unknown): void {
		if (!isStub(peer)) throw new TypeError("A dynamic Worker WebSocket peer must be a capability.");
		// Cap'n Web releases the stubs in call parameters when the call returns.
		this.#socket.connect(duplicateStub(peer));
	}

	message(data: unknown, text: unknown): void {
		if (!(data instanceof Uint8Array)) throw new TypeError("A dynamic Worker WebSocket message must be bytes.");
		this.#socket.receive(text === true ? Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString() : data);
	}

	// The dynamic Worker is untrusted, so a value that no close frame can hold becomes one that can.
	close(code: unknown, reason: unknown): void {
		const validCode =
			typeof code === "number" && Number.isInteger(code) && code >= 1000 && code < 5000 ? code : 1011;
		const validReason =
			typeof reason === "string" && Buffer.byteLength(reason) <= maxCloseReasonBytes ? reason : "";
		this.#socket.receiveClose(validCode, validReason);
	}

	// Cap'n Web calls this when the peer released the sink or the session ended. A peer that closed
	// the socket called close() first, so the socket is still open here only if the peer stopped.
	[Symbol.dispose](): void {
		this.#socket.lost();
	}
}

export interface LoaderWebSocketReply {
	headers: [string, string][];
	sink: object;
	statusText: string;
}

// The reply for a 101 response that a call returned, or undefined for any other result.
export function sendWebSocketResponse(result: unknown): LoaderWebSocketReply | undefined {
	if (!(result instanceof Response) || result.webSocket === null) return undefined;
	const socket = new LoaderWebSocket();
	coupleWebSocket(result.webSocket, socket);
	return { headers: [...result.headers], sink: socket.sink, statusText: result.statusText };
}

const responseSockets = new WeakMap<object, LoaderWebSocket>();

// The 101 response for a reply that `sendWebSocketResponse` made in the other process.
export function receiveWebSocketResponse(reply: unknown): Response {
	if (!isRecord(reply) || !Array.isArray(reply.headers) || typeof reply.statusText !== "string") {
		throw new TypeError("Dynamic Worker sent an invalid WebSocket reply");
	}
	const sink: unknown = reply.sink;
	if (!isStub(sink)) throw new TypeError("Dynamic Worker sent a WebSocket reply without a capability");
	const headers = reply.headers.map((entry: unknown): [string, string] => {
		if (!Array.isArray(entry) || typeof entry[0] !== "string" || typeof entry[1] !== "string") {
			throw new TypeError("Dynamic Worker sent an invalid WebSocket reply header");
		}
		return [entry[0], entry[1]];
	});
	const pair = new WebSocketPair();
	const socket = new LoaderWebSocket();
	coupleWebSocket(pair[1], socket);
	socket.connect(sink);
	Promise.resolve(sink.open(socket.sink)).catch(() => socket.lost());
	const response = new Response(null, {
		headers,
		status: 101,
		statusText: reply.statusText,
		webSocket: pair[0],
	});
	responseSockets.set(response, socket);
	return response;
}

// Settles when the WebSocket of a response from `receiveWebSocketResponse` has closed. Undefined
// for any other value.
export function webSocketResponseClosed(value: unknown): Promise<void> | undefined {
	return typeof value === "object" && value !== null ? responseSockets.get(value)?.closed : undefined;
}
