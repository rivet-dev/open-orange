import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { localDeploymentStoragePath } from "../../src/runtime/deployment.js";
import { freePort } from "../harness/free-port.js";
import { copyProject, repositoryRoot, startOrangeDev, type TemporaryProject } from "../harness/orange-dev.js";

async function exitedPid(): Promise<number> {
	const child = spawn(process.execPath, ["-e", ""]);
	await once(child, "exit");
	assert.ok(child.pid !== undefined);
	return child.pid;
}

// An Engine first gets back the port that the runtime file of its storage names, so two projects
// whose files name one port both pick it.
async function recordEnginePort(project: TemporaryProject, port: number, pid: number): Promise<void> {
	const storagePath = localDeploymentStoragePath({
		environment: undefined,
		projectRoot: project.directory,
		workerName: "hello-durable-object",
	});
	const engineDirectory = join(storagePath, ".rivetkit", "var", "engine");
	await mkdir(engineDirectory, { recursive: true });
	await writeFile(join(engineDirectory, "runtime.json"), JSON.stringify({ endpoint: `http://127.0.0.1:${port}`, pid }));
}

// Parallel `orange dev` sessions, such as parallel test files, check their Engine ports at the same
// time. Both find a port free about a second before either Engine binds it.
test("two orange dev projects whose Engines start at once on the same ports both serve", { timeout: 180_000 }, async () => {
	const source = join(repositoryRoot, "examples", "hello-durable-object");
	const projects = [await copyProject(source), await copyProject(source)];
	try {
		const port = await freePort();
		const deadPid = await exitedPid();
		for (const project of projects) await recordEnginePort(project, port, deadPid);

		const started = await Promise.allSettled(projects.map((project) => startOrangeDev(project.directory)));
		try {
			for (const result of started) {
				if (result.status === "rejected") throw result.reason;
				assert.deepEqual(await result.value.json("/alice"), { greeting: "Hello, alice!", visits: 1 });
			}
		} finally {
			await Promise.all(started.map((result) => (result.status === "fulfilled" ? result.value.close() : undefined)));
		}
	} finally {
		await Promise.all(projects.map((project) => project.dispose()));
	}
});
