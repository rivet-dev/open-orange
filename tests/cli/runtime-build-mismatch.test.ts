import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import { copyProject, repositoryRoot, runOrange, startOrangeDev, withDeadline } from "../harness/orange-dev.js";

// The fixture Worker writes a message no Orange build sends to the runtime's IPC channel.
const mismatchMessage =
	/open-orange runtime sent an invalid message; the runtime and CLI come from different builds\. Reinstall open-orange\./;
const stackFrame = /^\s+at /m;

test("orange dev fails with an actionable message when the runtime sends an invalid message during startup", async () => {
	const project = await copyProject(join(repositoryRoot, "tests", "fixtures", "runtime-build-mismatch"));
	try {
		const { code, output } = await runOrange(project.directory, ["dev", "--port", "0"], "wrangler.startup.jsonc");
		assert.equal(code, 1, output);
		assert.match(output, mismatchMessage);
		assert.doesNotMatch(output, stackFrame);
	} finally {
		await project.dispose();
	}
});

test("orange dev stops with an actionable message when the runtime sends an invalid message after readiness", async () => {
	const project = await copyProject(join(repositoryRoot, "tests", "fixtures", "runtime-build-mismatch"));
	try {
		const dev = await startOrangeDev(project.directory);
		let code: number | null | undefined;
		try {
			// The runtime stops while it handles this request, so the response may never arrive.
			await fetch(`${dev.origin}/invalid-ipc`).catch(() => undefined);
			code = await withDeadline(dev.exited, "orange dev exit");
		} finally {
			if (code === undefined) await dev.close();
		}
		assert.equal(code, 1, dev.output());
		assert.match(dev.output(), mismatchMessage);
		assert.doesNotMatch(dev.output(), stackFrame);
	} finally {
		await project.dispose();
	}
});
