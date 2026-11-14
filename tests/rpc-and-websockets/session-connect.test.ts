import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import { copyProject, repositoryRoot, startOrangeDev, type RunningOrangeDev } from "../harness/orange-dev.js";

async function withDev(run: (dev: RunningOrangeDev) => Promise<void>): Promise<void> {
	const project = await copyProject(join(repositoryRoot, "tests", "fixtures", "session-connect"));
	try {
		const dev = await startOrangeDev(project.directory, ["wrangler.jsonc", "wrangler.peer.jsonc"]);
		try {
			await run(dev);
		} finally {
			await dev.close();
		}
	} finally {
		await project.dispose();
	}
}

test("connect() through a service binding reaches another Worker, with its address, and the callee's close ends the caller's readable", { timeout: 120_000 }, async () => {
	await withDev(async (dev) => {
		assert.equal(await (await fetch(`${dev.origin}/echo`)).json(), "example.com:1234|hello");
	});
});

test("overlapping connect() calls to another Worker each get only their own bytes", { timeout: 120_000 }, async () => {
	await withDev(async (dev) => {
		const answers = (await (await fetch(`${dev.origin}/overlap`)).json()) as string[];
		assert.deepEqual(
			answers.map((answer) => answer.length),
			["a", "b", "c", "d"].map((name) => `${name}.example.com:1|`.length + 70_000),
		);
		for (const [index, name] of ["a", "b", "c", "d"].entries()) {
			assert.equal(answers[index], `${name}.example.com:1|${name.repeat(70_000)}`);
		}
	});
});

test("connect() to another Worker fails when it has no handler, its handler throws, or it isn't running", { timeout: 120_000 }, async () => {
	await withDev(async (dev) => {
		const failures = (await (await fetch(`${dev.origin}/failures`)).json()) as Record<string, string>;
		assert.notEqual(failures.noHandler, "opened");
		assert.notEqual(failures.stopped, "opened");
		assert.equal(failures.throws, "ended");
		// The Worker still serves afterwards.
		assert.equal(await (await fetch(`${dev.origin}/echo`)).json(), "example.com:1234|hello");
	});
});
