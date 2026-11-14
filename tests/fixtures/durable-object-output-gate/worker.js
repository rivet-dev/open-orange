import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";

// A plain Worker callee. It has no output gate, so its request shows when the call arrived.
export class Probe extends WorkerEntrypoint {
	async ping(url) {
		await fetch(url);
		return "pong";
	}
}

function openWebSocket(url) {
	return new Promise((resolve, reject) => {
		const webSocket = new WebSocket(url);
		webSocket.addEventListener("open", () => resolve(webSocket), { once: true });
		webSocket.addEventListener("error", () => reject(new Error("peer WebSocket failed")), {
			once: true,
		});
	});
}

export class GatedObject extends DurableObject {
	// Writes, then sends one outgoing message of `kind` to the test peer.
	async send(kind, peer) {
		const webSocket =
			kind === "websocket" ? await openWebSocket(`${peer.replace("http", "ws")}/socket`) : undefined;
		// The peer holds this request until the test has stopped the engine.
		await fetch(`${peer}/arrived`);
		const options = kind === "unconfirmed" ? { allowUnconfirmed: true } : undefined;
		await this.ctx.storage.put("written", kind, options);
		switch (kind) {
			case "fetch":
			case "unconfirmed":
				await fetch(`${peer}/out?kind=${kind}`);
				break;
			case "rpc":
				await this.env.PROBE.ping(`${peer}/out?kind=${kind}`);
				break;
			case "websocket":
				webSocket.send("first");
				this.ctx.storage.kv.put("between", true);
				webSocket.send("second");
				break;
			default:
				throw new TypeError(`unknown kind ${kind}`);
		}
		return await this.ctx.storage.get("written");
	}
}

export default {
	async fetch(request, env) {
		const url = new URL(request.url);
		const stub = env.GATED.get(env.GATED.idFromName(url.searchParams.get("name")));
		const written = await stub.send(url.searchParams.get("kind"), url.searchParams.get("peer"));
		return Response.json({ written });
	},
};
