import assert from "node:assert/strict";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

import { copyProject, repositoryRoot, startOrangeDev } from "../harness/orange-dev.js";

function actorStates(output: string): string[] {
	const states = new Map<string, string>();
	for (const match of output.matchAll(/actor lifecycle transition" actor_id=(\S+) old=\S+ new=(\S+)/g)) {
		states.set(match[1]!, match[2]!);
	}
	return [...states.values()];
}

test("a Worker with a cron every minute has no awake actor 20 s after a tick", { timeout: 180_000 }, async () => {
	const project = await copyProject(join(repositoryRoot, "tests", "fixtures", "cron-every-minute"));
	try {
		const dev = await startOrangeDev(project.directory, "wrangler.jsonc", { actorLifecycleLogs: true });
		try {
			const runs = (): number => dev.output().split("cron ran").length - 1;
			const before = runs();
			const deadline = Date.now() + 90_000;
			while (runs() <= before) {
				assert.ok(Date.now() < deadline, `no cron tick ran:\n${dev.output().slice(-500)}`);
				await delay(100);
			}
			await delay(20_000);
			const states = actorStates(dev.output());
			assert.ok(states.length > 0);
			assert.deepEqual(states.filter((state) => state !== "Terminated"), []);
		} finally {
			await dev.close();
		}
	} finally {
		await project.dispose();
	}
});
