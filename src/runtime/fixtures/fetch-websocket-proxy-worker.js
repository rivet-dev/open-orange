// Proxies a WebSocket the way Cloudflare documents: the upgrade request goes
// to fetch(), and its 101 response goes back to the client. For
// src/runtime/fetch-websocket.test.ts.
export default {
	fetch(request) {
		const origin = new URL(request.url).searchParams.get("origin");
		return fetch(new Request(`${origin}/ws`, request));
	},
};
