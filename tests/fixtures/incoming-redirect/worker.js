import { DurableObject } from "cloudflare:workers";

// Each route passes a request on the way a proxy Worker does, so a redirect comes back to the
// client as it does on Workers, not followed on the server.
export class Echo extends DurableObject {
	fetch(request) {
		return Response.json({ redirect: request.redirect });
	}
}

export default {
	async fetch(request, env) {
		const url = new URL(request.url);
		switch (url.pathname) {
			case "/echo":
				return Response.json({ redirect: request.redirect });
			case "/hop":
				return new Response(null, { status: 302, headers: { location: "/echo", "set-cookie": "hop=1" } });
			case "/pass":
				return fetch(new Request(new URL("/hop", url), request));
			case "/loop":
				return new Response(null, { status: 302, headers: { location: "/loop-pass" } });
			case "/loop-pass":
				return fetch(new Request(new URL("/loop", url), request));
			case "/follow": {
				const followed = await fetch(new URL("/hop", url), { redirect: "follow" });
				return Response.json({ redirected: followed.redirected, body: await followed.json() });
			}
			case "/object":
				return env.ECHO.getByName("a").fetch(new Request(new URL("/", url), { redirect: "follow" }));
			case "/service":
				return env.SELF.fetch(new Request(new URL("/echo", url), { redirect: "follow" }));
			default:
				return new Response("not found", { status: 404 });
		}
	},
};
