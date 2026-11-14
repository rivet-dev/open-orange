import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import { copyProject, repositoryRoot, startOrangeDev } from "../harness/orange-dev.js";

// Miniflare gives the Workers of one session one D1 database, KV namespace, and R2 bucket per ID,
// so a Worker reads what another Worker wrote. A database with another ID stays separate.
test("Workers of one session share D1, KV, and R2 by ID, and a database with another ID stays separate", { timeout: 180_000 }, async () => {
	const project = await copyProject(join(repositoryRoot, "tests", "fixtures", "session-shared-storage"));
	try {
		const dev = await startOrangeDev(project.directory, ["wrangler.jsonc", "wrangler.peer.jsonc"]);
		try {
			const read = async (): Promise<unknown> => {
				const response = await fetch(dev.origin);
				assert.equal(response.status, 200, `${await response.clone().text()}\n${dev.output()}`);
				return await response.json();
			};
			assert.deepEqual(await read(), { d1: null, kv: null, otherDb: null, r2: null });
			const written = await fetch(`${dev.origin}/write-through-peer`);
			assert.equal(await written.text(), "written", dev.output());
			assert.deepEqual(await read(), { d1: "peer-row", kv: "peer-kv", otherDb: null, r2: "peer-object" });
		} finally {
			await dev.close();
		}
	} finally {
		await project.dispose();
	}
});
