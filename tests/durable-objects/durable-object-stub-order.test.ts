import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import { copyProject, repositoryRoot, startOrangeDev } from "../harness/orange-dev.js";

// workerd delivers calls from one process to one object in the order they were made, whichever
// stub made them. Orange ordered each stub alone, so a read through a second stub could run
// before an earlier write through the first and return the old value.
test("a call through one stub reaches its object before a later call through another stub", { timeout: 180_000 }, async () => {
	const project = await copyProject(join(repositoryRoot, "tests", "fixtures", "durable-object-stub-order"));
	try {
		const dev = await startOrangeDev(project.directory, "wrangler.jsonc");
		try {
			for (const kind of ["rpc", "fetch"]) {
				const response = await fetch(`${dev.origin}/?kind=${kind}&rounds=50&name=${kind}`);
				const body = await response.text();
				assert.equal(response.status, 200, body);
				assert.deepEqual(JSON.parse(body), { stale: [] }, `${kind}: ${body}`);
			}
		} finally {
			await dev.close();
		}
	} finally {
		await project.dispose();
	}
});
