import { DurableObject } from "cloudflare:workers";

export class Echo extends DurableObject {
	async fetch(request) {
		const seen = {
			cf: request.cf ?? null,
			headers: [...request.headers],
			method: request.method,
		};
		if (request.body !== null) seen.body = await request.text();
		if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
			const pair = new WebSocketPair();
			pair[1].accept();
			pair[1].send(JSON.stringify(seen));
			return new Response(null, { status: 101, webSocket: pair[0] });
		}
		const headers = new Headers({ "x-object": "echo" });
		if (new URL(request.url).searchParams.has("cors")) {
			headers.set("access-control-allow-origin", "https://app.example");
			headers.set("vary", "Accept-Encoding");
		}
		return Response.json(seen, { headers, statusText: "Echoed" });
	}
}

export default {
	async fetch(request, env) {
		const stub = env.ECHO.get(env.ECHO.idFromName("echo"));
		// `?as-init` forwards the request as the init of a new URL, a form workerd accepts.
		const response = new URL(request.url).searchParams.has("as-init")
			? await stub.fetch(request.url, request)
			: await stub.fetch(request);
		if (response.webSocket !== null) return response;
		return Response.json({
			object: await response.json(),
			response: {
				headers: [...response.headers],
				status: response.status,
				statusText: response.statusText,
			},
			worker: { headers: [...request.headers] },
		});
	},
};
