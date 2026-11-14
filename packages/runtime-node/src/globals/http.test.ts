import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { fetch, Request, Response } from "./http.js";
import { WebSocketPair } from "./websocket.js";

test("constructs Cloudflare requests from streaming bodies without a duplex option", async () => {
	const encoder = new TextEncoder();
	const request = new Request("https://worker.example/stream", {
		body: new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode("streamed "));
				controller.enqueue(encoder.encode("body"));
				controller.close();
			},
		}),
		method: "POST",
	});

	assert.equal(request.method, "POST");
	assert.equal(await request.text(), "streamed body");
});

test("constructs status 101 WebSocket responses outside Undici's status range", () => {
	const pair = new WebSocketPair();
	const response = new Response(null, {
		headers: { "Sec-WebSocket-Protocol": "orange" },
		status: 101,
		webSocket: pair[0],
	});

	assert.equal(response.status, 101);
	assert.equal(response.statusText, "Switching Protocols");
	assert.equal(response.ok, false);
	assert.equal(response.body, null);
	assert.equal(response.webSocket, pair[0]);
	assert.equal(response.headers.get("sec-websocket-protocol"), "orange");
	assert.throws(
		() => response.clone(),
		/Cannot clone a response to a WebSocket handshake/,
	);
	assert.throws(
		() => new Response("body", { status: 101, webSocket: pair[1] }),
		/Response with null body status/,
	);
	assert.throws(
		() => new Response(null, { status: 200, webSocket: pair[1] }),
		/Responses with a WebSocket must have status code 101/,
	);
});

test("fetch() does not send CF-Connecting-IP to the origin, and leaves the caller's request alone", async () => {
	// Echoes each request's body and two of its headers.
	const server = createServer((request, response) => {
		const chunks: Buffer[] = [];
		request.on("data", (chunk: Buffer) => chunks.push(chunk));
		request.on("end", () => {
			response.end(
				JSON.stringify({
					body: Buffer.concat(chunks).toString(),
					connectingIp: request.headers["cf-connecting-ip"] ?? null,
					kept: request.headers["x-kept"] ?? null,
				}),
			);
		});
	});
	await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
	try {
		const address = server.address();
		assert.ok(address !== null && typeof address === "object");
		const origin = `http://127.0.0.1:${address.port}`;
		// What a Worker holds when it proxies its incoming request.
		const incoming = new Request(`${origin}/proxied`, {
			body: "payload",
			headers: { "CF-Connecting-IP": "203.0.113.9", "x-kept": "yes" },
			method: "POST",
		});
		assert.deepEqual(await (await fetch(incoming)).json(), {
			body: "payload",
			connectingIp: null,
			kept: "yes",
		});
		assert.equal(incoming.headers.get("cf-connecting-ip"), "203.0.113.9");

		const streamed = await fetch(`${origin}/streamed`, {
			body: new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(new TextEncoder().encode("streamed"));
					controller.close();
				},
			}),
			headers: { "cf-connecting-ip": "203.0.113.9" },
			method: "POST",
		});
		assert.deepEqual(await streamed.json(), { body: "streamed", connectingIp: null, kept: null });
	} finally {
		server.closeAllConnections();
		await new Promise((resolveClose) => server.close(resolveClose));
	}
});
