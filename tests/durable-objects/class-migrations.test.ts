import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import { copyProject, repositoryRoot, runOrange, startOrangeDev } from "../harness/orange-dev.js";

test("a renamed class keeps its objects, and a class made again after its deletion starts empty", { timeout: 240_000 }, async () => {
	const project = await copyProject(join(repositoryRoot, "tests", "fixtures", "class-migrations"));
	try {
		const before = await startOrangeDev(project.directory, "wrangler.before.jsonc");
		let uniqueId: string;
		try {
			assert.equal(await before.json("/named"), 1);
			assert.equal(await before.json("/retired"), 1);
			const unique = (await before.json("/unique")) as { id: string; value: number };
			uniqueId = unique.id;
		} finally {
			await before.close();
		}

		const after = await startOrangeDev(project.directory, "wrangler.after.jsonc");
		try {
			assert.equal(await after.json("/named"), 2);
			assert.equal(await after.json(`/by-id?id=${uniqueId}`), 2);
			assert.equal(await after.json("/retired"), "no binding");
		} finally {
			await after.close();
		}

		const recreated = await startOrangeDev(project.directory, "wrangler.recreated.jsonc");
		try {
			assert.equal(await recreated.json("/retired"), 1);
			assert.equal(await recreated.json("/named"), 3);
		} finally {
			await recreated.close();
		}
	} finally {
		await project.dispose();
	}
});

test("orange dev refuses a migration that renames a class that does not exist", { timeout: 90_000 }, async () => {
	const project = await copyProject(join(repositoryRoot, "tests", "fixtures", "class-migrations"));
	try {
		const { code, output } = await runOrange(project.directory, ["dev"], "wrangler.bad-rename.jsonc");
		assert.notEqual(code, 0);
		assert.match(output, /renames unknown class Missing/);
	} finally {
		await project.dispose();
	}
});

// Retired is named in both transferred_classes and new_sqlite_classes of one migration, as in
// kody. Orange treats it as one creation; Cloudflare's behavior for that on a fresh deploy is
// inferred, not verified.
test("a class moved in with transferred_classes stores objects that survive a restart", { timeout: 180_000 }, async () => {
	const project = await copyProject(join(repositoryRoot, "tests", "fixtures", "class-migrations"));
	try {
		for (const expected of [[1, 2], [3]]) {
			const dev = await startOrangeDev(project.directory, "wrangler.transferred.jsonc");
			try {
				for (const value of expected) {
					assert.equal(await dev.json("/named"), value);
					assert.equal(await dev.json("/retired"), value);
				}
			} finally {
				await dev.close();
			}
		}
	} finally {
		await project.dispose();
	}
});

test("orange dev refuses a transferred_classes entry without from_script", { timeout: 90_000 }, async () => {
	const project = await copyProject(join(repositoryRoot, "tests", "fixtures", "class-migrations"));
	try {
		const { code, output } = await runOrange(project.directory, ["dev"], "wrangler.bad-transfer.jsonc");
		assert.notEqual(code, 0);
		assert.match(output, /transferred_classes/);
	} finally {
		await project.dispose();
	}
});
