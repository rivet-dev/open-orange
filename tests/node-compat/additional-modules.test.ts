import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import { copyProject, repositoryRoot, startOrangeDev, type RunningOrangeDev } from "../harness/orange-dev.js";

async function withDev(config: string, run: (dev: RunningOrangeDev) => Promise<void>): Promise<void> {
	const project = await copyProject(join(repositoryRoot, "tests", "fixtures", "additional-modules"));
	try {
		const dev = await startOrangeDev(project.directory, config);
		try {
			await run(dev);
		} finally {
			await dev.close();
		}
	} finally {
		await project.dispose();
	}
}

async function files(dev: RunningOrangeDev): Promise<string[]> {
	return (await (await fetch(`${dev.origin}/files`)).json()) as string[];
}

test("find_additional_modules puts the files that match a rule under /bundle, read-only", { timeout: 120_000 }, async () => {
	await withDev("wrangler.jsonc", async (dev) => {
		assert.deepEqual(await files(dev), ["notes.txt", "skills/hello.txt", "skills/nested/deep.md"]);
		assert.equal(await (await fetch(`${dev.origin}/read?path=skills/hello.txt`)).text(), "hello from a bundled file\n");

		const write = await fetch(`${dev.origin}/write?path=skills/hello.txt`);
		assert.equal(write.status, 500);
		// workerd's /bundle refuses a write with EPERM, as Orange's node:fs does.
		assert.equal(await write.text(), "EPERM");
		assert.equal(await (await fetch(`${dev.origin}/read?path=skills/hello.txt`)).text(), "hello from a bundled file\n");
	});
});

test("find_additional_modules searches base_dir when it is set, and names files from there", { timeout: 120_000 }, async () => {
	await withDev("wrangler.base-dir.jsonc", async (dev) => {
		assert.deepEqual(await files(dev), ["other/outside.txt", "src/notes.txt", "src/skills/hello.txt"]);
	});
});

test("without find_additional_modules, /bundle has only the Worker", { timeout: 120_000 }, async () => {
	await withDev("wrangler.off.jsonc", async (dev) => {
		assert.deepEqual(await files(dev), []);
		const read = await fetch(`${dev.origin}/read?path=skills/hello.txt`);
		assert.equal(read.status, 500);
		assert.equal(await read.text(), "ENOENT");
	});
});
