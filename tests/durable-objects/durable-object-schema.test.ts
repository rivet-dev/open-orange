import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import { copyProject, repositoryRoot, startOrangeDev } from "../harness/orange-dev.js";

interface Dump {
	rows: Record<string, number | { error: string }>;
	tableList: string[];
}

// On workerd a Durable Object's schema holds its own tables and Cloudflare's `_cf_` tables, which
// user SQL can list but not read. Tools such as starbasedb's export list every table and then read
// each one, so a listed table that refuses access breaks them.
test("a Durable Object's schema lists its own tables and Cloudflare's, never the Rivet host's", { timeout: 120_000 }, async () => {
	const project = await copyProject(join(repositoryRoot, "tests", "fixtures", "durable-object-schema"));
	try {
		const dev = await startOrangeDev(project.directory, "wrangler.jsonc");
		try {
			const dump = async (query: string): Promise<Dump> => {
				const response = await fetch(`${dev.origin}/?${query}`);
				const body = await response.text();
				assert.equal(response.status, 200, body);
				return JSON.parse(body) as Dump;
			};

			// Only SQL, as starbasedb: every listed table reads, as on workerd.
			assert.deepEqual(await dump("name=sql-only"), { rows: { users: 1 }, tableList: ["users"] });

			// The KV API adds `_cf_KV`, which workerd lists and refuses.
			const withKv = await dump("name=with-kv&kv=1");
			assert.deepEqual(Object.keys(withKv.rows).sort(), ["_cf_KV", "users"]);
			assert.equal(withKv.rows.users, 1);
			assert.ok(typeof withKv.rows._cf_KV === "object" && "error" in withKv.rows._cf_KV);
			assert.deepEqual(withKv.tableList, ["_cf_KV", "users"]);
		} finally {
			await dev.close();
		}
	} finally {
		await project.dispose();
	}
});
