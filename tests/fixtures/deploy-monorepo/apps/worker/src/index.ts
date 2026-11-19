import { readdirSync, readFileSync } from "node:fs";

import { DurableObject } from "cloudflare:workers";
import { lib } from "@acme/lib";
import { shared } from "@acme/shared";
import note from "./note.txt";

export class Counter extends DurableObject {
	fetch() {
		this.ctx.storage.kv.put("n", (this.ctx.storage.kv.get<number>("n") ?? 0) + 1);
		return new Response(String(this.ctx.storage.kv.get("n")));
	}
}

export default {
	async fetch(_request: Request, env: { COUNTER: DurableObjectNamespace }) {
		const count = await (await env.COUNTER.getByName("one").fetch("https://do/")).text();
		// The image lists the module rule file under /bundle by its Wrangler name.
		const bundle = readdirSync("/bundle")
			.filter((name) => name !== "worker")
			.map((name) => [name, readFileSync(`/bundle/${name}`, "utf8")]);
		return Response.json({ bundle, count, lib, note: note.trim(), shared });
	},
};
