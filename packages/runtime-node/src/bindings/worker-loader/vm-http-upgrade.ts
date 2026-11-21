// WebSocket upgrades for the agentOS build of node:http. A server with an "upgrade" listener gets
// a socket, as in Node.js, and writes its handshake and then WebSocket frames to it, usually
// through the `ws` package. This file is the client on the other end of that socket. It reads the
// handshake, then turns frames into the messages of a WebSocketPair and back. The pair's other end
// goes to the caller in a 101 response. workerd's node:http has no upgrades.

import { Duplex } from "node:stream";

import { terminateCoupledWebSocket, WebSocketPair, type WebSocket } from "../../globals/websocket.js";
import { Response } from "../../globals/http.js";
import {
	webSocketBufferLimitCloseReason,
	webSocketBufferLimitError,
	webSocketBufferLimitReached,
} from "./websocket.js";

// Node.js' own limit for the head of an HTTP message.
const maxHeadBytes = 16 * 1024;
const headEnd = Buffer.from("\r\n\r\n");

type Callback = (error?: Error | null) => void;

// One end of an in-memory connection: what it writes, its peer reads. It has the net.Socket
// members that HTTP servers and `ws` call.
class SocketEnd extends Duplex {
	readonly encrypted = false;
	readonly localAddress = "127.0.0.1";
	readonly localPort = 0;
	readonly remoteAddress = "127.0.0.1";
	readonly remoteFamily = "IPv4";
	readonly remotePort = 0;
	peer: SocketEnd | undefined;
	// The peer has been told that no more data comes.
	#ended = false;
	// A write that waits for the peer to read.
	#waiting: Callback | undefined;

	override _read(): void {
		const peer = this.peer;
		if (peer === undefined) return;
		const waiting = peer.#waiting;
		peer.#waiting = undefined;
		waiting?.();
	}

	override _write(chunk: Buffer, _encoding: BufferEncoding, callback: Callback): void {
		const peer = this.peer;
		if (peer === undefined || peer.destroyed) callback(new Error("The upgrade socket is closed."));
		else if (peer.push(chunk)) callback();
		else this.#waiting = callback;
	}

	override _final(callback: Callback): void {
		this.#end();
		callback();
	}

	// Like a closed TCP connection: the peer reads what was written, then sees the end, and its
	// next write fails.
	override _destroy(error: Error | null, callback: Callback): void {
		this.#end();
		this.#waiting?.(new Error("The upgrade socket is closed."));
		this.#waiting = undefined;
		callback(error);
	}

	#end(): void {
		if (this.#ended) return;
		this.#ended = true;
		this.peer?.push(null);
	}

	ref(): this {
		return this;
	}

	unref(): this {
		return this;
	}

	setKeepAlive(): this {
		return this;
	}

	setNoDelay(): this {
		return this;
	}

	setTimeout(): this {
		return this;
	}
}

interface ResponseHead {
	headers: [string, string][];
	status: number;
	statusText: string;
}

function parseHead(text: string): ResponseHead {
	const [statusLine = "", ...lines] = text.split("\r\n");
	const match = /^HTTP\/1\.[01] (\d{3})(?: (.*))?$/.exec(statusLine);
	if (match === null) throw new Error(`The server answered the upgrade with an invalid status line: ${statusLine}`);
	const headers: [string, string][] = [];
	for (const line of lines) {
		const colon = line.indexOf(":");
		if (colon > 0) headers.push([line.slice(0, colon).trim(), line.slice(colon + 1).trim()]);
	}
	return { headers, status: Number(match[1]), statusText: match[2] ?? "" };
}

// The caller's HTTP layer writes these for the response it sends.
const hopHeaders = new Set(["connection", "sec-websocket-accept", "transfer-encoding", "upgrade"]);

function responseHeaders(head: ResponseHead): [string, string][] {
	return head.headers.filter(([name]) => !hopHeaders.has(name.toLowerCase()));
}

