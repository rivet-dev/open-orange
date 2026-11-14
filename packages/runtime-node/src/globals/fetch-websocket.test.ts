import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { after, before, describe, it } from "node:test";

import { fetch } from "./http.js";

// fetch() with `Upgrade: websocket` against a real WebSocket server. The
// expected values are what the same calls return on Cloudflare, measured on
// 2026-11-13.

interface ServerSocket {
	close(code?: number, reason?: string): void;
	on(type: "message", listener: (data: Buffer, isBinary: boolean) => void): void;
	on(type: "close", listener: (code: number, reason: Buffer) => void): void;
	send(data: string | Uint8Array): void;
}

interface SocketServer {
	close(): void;
	handleUpgrade(
		request: IncomingMessage,
		socket: Duplex,
		head: Buffer,
		callback: (webSocket: ServerSocket) => void,
	): void;
}

const { WebSocketServer } = createRequire(import.meta.url)("ws") as {
	WebSocketServer: new (options: {
		handleProtocols: (protocols: Set<string>) => string | false;
		noServer: true;
	}) => SocketServer;
};

interface CloseRecord {
	code: number;
	reason: string;
	wasClean: boolean;
}

function closeOf(webSocket: { addEventListener(type: "close", listener: (event: CloseRecord) => void): void }): Promise<CloseRecord> {
	return new Promise((resolveClose) => {
		webSocket.addEventListener("close", ({ code, reason, wasClean }) => resolveClose({ code, reason, wasClean }));
	});
}

describe("fetch() with Upgrade: websocket", () => {
	let server: Server;
	let sockets: SocketServer;
	let origin = "";
	const serverCloses: { code: number; reason: string }[] = [];

	before(async () => {
		sockets = new WebSocketServer({
			handleProtocols: (protocols) => [...protocols][0] ?? false,
			noServer: true,
		});
		server = createServer();
		server.on("upgrade", (request, socket, head) => {
			if (request.url === "/redirect") {
				socket.end("HTTP/1.1 302 Found\r\nlocation: /ws?from=redirect\r\ncontent-length: 0\r\nconnection: close\r\n\r\n");
				return;
			}
			if (request.url === "/plain") {
				// An origin that ignores the upgrade answers over plain HTTP.
				const body = "not a websocket";
				socket.end(
					`HTTP/1.1 200 OK\r\nx-echo: plain\r\ncontent-length: ${body.length}\r\nconnection: close\r\n\r\n${body}`,
				);
				return;
			}
			sockets.handleUpgrade(request, socket, head, (webSocket) => {
				webSocket.on("message", (data, isBinary) => {
					if (isBinary) webSocket.send(data);
					else if (data.toString() === "close-me") webSocket.close(4001, "bye");
					else webSocket.send(`echo:${data.toString()}`);
				});
				webSocket.on("close", (code, reason) => serverCloses.push({ code, reason: reason.toString() }));
				webSocket.send(
					JSON.stringify({
						auth: request.headers["x-probe-auth"],
						method: request.method,
						offered: request.headers["sec-websocket-protocol"],
						path: request.url,
					}),
				);
			});
		});
		await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
		origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	});

	after(async () => {
		sockets.close();
		server.closeAllConnections();
		await new Promise((resolveClose) => server.close(resolveClose));
	});

	it("when the origin upgrades, the 101 response carries a WebSocket that works after accept()", async () => {
		const response = await fetch(`${origin}/ws?x=1`, {
			headers: {
				"Sec-WebSocket-Protocol": "probe.v1, other",
				Upgrade: "websocket",
				"x-probe-auth": "secret",
			},
		});
		assert.equal(response.status, 101);
		assert.equal(response.statusText, "Switching Protocols");
		assert.equal(response.ok, false);
		assert.equal(response.body, null);
		assert.equal(response.headers.get("upgrade"), "websocket");
		assert.equal(response.headers.get("sec-websocket-protocol"), "probe.v1");
		assert.equal(response.headers.has("sec-websocket-accept"), true);
		const webSocket = response.webSocket;
		assert.ok(webSocket);
		assert.throws(
			() => webSocket.send("early"),
			/You must call one of accept\(\) or state\.acceptWebSocket\(\) on this WebSocket before sending messages\./,
		);
		const messages: unknown[] = [];
		webSocket.addEventListener("message", (event: { data: unknown }) => {
			messages.push(event.data instanceof ArrayBuffer ? [...new Uint8Array(event.data)] : event.data);
		});
		const closed = closeOf(webSocket);
		webSocket.binaryType = "arraybuffer";
		webSocket.accept();
		webSocket.send("hi");
		webSocket.send(new Uint8Array([1, 2, 3]));
		webSocket.send("close-me");
		assert.deepEqual(await closed, { code: 4001, reason: "bye", wasClean: true });
		// The message that the origin sent before accept() was kept.
		assert.equal(typeof messages[0], "string");
		assert.deepEqual(JSON.parse(String(messages[0])), {
			auth: "secret",
			method: "GET",
			offered: "probe.v1,other",
			path: "/ws?x=1",
		});
		assert.deepEqual(messages.slice(1), ["echo:hi", [1, 2, 3]]);
	});

	it("when the Worker closes the WebSocket, the origin gets its code and reason", async () => {
		const response = await fetch(`${origin}/ws`, { headers: { upgrade: "WebSocket" }, method: "POST", body: "x" });
		const webSocket = response.webSocket;
		assert.ok(webSocket);
		const closed = closeOf(webSocket);
		webSocket.accept();
		webSocket.close(4002, "client done");
		assert.deepEqual(await closed, { code: 4002, reason: "client done", wasClean: true });
		// The close reaches the origin after the Worker's own close event.
		while (serverCloses.at(-1)?.code !== 4002) await new Promise((resolveWait) => setTimeout(resolveWait, 10));
		assert.deepEqual(serverCloses.at(-1), { code: 4002, reason: "client done" });
	});

	it("when the origin does not upgrade, fetch() returns the origin's response", async () => {
		const response = await fetch(`${origin}/plain`, { headers: { Upgrade: "websocket" } });
		assert.equal(response.status, 200);
		assert.equal(response.webSocket, null);
		assert.equal(response.headers.get("x-echo"), "plain");
		assert.equal(await response.text(), "not a websocket");
	});

	it("when the origin redirects, fetch() follows it, and returns it under redirect: manual", async () => {
		const followed = await fetch(`${origin}/redirect`, { headers: { Upgrade: "websocket" } });
		assert.equal(followed.status, 101);
		assert.equal(followed.redirected, true);
		const webSocket = followed.webSocket;
		assert.ok(webSocket);
		const hello = new Promise<string>((resolveHello) => {
			webSocket.addEventListener("message", (event: { data: unknown }) => resolveHello(String(event.data)));
		});
		webSocket.accept();
		assert.equal(JSON.parse(await hello).path, "/ws?from=redirect");
		webSocket.close(1000);

		const manual = await fetch(`${origin}/redirect`, { headers: { Upgrade: "websocket" }, redirect: "manual" });
		assert.equal(manual.status, 302);
		assert.equal(manual.webSocket, null);
		assert.equal(manual.headers.get("location"), "/ws?from=redirect");
	});

	it("when the URL is ws: or wss:, fetch() rejects as on Cloudflare", async () => {
		const url = `${origin.replace("http:", "ws:")}/ws`;
		await assert.rejects(fetch(url, { headers: { Upgrade: "websocket" } }), {
			message: `Fetch API cannot load: ${url}`,
			name: "TypeError",
		});
	});
});
