import assert from "node:assert/strict";
import { symlink, mkdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { copyProject, repositoryRoot, startOrangeDev } from "../harness/orange-dev.js";

// Expected values are workerd 1.20260903.1's output for the same fixture.
test("a Worker's Cap'n Web session hands out stubs that came from a Durable Object", { timeout: 120_000 }, async () => {
	const project = await copyProject(join(repositoryRoot, "tests", "fixtures", "capnweb-stubs"));
	try {
		await mkdir(join(project.directory, "node_modules"));
		await symlink(
			join(repositoryRoot, "packages", "runtime-node", "node_modules", "capnweb"),
			join(project.directory, "node_modules", "capnweb"),
		);
		const dev = await startOrangeDev(project.directory);
		try {
			const response = await fetch(dev.origin);
			const body = await response.text();
			assert.equal(response.status, 200, `${body}\n${dev.output()}`);
			assert.deepEqual(JSON.parse(body), { returned: "pong", object: "room", objectIsServiceStub: true });
		} finally {
			await dev.close();
		}
	} finally {
		await project.dispose();
	}
});
