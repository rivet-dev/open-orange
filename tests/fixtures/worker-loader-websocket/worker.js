// A parent Worker that passes each request, WebSocket upgrades included, to a dynamic Worker:
// /<kind>/<name>/... goes to the dynamic Worker <name> of that kind.
//
// Both kinds answer a WebSocket the same way. They greet with "hello <name>", echo a text message
// as "<name>:<text>", answer a binary message with "binary <bytes>", and obey these commands:
// "close:<code>:<reason>", "instance", "binary", and "exit".

// A Worker that answers with a WebSocketPair in a 101 response.
const pairCode = `
	const instance = crypto.randomUUID();
	let lastClose = null;
	export default {
		fetch(request, env) {
			if (new URL(request.url).pathname.endsWith("/last-close")) return Response.json(lastClose);
			if (request.headers.get("upgrade") !== "websocket") {
				return new Response("expected a WebSocket", { status: 426 });
			}
			const [client, server] = Object.values(new WebSocketPair());
			server.binaryType = "arraybuffer";
			server.accept();
			server.send("hello " + env.NAME);
			server.addEventListener("message", ({ data }) => {
				if (typeof data !== "string") server.send("binary " + new Uint8Array(data).join(","));
				else if (data.startsWith("close:")) server.close(Number(data.split(":")[1]), data.split(":")[2]);
				else if (data === "instance") server.send("instance:" + instance);
				else if (data === "binary") server.send(new Uint8Array([0, 255, 1]));
				// The runtime catches what a listener throws, and process.exit() throws in the VM.
				else if (data === "exit") setTimeout(() => process.exit(1));
				else server.send(env.NAME + ":" + data);
			});
			server.addEventListener("close", ({ code, reason }) => {
				lastClose = { code, reason };
			});
			return new Response(null, { status: 101, webSocket: client });
		},
	};
`;

// A Worker that runs a node:http server with the `ws` package. The test bundles and posts it.
let nodeCode;

function dynamicWorker(env, kind, name) {
	return env.LOADER.get(`${kind}:${name}`, () => ({
		compatibilityDate: "2026-09-03",
		compatibilityFlags: ["nodejs_compat"],
		env: { NAME: name },
		globalOutbound: null,
		mainModule: "main.js",
		modules: { "main.js": kind === "node" ? nodeCode : pairCode },
	})).getEntrypoint();
}

export default {
	async fetch(request, env) {
		const url = new URL(request.url);
		if (url.pathname === "/node-code") {
			nodeCode = await request.text();
			return new Response("ok");
		}
		const route = /^\/(node|pair)\/([a-z]+)\//.exec(url.pathname);
		if (route === null) return new Response("not found", { status: 404 });
		return dynamicWorker(env, route[1], route[2]).fetch(request);
	},
};
