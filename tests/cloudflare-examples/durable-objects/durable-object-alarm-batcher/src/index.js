import { DurableObject } from "cloudflare:workers";

// Worker
export default {
	async fetch(request, env) {
		return await env.BATCHER.getByName("foo").fetch(request);
	},
};

// Durable Object
export class Batcher extends DurableObject {
	constructor(ctx, env) {
		super(ctx, env);
		this.storage = ctx.storage;
		this.ctx.blockConcurrencyWhile(async () => {
			let vals = await this.storage.list({ reverse: true, limit: 1 });
			this.count = vals.size == 0 ? 0 : parseInt(vals.keys().next().value);
		});
	}

	async fetch(request) {
		this.count++;

		// If there is no alarm currently set, set one for 10 seconds from now
		// Any further POSTs in the next 10 seconds will be part of this batch.
		let currentAlarm = await this.storage.getAlarm();
		if (currentAlarm == null) {
			this.storage.setAlarm(Date.now() + 1000 * 10);
		}

		// Add the request to the batch.
		await this.storage.put(this.count, await request.text());
		return new Response(JSON.stringify({ queued: this.count }), {
			headers: {
				"content-type": "application/json;charset=UTF-8",
			},
		});
	}

	async alarm() {
		let vals = await this.storage.list();
		await fetch("http://example.com/some-upstream-service", {
			method: "POST",
			body: Array.from(vals.values()),
		});
		await this.storage.deleteAll();
		this.count = 0;
	}
}
