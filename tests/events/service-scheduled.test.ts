import assert from "node:assert/strict";
import test from "node:test";

import { withOrangeDev, type RunningOrangeDev } from "../harness/orange-dev.js";

interface Answer {
	result: { noRetry: boolean; outcome: string };
	seen: { cron: string; scheduledTime: number };
}

async function scheduled(dev: RunningOrangeDev, options?: object): Promise<Answer> {
	const query = options === undefined ? "" : `?options=${encodeURIComponent(JSON.stringify(options))}`;
	return (await (await fetch(`${dev.origin}/scheduled${query}`)).json()) as Answer;
}

test("a service binding's scheduled() runs the handler and reports its outcome", { timeout: 120_000 }, async () => {
	await withOrangeDev("service-scheduled", async (dev) => {
		const before = Date.now();
		const defaults = await scheduled(dev);
		assert.deepEqual(defaults.result, { noRetry: false, outcome: "ok" });
		assert.equal(defaults.seen.cron, "");
		assert.ok(Math.abs(defaults.seen.scheduledTime - before) < 10_000);

		// Overlapping calls each get their own outcome.
		const [noRetry, failing] = await Promise.all([
			scheduled(dev, { cron: "no-retry", scheduledTime: 1000 }),
			scheduled(dev, { cron: "throws", scheduledTime: 2000 }),
		]);
		assert.deepEqual(noRetry.result, { noRetry: true, outcome: "ok" });
		assert.equal(noRetry.seen.scheduledTime, 1000);
		assert.deepEqual(failing.result, { noRetry: false, outcome: "exception" });
		assert.equal(failing.seen.scheduledTime, 2000);

		// An entrypoint with no handler fails the event and turns off retries.
		const none = (await (await fetch(`${dev.origin}/none`)).json()) as Answer["result"];
		assert.deepEqual(none, { noRetry: true, outcome: "exception" });
	});
});

test("a service binding sends a stream of unknown length as chunked, and a known body with its length", { timeout: 120_000 }, async () => {
	await withOrangeDev("service-scheduled", async (dev) => {
		const stream = (await (await fetch(`${dev.origin}/stream`)).json()) as Record<string, string>;
		assert.equal(stream["transfer-encoding"], "chunked");
		assert.equal(stream["content-length"], undefined);

		const buffer = (await (await fetch(`${dev.origin}/buffer`)).json()) as Record<string, string>;
		assert.equal(buffer["transfer-encoding"], undefined);
	});
});
