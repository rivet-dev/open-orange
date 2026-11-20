import { deserialize } from "node:v8";

import { Event } from "./event.js";
import { reportError } from "./global-scope.js";
import { Blob, queueMicrotask } from "./native.js";
import { startWorkerOutboundWork } from "../internal/outbound-work.js";
import {
	currentDurableObjectOutputGate,
	OrderedOutput,
	type OutputGate,
	runWithOutputGate,
	waitForOutputGate,
} from "../internal/output-gate.js";
import { serializeUnshared } from "../internal/v8-serialize.js";
import { currentWorkerTmp, runWithWorkerTmp, type WorkerTmp } from "../internal/worker-tmp.js";

export interface WebSocketValue {
	readonly bufferedAmount: number;
	binaryType: "blob" | "arraybuffer";
	readonly extensions: string | null;
	readonly protocol: string | null;
	readonly readyState: number;
	readonly url: string | null;
	addEventListener(type: string, listener: unknown, options?: object | boolean): void;
	removeEventListener(type: string, listener: unknown, options?: object | boolean): void;
	dispatchEvent(event: Event): boolean;
	close(code?: number, reason?: string): void;
	send(message: ArrayBuffer | ArrayBufferView | string): void;
}

export interface WebSocketConstructor {
	readonly prototype: WebSocketValue;
	new (url: string, protocols?: string[] | string): WebSocketValue;
	readonly READY_STATE_CONNECTING: number;
	readonly CONNECTING: number;
	readonly READY_STATE_OPEN: number;
	readonly OPEN: number;
	readonly READY_STATE_CLOSING: number;
	readonly CLOSING: number;
	readonly READY_STATE_CLOSED: number;
	readonly CLOSED: number;
}

function isWebSocketConstructor(value: unknown): value is WebSocketConstructor {
	if (typeof value !== "function") return false;
	const prototype: unknown = Reflect.get(value, "prototype");
	return (
		typeof prototype === "object" &&
		prototype !== null &&
		typeof Reflect.get(prototype, "close") === "function" &&
		typeof Reflect.get(prototype, "send") === "function"
	);
}

const maybeNativeWebSocket: unknown = Reflect.get(globalThis, "WebSocket");
if (!isWebSocketConstructor(maybeNativeWebSocket)) {
	throw new Error("Node.js does not provide the required WebSocket global");
}
const NativeWebSocket = maybeNativeWebSocket;

/** Runtime-owned transports use the platform socket directly, under its network policy. */
export function createRuntimeWebSocket(url: string, protocols: string[]): WebSocketValue {
	return new NativeWebSocket(url, protocols);
}


type PairMessage = string | ArrayBuffer;
type WebSocketListener = object | Function;

interface ListenerRegistration {
	listener: WebSocketListener;
	once: boolean;
}

interface PairSocketState {
	accepted: boolean;
	allowHalfOpen: boolean;
	binaryType: "blob" | "arraybuffer";
	coupled: boolean;
	hibernatable: boolean;
	incomingClosed: boolean;
	listeners: Map<string, ListenerRegistration[]>;
	outgoingClosed: boolean;
	// Created when a gate first holds a frame, because most endpoints never wait on one.
	output?: OrderedOutput;
	// The Durable Object that created the pair. Its listeners run under that object's output gate.
	ownerGate: OutputGate | undefined;
	// The /tmp of the event or object that created the pair, which its listeners also see.
	ownerTmp: WorkerTmp | undefined;
	peer?: WebSocket;
	queuedEvents: Array<() => void>;
}

const pairSockets = new WeakMap<WebSocket, PairSocketState>();

// Each send() and close() from a Durable Object waits on its output gate, in order.
const nativeOutputs = new WeakMap<WebSocket, OrderedOutput>();

function releaseOutput(output: OrderedOutput, deliver: () => void): void {
	output.release(waitForOutputGate(), deliver);
}

// A pair endpoint gets its ordered output only when a gate first holds one of its frames.
function releasePairOutput(state: PairSocketState, deliver: () => void): void {
	const lock = waitForOutputGate();
	if (lock === undefined && state.output === undefined) {
		deliver();
		return;
	}
	state.output ??= new OrderedOutput(reportError);
	state.output.release(lock, deliver);
}

// Workerd caps a WebSocket attachment at 16 KiB, a Cloudflare quota that Orange does not copy.

interface WebSocketAttachmentState {
	onChange?: (serialized: Uint8Array) => void;
	serialized?: Uint8Array;
}

