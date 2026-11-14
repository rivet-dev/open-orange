import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import { copyProject, repositoryRoot, startOrangeDev } from "../harness/orange-dev.js";

// Expected values are workerd 1.20260903.1's output for the same fixture under `wrangler dev`.
test("HTMLRewriter rejects streamed replacement content that is not valid UTF-8", { timeout: 120_000 }, async () => {
	const project = await copyProject(join(repositoryRoot, "tests", "fixtures", "html-rewriter-invalid-utf8"));
	try {
		const dev = await startOrangeDev(project.directory);
		try {
			const response = await fetch(dev.origin);
			assert.equal(response.status, 200, `${await response.clone().text()}\n${dev.output()}`);
			assert.deepEqual(await response.json(), {
				invalidResponse: { error: "TypeError: Parser error: Invalid UTF-8" },
				truncatedStream: { text: "<p>ax</p>" },
				splitCharacter: { text: "<p>é!x</p>" },
			});
		} finally {
			await dev.close();
		}
	} finally {
		await project.dispose();
	}
});
