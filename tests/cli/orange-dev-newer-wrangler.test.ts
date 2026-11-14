import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { runOrange, startOrangeDev, stopProjectEngines } from "../harness/orange-dev.js";

// Shaped like the `dist/server/wrangler.json` that `@cloudflare/vite-plugin` writes with
// Wrangler 4.147.0: Wrangler's normalized config, with an empty list for each binding type,
// including `k2: []` when the Worker has no K2 binding. This is a subset of those fields;
// `k2` is new in 4.147 and is the one that the Wrangler Orange pins does not know.
function viteBuildConfig(k2: unknown[]): Record<string, unknown> {
	return {
		compatibility_date: "2026-09-03",
		compatibility_flags: [],
		d1_databases: [],
		dispatch_namespaces: [],
		durable_objects: { bindings: [] },
		k2,
		kv_namespaces: [],
		main: "w.js",
		migrations: [],
		mtls_certificates: [],
		name: "newer-wrangler",
		pipelines: [],
		queues: { consumers: [], producers: [] },
		r2_buckets: [],
		rules: [],
		send_email: [],
		services: [],
		vars: {},
		vpc_networks: [],
		vpc_services: [],
	};
}

test("orange dev runs a config that a newer Wrangler wrote with an empty field Orange does not know, and refuses that field with a value", { timeout: 180_000 }, async () => {
	const directory = await mkdtemp(join(tmpdir(), "orange-newer-wrangler-"));
	try {
		await writeFile(join(directory, "w.js"), 'export default { fetch() { return new Response("served"); } };\n');

		await writeFile(join(directory, "wrangler.json"), JSON.stringify(viteBuildConfig([])));
		const dev = await startOrangeDev(directory, "wrangler.json");
		try {
			const response = await fetch(dev.origin);
			assert.equal(await response.text(), "served", dev.output());
			assert.match(dev.output(), /ignores these empty configuration fields that it does not know: k2\./);
		} finally {
			await dev.close();
		}

		// A K2 binding with a stream is one Orange cannot run, so it must not be dropped silently.
		await writeFile(join(directory, "wrangler.json"), JSON.stringify(viteBuildConfig([{ binding: "EVENTS", stream: "events" }])));
		const refused = await runOrange(directory, ["dev", "--port", "0"], "wrangler.json");
		assert.equal(refused.code, 1, refused.output);
		assert.match(refused.output, /Unknown Wrangler configuration fields: k2\. .*cannot use a field a newer Wrangler added/);
	} finally {
		await stopProjectEngines(directory);
		await rm(directory, { force: true, recursive: true });
	}
});