const webSocketAttachments = new WeakMap<WebSocket, WebSocketAttachmentState>();
const webSocketAutoResponseTimestamps = new WeakMap<WebSocket, number>();

function attachmentState(socket: WebSocket): WebSocketAttachmentState {
	const existing = webSocketAttachments.get(socket);
	if (existing !== undefined) return existing;
	const created: WebSocketAttachmentState = {};
	webSocketAttachments.set(socket, created);
	return created;
}

export function isWebSocketPairEndpoint(value: unknown): value is WebSocket {
	return value instanceof WebSocket && pairSockets.has(value);
}

export function getWebSocketPairPeer(socket: WebSocket): WebSocket | undefined {
	const state = pairSockets.get(socket);
	return state?.peer;
}

export function getSerializedWebSocketAttachment(
	socket: WebSocket,
): Uint8Array | undefined {
	const serialized = webSocketAttachments.get(socket)?.serialized;
	return serialized === undefined ? undefined : Uint8Array.from(serialized);
}

export function restoreSerializedWebSocketAttachment(
	socket: WebSocket,
	serialized: Uint8Array | undefined,
): void {
	const state = attachmentState(socket);
	if (serialized === undefined) {
		state.serialized = undefined;
		return;
	}
	// Validate persisted bytes before exposing a restored socket. Workerd also
	// stores the V8 wire payload and deserializes a fresh value on every read.
	// https://github.com/cloudflare/workerd/blob/fb814ad10ea778820b5e24b82f21edfb8c0f6556/src/workerd/api/web-socket.c%2B%2B#L1052-L1077
	deserialize(serialized);
	state.serialized = Uint8Array.from(serialized);
}

export function setWebSocketAttachmentChangeHandler(
	socket: WebSocket,
	onChange: ((serialized: Uint8Array) => void) | undefined,
): void {
	attachmentState(socket).onChange = onChange;
}

export function getWebSocketAutoResponseTimestamp(
	socket: WebSocket,
): Date | null {
	const timestamp = webSocketAutoResponseTimestamps.get(socket);
	return timestamp === undefined ? null : new Date(timestamp);
}

export function setWebSocketAutoResponseTimestamp(
	socket: WebSocket,
	timestamp: number | undefined,
): void {
	if (timestamp === undefined) {
		webSocketAutoResponseTimestamps.delete(socket);
	} else {
		webSocketAutoResponseTimestamps.set(socket, timestamp);
	}
}

class PairMessageEvent extends Event {
	readonly data: PairMessage | Blob;

	constructor(data: PairMessage | Blob) {
		super("message");
		this.data = data;
	}
}

class PairCloseEvent extends Event {
	readonly code: number;
	readonly reason: string;
	readonly wasClean: boolean;

	constructor(code: number, reason: string, wasClean: boolean) {
		super("close");
		this.code = code;
		this.reason = reason;
		this.wasClean = wasClean;
	}
}

class PairErrorEvent extends Event {
	readonly error: unknown;

	constructor(error: unknown) {
		super("error");
		this.error = error;
	}
}

function unsupported(operation: string): Error {
	const error = new Error(
		`Cloudflare WebSocket.${operation}() is not implemented by OpenOrange`,
	);
	error.name = "NotSupportedError";
	return error;
}

function domError(name: string, message: string): Error {
	const error = new Error(message);
	error.name = name;
	return error;
}

function nativeMember(receiver: WebSocket, name: string): unknown {
	return Reflect.get(NativeWebSocket.prototype, name, receiver);
}

function callNative(
	receiver: WebSocket,
	name: string,
	parameters: unknown[],
): unknown {
	const member = nativeMember(receiver, name);
	if (typeof member !== "function") {
		throw new TypeError(`Native WebSocket.${name} is not callable`);
	}
	return Reflect.apply(member, receiver, parameters);
}

function listenerFrom(value: unknown): WebSocketListener | undefined {
	if (typeof value === "function") return value;
	if (
		typeof value === "object" &&
		value !== null &&
		typeof Reflect.get(value, "handleEvent") === "function"
	) {
		return value;
	}
	return undefined;
}

function onceFrom(options: object | boolean | undefined): boolean {
	return (
		typeof options === "object" &&
		options !== null &&
		Reflect.get(options, "once") === true
	);
}

function pairState(socket: WebSocket): PairSocketState | undefined {
	return pairSockets.get(socket);
}

function requirePeer(state: PairSocketState): WebSocket {
	if (state.peer === undefined) {
		throw new Error("OpenOrange WebSocketPair is not entangled");
	}
	return state.peer;
}

