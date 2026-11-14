import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import { copyProject, repositoryRoot, startOrangeDev } from "../harness/orange-dev.js";

test("node:worker_threads gives a Worker the same MessageChannel as its global, and a working port", { timeout: 120_000 }, async () => {
	const project = await copyProject(join(repositoryRoot, "tests", "fixtures", "worker-threads"));
	try {
		const dev = await startOrangeDev(project.directory);
		try {
			const response = await fetch(dev.origin);
			assert.deepEqual(await response.json(), {
				defaultExportMatches: true,
				isMainThread: true,
				isPort: true,
				nothingToReceive: true,
				received: { hello: "port" },
				sameAsGlobal: true,
			});
		} finally {
			await dev.close();
		}
	} finally {
		await project.dispose();
	}
});
