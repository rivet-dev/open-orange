import assert from "node:assert/strict";
import test from "node:test";

import { withOrangeDev } from "../harness/orange-dev.js";

test("replacing the public stream methods doesn't intercept a stream passed over RPC, and a Worker's own calls still see them", { timeout: 120_000 }, async () => {
	await withOrangeDev("rpc-stream-pollution", async (dev) => {
		const expected = { read: "read", trapped: [], written: "written" };
		assert.deepEqual(await dev.json("/remote"), expected);
		assert.deepEqual(await dev.json("/user"), ["getReader"]);
	}, { config: ["wrangler.jsonc", "wrangler.peer.jsonc"] });
});
