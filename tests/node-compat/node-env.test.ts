import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import { copyProject, repositoryRoot, startOrangeDev } from "../harness/orange-dev.js";

// Expected values are `wrangler dev` 4.129.0's output for the same fixture.
test("orange dev sets process.env.NODE_ENV like wrangler dev, and leaves it to vars for a no_bundle Worker", { timeout: 180_000 }, async () => {
	const project = await copyProject(join(repositoryRoot, "tests", "fixtures", "node-env"));
	try {
		for (const [config, expected] of [
			["wrangler.jsonc", "development"],
			["wrangler.no-bundle.jsonc", "from-vars"],
			["wrangler.no-bundle-no-vars.jsonc", "undefined"],
		] as const) {
			const dev = await startOrangeDev(project.directory, config);
			try {
				assert.equal(await (await fetch(dev.origin)).text(), expected, `${config}\n${dev.output()}`);
			} finally {
				await dev.close();
			}
		}
	} finally {
		await project.dispose();
	}
});
