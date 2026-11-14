import assert from "node:assert/strict";
import { glob, readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { copyProject, isRecord, repositoryRoot, startOrangeDev, stopProjectEngines } from "../harness/orange-dev.js";

async function greet(origin: string, name: string): Promise<unknown> {
	const response = await fetch(`${origin}/${name}`);
	assert.equal(response.status, 200, await response.clone().text());
	return await response.json();
}

async function enginePid(projectDirectory: string): Promise<number> {
	for await (const path of glob("**/.open-orange/rivetkit/*/.rivetkit/var/engine/runtime.json", {
		cwd: projectDirectory,
	})) {
		const value: unknown = JSON.parse(await readFile(join(projectDirectory, path), "utf8"));
		if (isRecord(value) && typeof value.pid === "number") return value.pid;
	}
	assert.fail("no Engine runtime file");
}

function processIsAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

// Two `orange dev` processes of one project share one Engine. The first one starts it, so
// the first one to exit must leave it running for the other, and the last one stops it.
test("the orange dev that started the shared Engine exits and the other keeps serving", { timeout: 240_000 }, async () => {
	const project = await copyProject(join(repositoryRoot, "examples", "hello-durable-object"));
	try {
		const first = await startOrangeDev(project.directory);
		assert.deepEqual(await greet(first.origin, "alice"), { greeting: "Hello, alice!", visits: 1 });
		const second = await startOrangeDev(project.directory);
		assert.deepEqual(await greet(second.origin, "alice"), { greeting: "Hello, alice!", visits: 2 });

		await first.close();
		assert.deepEqual(await greet(second.origin, "alice"), { greeting: "Hello, alice!", visits: 3 });

		const pid = await enginePid(project.directory);
		assert.ok(processIsAlive(pid), "the Engine stopped while an orange dev still used it");
		await second.close();
		assert.equal(processIsAlive(pid), false, "the last orange dev left the Engine running");
	} finally {
		await stopProjectEngines(project.directory);
		await project.dispose();
	}
});
