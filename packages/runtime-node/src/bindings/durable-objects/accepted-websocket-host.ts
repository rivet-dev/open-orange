import { randomUUID } from "node:crypto";

import { reportError } from "../../globals/global-scope.js";
import {
	coupleWebSocket,
	WebSocket,
	type WebSocketTransport,
} from "../../globals/websocket.js";
import { isRecord } from "../unknown-values.js";
import type { RivetActorConnection } from "../../internal/rivetkit.js";
import {
	type WebSocketDrainCloser,
	webSocketDrainTransportClose,
} from "../../internal/websocket-drain.js";
import { createHibernatableWebSocketIncomingHandlers } from "./hibernatable-websocket-events.js";
import type { HibernationHeldReport, HibernationHold } from "./hibernation-lifecycle.js";
import type { DurableObjectWebSocketAutoResponseValue } from "./hibernation-settings.js";
import type { DurableObjectGeneration } from "./state.js";
import type {
	DurableObjectActorWebSocketTransport,
	DurableObjectWebSocketClientClose,
} from "./websocket-transport.js";

type TransportListener = (event: unknown) => void | Promise<void>;

const routedEventTypes = ["open", "message", "close", "error"] as const;

export interface DurableObjectAcceptedWebSocketHostOptions {
	/** Learns what keeps an object running after its idle timeout. */
	held?(generation: DurableObjectGeneration, report: HibernationHeldReport): void;
	/**
	 * Drops the idle object and keeps its accepted sockets open. When it cannot, it returns what
	 * the object still holds for a client, with counts.
	 */
	hibernate(generation: DurableObjectGeneration): true | ReadonlyMap<HibernationHold, number>;
	/** Asks Rivet to sleep the actor. */
	sleep(): void;
	/** Builds the object, when it is not running, and rebinds every accepted socket to it. */
	wake(): Promise<void>;
}

/**
 * One accepted socket's Rivet transport. It outlives the objects that serve it: while the object
 * hibernates, the transport stays open, and its next event wakes a new object.
 */
class AcceptedWebSocketLink implements WebSocketTransport {
	// Holds the socket's tags, attachment, and auto-response timestamp while no object runs, in the
	// shape that the object's socket store restores before the user constructor.
	readonly connection: RivetActorConnection = {
		id: randomUUID(),
		isHibernatable: true,
		state: null,
	};
	readonly #host: DurableObjectAcceptedWebSocketHost;
	readonly #listeners = new Map<string, TransportListener[]>();
	readonly #transport: DurableObjectActorWebSocketTransport;
	// The object and user socket while bound.
	#bound: { generation: DurableObjectGeneration; userSocket: WebSocket } | undefined;
	// "gone" once the socket closed or its actor stopped, so no event wakes an object again.
	#state: "bound" | "gone" | "hibernated" = "hibernated";

	constructor(
		host: DurableObjectAcceptedWebSocketHost,
		transport: DurableObjectActorWebSocketTransport,
	) {
		this.#host = host;
		this.#transport = transport;
		for (const type of routedEventTypes) {
			transport.addEventListener(type, (event) => this.#route(type, event));
		}
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
		const listeners = this.#listeners.get(type) ?? [];
		listeners.push(listener);
		this.#listeners.set(type, listeners);
	}

	removeEventListener(type: string, listener: TransportListener): void {
		const listeners = this.#listeners.get(type);
		if (listeners === undefined) return;
		const index = listeners.indexOf(listener);
		if (index !== -1) listeners.splice(index, 1);
	}

	send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
		this.#transport.send(data);
	}

	close(code?: number, reason?: string): void {
		this.#transport.close(code, reason);
	}

	bind(generation: DurableObjectGeneration, responseSocket: WebSocket, userSocket: WebSocket): void {
		const detach = coupleWebSocket(responseSocket, this, {
			incoming: createHibernatableWebSocketIncomingHandlers(generation, userSocket, {
				onEventSettled: () => generation.hibernationLifecycle.eventSettled(),
				onEventTimeout: () => generation.hibernationLifecycle.eventTimedOut(),
			}),
		});
		this.#state = "bound";
		this.#bound = { generation, userSocket };
		generation.hibernatableWebSockets.bindConnection(responseSocket, this.connection, detach);
	}

