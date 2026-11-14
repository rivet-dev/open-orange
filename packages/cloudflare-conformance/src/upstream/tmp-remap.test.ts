import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { hostChanges, pathVocabulary, snapshotHost } from "./tmp-remap.js";

test("the host safety net blocks changes the test file could make and lets other processes' changes through", async () => {
	const root = await mkdtemp(join(tmpdir(), "tmp-remap-test-"));
	try {
		const host = { tmp: join(root, "tmp"), home: join(root, "home"), repository: join(root, "repo") };
		for (const directory of Object.values(host)) await mkdir(directory);
		await mkdir(join(host.home, "dev"));
		// Linux stamps mtimes from a coarse clock, so on a fast host a write right after mkdir can
		// keep the same mtime. An old mtime makes the later write a visible change.
		await utimes(join(host.home, "dev"), 0, 0);
		await writeFile(join(host.home, ".profile"), "");
		const vocabulary = pathVocabulary([
			`mkdtempSync('/tmp/testdir-'); symlinkSync('/', '/tmp/link-root'); readFileSync("/dev/null");`,
		]);
		const before = await snapshotHost(host);

		await mkdir(join(host.tmp, "testdir-Ab12Cd"));
		await writeFile(join(host.tmp, "link-root"), "");
		await writeFile(join(host.repository, "test-cwd.txt"), "");
		await chmod(join(host.home, ".profile"), 0o600);
		await writeFile(join(host.tmp, "other-tool-install.log"), "");
		await writeFile(join(host.home, "dev", "new-worktree"), "");
		const changes = hostChanges(host, before, await snapshotHost(host), vocabulary);

		assert.deepEqual(changes.blocking.sort(), [
			`added ${join(host.repository, "test-cwd.txt")} (file)`,
			`added ${join(host.tmp, "link-root")} (file)`,
			`added ${join(host.tmp, "testdir-Ab12Cd")} (directory)`,
			`changed ${join(host.home, ".profile")}: mode 100644 -> 100600`,
		]);
		assert.deepEqual(changes.unattributed.sort(), [
			`added ${join(host.tmp, "other-tool-install.log")} (file)`,
			`changed ${join(host.home, "dev")}: mtimeMs 0 -> ${(await stat(join(host.home, "dev"))).mtimeMs}`,
		]);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
