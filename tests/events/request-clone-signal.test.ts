import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import { copyProject, repositoryRoot, startOrangeDev, type RunningOrangeDev } from "../harness/orange-dev.js";

interface Answer {
	failure: string;
	flag: boolean;
	seen: Record<string, string>;
}

async function run(config: string, check: (answer: Answer, dev: RunningOrangeDev) => void): Promise<void> {
	const project = await copyProject(join(repositoryRoot, "tests", "fixtures", "request-clone-signal"));
	try {
		const dev = await startOrangeDev(project.directory, config);
		try {
			check((await (await fetch(dev.origin)).json()) as Answer, dev);
		} finally {
			await dev.close();
		}
	} finally {
		await project.dispose();
	}
}

const disconnected = "The client has disconnected";

test("request_signal_passthrough: a copy of a service binding's request sees the client's disconnect", { timeout: 120_000 }, async () => {
	await run("wrangler.passthrough.jsonc", (answer, dev) => {
		assert.equal(answer.failure, "The operation was aborted due to timeout");
		assert.equal(answer.flag, true);
		assert.deepEqual(answer.seen, { clone: disconnected, copy: disconnected, original: disconnected });
		assert.doesNotMatch(dev.output(), /ignores compatibility_flags.*request_signal_passthrough/);
	});
});

test("by default, only the original request sees the disconnect, and its copies don't", { timeout: 120_000 }, async () => {
	await run("wrangler.jsonc", (answer) => {
		assert.equal(answer.failure, "The operation was aborted due to timeout");
		assert.equal(answer.flag, false);
		assert.deepEqual(answer.seen, { original: disconnected });
	});
});
