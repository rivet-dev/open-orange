// Records the cron and queue events this Worker receives and serves them.
const events = [];

export default {
	fetch() {
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
