import assert from "node:assert/strict";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

import { copyProject, repositoryRoot, startOrangeDev } from "../harness/orange-dev.js";

async function waitFor<Value>(
	read: () => Promise<Value>,
	done: (value: Value) => boolean,
	timeoutMs: number,
): Promise<Value> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = await read();
		if (done(value) || Date.now() > deadline) return value;
		await delay(1_000);
	}
}

// Cloudflare allows these handlers 15 minutes of wall time. Orange sets no limit.
test("a cron or alarm handler that runs past 60 seconds keeps its storage, and later cron ticks still fire", { timeout: 420_000 }, async () => {
	const project = await copyProject(join(repositoryRoot, "tests", "fixtures", "long-handlers"));
	try {
		const dev = await startOrangeDev(project.directory);
		const get = async (path: string): Promise<unknown> =>
			await (await fetch(new URL(path, dev.origin))).json();
		try {
			const instance = await get("/arm");
			assert.deepEqual(
				await waitFor(
					() => get("/alarm"),
					(events) => Array.isArray(events) && events.length > 0,
					120_000,
				),
				["stored"],
				dev.output(),
			);
			// The object never restarted under its handler.
			assert.deepEqual(await get("/status"), { instance, finished: instance });

			// The long first run ends, and a later tick runs too.
			const expectedRuns = ["start", "end", "start", "end"];
			const runs = await waitFor(
				() => get("/cron"),
				(events) => Array.isArray(events) && events.length >= expectedRuns.length,
				240_000,
			);
			assert.deepEqual(Array.isArray(runs) ? runs.slice(0, expectedRuns.length) : runs, expectedRuns, dev.output());
		} finally {
			await dev.close();
		}
	} finally {
		await project.dispose();
	}
});