function dispatchPairEvent(socket: WebSocket, event: Event): boolean {
	const state = pairSockets.get(socket);
	if (state === undefined) {
		throw new TypeError("WebSocket is not a local pair endpoint");
	}
	// Listeners of a socket that a Durable Object created run as that object's code, as in
	// workerd's actor IoContext, so their outgoing messages wait on its output gate.
	if (
		state.ownerGate !== undefined &&
		currentDurableObjectOutputGate() !== state.ownerGate
	) {
		return runWithOutputGate(state.ownerGate, () =>
			dispatchPairEvent(socket, event),
		);
	}
	if (state.ownerTmp !== undefined && currentWorkerTmp() !== state.ownerTmp) {
		return runWithWorkerTmp(state.ownerTmp, () => dispatchPairEvent(socket, event));
	}
	const registrations = [...(state.listeners.get(event.type) ?? [])];
	let listenerError: { error: unknown } | undefined;
	for (const registration of registrations) {
		if (registration.once) {
			const current = state.listeners.get(event.type) ?? [];
			state.listeners.set(
				event.type,
				current.filter((entry) => entry.listener !== registration.listener),
			);
		}
		// A throwing listener is reported to the global scope and the remaining
		// listeners still run, as with any workerd EventTarget dispatch.
		try {
			if (typeof registration.listener === "function") {
				Reflect.apply(registration.listener, socket, [event]);
			} else {
				const handleEvent: unknown = Reflect.get(
					registration.listener,
					"handleEvent",
				);
				if (typeof handleEvent === "function") {
					Reflect.apply(handleEvent, registration.listener, [event]);
				}
			}
		} catch (error: unknown) {
			listenerError ??= { error };
			reportError(error);
		}
	}
	// A throwing message listener errors the WebSocket once the dispatch
	// finishes, so the remaining listeners still see an open socket.
	// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/tests/events-test.js#L699-L747
	if (listenerError !== undefined && event.type === "message") {
		const { error } = listenerError;
		queueMicrotask(() => dispatchPairEvent(socket, new PairErrorEvent(error)));
	}
	return !event.defaultPrevented;
}

function enqueuePairEvent(socket: WebSocket, dispatch: () => void): void {
	const state = pairSockets.get(socket);
	if (state === undefined) {
		throw new TypeError("WebSocket is not a local pair endpoint");
	}
	if (state.accepted) dispatch();
	else state.queuedEvents.push(dispatch);
}

// DurableObjectState uses a distinct acceptance mode because workerd does not
// permit a hibernatable endpoint to be accepted through the standard API, or
// to register one whose peer is no longer awaiting response coupling.
// https://github.com/cloudflare/workerd/blob/fb814ad10ea778820b5e24b82f21edfb8c0f6556/src/workerd/api/actor-state.c%2B%2B#L1231-L1264
export function acceptWebSocketForHibernation(socket: WebSocket): void {
	const state = pairSockets.get(socket);
	if (state === undefined) {
		throw new TypeError("WebSocket is not a local pair endpoint");
	}
	if (state.accepted) {
		throw new Error(
			"Cannot call `acceptWebSocket()` if the WebSocket was already accepted via `accept()`",
		);
	}
	const peerState = pairSockets.get(requirePeer(state));
	if (peerState === undefined || peerState.accepted) {
		throw new Error(
			"Cannot call `acceptWebSocket()` on this WebSocket because its pair has already been accepted or used in a Response.",
		);
	}
	state.accepted = true;
	state.hibernatable = true;
	for (const dispatch of state.queuedEvents.splice(0)) dispatch();
}

function copyMessage(message: ArrayBuffer | ArrayBufferView | string): PairMessage {
	if (typeof message === "string") return message;
	// Workerd snapshots binary data before the asynchronous frame pump can
	// observe a detached or mutated V8 backing store.
	// https://github.com/cloudflare/workerd/blob/fb814ad10ea778820b5e24b82f21edfb8c0f6556/src/workerd/api/web-socket.c%2B%2B#L883-L890
	if (message instanceof ArrayBuffer) return message.slice(0);
	const bytes = new Uint8Array(
		message.buffer,
		message.byteOffset,
		message.byteLength,
	);
	return Uint8Array.from(bytes).buffer;
}

function incomingBinary(state: PairSocketState, message: ArrayBuffer): ArrayBuffer | Blob {
	return state.binaryType === "arraybuffer"
		? message.slice(0)
		: new Blob([message]);
}

