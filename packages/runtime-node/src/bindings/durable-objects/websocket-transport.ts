import type { RivetWebSocket } from "../../internal/rivetkit.js";
import { clearTimeout, setTimeout } from "../../globals/timers.js";
import type { WebSocketTransport } from "../../globals/websocket.js";
import {
	webSocketDrainClose,
	webSocketDrainTransportClose,
} from "../../internal/websocket-drain.js";

const notificationTimeoutMilliseconds = 1_000;

export interface DurableObjectWebSocketClientClose {
	code: number;
	reason: string;
}

// Rivet's gateway closes an actor WebSocket with 1011 and `<group>.<code>#<ray id>` for every error
// that is not an auth error or a normal close. Only these errors mean that the actor's runner or the
// Engine went away, so the client can connect again: the UPS channel to the peer closed, failed, or
// names a peer that moved or restarted. Measured as `ups.consumer_closed` for a runner crash and for
// an Engine restart. Every other error, such as `core.internal_error`, `guard.rate_limit`, or
// `actor.not_found`, reaches the client unchanged with its ray ID.
// https://github.com/rivet-dev/rivet/blob/cf8679c670bc1e0e22252a6daf0523b9a1771ed6/engine/packages/guard-core/src/errors.rs#L103-L124
// https://github.com/rivet-dev/rivet/blob/cf8679c670bc1e0e22252a6daf0523b9a1771ed6/engine/packages/universalpubsub/src/pubsub/channel/client.rs#L527-L557
const rivetPeerGoneErrors = new Set([
	"ups.consumer_closed",
	"ups.no_responders",
	"ups.transport",
	"ups.unknown_worker",
	"ups.wrong_worker",
]);

// A close that the platform made, not the object: the object's runtime drains, or Rivet lost the
// actor's side of the socket. The client's object is gone either way, and it can connect again.
function isPlatformClose(event: unknown): boolean {
	if (typeof event !== "object" || event === null) return false;
	const reason: unknown = Reflect.get(event, "reason");
	if (Reflect.get(event, "code") !== webSocketDrainTransportClose.code || typeof reason !== "string") {
		return false;
	}
	return reason === webSocketDrainTransportClose.reason || rivetPeerGoneErrors.has(reason.split("#", 1)[0] ?? "");
}

const transportSettleEvents = ["open", "close", "error"] as const;

class DurableObjectClientWebSocketTransport implements WebSocketTransport {
	readonly #notifyClose: (
		close?: DurableObjectWebSocketClientClose,
	) => Promise<void>;
	readonly #closeListeners = new Map<TransportListener, TransportListener>();
	readonly #transport: RivetWebSocket;
	#closing = false;

	constructor(
		transport: RivetWebSocket,
		notifyClose: (close?: DurableObjectWebSocketClientClose) => Promise<void>,
	) {
		this.#transport = transport;
		this.#notifyClose = notifyClose;
	}

	get binaryType(): "arraybuffer" | "blob" {
		return this.#transport.binaryType;
	}

	set binaryType(value: "arraybuffer" | "blob") {
		this.#transport.binaryType = value;
	}

	get readyState(): number {
		return this.#transport.readyState;
	}

	addEventListener(type: string, listener: TransportListener): void {
		if (type !== "close") {
			this.#transport.addEventListener(type, listener);
			return;
		}
		// The client gets 1012 for a close that the platform made, with no Rivet error in it.
		const translated: TransportListener = (event) =>
			listener(isPlatformClose(event) ? { ...webSocketDrainClose, type: "close", wasClean: true } : event);
		this.#closeListeners.set(listener, translated);
		this.#transport.addEventListener(type, translated);
	}

	removeEventListener(type: string, listener: TransportListener): void {
		const translated = type === "close" ? this.#closeListeners.get(listener) : undefined;
		if (translated !== undefined) this.#closeListeners.delete(listener);
		this.#transport.removeEventListener(type, translated ?? listener);
	}

	send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
		this.#transport.send(data);
	}

	close(code?: number, reason?: string): void {
		// The Engine gives the actor `1001 "gateway disconnected"` for every client close, and the
		// WHATWG client that RivetKit opens can send only 1000 and 3000-4999. So deliver the code and
		// reason through private HTTP, then close Rivet's raw transport. Workerd accepts 1000-4999
		// except the reserved codes, and a close without a code reaches the peer as 1005.
		// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/web-socket.c%2B%2B#L909-L926
		// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/web-socket.c%2B%2B#L971-L973
		this.#notifyThenClose({ code: code ?? 1005, reason: reason ?? "" });
	}

	terminate(): void {
		// A 1006 status cannot be placed in a WebSocket close frame. Notify the
		// actor through private HTTP before closing Rivet's raw transport so the
		// user endpoint observes Cloudflare's synthetic abnormal-close event.
		this.#notifyThenClose();
	}

	#notifyThenClose(close?: DurableObjectWebSocketClientClose): void {
		if (this.#closing) return;
		this.#closing = true;
		// The actor learns this socket's token only once the raw transport opens, so a notice sent
		// before that finds no socket.
		void this.#opened().then(() => {
			if (this.#transport.readyState >= 2) return;
			const timeout = setTimeout(
				() => this.#closeTransport(),
				notificationTimeoutMilliseconds,
			);
			const closeTransport = (): void => {
				clearTimeout(timeout);
				this.#closeTransport();
			};
			void this.#notifyClose(close).then(closeTransport, closeTransport);
		});
	}

	#opened(): Promise<void> {
		const transport = this.#transport;
		if (transport.readyState !== 0) return Promise.resolve();
		return new Promise((resolve) => {
			const settle = (): void => {
				for (const type of transportSettleEvents) transport.removeEventListener(type, settle);
				resolve();
			};
			for (const type of transportSettleEvents) transport.addEventListener(type, settle);
		});
	}

	#closeTransport(): void {
		if (this.#transport.readyState < 2) this.#transport.close();
	}
}

