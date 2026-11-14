import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { copyProject, repositoryRoot, runOrange, startOrangeDev } from "../harness/orange-dev.js";

const fixture = join(repositoryRoot, "tests", "fixtures", "dev-vars-multiline");

test("a quoted .dev.vars value with line breaks reaches the Worker whole", { timeout: 90_000 }, async () => {
	const project = await copyProject(fixture);
	try {
		await writeFile(
			join(project.directory, ".dev.vars"),
			'SIGNING_KEY="-----BEGIN KEY-----\nAAAA\nBBBB\n-----END KEY-----"\nAFTER=next\n',
		);
		const dev = await startOrangeDev(project.directory);
		try {
			const response = await fetch(dev.origin);
			assert.equal(response.status, 200, dev.output());
			assert.deepEqual(await response.json(), {
				after: "next",
				key: "-----BEGIN KEY-----\nAAAA\nBBBB\n-----END KEY-----",
			});
		} finally {
			await dev.close();
		}
	} finally {
		await project.dispose();
	}
});

test("orange dev names the line of an unclosed .dev.vars quote and hides the value", { timeout: 90_000 }, async () => {
	const project = await copyProject(fixture);
	try {
		await writeFile(join(project.directory, ".dev.vars"), 'AFTER=next\nSIGNING_KEY="secret-start\nsecret-rest\n');
		const { code, output } = await runOrange(project.directory, ["dev"]);
		assert.notEqual(code, 0);
		assert.match(output, /line 2/);
		assert.doesNotMatch(output, /secret-start|secret-rest/);
	} finally {
		await project.dispose();
	}
});
