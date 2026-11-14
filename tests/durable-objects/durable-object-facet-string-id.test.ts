import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import { copyProject, repositoryRoot, startOrangeDev } from "../harness/orange-dev.js";

// Expected values are workerd 1.20260903.1's output for the same fixture under `wrangler dev`.
test("a facet started with a string id sees that string as ctx.id, and a restart takes the new one", { timeout: 120_000 }, async () => {
	const project = await copyProject(join(repositoryRoot, "tests", "fixtures", "facet-string-id"));
	try {
		const dev = await startOrangeDev(project.directory);
		try {
			const response = await fetch(dev.origin);
			assert.equal(response.status, 200, `${await response.clone().text()}\n${dev.output()}`);
			assert.deepEqual(await response.json(), {
				described: { type: "string", id: "first-id", name: null },
				grandchild: { type: "string", id: "first-id", name: null },
				restarted: { type: "string", id: "second-id", name: null },
				recalled: "kept",
				parentIdType: "object",
			});
		} finally {
			await dev.close();
		}
	} finally {
		await project.dispose();
	}
});