function sendPairMessage(socket: WebSocket, message: PairMessage): void {
	const state = pairSockets.get(socket);
	if (state === undefined) {
		throw new TypeError("WebSocket is not a local pair endpoint");
	}
	if (state.outgoingClosed) {
		throw new TypeError("Can't call WebSocket send() after close().");
	}
	deliverPairMessage(requirePeer(state), message);
}

function deliverPairMessage(peer: WebSocket, message: PairMessage): void {
	queueMicrotask(() => {
		enqueuePairEvent(peer, () => {
			const peerState = pairSockets.get(peer);
			if (peerState === undefined) return;
			const data =
				typeof message === "string"
					? message
					: incomingBinary(peerState, message);
			dispatchPairEvent(peer, new PairMessageEvent(data));
		});
	});
}

function receivePairClose(
	socket: WebSocket,
	sender: WebSocket,
	code: number,
	reason: string,
	wasClean = true,
	dispatchEvents = true,
): void {
	const state = pairSockets.get(socket);
	const senderState = pairSockets.get(sender);
	if (state === undefined || senderState === undefined || state.incomingClosed) {
		return;
	}
	state.incomingClosed = true;
	if (!state.allowHalfOpen && !state.outgoingClosed) {
		state.outgoingClosed = true;
		senderState.incomingClosed = true;
		if (dispatchEvents) {
			queueMicrotask(() => {
				enqueuePairEvent(sender, () => {
					dispatchPairEvent(sender, new PairCloseEvent(code, reason, wasClean));
				});
			});
		}
	}
	if (dispatchEvents) {
		dispatchPairEvent(socket, new PairCloseEvent(code, reason, wasClean));
	}
}

function closePairSocket(
	socket: WebSocket,
	code?: number,
	reason?: string,
	wasClean = true,
	dispatchEvents = true,
): void {
	const state = pairSockets.get(socket);
	if (state === undefined) {
		throw new TypeError("WebSocket is not a local pair endpoint");
	}
	if (state.outgoingClosed) return;
	state.outgoingClosed = true;
	deliverPairClose(socket, requirePeer(state), code, reason, wasClean, dispatchEvents);
}

function deliverPairClose(
	socket: WebSocket,
	peer: WebSocket,
	code?: number,
	reason?: string,
	wasClean = true,
	dispatchEvents = true,
): void {
	queueMicrotask(() => {
		enqueuePairEvent(peer, () => {
			receivePairClose(
				peer,
				socket,
				code ?? 1005,
				reason ?? "",
				wasClean,
				dispatchEvents,
			);
		});
	});
}

export function terminateCoupledWebSocket(
	socket: WebSocket,
	code: number,
	reason: string,
	wasClean: boolean,
): void {
	if (pairSockets.get(socket) === undefined) {
		throw new TypeError("Only a WebSocketPair endpoint can be terminated");
	}
	closePairSocket(socket, code, reason, wasClean);
}

function validateClose(code?: number, reason?: string): void {
	// Current workerd validates before checking the socket state. Keep this in
	// sync with the pinned implementation:
	// https://github.com/cloudflare/workerd/blob/fb814ad10ea778820b5e24b82f21edfb8c0f6556/src/workerd/api/web-socket.c%2B%2B#L904-L941
	if (
		code !== undefined &&
		!(
			code >= 1000 &&
			code < 5000 &&
			code !== 1004 &&
			code !== 1005 &&
			code !== 1006 &&
			code !== 1015
		)
	) {
		throw domError("InvalidAccessError", `Invalid WebSocket close code: ${code}.`);
	}
	if (reason !== undefined && new TextEncoder().encode(reason).byteLength > 123) {
		throw domError(
			"SyntaxError",
			"WebSocket close reason must not be longer than 123 bytes when UTF-8 encoded.",
		);
	}
	if (reason !== undefined && code === undefined) {
		throw domError(
			"InvalidAccessError",
			"If you specify a WebSocket close reason, you must also specify a code.",
		);
	}
}

// The pair state machine follows workerd's OPEN/CLOSING/CLOSED predicates and
// Miniflare v2's small JavaScript entanglement/queue pattern. Each send() and
// close() from a Durable Object waits on its output gate.
// https://github.com/cloudflare/workerd/blob/fb814ad10ea778820b5e24b82f21edfb8c0f6556/src/workerd/api/web-socket.c%2B%2B#L984-L995
// https://github.com/cloudflare/miniflare/blob/b536e56ee19803f0c1fbb922394992bbed7e7c96/packages/web-sockets/src/websocket.ts#L194-L349
export class WebSocket extends NativeWebSocket {
	static readonly READY_STATE_CONNECTING = NativeWebSocket.CONNECTING;
	static readonly READY_STATE_OPEN = NativeWebSocket.OPEN;
	static readonly READY_STATE_CLOSING = NativeWebSocket.CLOSING;
	static readonly READY_STATE_CLOSED = NativeWebSocket.CLOSED;

	// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/web-socket.c%2B%2B#L457-L466
	constructor(url: string | URL, protocols?: string | string[]) {
		if (!URL.canParse(String(url))) {
			throw domError("SyntaxError", "WebSocket Constructor: The url is invalid.");
		}
		super(String(url), protocols);
		// Workerd does not hibernate an object while a WebSocket that it opened is open. Measured
		// on `wrangler dev` 4.129. RivetKit opens its gateway sockets with this class when it
		// cannot use `ws`, and those are not the Worker's sockets.
		const ended = startWorkerOutboundWork(new.target, "outbound-websocket");
		if (ended !== undefined) {
			callNative(this, "addEventListener", ["close", ended, { once: true }]);
		}
	}

	get bufferedAmount(): number {
		return pairState(this) === undefined
			? Number(nativeMember(this, "bufferedAmount"))
			: 0;
	}

	get binaryType(): "blob" | "arraybuffer" {
		const state = pairState(this);
		if (state !== undefined) return state.binaryType;
		return nativeMember(this, "binaryType") === "arraybuffer"
			? "arraybuffer"
			: "blob";
	}

	set binaryType(value: "blob" | "arraybuffer") {
		// Workerd ignores values other than "blob" and "arraybuffer"; undici
		// resets the type to "blob" instead.
		// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/web-socket.c%2B%2B#L1698-L1705
		if (value !== "blob" && value !== "arraybuffer") return;
		const state = pairState(this);
		if (state !== undefined) {
			state.binaryType = value;
			return;
		}
		if (!Reflect.set(NativeWebSocket.prototype, "binaryType", value, this)) {
			throw new TypeError("Unable to set native WebSocket.binaryType");
		}
	}

	get extensions(): string | null {
		return pairState(this) === undefined
			? String(nativeMember(this, "extensions"))
			: null;
	}

	get protocol(): string | null {
		return pairState(this) === undefined
			? String(nativeMember(this, "protocol"))
			: null;
	}

	get readyState(): number {
		const state = pairState(this);
		if (state === undefined) return Number(nativeMember(this, "readyState"));
		if (state.incomingClosed && state.outgoingClosed) {
			return WebSocket.READY_STATE_CLOSED;
		}
		if (state.incomingClosed || state.outgoingClosed) {
			return WebSocket.READY_STATE_CLOSING;
		}
		return WebSocket.READY_STATE_OPEN;
	}

	get url(): string | null {
		return pairState(this) === undefined
			? String(nativeMember(this, "url"))
			: null;
	}

	addEventListener(
		type: string,
		listener: unknown,
		options?: object | boolean,
	): void {
		const state = pairState(this);
		if (state === undefined) {
			callNative(this, "addEventListener", [type, listener, options]);
			return;
		}
		const parsed = listenerFrom(listener);
		if (parsed === undefined) return;
		const registrations = state.listeners.get(type) ?? [];
		if (!registrations.some((entry) => entry.listener === parsed)) {
			registrations.push({ listener: parsed, once: onceFrom(options) });
			state.listeners.set(type, registrations);
		}
	}

	removeEventListener(
		type: string,
		listener: unknown,
		options?: object | boolean,
	): void {
		const state = pairState(this);
		if (state === undefined) {
			callNative(this, "removeEventListener", [type, listener, options]);
			return;
		}
		state.listeners.set(
			type,
			(state.listeners.get(type) ?? []).filter(
				(entry) => entry.listener !== listener,
			),
		);
	}

	dispatchEvent(event: Event): boolean {
		if (pairState(this) !== undefined) return dispatchPairEvent(this, event);
		return callNative(this, "dispatchEvent", [event]) === true;
	}

	accept(options?: { allowHalfOpen?: boolean }): void {
		const state = pairState(this);
		if (state === undefined) throw unsupported("accept");
		if (state.coupled) {
			throw new TypeError(
				"Can't accept() WebSocket that was already used in a response.",
			);
		}
		if (state.hibernatable) {
			throw new TypeError("Can't accept() WebSocket after enabling hibernation.");
		}
		if (state.accepted) return;
		state.allowHalfOpen = options?.allowHalfOpen === true;
		state.accepted = true;
		const queued = state.queuedEvents.splice(0);
		for (const dispatch of queued) dispatch();
	}

