import assert from "node:assert/strict";
import test from "node:test";

import { withOrangeDev, type RunningOrangeDev } from "../harness/orange-dev.js";

function withDev(run: (dev: RunningOrangeDev) => Promise<void>): Promise<void> {
	return withOrangeDev("session-connect", run, { config: ["wrangler.jsonc", "wrangler.peer.jsonc"] });
}

test("connect() through a service binding reaches another Worker, with its address, and the callee's close ends the caller's readable", { timeout: 120_000 }, async () => {
	await withDev(async (dev) => {
		assert.equal(await dev.json("/echo"), "example.com:1234|hello");
	});
});

test("overlapping connect() calls to another Worker each get only their own bytes", { timeout: 120_000 }, async () => {
	await withDev(async (dev) => {
		const answers = (await dev.json("/overlap")) as string[];
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
		const failures = (await dev.json("/failures")) as Record<string, string>;
		assert.notEqual(failures.noHandler, "opened");
		assert.notEqual(failures.stopped, "opened");
		assert.equal(failures.throws, "ended");
		// The Worker still serves afterwards.
		assert.equal(await dev.json("/echo"), "example.com:1234|hello");
	});
});