export function createDurableObjectClientWebSocketTransport(
	transport: RivetWebSocket,
	notifyClose: (close?: DurableObjectWebSocketClientClose) => Promise<void>,
): WebSocketTransport {
	return new DurableObjectClientWebSocketTransport(transport, notifyClose);
}

type TransportListener = (event: unknown) => void | Promise<void>;

/**
 * The actor end of a client WebSocket transport. A client close that arrived through private HTTP
 * replaces the code and reason of the raw transport's close event.
 */
export class DurableObjectActorWebSocketTransport implements WebSocketTransport {
	// Settles after the close listeners, including the object's close handler, finish.
	readonly closed: Promise<void>;
	readonly #closeListeners = new Set<TransportListener>();
	readonly #resolveClosed: () => void;
	readonly #transport: RivetWebSocket;
	#closeDispatched = false;
	#peerClose: unknown;

	constructor(transport: RivetWebSocket) {
		this.#transport = transport;
		const { promise, resolve } = Promise.withResolvers<void>();
		this.closed = promise;
		this.#resolveClosed = resolve;
		transport.addEventListener("close", (event) => this.#dispatchClose(this.#peerClose ?? event));
	}

	get binaryType(): "arraybuffer" | "blob" {
		return this.#transport.binaryType;
	}

	set binaryType(value: "arraybuffer" | "blob") {
		this.#transport.binaryType = value;
	}

	get readyState(): number {
		return this.#transport.readyState;
	}

	addEventListener(type: string, listener: TransportListener): void {
		if (type === "close") this.#closeListeners.add(listener);
		else this.#transport.addEventListener(type, listener);
	}

	removeEventListener(type: string, listener: TransportListener): void {
		if (type === "close") this.#closeListeners.delete(listener);
		else this.#transport.removeEventListener(type, listener);
	}

	send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
		this.#transport.send(data);
	}

	close(code?: number, reason?: string): void {
		this.#transport.close(code, reason);
		// Rivet's actor socket reports no close event after a local close. Deliver the close here, as a
		// peer's reply would in workerd, or the socket's handlers and keep-awake lifetime never end.
		void this.#dispatchClose({
			code: code ?? 1005,
			reason: reason ?? "",
			type: "close",
			wasClean: true,
		});
	}

	// The client closes the raw transport after this, so its close event still follows every frame
	// the client sent before it closed. Workerd dispatches the peer's close frame as is.
	// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/io/legacy-hibernation-manager.c%2B%2B#L636-L641
	receiveClientClose({ code, reason }: DurableObjectWebSocketClientClose): void {
		this.#peerClose ??= { code, reason, type: "close", wasClean: true };
	}

	// Workerd reports a network peer that left without a close frame as this close event, not as an
	// error. Passing it through the transport also reaches acceptWebSocket()'s webSocketClose.
	// https://github.com/cloudflare/workerd/blob/fb814ad10ea778820b5e24b82f21edfb8c0f6556/src/workerd/api/web-socket.c%2B%2B
	receiveDisconnect(): void {
		this.#peerClose ??= {
			code: 1006,
			reason: "WebSocket disconnected without sending Close frame.",
			type: "close",
			wasClean: false,
		};
	}

	async #dispatchClose(event: unknown): Promise<void> {
		if (this.#closeDispatched) return;
		this.#closeDispatched = true;
		try {
			await Promise.all([...this.#closeListeners].map((listener) => listener(event)));
		} finally {
			this.#resolveClosed();
		}
	}
}
