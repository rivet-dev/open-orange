import { createRequire } from "node:module";
import { STATUS_CODES, type IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

import type { Response } from "../globals/http.js";
import {
	coupleWebSocket,
	type WebSocket,
	type WebSocketTransport,
} from "../globals/websocket.js";

export interface NetworkWebSocket extends WebSocketTransport {
	on(type: "pong", listener: () => void): void;
	ping(): void;
	terminate(): void;
}

interface NetworkWebSocketServer {
	close(callback: (error?: Error) => void): void;
	handleUpgrade(
		request: IncomingMessage,
		socket: Duplex,
		head: Uint8Array,
		callback: (webSocket: NetworkWebSocket) => void,
	): void;
	on(type: "headers", listener: (headers: string[], request: IncomingMessage) => void): void;
}

interface WsClientWebSocket extends NetworkWebSocket {
	readonly protocol: string;
	on(type: "error", listener: (error: unknown) => void): void;
	on(type: "pong", listener: () => void): void;
	once(type: "open", listener: () => void): void;
	once(type: "upgrade", listener: (response: IncomingMessage) => void): void;
	once(
		type: "unexpected-response",
		listener: (request: unknown, response: IncomingMessage) => void,
	): void;
}

// The exports of the `ws` package that Orange uses. Orange does not depend on @types/ws.
interface WsModule {
	WebSocket: new (
		url: string,
		protocols: string[],
		options: { headers: Record<string, string>; perMessageDeflate: false },
	) => WsClientWebSocket;
	WebSocketServer: new (options: {
		handleProtocols(protocols: ReadonlySet<string>, request: IncomingMessage): string | false;
		noServer: true;
	}) => NetworkWebSocketServer;
}

const requireFromOrange = createRequire(import.meta.url);

function loadWs(): WsModule {
	// SAFETY: `ws` is a pinned dependency whose exports match WsModule. require() is untyped.
	return requireFromOrange("ws") as WsModule;
}

function offeredWebSocketProtocols(request: IncomingMessage): Set<string> {
	const raw = request.headers["sec-websocket-protocol"];
	const values = typeof raw === "string" ? [raw] : [];
	return new Set(
		values.flatMap((value) =>
			value
				.split(",")
				.map((protocol) => protocol.trim())
				.filter((protocol) => protocol.length > 0),
		),
	);
}

export function closeUncoupledWorkerWebSocket(socket: WebSocket): void {
	try {
		socket.accept({ allowHalfOpen: true });
		socket.close(1011, "OpenOrange WebSocket upgrade failed");
	} catch {
		// The response socket may already have been consumed by another failure path.
	}
}

export async function writeRejectedUpgrade(
	socket: Duplex,
	response: Response,
	extraHeaders: readonly [string, string][] = [],
): Promise<void> {
	const body = Buffer.from(await response.arrayBuffer());
	const statusText = response.statusText || STATUS_CODES[response.status] || "Response";
	const lines = [`HTTP/1.1 ${response.status} ${statusText}`];
	for (const [name, value] of [...response.headers, ...extraHeaders]) {
		if (
			name !== "connection" &&
			name !== "content-length" &&
			name !== "transfer-encoding"
		) {
			lines.push(`${name}: ${value}`);
		}
	}
	lines.push("connection: close", `content-length: ${body.byteLength}`, "", "");
	socket.end(Buffer.concat([Buffer.from(lines.join("\r\n")), body]));
}

export function writeUpgradeFailure(socket: Duplex): void {
	if (socket.destroyed) return;
	const body = Buffer.from("Internal Server Error");
	socket.end(
		Buffer.concat([
			Buffer.from(
				`HTTP/1.1 500 Internal Server Error\r\nconnection: close\r\ncontent-type: text/plain; charset=utf-8\r\ncontent-length: ${body.byteLength}\r\n\r\n`,
			),
			body,
		]),
	);
}

// Accepts network WebSockets for a runtime's HTTP server and closes them with it.
const closeHandshakeTimeoutMs = 1_000;
// Cloudflare, in front of Rivet's pool URLs, closes a socket with no traffic after 125 s with 1006.
// Clients answer pings without help from the application. The frames stop at this server, so
// a Worker or Durable Object never sees them, and they don't count as activity.
// https://developers.cloudflare.com/network/websockets/
const keepAlivePingIntervalMs = 30_000;
// A client that lost the network ends nothing, so only its silence shows it is gone.
const keepAliveMissedPongLimit = 2;

export class NetworkWebSocketUpgrades {
	readonly #selectedProtocols = new WeakMap<object, string>();
	readonly #upgradeHeaders = new WeakMap<object, string[]>();
	// Each open socket and the pings it has not answered.
	readonly #sockets = new Map<NetworkWebSocket, number>();
	// One timer pings every socket, so an open socket holds no timer of its own.
	#keepAlive: ReturnType<typeof setInterval> | undefined;
	readonly #server: NetworkWebSocketServer;

	constructor() {
		const selectedProtocols = this.#selectedProtocols;
		this.#server = new (loadWs().WebSocketServer)({
			handleProtocols(protocols, request): string | false {
				const selected = selectedProtocols.get(request);
				return selected !== undefined && protocols.has(selected) ? selected : false;
			},
			noServer: true,
		});
		this.#server.on("headers", (headers, request) => {
			const extraHeaders = this.#upgradeHeaders.get(request);
			if (extraHeaders === undefined) return;
			for (const header of extraHeaders) headers.push(header);
		});
	}

	// Completes an upgrade with the WebSocket of a Worker's 101 response.
	// Workerd couples the response endpoint to the accepted network socket
	// with eager pumps in both directions and keeps a non-hibernatable actor
	// request alive until that coupling terminates.
	// https://github.com/cloudflare/workerd/blob/fb814ad10ea778820b5e24b82f21edfb8c0f6556/src/workerd/api/web-socket.c%2B%2B#L3118-L3224
	coupleResponse(
		incoming: IncomingMessage,
		socket: Duplex,
		head: Uint8Array,
		response: Response,
		responseSocket: WebSocket,
		onError: (error: unknown) => void,
		onCoupled?: () => void,
	): void {
		const selectedProtocol = response.headers.get("sec-websocket-protocol");
		if (selectedProtocol !== null) {
			if (!offeredWebSocketProtocols(incoming).has(selectedProtocol)) {
				throw new Error(`Worker selected an unoffered WebSocket protocol: ${selectedProtocol}`);
			}
			this.#selectedProtocols.set(incoming, selectedProtocol);
		}
		this.#upgradeHeaders.set(
			incoming,
			[...response.headers]
				.filter(
					([name]) =>
						name !== "connection" &&
						name !== "sec-websocket-accept" &&
						name !== "sec-websocket-protocol" &&
						name !== "upgrade",
				)
				.map(([name, value]) => `${name}: ${value}`),
		);
		this.#server.handleUpgrade(incoming, socket, head, (networkSocket) => {
			this.#track(networkSocket);
			try {
				coupleWebSocket(responseSocket, networkSocket);
				onCoupled?.();
			} catch (error: unknown) {
				networkSocket.terminate();
				closeUncoupledWorkerWebSocket(responseSocket);
				onError(error);
			}
		});
	}

	// Accepts an upgrade whose WebSocket Orange uses itself, such as an RPC session.
	accept(incoming: IncomingMessage, socket: Duplex, head: Uint8Array): Promise<NetworkWebSocket> {
		return new Promise((resolveAccept) => {
			this.#server.handleUpgrade(incoming, socket, head, (networkSocket) => {
				this.#track(networkSocket);
				resolveAccept(networkSocket);
			});
		});
	}

	#track(networkSocket: NetworkWebSocket): void {
		this.#sockets.set(networkSocket, 0);
		networkSocket.on("pong", () => {
			if (this.#sockets.has(networkSocket)) this.#sockets.set(networkSocket, 0);
		});
		networkSocket.addEventListener("close", () => {
			this.#sockets.delete(networkSocket);
			if (this.#sockets.size === 0) this.#stopKeepAlive();
		});
		if (this.#keepAlive === undefined) {
			this.#keepAlive = setInterval(() => this.#pingAll(), keepAlivePingIntervalMs);
			this.#keepAlive.unref();
		}
	}

	#pingAll(): void {
		for (const [networkSocket, missedPongs] of this.#sockets) {
			if (missedPongs >= keepAliveMissedPongLimit) {
				networkSocket.terminate();
				continue;
			}
			this.#sockets.set(networkSocket, missedPongs + 1);
			networkSocket.ping();
		}
	}

	#stopKeepAlive(): void {
		if (this.#keepAlive === undefined) return;
		clearInterval(this.#keepAlive);
		this.#keepAlive = undefined;
	}

	// A stopping runtime tells its clients to reconnect, then drops any client that doesn't answer.
	close(): Promise<void> {
		this.#stopKeepAlive();
		for (const webSocket of this.#sockets.keys()) webSocket.close(1012, "Service Restart");
		const terminate = setTimeout(() => {
			for (const webSocket of this.#sockets.keys()) webSocket.terminate();
		}, closeHandshakeTimeoutMs);
		return new Promise<void>((resolveClose, rejectClose) => {
			this.#server.close((error) => {
				clearTimeout(terminate);
				if (error === undefined) resolveClose();
				else rejectClose(error);
			});
		});
	}
}

