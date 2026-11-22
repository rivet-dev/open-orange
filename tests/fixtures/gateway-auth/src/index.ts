import { DurableObject } from "cloudflare:workers";

interface Env {
	COUNTER: DurableObjectNamespace<Counter>;
	JOBS: Queue;
}

// Every response shows the request headers the object saw.
export class Counter extends DurableObject<Env> {
	// Each instance has its own ID, so a client can tell when the object built a new one.
	#boot = crypto.randomUUID();

	async fetch(request: Request): Promise<Response> {
		if (request.headers.get("upgrade") === "websocket") {
			const [client, server] = Object.values(new WebSocketPair());
			this.ctx.acceptWebSocket(server);
			server.serializeAttachment([...request.headers]);
			return new Response(null, { status: 101, webSocket: client });
		}
		return Response.json({ count: await this.increment(), headers: [...request.headers] });
	}

	async increment(): Promise<number> {
		const count = ((await this.ctx.storage.get<number>("count")) ?? 0) + 1;
		await this.ctx.storage.put("count", count);
		return count;
	}

	async read(): Promise<number> {
		return (await this.ctx.storage.get<number>("count")) ?? 0;
	}

	webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): void {
		if (message === "headers") socket.send(JSON.stringify(socket.deserializeAttachment()));
		else if (message === "boot") socket.send(this.#boot);
		else socket.send(`echo:${String(message)}`);
	}
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		const counter = env.COUNTER.getByName(url.searchParams.get("name") ?? "counter");
		switch (url.pathname) {
			case "/fetch":
			case "/ws":
				return counter.fetch(request);
			case "/rpc":
				return Response.json({ count: await counter.increment() });
			// The error that Worker code catches when a call to its object fails.
			case "/try-rpc":
				try {
					return Response.json({ count: await counter.increment() });
				} catch (error) {
					return Response.json({ error: String(error) }, { status: 502 });
				}
			case "/read":
				return Response.json({ count: await counter.read() });
			case "/send":
				await env.JOBS.send({ from: "worker" });
				return new Response("sent");
			case "/backlog":
				return Response.json(await env.JOBS.metrics());
			default:
				return new Response("not found", { status: 404 });
		}
	},
};
