// Records the cron and queue events this Worker receives. Requests under /b/
// go to the other Worker of the session.
const events = [];

export default {
	async fetch(request, env) {
		const url = new URL(request.url);
		if (url.pathname.startsWith("/b/")) {
			return env.B.fetch(new URL(url.pathname.slice(2), "http://b"));
		}
		if (url.pathname === "/send") {
			await env.JOBS.send(`from ${env.NAME}`);
			return new Response("sent");
		}
		return Response.json(events);
	},
	scheduled(event) {
		events.push({ cron: event.cron, kind: "scheduled" });
	},
	queue(batch) {
		for (const message of batch.messages) {
			events.push({ body: message.body, kind: "queue", queue: batch.queue });
		}
	},
};