	/** The object hibernated, so the next event wakes a new one. */
	unbind(): void {
		this.#bound = undefined;
		if (this.#state === "bound") this.#state = "hibernated";
	}

	/** Sends the auto-response and records its time, without an event for the object. */
	autoRespond(response: string): void {
		const timestamp = Date.now();
		const bound = this.#bound;
		if (bound === undefined) {
			// The next object restores the timestamp from this state.
			if (isRecord(this.connection.state)) {
				this.connection.state.autoResponseTimestamp = timestamp;
			}
			this.#transport.send(response);
			return;
		}
		bound.generation.hibernatableWebSockets.recordAutoResponse(bound.userSocket, timestamp);
		// The user socket orders the response after the object's earlier sends.
		if (bound.userSocket.readyState === WebSocket.READY_STATE_OPEN) {
			bound.userSocket.send(response);
		}
	}

	/** Closes the transport without an event for the object. */
	end(code: number, reason: string): void {
		this.#state = "gone";
		if (this.#transport.readyState >= 2) return;
		try {
			this.#transport.close(code, reason);
		} catch {
			// RivetKit's actor WebSocket cannot send 1012-1014, so the client gets 1011 and the reason.
			this.#transport.close(1011, reason);
		}
	}

	/** Resolves once the transport is closed. */
	get closed(): Promise<void> {
		return this.#transport.closed;
	}

	#route(type: string, event: unknown): void | Promise<void> {
		if (this.#state === "gone" || this.#host.disposed) return;
		if (type === "message" && this.#host.tryAutoRespond(this, event)) return;
		if (this.#state === "bound" || type === "open") return this.#dispatch(type, event);
		// Workerd constructs the object again for the next event of a hibernated socket.
		// https://github.com/cloudflare/workerd/blob/80c80a712532b012cbeaef4d08ff6ab15407e960/src/workerd/io/legacy-hibernation-manager.c%2B%2B#L379-L418
		const delivered = this.#host.wake().then(
			() => this.#dispatch(type, event),
			(error: unknown) => {
				reportError(error);
				if (type === "close" || type === "error") this.#host.forget(this);
			},
		);
		return delivered;
	}

	async #dispatch(type: string, event: unknown): Promise<void> {
		try {
			await Promise.all(
				[...(this.#listeners.get(type) ?? [])].map((listener) => listener(event)),
			);
		} finally {
			if (type === "close") this.#host.forget(this);
		}
	}
}

/**
 * The accepted WebSockets of one Rivet actor. They outlive the object: after the idle timeout, the
 * actor drops the object and keeps these sockets open, as workerd hibernates them. Rivet has no
 * WebSocket hibernation, so the actor itself stays awake while one is open.
 * https://github.com/cloudflare/workerd/blob/80c80a712532b012cbeaef4d08ff6ab15407e960/src/workerd/server/server.c%2B%2B#L988-L1028
 */
export class DurableObjectAcceptedWebSocketHost {
	readonly #clientCloses = new Map<string, DurableObjectActorWebSocketTransport>();
	readonly #links = new Set<AcceptedWebSocketLink>();
	readonly #options: DurableObjectAcceptedWebSocketHostOptions | undefined;
	#autoResponse: DurableObjectWebSocketAutoResponseValue | null = null;
	#disposed = false;
	#waking: Promise<void> | undefined;

	constructor(options?: DurableObjectAcceptedWebSocketHostOptions) {
		this.#options = options;
		if (options !== undefined) liveHosts.add(this);
	}

	get disposed(): boolean {
		return this.#disposed;
	}

	/** The connections whose sockets the next object restores before its constructor. */
	connections(): RivetActorConnection[] {
		return [...this.#links].map((link) => link.connection);
	}

	/** Takes an accepted socket's transport, and couples it to the object that accepted it. */
	adopt(
		generation: DurableObjectGeneration,
		responseSocket: WebSocket,
		userSocket: WebSocket,
		transport: DurableObjectActorWebSocketTransport,
	): void {
		const link = new AcceptedWebSocketLink(this, transport);
		this.#links.add(link);
		link.bind(generation, responseSocket, userSocket);
	}

	/** Couples every accepted socket to a new object, which restored them before its constructor. */
	rebind(generation: DurableObjectGeneration): void {
		for (const link of [...this.#links]) {
			const restored = generation.hibernatableWebSockets.restoreConnection(link.connection);
			if (restored === undefined) {
				this.#links.delete(link);
				continue;
			}
			link.bind(generation, restored.responseSocket, restored.userSocket);
		}
		if (this.#links.size > 0) this.bindIdleTimeout(generation);
	}

	/**
	 * Runs when the object has had no event for the idle timeout. With accepted sockets open, the
	 * object hibernates. Without them, the actor sleeps.
	 */
	bindIdleTimeout(generation: DurableObjectGeneration): void {
		const options = this.#options;
		if (options === undefined) return;
		const held = options.held;
		generation.hibernationLifecycle.bind(
			() => {
				if (this.#links.size === 0) {
					options.sleep();
					return;
				}
				// An upgrade or RPC result that a client still holds needs this object, so wait again.
				const blockers = options.hibernate(generation);
				if (blockers !== true) generation.hibernationLifecycle.blocked(blockers);
			},
			held === undefined ? undefined : (report) => held(generation, report),
		);
	}

	/** Unbinds every accepted socket from the object that hibernated. */
	hibernate(): void {
		for (const link of this.#links) link.unbind();
	}

	wake(): Promise<void> {
		const options = this.#options;
		if (options === undefined) {
			return Promise.reject(new Error("Durable Object WebSocket host cannot wake an object"));
		}
		this.#waking ??= options.wake().finally(() => {
			this.#waking = undefined;
		});
		return this.#waking;
	}

	/** The object's auto-response, which stays in effect while the object hibernates. */
	setAutoResponse(value: DurableObjectWebSocketAutoResponseValue | null): void {
		this.#autoResponse = value;
	}

	// Workerd's hibernation manager answers a matching text frame before it dispatches an event, so
	// the object doesn't wake and its idle timer doesn't restart. Binary frames never match.
	// https://github.com/cloudflare/workerd/blob/80c80a712532b012cbeaef4d08ff6ab15407e960/src/workerd/io/legacy-hibernation-manager.c%2B%2B#L319-L381
	tryAutoRespond(link: AcceptedWebSocketLink, event: unknown): boolean {
		const autoResponse = this.#autoResponse;
		if (autoResponse === null) return false;
		const data = isRecord(event) ? event.data : undefined;
		if (typeof data !== "string" || data !== autoResponse.request) return false;
		link.autoRespond(autoResponse.response);
		return true;
	}

	links(): AcceptedWebSocketLink[] {
		return [...this.#links];
	}

	forget(link: AcceptedWebSocketLink): void {
		this.#links.delete(link);
	}

	/** Closes every accepted socket, as workerd disconnects them when it resets the object. */
	closeAll(code: number, reason: string): void {
		const links = [...this.#links];
		this.#links.clear();
		for (const link of links) link.end(code, reason);
	}

	/** Lets the client deliver a close code its WebSocket transport cannot send. */
	trackClientClose(token: string, transport: DurableObjectActorWebSocketTransport): void {
		this.#clientCloses.set(token, transport);
		const onClose = (): void => {
			transport.removeEventListener("close", onClose);
			if (this.#clientCloses.get(token) === transport) this.#clientCloses.delete(token);
		};
		transport.addEventListener("close", onClose);
	}

	async receiveClientClose(token: string, close: DurableObjectWebSocketClientClose): Promise<boolean> {
		const transport = this.#clientCloses.get(token);
		if (transport === undefined) return false;
		await transport.receiveClientClose(close);
		return true;
	}

	async receiveDisconnect(token: string): Promise<boolean> {
		const transport = this.#clientCloses.get(token);
		if (transport === undefined) return false;
		await transport.receiveDisconnect();
		return true;
	}

	/** Stops waking objects. The actor is stopping, and Rivet closes the sockets. */
	dispose(): void {
		liveHosts.delete(this);
		this.#disposed = true;
		this.#links.clear();
		this.#clientCloses.clear();
	}
}

const liveHosts = new Set<DurableObjectAcceptedWebSocketHost>();

/** One closer per accepted socket in this process. Its client gets 1012 from the Worker side. */
export function acceptedWebSocketDrainClosers(): WebSocketDrainCloser[] {
	const closers: WebSocketDrainCloser[] = [];
	for (const host of liveHosts) {
		for (const link of host.links()) {
			closers.push(Object.assign(async () => {
				host.forget(link);
				link.end(webSocketDrainTransportClose.code, webSocketDrainTransportClose.reason);
				await link.closed;
			}, { closed: link.closed }));
		}
	}
	return closers;
}
