import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import { copyProject, repositoryRoot, startOrangeDev } from "../harness/orange-dev.js";

// Expected values are workerd 1.20260903.1's output for the same fixture under `wrangler dev`.
test("ctx.exports gives a facet class that carries props into the facet's ctx.props", { timeout: 120_000 }, async () => {
	const project = await copyProject(join(repositoryRoot, "tests", "fixtures", "facet-props"));
	try {
		const dev = await startOrangeDev(project.directory);
		try {
			const response = await fetch(dev.origin);
			assert.equal(response.status, 200, `${await response.clone().text()}\n${dev.output()}`);
			const optionsError =
				"TypeError: Failed to execute '(called as function)' on 'LoopbackDurableObjectClass': parameter 1 is not of type 'Options'.";
			assert.deepEqual(await response.json(), {
				parentProps: {},
				greeterType: "function",
				greeterTag: "[object LoopbackDurableObjectClass]",
				calledTag: "[object DurableObjectClass]",
				bare: { value: {} },
				withProps: { value: { greeting: "Hi", n: 1 } },
				calledEmpty: { value: {} },
				calledNoArgument: { error: optionsError },
				uncloneableProps: { error: "DataCloneError: () => 1 could not be cloned." },
				constructed: { error: optionsError },
			});
		} finally {
			await dev.close();
		}
	} finally {
		await project.dispose();
	}
});
