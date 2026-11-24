import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { freePort } from "./free-port.js";
import { startStandaloneEngine } from "./orange-serve.js";

// Builds a real `orange deploy` image and runs it the way a runner pool does.
export const dockerSkip = spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0 ? false : "Docker is not running, so no image can be built here";
const engineToken = "test-only-engine-token";

export function dockerBuild(outdir: string, tag: string): void {
	const build = spawnSync("docker", ["build", "--quiet", "--platform", "linux/amd64", "-f", join(outdir, "Dockerfile"), "-t", tag, join(outdir, "context")], { encoding: "utf8" });
	assert.equal(build.status, 0, build.stderr);
}

// An Engine on the host stands in for the cluster. The container reaches it through host.docker.internal.
export async function withEngine<Value>(body: (endpoint: string) => Promise<Value>): Promise<Value> {
	const engine = await startStandaloneEngine({ adminToken: engineToken, guardHost: "0.0.0.0", publicHost: "host.docker.internal" });
	try {
		// A cluster creates its pool. This Engine is empty, so the test does.
		const pool = await fetch(`http://127.0.0.1:${engine.guardPort}/pools/default?namespace=default`, {
			body: "{}",
			headers: { authorization: `Bearer ${engineToken}`, "content-type": "application/json" },
			method: "PUT",
		});
		assert.ok(pool.ok, `${pool.status} ${await pool.text()}`);
		try {
			return await body(`http://host.docker.internal:${engine.guardPort}`);
		} catch (error: unknown) {
			// A Worker that cannot reach the Engine fails here, so the Engine's own output goes along.
			if (error instanceof Error) error.message += `\n\nThe Engine during this test:\n${engine.report().slice(-4_000)}`;
			throw error;
		}
	} finally {
		await engine.stop();
	}
}

// Runs the image the way a pool does, and returns what the Worker answers, or the runner's last log
// lines when it exits first. `environment` is the `docker run` process's own, which a bare `-e NAME`
// in `flags` passes on.
async function runWorker(
	tag: string,
	endpoint: string,
	{ environment, flags = [] }: { environment?: Record<string, string>; flags?: readonly string[] } = {},
): Promise<{ exited: string } | { text: string }> {
	const port = await freePort();
	const name = `oo-secrets-${port}`;
	const run = spawnSync("docker", ["run", "-d", "--platform", "linux/amd64", "--name", name, "--add-host", "host.docker.internal:host-gateway", "-p", `127.0.0.1:${port}:8080`, "-e", `RIVET_ENDPOINT=${endpoint.replace("http://", `http://default:${engineToken}@`)}`, "-e", "PORT=8080", ...flags, tag], { encoding: "utf8", env: { ...process.env, ...environment } });
	assert.equal(run.status, 0, run.stderr);
	const logs = (): string => {
		const tail = spawnSync("docker", ["logs", "--tail", "40", name], { encoding: "utf8" });
		return `${tail.stdout}\n${tail.stderr}`;
	};
	try {
		for (let i = 0; i < 300; i += 1) {
			const response = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2_000) }).catch(() => undefined);
			if (response?.ok) return { text: await response.text() };
			const state = spawnSync("docker", ["inspect", "-f", "{{.State.Running}}", name], { encoding: "utf8" });
			if (state.stdout.trim() === "false") return { exited: logs() };
			await delay(500);
		}
		assert.fail(`the Worker did not answer:\n${logs()}`);
	} finally {
		spawnSync("docker", ["rm", "-f", name], { stdio: "ignore" });
	}
}

export async function workerAnswer(tag: string, endpoint: string, options?: Parameters<typeof runWorker>[2]): Promise<string> {
	const result = await runWorker(tag, endpoint, options);
	if ("exited" in result) assert.fail(`the Worker exited:\n${result.exited}`);
	return result.text;
}

// The text goes to grep on stdin, so it is never a process argument.
export function imageHolds(tag: string, text: string): boolean {
	const search = spawnSync("docker", ["run", "--rm", "-i", "--platform", "linux/amd64", "--entrypoint", "grep", tag, "-rlF", "-f", "-", "/app"], { encoding: "utf8", input: `${text}\n` });
	return search.stdout.trim().length > 0;
}
