import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import { copyProject, repositoryRoot, startOrangeDev } from "../harness/orange-dev.js";

test("replacing the public stream methods doesn't intercept a stream passed over RPC, and a Worker's own calls still see them", { timeout: 120_000 }, async () => {
	const project = await copyProject(join(repositoryRoot, "tests", "fixtures", "rpc-stream-pollution"));
	try {
		const dev = await startOrangeDev(project.directory, ["wrangler.jsonc", "wrangler.peer.jsonc"]);
		try {
			const expected = { read: "read", trapped: [], written: "written" };
			assert.deepEqual(await (await fetch(`${dev.origin}/remote`)).json(), expected);
			assert.deepEqual(await (await fetch(`${dev.origin}/user`)).json(), ["getReader"]);
		} finally {
			await dev.close();
		}
	} finally {
		await project.dispose();
	}
});