export interface NetworkWebSocketClientOptions {
	headers: Record<string, string>;
	/**
	 * Runs when the socket opens, before any of its messages. A message can
	 * arrive before the caller's `await` continues, so listeners go here.
	 */
	onOpen?: (webSocket: NetworkWebSocket) => void;
	protocols: string[];
}

export type NetworkWebSocketConnection =
	| { kind: "open"; protocol: string; headers: [string, string][]; webSocket: NetworkWebSocket }
	| { kind: "rejected"; response: IncomingMessage };

// Opens a client WebSocket and reports a refused upgrade as its HTTP response.
export function connectNetworkWebSocket(
	url: string,
	options: NetworkWebSocketClientOptions,
): Promise<NetworkWebSocketConnection> {
	const { WebSocket } = loadWs();
	const webSocket = new WebSocket(url, options.protocols, {
		headers: options.headers,
		perMessageDeflate: false,
	});
	return new Promise((resolveConnection, rejectConnection) => {
		let responseHeaders: [string, string][] = [];
		webSocket.once("upgrade", (response) => {
			responseHeaders = Object.entries(response.headers).flatMap(([name, header]) =>
				header === undefined
					? []
					: (Array.isArray(header) ? header : [header]).map(
							(entry): [string, string] => [name, entry],
						),
			);
		});
		webSocket.once("open", () => {
			options.onOpen?.(webSocket);
			resolveConnection({
				headers: responseHeaders,
				kind: "open",
				protocol: webSocket.protocol,
				webSocket,
			});
		});
		webSocket.once("unexpected-response", (_request, response) => {
			resolveConnection({ kind: "rejected", response });
		});
		// The listener stays, so a later socket error closes the socket instead of
		// becoming an uncaught error event. A rejection after `open` has no effect.
		webSocket.on("error", (error) => rejectConnection(error));
	});
}
