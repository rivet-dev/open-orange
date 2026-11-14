import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import { copyProject, repositoryRoot, startOrangeDev } from "./orange-dev.js";

// After ctx.abort(), RivetKit can route a call to the aborted generation until the actor stops.
// The race needs many rounds to show, so this test runs them in batches against one runtime. Each
// batch uses its own objects, so the batches run at the same time.
test(
	"Durable Object calls around ctx.abort() either fail with its error or reach a new instance",
	{ timeout: 600_000 },
	async () => {
		const project = await copyProject(join(repositoryRoot, "tests", "fixtures", "abort-race"));
		const dev = await startOrangeDev(project.directory);
		try {
			const outcomes: Record<string, number> = {};
			const batches = await Promise.all(
				Array.from({ length: 8 }, async (_, batch) => {
					const response = await fetch(`${dev.origin}/?rounds=20&tag=${batch}`);
					assert.equal(response.status, 200, `${await response.clone().text()}\n${dev.output()}`);
					return (await response.json()) as Record<string, number>;
				}),
			);
			for (const batch of batches) {
				for (const [outcome, count] of Object.entries(batch)) {
					outcomes[outcome] = (outcomes[outcome] ?? 0) + count;
				}
			}
			// A call that overlaps the abort can also lose its connection when RivetKit stops the
			// aborted actor mid-response. It fails as on Cloudflare, with a different error.
			const lostConnection = (outcome: string): boolean =>
				/^error: (terminated|fetch failed)\b/.test(outcome);
			const unexpected = Object.keys(outcomes).filter(
				(outcome) =>
					outcome !== "ok" && outcome !== "aborted" && outcome !== "after abort: ok" && !lostConnection(outcome),
			);
			assert.deepEqual(unexpected, [], JSON.stringify(outcomes));
			assert.equal(outcomes["after abort: ok"], 160, JSON.stringify(outcomes));
		} finally {
			try {
				await dev.close();
			} finally {
				await project.dispose();
			}
		}
	},
);
