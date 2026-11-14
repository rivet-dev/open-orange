import { DurableObject, WorkerEntrypoint, WorkflowEntrypoint } from "cloudflare:workers";

export class Counter extends DurableObject {
	async increment(caller) {
		const count = ((await this.ctx.storage.get("count")) ?? 0) + 1;
		await this.ctx.storage.put("count", count);
		return { caller, count };
	}
}

export class Greet extends WorkflowEntrypoint {
	async run(event, step) {
		return await step.do("greet", async () => `hello ${event.payload.name} from worker-b`);
	}
}

export class Admin extends WorkerEntrypoint {
	add(left, right) {
		return left + right;
	}

	fail() {
		throw new RangeError("callee failed");
	}
}

export default {
	async fetch(request, env) {
		const url = new URL(request.url);
		if (url.pathname === "/count") {
			return Response.json(await env.COUNTER.getByName("shared").increment("worker-b"));
		}
		return new Response(`${request.method} ${url.pathname} ${await request.text()}`, {
			headers: { "x-from": "worker-b" },
			status: 201,
		});
	},
};