	send(message: ArrayBuffer | ArrayBufferView | string): void {
		const state = pairState(this);
		if (state === undefined) {
			// A connecting socket throws synchronously, so only an open socket's frames queue.
			if (Number(nativeMember(this, "readyState")) === WebSocket.READY_STATE_CONNECTING) {
				callNative(this, "send", [message]);
				return;
			}
			const snapshot =
				typeof message === "string" ||
				message instanceof ArrayBuffer ||
				ArrayBuffer.isView(message)
					? copyMessage(message)
					: message;
			releaseOutput(nativeOutput(this), () => {
				callNative(this, "send", [snapshot]);
			});
			return;
		}
		if (!state.accepted) {
			throw new TypeError(
				"You must call one of accept() or state.acceptWebSocket() on this WebSocket before sending messages.",
			);
		}
		if (state.outgoingClosed) {
			throw new TypeError("Can't call WebSocket send() after close().");
		}
		const peer = requirePeer(state);
		const copied = copyMessage(message);
		releasePairOutput(state, () => deliverPairMessage(peer, copied));
	}

	close(code?: number, reason?: string): void {
		const state = pairState(this);
		if (state === undefined) {
			releaseOutput(nativeOutput(this), () => {
				callNative(this, "close", [code, reason]);
			});
			return;
		}
		validateClose(code, reason);
		if (!state.accepted) {
			throw new TypeError(
				"You must call one of accept() or state.acceptWebSocket() on this WebSocket before sending messages.",
			);
		}
		if (state.outgoingClosed) return;
		state.outgoingClosed = true;
		const peer = requirePeer(state);
		releasePairOutput(state, () => deliverPairClose(this, peer, code, reason));
	}

	serializeAttachment(attachment: unknown): void {
		// Workerd uses V8 serializer format version 15 (including its header),
		// rejects non-cloneable values, and applies the 16 KiB limit to those bytes.
		// Node's V8 serializer gives Orange the same graph/cycle semantics while the
		// hibernation store owns transport persistence.
		// https://github.com/cloudflare/workerd/blob/fb814ad10ea778820b5e24b82f21edfb8c0f6556/src/workerd/api/web-socket.c%2B%2B#L1052-L1077
		let serialized: Uint8Array;
		try {
			serialized = serializeUnshared(attachment);
		} catch (error) {
			if (error instanceof Error) error.name = "DataCloneError";
			throw error;
		}
		const state = attachmentState(this);
		const copied = Uint8Array.from(serialized);
		state.onChange?.(copied);
		state.serialized = copied;
	}

	deserializeAttachment(): unknown | null {
		const serialized = webSocketAttachments.get(this)?.serialized;
		return serialized === undefined ? null : deserialize(serialized);
	}
}

function createPairSocket(): WebSocket {
	const value: unknown = Object.create(WebSocket.prototype);
	if (!(value instanceof WebSocket)) {
		throw new Error("Failed to construct an OpenOrange WebSocketPair endpoint");
	}
	pairSockets.set(value, {
		accepted: false,
		allowHalfOpen: false,
		binaryType: "blob",
		coupled: false,
		hibernatable: false,
		incomingClosed: false,
		listeners: new Map(),
		outgoingClosed: false,
		ownerGate: currentDurableObjectOutputGate(),
		ownerTmp: currentWorkerTmp(),
		queuedEvents: [],
	});
	return value;
}

function nativeOutput(socket: WebSocket): OrderedOutput {
	let output = nativeOutputs.get(socket);
	if (output === undefined) {
		output = new OrderedOutput(reportError);
		nativeOutputs.set(socket, output);
	}
	return output;
}

// This global is a small immutable holder. DurableObjectState applies the
// byte limits and installs a fresh copy when the configuration is read:
// https://github.com/cloudflare/workerd/blob/fb814ad10ea778820b5e24b82f21edfb8c0f6556/src/workerd/api/actor-state.h#L552-L575
const webSocketRequestResponsePairValues = new WeakMap<
	object,
	{ request: string; response: string }
>();

function webSocketRequestResponsePairValue(
	pair: WebSocketRequestResponsePair,
): { request: string; response: string } {
	const value = webSocketRequestResponsePairValues.get(pair);
	if (value === undefined) {
		throw new TypeError("Illegal invocation");
	}
	return value;
}

