import { DurableObject } from "cloudflare:workers";

export class Room extends DurableObject {
	#events = [];
	#nextMessage = 0;

	async fetch(request) {
		const url = new URL(request.url);
		if (url.pathname === "/events") {
			return Response.json(this.#events);
		}
		if (url.pathname === "/reject") {
			return new Response("Upgrade Required", {
				headers: { "x-do-rejection": "expected" },
				status: 426,
				statusText: "Upgrade Required",
			});
		}
		if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
			return new Response("Upgrade Required", { status: 426 });
		}

		const pair = new WebSocketPair();
		const server = pair[1];
		server.binaryType = "arraybuffer";
		server.accept();
		this.#events.push([
			"open",
			url.searchParams.get("id"),
			request.headers.get("x-client-id"),
		]);
		server.addEventListener("message", (event) => {
			this.#nextMessage += 1;
			if (typeof event.data === "string") {
				this.#events.push(["text", this.#nextMessage, event.data]);
				if (event.data === "server-close") {
					server.send("before-close");
					server.close(3001, "server done");
				} else if (event.data === "burst") {
					for (let index = 0; index < 64; index += 1) {
						const payload = new Uint8Array(16 * 1024);
						payload[0] = index;
						payload[payload.length - 1] = 255 - index;
						server.send(payload);
					}
					server.send("burst-done");
				} else {
					server.send(`echo:${this.#nextMessage}:${event.data}`);
				}
				return;
			}
			const bytes = [...new Uint8Array(event.data)];
			this.#events.push([
				"binary",
				this.#nextMessage,
				bytes.length <= 16
					? bytes
					: [bytes.length, bytes[0], bytes[bytes.length - 1]],
			]);
			server.send(event.data);
		});
		server.addEventListener("close", (event) => {
			this.#events.push([
				"close",
				event.code,
				event.reason,
				event.wasClean,
			]);
		});
		server.addEventListener("error", (event) => {
			this.#events.push([
				"error",
				event.error instanceof Error ? event.error.name : typeof event.error,
			]);
		});

		return new Response(null, {
			headers: {
				"sec-websocket-protocol": "orange.v1",
				"x-do-upgrade": "accepted",
			},
			status: 101,
			webSocket: pair[0],
		});
	}
}

export default {
	async fetch(request, env) {
		const incoming = new URL(request.url);
		const target = new URL(incoming.pathname + incoming.search, "https://room.internal");
		return await env.ROOMS.getByName("main").fetch(
			new Request(target, {
				headers: request.headers,
				method: request.method,
			}),
		);
	},
};
