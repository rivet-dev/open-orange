import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import { copyProject, repositoryRoot, startOrangeDev } from "../harness/orange-dev.js";

const fixture = join(repositoryRoot, "tests", "fixtures", "worker-node-url");

// Expected values are plain Node.js output for the same URL, which workerd matches.
test("url.format() of a Worker's URL keeps its credentials and honors its options, as on Node.js", { timeout: 120_000 }, async () => {
	const project = await copyProject(fixture);
	try {
		const dev = await startOrangeDev(project.directory);
		try {
			const response = await fetch(dev.origin);
			assert.equal(response.status, 200, dev.output());
			assert.deepEqual(await response.json(), {
				format: "postgres://admin:secret@db.example.com:5432/app?sslmode=require#primary",
				withoutAuth: "postgres://db.example.com:5432/app?sslmode=require#primary",
				withoutFragment: "postgres://admin:secret@db.example.com:5432/app?sslmode=require",
				isNodeURL: true,
			});
		} finally {
			await dev.close();
		}
	} finally {
		await project.dispose();
	}
});
