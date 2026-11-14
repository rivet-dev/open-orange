// Sends numbered messages to its own queue and records each delivery. Each
// delivery takes a while, so a backlog outlives the start of the session.
const delivered = [];

export default {
	async fetch(request, env) {
		const url = new URL(request.url);
		if (url.pathname === "/send") {
			const count = Number(url.searchParams.get("count"));
			await env.JOBS.sendBatch(Array.from({ length: count }, (_, index) => ({ body: index })));
			return new Response("sent");
		}
		return Response.json(delivered);
	},
	async queue(batch) {
		for (const message of batch.messages) {
			await new Promise((resolve) => setTimeout(resolve, 500));
			delivered.push(message.body);
			message.ack();
		}
	},
};
