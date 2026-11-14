import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";

function gzipped(text) {
	return new Response(text).body.pipeThrough(new CompressionStream("gzip"));
}

export class Encoded extends DurableObject {
	fetch() {
		return new Response("from object", { headers: { "content-encoding": "gzip" } });
	}
}

export class Assets extends WorkerEntrypoint {
	fetch() {
		return new Response(gzipped("from service"), {
			encodeBody: "manual",
			headers: { "content-encoding": "gzip" },
		});
	}
}

export default {
	async fetch(request, env) {
		const url = new URL(request.url);
		const object = () => env.ENCODED.get(env.ENCODED.idFromName("main"));
		switch (url.pathname) {
			case "/gzip":
				return new Response("automatic gzip", {
					headers: { "content-encoding": "gzip", "content-length": "14" },
				});
			case "/br":
				return new Response("automatic br", { headers: { "content-encoding": "br" } });
			case "/deflate":
				return new Response("not encoded", { headers: { "content-encoding": "deflate" } });
			case "/manual":
				return new Response(gzipped("manual gzip"), {
					encodeBody: "manual",
					headers: { "content-encoding": "gzip" },
				});
			case "/proxy":
				return fetch(new URL("/gzip", url));
			case "/object":
				return object().fetch(request);
			case "/object-text":
				return new Response(await (await object().fetch(request)).text());
			case "/service-text":
				return new Response(await (await env.ASSETS.fetch(request)).text());
			default:
				return new Response("Not Found", { status: 404 });
		}
	},
};
