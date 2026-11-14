import assert from "node:assert/strict";
import test from "node:test";

import { withOrangeDev } from "../harness/orange-dev.js";

// Miniflare gives the Workers of one session one D1 database, KV namespace, and R2 bucket per ID,
// so a Worker reads what another Worker wrote. A database with another ID stays separate.
test("Workers of one session share D1, KV, and R2 by ID, and a database with another ID stays separate", { timeout: 180_000 }, async () => {
	await withOrangeDev("session-shared-storage", async (dev) => {
		assert.deepEqual(await dev.json("/"), { d1: null, kv: null, otherDb: null, r2: null });
		const written = await fetch(`${dev.origin}/write-through-peer`);
		assert.equal(await written.text(), "written", dev.output());
		assert.deepEqual(await dev.json("/"), { d1: "peer-row", kv: "peer-kv", otherDb: null, r2: "peer-object" });
	}, { config: ["wrangler.jsonc", "wrangler.peer.jsonc"] });
});
