// Drives the Cache API for src/runtime/cache.test.ts. Each route maps one
// HTTP request to one cache call so the test observes results over real HTTP.
// Request headers named x-res-<name> become headers of the response that put()
// stores, and x-req-<name> become headers of the request that match() sends.

function prefixedHeaders(headers, prefix) {
	const result = new Headers();
	for (const [name, value] of headers) {
		if (name.startsWith(prefix)) result.append(name.slice(prefix.length), value);
	}
	return result;
}

export default {
	async fetch(request) {
		const url = new URL(request.url);
		const cacheName = url.searchParams.get("cache");
		const cache = cacheName === null ? caches.default : await caches.open(cacheName);
		const key = url.searchParams.get("url") ?? "https://example.com/resource";
		const method = url.searchParams.get("method") ?? "GET";
		try {
			switch (url.pathname) {
				case "/put": {
					const status = Number(url.searchParams.get("status") ?? "200");
					await cache.put(
						new Request(key, { method }),
						new Response(request.body, {
							headers: prefixedHeaders(request.headers, "x-res-"),
							status,
						}),
					);
					return new Response(null, { status: 204 });
				}
				case "/proxy": {
					// The usual caching proxy: store a clone and return the original.
					const response = new Response(request.body, {
						headers: prefixedHeaders(request.headers, "x-res-"),
					});
					await cache.put(new Request(key), response.clone());
					return response;
				}
				case "/put-streamed": {
					// The Worker writes the body while two puts read it: the response and its clone.
					const { readable, writable } = new TransformStream();
					const response = new Response(readable, {
						headers: prefixedHeaders(request.headers, "x-res-"),
					});
					const puts = Promise.all([
						cache.put(new Request(key), response.clone()),
						cache.put(new Request(`${key}?copy`), response),
					]);
					const writer = writable.getWriter();
					const write = (async () => {
						for (let index = 0; index < 16; index += 1) await writer.write(new Uint8Array(64 * 1024));
						await writer.close();
					})();
					const outcomes = await Promise.allSettled([puts, write]);
					return Response.json(outcomes.map((outcome) => outcome.status));
				}
				case "/match": {
					const matched = await cache.match(
						new Request(key, { headers: prefixedHeaders(request.headers, "x-req-"), method }),
						{ ignoreMethod: url.searchParams.has("ignoreMethod") },
					);
					if (matched === undefined) {
						return new Response("miss", { headers: { "x-match": "miss" }, status: 404 });
					}
					return matched;
				}
				case "/delete": {
					const deleted = await cache.delete(new Request(key, { method }), {
						ignoreMethod: url.searchParams.has("ignoreMethod"),
					});
					return Response.json({ deleted });
				}
				default:
					return new Response("not found", { status: 404 });
			}
		} catch (error) {
			return new Response(`${error.name}: ${error.message}`, { status: 500 });
		}
	},
};
