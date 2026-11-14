import { DurableObject, WorkflowEntrypoint } from "cloudflare:workers";

// One Worker that uses every binding Orange backs with its own actors. A cron
// tick sends a queue message. The queue consumer stores it in R2 and starts a
// Workflow. The Workflow reads R2, asks Workers AI, and writes the answer back.

export class Counter extends DurableObject {
	count = 0;

	increment() {
		this.count += 1;
		return this.count;
	}
}

export class Parent extends DurableObject {
	async fetch() {
		const facet = this.ctx.facets.get("counter", () => ({ class: this.ctx.exports.Counter }));
		return Response.json(await facet.increment());
	}
}

export class Answer extends WorkflowEntrypoint {
	async run(event, step) {
		const { id } = event.payload;
		const question = await step.do("read question", async () => {
			const object = await this.env.BUCKET.get(`questions/${id}`);
			return object.text();
		});
		const answer = await step.do("ask", async () => {
			const result = await this.env.AI.run("@cf/meta/llama-3.1-8b-instruct", { prompt: question });
			return result.response;
		});
		await step.do("store answer", async () => {
			await this.env.BUCKET.put(`answers/${id}`, answer);
		});
		return answer;
	}
}

export default {
	async fetch(request, env) {
		const url = new URL(request.url);
		switch (url.pathname) {
			case "/limit": {
				const results = [];
				for (let index = 0; index < 3; index += 1) {
					results.push((await env.LIMITER.limit({ key: url.searchParams.get("key") })).success);
				}
				return Response.json(results);
			}
			case "/facet":
				return env.PARENT.getByName("parent").fetch(request);
			case "/answer": {
				const id = url.searchParams.get("id");
				let instance;
				try {
					instance = await env.ANSWER.get(id);
				} catch {
					// The queue consumer has not created the instance yet.
					return Response.json(null);
				}
				const { error, status } = await instance.status();
				const object = await env.BUCKET.get(`answers/${id}`);
				return Response.json({ answer: (await object?.text()) ?? null, error, status });
			}
			default:
				return new Response(null, { status: 404 });
		}
	},

	async scheduled(controller, env) {
		await env.QUESTIONS.send({ id: String(controller.scheduledTime), question: controller.cron });
	},

	async queue(batch, env) {
		for (const message of batch.messages) {
			const { id, question } = message.body;
			await env.BUCKET.put(`questions/${id}`, `what runs at ${question}?`);
			await env.ANSWER.create({ id, params: { id } });
		}
	},
};