// Moves messages and closes between the server's socket and `inner`, one end of a WebSocketPair.
async function bridgeFrames(client: SocketEnd, inner: WebSocket, firstFrames: Buffer): Promise<void> {
	const { Receiver, Sender } = await import("./ws-module.js");
	const receiver = new Receiver({ isServer: false });
	// A client must mask its frames, and a zero mask leaves the payload as it is. The bytes never
	// leave this process, so the mask has nothing to hide.
	const sender = new Sender(client, {}, (mask) => void mask.fill(0));
	let closeSent = false;
	// The server sent its close frame, so the end of the socket is a clean close.
	let concluded = false;
	// Bytes of frames that the server has not read yet.
	let unreadBytes = 0;
	inner.binaryType = "arraybuffer";

	const sendClose = (code: number | undefined, reason: string): void => {
		if (closeSent || client.destroyed) return;
		closeSent = true;
		try {
			sender.close(code, reason, true);
		} catch {
			// `ws` cannot send every code that a WebSocket can close with.
			sender.close(1011, reason, true);
		}
	};

	receiver.on("message", (data, isBinary) => {
		if (!concluded && inner.readyState === 1) inner.send(isBinary ? data : data.toString());
	});
	receiver.on("ping", (data) => {
		if (!client.destroyed) sender.pong(data, true);
	});
	receiver.on("conclude", (code, reason) => {
		concluded = true;
		const text = reason.toString();
		// 1005 means a close frame without a code.
		sendClose(code === 1005 ? undefined : code, text);
		client.end();
		if (code === 1005) inner.close();
		else inner.close(code, text);
	});
	receiver.on("error", () => client.destroy());
	receiver.on("drain", () => client.resume());
	client.on("data", (chunk: Buffer) => {
		if (!receiver.write(chunk)) client.pause();
	});
	client.on("error", () => undefined);
	// The server ended the connection without a close frame, as `ws` does in terminate().
	client.on("close", () => {
		if (!concluded) terminateCoupledWebSocket(inner, 1006, "", false);
	});

	inner.addEventListener("message", (event: { data: string | ArrayBuffer }) => {
		if (closeSent || client.destroyed) return;
		const bytes = typeof event.data === "string" ? Buffer.byteLength(event.data) : event.data.byteLength;
		unreadBytes += bytes;
		if (webSocketBufferLimitReached(unreadBytes)) {
			const error = webSocketBufferLimitError();
			process.stderr.write(`${error.name}: ${error.message}\n`);
			concluded = true;
			client.destroy();
			inner.close(1011, webSocketBufferLimitCloseReason);
			return;
		}
		sender.send(event.data, { binary: typeof event.data !== "string", compress: false, fin: true, mask: true }, () => {
			unreadBytes -= bytes;
		});
	});
	inner.addEventListener("close", (event: { code: number; reason: string }) => {
		// The other end went away without a close frame, so the server's socket ends the same way.
		if (event.code === 1006) client.destroy();
		else sendClose(event.code === 1005 ? undefined : event.code, event.reason);
	});
	inner.accept();
	client.resume();
	if (firstFrames.byteLength > 0 && !receiver.write(firstFrames)) client.pause();
}

// Emits an upgrade through `emit` and resolves with the server's answer: a 101 response with a
// WebSocket, or the response that refused the upgrade.
export function upgradeToWebSocket(emit: (socket: Duplex, head: Buffer) => void): Promise<Response> {
	return new Promise<Response>((resolve, reject) => {
		const client = new SocketEnd();
		const server = new SocketEnd();
		client.peer = server;
		server.peer = client;
		let received = Buffer.alloc(0);
		let head: ResponseHead | undefined;

		const onData = (chunk: Buffer): void => {
			received = Buffer.concat([received, chunk]);
			if (head !== undefined) return;
			const end = received.indexOf(headEnd);
			if (end === -1) {
				if (received.byteLength > maxHeadBytes) {
					client.destroy();
					reject(new Error(`The server answered the upgrade with a head above ${maxHeadBytes} bytes.`));
				}
				return;
			}
			try {
				head = parseHead(received.subarray(0, end).toString("latin1"));
			} catch (error: unknown) {
				client.destroy();
				reject(error);
				return;
			}
			received = received.subarray(end + headEnd.byteLength);
			if (head.status !== 101) return;
			// The frame bridge reads the socket from here.
			client.off("data", onData);
			client.off("close", onClose);
			client.pause();
			const pair = new WebSocketPair();
			const accepted = head;
			bridgeFrames(client, pair[1], received).then(
				() => {
					resolve(new Response(null, { headers: responseHeaders(accepted), status: 101, webSocket: pair[0] }));
				},
				(error: unknown) => {
					client.destroy();
					reject(error);
				},
			);
		};
		// A server that refuses an upgrade writes an ordinary response and ends the socket.
		const onClose = (): void => {
			if (head === undefined) {
				reject(new Error("The server closed the upgrade socket before it sent a response."));
				return;
			}
			resolve(
				new Response(received.byteLength === 0 ? null : new Uint8Array(received), {
					headers: responseHeaders(head),
					status: head.status,
					statusText: head.statusText,
				}),
			);
		};
		client.on("data", onData);
		client.on("close", onClose);
		client.on("end", () => client.end());
		client.on("error", () => undefined);
		try {
			emit(server, Buffer.alloc(0));
		} catch (error: unknown) {
			client.destroy();
			reject(error);
		}
	});
}