export class WebSocketRequestResponsePair {
	constructor(request: string, response: string) {
		webSocketRequestResponsePairValues.set(this, {
			request: `${request}`,
			response: `${response}`,
		});
	}

	get request(): string {
		return webSocketRequestResponsePairValue(this).request;
	}

	get response(): string {
		return webSocketRequestResponsePairValue(this).response;
	}
}

export class WebSocketPair {
	readonly 0: WebSocket;
	readonly 1: WebSocket;

	constructor() {
		const first = createPairSocket();
		const second = createPairSocket();
		const firstState = pairSockets.get(first);
		const secondState = pairSockets.get(second);
		if (firstState === undefined || secondState === undefined) {
			throw new Error("Failed to initialize OpenOrange WebSocketPair state");
		}
		firstState.peer = second;
		secondState.peer = first;
		this[0] = first;
		this[1] = second;
	}

	// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/web-socket.h#L135-L143
	*[Symbol.iterator](): IterableIterator<WebSocket> {
		yield this[0];
		yield this[1];
	}
}

export interface WebSocketTransport {
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
	terminate?(): void;
}

export interface WebSocketIncomingHandlers {
	close(code: number, reason: string, wasClean: boolean): void | Promise<void>;
	error(error: unknown): void | Promise<void>;
	message(message: string | ArrayBuffer): void | Promise<void>;
}

export interface WebSocketCouplingOptions {
	incoming?: WebSocketIncomingHandlers;
}

function eventProperty(event: unknown, name: string): unknown {
	return typeof event === "object" && event !== null
		? Reflect.get(event, name)
		: undefined;
}

function isBlobValue(value: unknown): value is Blob {
	return (
		typeof value === "object" &&
		value !== null &&
		Object.prototype.toString.call(value) === "[object Blob]"
	);
}

function transportMessage(
	socket: WebSocket,
	data: string | ArrayBuffer | ArrayBufferView,
): void {
	const state = pairSockets.get(socket);
	if (state === undefined || state.outgoingClosed) return;
	sendPairMessage(socket, copyMessage(data));
}

function transportError(socket: WebSocket, error: unknown): void {
	const state = pairSockets.get(socket);
	if (state === undefined) return;
	const peer = requirePeer(state);
	queueMicrotask(() => {
		enqueuePairEvent(peer, () => {
			dispatchPairEvent(peer, new PairErrorEvent(error));
		});
	});
}

// workerd forwards a peer's close code and reason verbatim:
// https://github.com/cloudflare/workerd/blob/fb814ad10ea778820b5e24b82f21edfb8c0f6556/src/workerd/api/web-socket.c%2B%2B#L1314-L1316
// The pair accepts every code that workerd accepts, but some transports cannot
// send all of them. RivetKit's actor WebSocket rejects 1012-1014 and the `ws`
// package rejects 1016-2999. Such a code becomes 1011, the closest code that
// every transport can send, so the peer still sees an error close.
function closeTransportWithPeerCode(
	transport: WebSocketTransport,
	code: number,
	reason: string,
): void {
	try {
		transport.close(code, reason);
	} catch {
		transport.close(1011, reason);
	}
}

