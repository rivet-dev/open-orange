import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { copyProject, repositoryRoot, startOrangeDev } from "../harness/orange-dev.js";

const fixture = join(repositoryRoot, "tests", "fixtures", "worker-process-env");
const hostSecret = "OPEN_ORANGE_TEST_HOST_SECRET";

test("Worker code sees only its own vars and secrets in process.env and globalThis.process.env, as workerd populates them", async () => {
	const project = await copyProject(fixture);
	await writeFile(join(project.directory, ".dev.vars"), "API_KEY=from-dev-vars\n");
	process.env[hostSecret] = "host-only";
	try {
		const dev = await startOrangeDev(project.directory);
		try {
			const response = await fetch(dev.origin);
			assert.equal(response.status, 200, dev.output());
			const expected = {
				API_KEY: "from-dev-vars",
				GREETING: "hello",
				LIMITS: '{"max":3}',
			};
			// The KV binding is not a string or plain JSON, so workerd leaves it out.
			assert.deepEqual(await response.json(), {
				bare: expected,
				imported: expected,
				global: expected,
				sameProcess: true,
			});
		} finally {
			await dev.close();
		}
	} finally {
		delete process.env[hostSecret];
		await project.dispose();
	}
});
