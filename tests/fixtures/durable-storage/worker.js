import { DurableObject } from "cloudflare:workers";

export class Store extends DurableObject {
	async fetch(request) {
		if (request.method === "PUT") await this.ctx.storage.put("value", await request.text());
		return new Response((await this.ctx.storage.get("value")) ?? "");
	}
}

export default {
	fetch(request, env) {
		return env.STORE.get(env.STORE.idFromName("one")).fetch(request);
	},
};