// Couples a local WebSocketPair endpoint to an already-owned transport. Like
// workerd's two eager pump directions, the non-hibernatable connection remains
// attached until a terminal event. The caller retains transport lifecycle
// ownership; this adapter only mirrors frames and terminal events.
// https://github.com/cloudflare/workerd/blob/fb814ad10ea778820b5e24b82f21edfb8c0f6556/src/workerd/api/web-socket.c%2B%2B#L3118-L3224
export function coupleWebSocket(
	socket: WebSocket,
	transport: WebSocketTransport,
	options: WebSocketCouplingOptions = {},
): () => void {
	const state = pairSockets.get(socket);
	if (state === undefined) {
		throw new TypeError("Only a WebSocketPair endpoint can be coupled");
	}
	if (state.coupled) {
		throw new TypeError("Can't return WebSocket that was already used in a response.");
	}
	if (state.accepted) {
		throw new TypeError(
			state.hibernatable
				? "Can't return WebSocket in a Response after calling acceptWebSocket()."
				: "Can't return WebSocket in a Response after calling accept().",
		);
	}

	const pending: Array<string | ArrayBufferLike | Blob | ArrayBufferView> = [];
	const sendToTransport = (data: string | ArrayBufferLike | Blob | ArrayBufferView) => {
		if (transport.readyState === WebSocket.READY_STATE_CONNECTING) {
			pending.push(data);
		} else if (transport.readyState === WebSocket.READY_STATE_OPEN) {
			transport.send(data);
		}
	};
	const onPairMessage = (event: unknown) => {
		const data = eventProperty(event, "data");
		if (
			typeof data === "string" ||
			data instanceof ArrayBuffer ||
			ArrayBuffer.isView(data) ||
			isBlobValue(data)
		) {
			sendToTransport(data);
		}
	};
	const onPairClose = (event: unknown) => {
		if (transport.readyState >= WebSocket.READY_STATE_CLOSING) return;
		const code = eventProperty(event, "code");
		const reason = eventProperty(event, "reason");
		if (code === 1006 && transport.terminate !== undefined) {
			transport.terminate();
		} else if (code === 1005 || code === 1006) transport.close();
		else
			closeTransportWithPeerCode(
				transport,
				typeof code === "number" ? code : 1000,
				typeof reason === "string" ? reason : "",
			);
	};
	const onTransportOpen = () => {
		for (const message of pending.splice(0)) transport.send(message);
	};
	const dispatchIncomingMessage = (
		data: string | ArrayBuffer | ArrayBufferView,
	): void | Promise<void> => {
		if (options.incoming !== undefined) {
			return options.incoming.message(copyMessage(data));
		}
		transportMessage(socket, data);
	};
	const onTransportMessage = (event: unknown): void | Promise<void> => {
		const data = eventProperty(event, "data");
		if (typeof data === "string" || data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
			return dispatchIncomingMessage(data);
		}
		if (isBlobValue(data)) {
			const arrayBuffer: unknown = Reflect.get(data, "arrayBuffer");
			if (typeof arrayBuffer === "function") {
				return Promise.resolve(Reflect.apply(arrayBuffer, data, [])).then(
					(value: unknown) => {
						if (value instanceof ArrayBuffer) {
							return dispatchIncomingMessage(value);
						}
					},
					(error: unknown) => {
						if (options.incoming !== undefined) {
							return options.incoming.error(error);
						}
						transportError(socket, error);
					},
				);
			}
		}
	};
	const onTransportClose = (event: unknown): void | Promise<void> => {
		const code = eventProperty(event, "code");
		const rawReason = eventProperty(event, "reason");
		const wasClean = eventProperty(event, "wasClean");
		const closeCode = typeof code === "number" ? code : 1006;
		const reason =
			closeCode === 1006 && (typeof rawReason !== "string" || rawReason.length === 0)
				? "WebSocket disconnected without sending Close frame."
				: typeof rawReason === "string"
					? rawReason
					: "";
		const clean = typeof wasClean === "boolean" ? wasClean : closeCode !== 1006;
		closePairSocket(socket, closeCode, reason, clean, options.incoming === undefined);
		if (options.incoming !== undefined) {
			// The pair state transition is queued before this continuation, so the
			// hibernatable method observes a terminal WebSocket without receiving a
			// normal DOM close event.
			return Promise.resolve().then(() =>
				options.incoming?.close(closeCode, reason, clean),
			);
		}
	};
	const onTransportError = (event: unknown): void | Promise<void> => {
		const error = eventProperty(event, "error") ?? event;
		if (options.incoming !== undefined) {
			closePairSocket(socket, 1006, "", false, false);
			return Promise.resolve().then(() => options.incoming?.error(error));
		}
		transportError(socket, error);
	};

	socket.addEventListener("message", onPairMessage);
	socket.addEventListener("close", onPairClose);
	transport.addEventListener("open", onTransportOpen);
	transport.addEventListener("message", onTransportMessage);
	transport.addEventListener("close", onTransportClose);
	transport.addEventListener("error", onTransportError);
	transport.binaryType = "arraybuffer";
	state.binaryType = "arraybuffer";
	state.accepted = true;
	state.coupled = true;
	for (const dispatch of state.queuedEvents.splice(0)) dispatch();
	if (transport.readyState === WebSocket.READY_STATE_OPEN) onTransportOpen();

	let detached = false;
	return () => {
		if (detached) return;
		detached = true;
		socket.removeEventListener("message", onPairMessage);
		socket.removeEventListener("close", onPairClose);
		transport.removeEventListener("open", onTransportOpen);
		transport.removeEventListener("message", onTransportMessage);
		transport.removeEventListener("close", onTransportClose);
		transport.removeEventListener("error", onTransportError);
		pending.splice(0);
	};
}
