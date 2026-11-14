import { DurableObject } from "cloudflare:workers";

// Worker
export default {
	async fetch(request, env) {
		let url = new URL(request.url);
		let name = url.searchParams.get("name");
		if (!name) {
			return new Response(
				"Select a Durable Object to contact by using" +
					" the `name` URL query string parameter, for example, ?name=A",
			);
		}

		// A stub is a client Object used to send messages to the Durable Object.
		let stub = env.COUNTERS.getByName(name);

		// Send a request to the Durable Object using RPC methods, then await its response.
		let count = null;
		switch (url.pathname) {
			case "/increment":
				count = await stub.increment();
				break;
			case "/decrement":
				count = await stub.decrement();
				break;
			case "/":
				// Serves the current value.
				count = await stub.getCounterValue();
				break;
			default:
				return new Response("Not found", { status: 404 });
		}

		return new Response(`Durable Object '${name}' count: ${count}`);
	},
};

// Durable Object
export class Counter extends DurableObject {
	async getCounterValue() {
		let value = (await this.ctx.storage.get("value")) || 0;
		return value;
	}

	async increment(amount = 1) {
		let value = (await this.ctx.storage.get("value")) || 0;
		value += amount;
		// You do not have to worry about a concurrent request having modified the value in storage.
		// "input gates" will automatically protect against unwanted concurrency.
		// Read-modify-write is safe.
		await this.ctx.storage.put("value", value);
		return value;
	}

	async decrement(amount = 1) {
		let value = (await this.ctx.storage.get("value")) || 0;
		value -= amount;
		await this.ctx.storage.put("value", value);
		return value;
	}
}
