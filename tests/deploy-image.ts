import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { waitFor, withDeadline } from "./orange-dev.js";
import { freePort } from "./free-port.js";

// Builds a real `orange deploy` image and runs it the way a runner pool does.
export const dockerSkip = spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0 ? false : "Docker is not running, so no image can be built here";
const requireFromRivetKit = createRequire(createRequire(import.meta.url).resolve("rivetkit"));
const { getEnginePath } = requireFromRivetKit("@rivetkit/engine-cli") as { getEnginePath(): string };

export function dockerBuild(outdir: string, tag: string): void {
	const build = spawnSync("docker", ["build", "--quiet", "--platform", "linux/amd64", "-f", join(outdir, "Dockerfile"), "-t", tag, join(outdir, "context")], { encoding: "utf8" });
	assert.equal(build.status, 0, build.stderr);
}

// An Engine on the host stands in for the cluster. The container reaches it through host.docker.internal.
export async function withEngine<Value>(body: (endpoint: string) => Promise<Value>): Promise<Value> {
	const directory = await mkdtemp(join(tmpdir(), "open-orange-secrets-engine-"));
	const [guardPort, peerPort, metricsPort] = [await freePort(), await freePort(), await freePort()];
	await mkdir(join(directory, "log"));
	const configPath = join(directory, "config.json");
	const endpoint = `http://host.docker.internal:${guardPort}`;
	await writeFile(
		configPath,
		JSON.stringify({
			topology: {
				datacenter_label: 1,
				datacenters: { default: { datacenter_label: 1, is_leader: true, peer_url: `http://127.0.0.1:${peerPort}/`, public_url: `${endpoint}/` } },
			},
		}),
	);
	const engine: ChildProcess = spawn(getEnginePath(), ["--config", configPath], {
		cwd: directory,
		env: {
			...process.env,
			RIVET__API_PEER__HOST: "127.0.0.1",
			RIVET__API_PEER__PORT: String(peerPort),
			RIVET__AUTH__ADMIN_TOKEN: "test-only-engine-token",
			RIVET__GUARD__HOST: "0.0.0.0",
			RIVET__GUARD__PORT: String(guardPort),
			RIVET__METRICS__HOST: "127.0.0.1",
			RIVET__METRICS__PORT: String(metricsPort),
			RIVET__OBJECT_STORAGE__PRIMARY__FILE_SYSTEM__PATH: join(directory, "objects"),
			RIVET__STORAGE__AUTO_PROVISION_PARTITIONS: "1",
			RIVET__STORAGE__BALANCING__ENABLED: "false",
			RIVET__STORAGE__COLD_STORE__DISK_CACHE_BYTES: "0",
			RIVET__STORAGE__LOG_DIRECTORY: join(directory, "log"),
			RIVET__STORAGE__LOG_SHARD__MAX_DISK_BYTES: String(1024 * 1024 * 1024),
		},
		stdio: "ignore",
	});
	try {
		await waitFor(
			"the Engine to start",
			async () => {
				const names = await fetch(`http://127.0.0.1:${guardPort}/actors/names?namespace=default`, {
					headers: { authorization: "Bearer test-only-engine-token" },
				}).catch(() => undefined);
				return names?.status === 200;
			},
			60_000,
		);
		// A cluster creates its pool. This Engine is empty, so the test does.
		const pool = await fetch(`http://127.0.0.1:${guardPort}/pools/default?namespace=default`, {
			body: "{}",
			headers: { authorization: "Bearer test-only-engine-token", "content-type": "application/json" },
			method: "PUT",
		});
		assert.ok(pool.ok, `${pool.status} ${await pool.text()}`);
		return await body(endpoint);
	} finally {
		const exit = new Promise((done) => engine.once("exit", done));
		engine.kill("SIGTERM");
		await withDeadline(exit, "Engine stop", 20_000).catch(() => engine.kill("SIGKILL"));
		await rm(directory, { force: true, recursive: true });
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
	const run = spawnSync("docker", ["run", "-d", "--platform", "linux/amd64", "--name", name, "--add-host", "host.docker.internal:host-gateway", "-p", `127.0.0.1:${port}:8080`, "-e", `RIVET_ENDPOINT=${endpoint.replace("http://", "http://default:test-only-engine-token@")}`, "-e", "PORT=8080", ...flags, tag], { encoding: "utf8", env: { ...process.env, ...environment } });
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
