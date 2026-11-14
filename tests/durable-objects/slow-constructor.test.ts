import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import { copyProject, repositoryRoot, startOrangeDev } from "../harness/orange-dev.js";

// Cloudflare allows a constructor 30 seconds. Callers that arrive during it wait for the same object.
test("overlapping callers of a Durable Object with a 22 second constructor all reach one object that started once", { timeout: 180_000 }, async () => {
	const project = await copyProject(join(repositoryRoot, "tests", "fixtures", "slow-constructor"));
	try {
		const dev = await startOrangeDev(project.directory);
		try {
			const responses = await Promise.all([
				fetch(dev.origin),
				fetch(dev.origin),
				fetch(dev.origin),
			]);
			const bodies = await Promise.all(responses.map((response) => response.text()));
			assert.deepEqual(responses.map((response) => response.status), [200, 200, 200], `${bodies.join("\n")}\n${dev.output()}`);
			const results = bodies.map((body) => JSON.parse(body) as { instance: string; starts: number });
			assert.equal(new Set(results.map((result) => result.instance)).size, 1);
			assert.deepEqual(results.map((result) => result.starts), [1, 1, 1], dev.output());
		} finally {
			await dev.close();
		}
	} finally {
		await project.dispose();
	}
});
