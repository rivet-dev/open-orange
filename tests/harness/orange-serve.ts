import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { freePort } from "./free-port.js";
import { repositoryRoot, withDeadline } from "./orange-dev.js";

// The Engine binary that the pinned RivetKit spawns for `orange dev`. It is a
// RivetKit dependency, not a root one, so it resolves from RivetKit's package.
const requireFromRivetKit = createRequire(createRequire(import.meta.url).resolve("rivetkit"));
const { getEnginePath } = requireFromRivetKit("@rivetkit/engine-cli") as { getEnginePath(): string };
export const cliEntrypoint = join(repositoryRoot, "src", "bin.ts");
export const adminToken = "orange-serve-test";

export function collectOutput(child: ChildProcess): () => string {
	let output = "";
	child.stdout?.on("data", (chunk: Buffer) => (output += chunk.toString()));
	child.stderr?.on("data", (chunk: Buffer) => (output += chunk.toString()));
	return () => output;
}

export function exited(child: ChildProcess): Promise<number | null> {
	if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(child.exitCode);
	return new Promise((resolveExit) => child.once("exit", (code) => resolveExit(code)));
}

export interface StandaloneEngine {
	/** The endpoint with the admin token, for clients on this host. */
	endpoint: string;
	guardPort: number;
	/** The Engine's output so far, and its exit code once it has exited. */
	report(): string;
	stop(): Promise<void>;
}

export interface StandaloneEngineOptions {
	adminToken?: string;
	/** Where the guard listens. A container reaches the host only on 0.0.0.0. */
	guardHost?: string;
	/** The host in the datacenter's public URL, which runners connect to. */
	publicHost?: string;
}

// A Rivet 3 Engine in its own directory stands in for a Rivet cluster. It runs the
// way RivetKit runs its local Engine: one storage worker on the local file system.
// https://github.com/rivet-dev/rivet/blob/a00b07f483aa3fb07ab403614bcb79d7a8be0322/rivetkit-rust/packages/engine-process/src/lib.rs
export async function startStandaloneEngine(options: StandaloneEngineOptions = {}): Promise<StandaloneEngine> {
	// freePort() frees a port before the Engine binds it, so a process in a parallel test can take
	// it first. The Engine then exits during startup, and a start on new ports succeeds.
	for (let attempt = 1; ; attempt += 1) {
		const started = await startEngineOnce(options);
		if ("engine" in started) return started.engine;
		if (attempt === 3) assert.fail(`rivet-engine did not start in ${attempt} attempts:\n${started.report}`);
	}
}

async function startEngineOnce(
	options: StandaloneEngineOptions,
): Promise<{ engine: StandaloneEngine } | { report: string }> {
	const token = options.adminToken ?? adminToken;
	const directory = await mkdtemp(join(tmpdir(), "open-orange-engine-"));
	const [guardPort, peerPort, metricsPort] = [await freePort(), await freePort(), await freePort()];
	const configPath = join(directory, "config.json");
	await mkdir(join(directory, "log"));
	// The datacenter's public URL matches the endpoint that runners connect to.
	await writeFile(
		configPath,
		JSON.stringify({
			topology: {
				datacenter_label: 1,
				datacenters: {
					default: {
						datacenter_label: 1,
						is_leader: true,
						peer_url: `http://127.0.0.1:${peerPort}/`,
						public_url: `http://${options.publicHost ?? "127.0.0.1"}:${guardPort}/`,
					},
				},
			},
		}),
	);
	const child = spawn(getEnginePath(), ["--config", configPath], {
		cwd: directory,
		env: {
			...process.env,
			RIVET__API_PEER__HOST: "127.0.0.1",
			RIVET__API_PEER__PORT: String(peerPort),
			RIVET__AUTH__ADMIN_TOKEN: token,
			RIVET__GUARD__HOST: options.guardHost ?? "127.0.0.1",
			RIVET__GUARD__PORT: String(guardPort),
			RIVET__METRICS__HOST: "127.0.0.1",
			RIVET__METRICS__PORT: String(metricsPort),
			// A killed runner keeps its actors until the Engine judges it lost, 40 s by default.
			// RivetKit's local Engine uses 7 s, so restart tests move actors on as `orange dev` does.
			RIVET__PEGBOARD__NODE_LOST_THRESHOLD: "7000",
			RIVET__OBJECT_STORAGE__PRIMARY__FILE_SYSTEM__PATH: join(directory, "objects"),
			RIVET__STORAGE__AUTO_PROVISION_PARTITIONS: "1",
			RIVET__STORAGE__BALANCING__ENABLED: "false",
			RIVET__STORAGE__COLD_STORE__DISK_CACHE_BYTES: "0",
			RIVET__STORAGE__LOG_DIRECTORY: join(directory, "log"),
			RIVET__STORAGE__LOG_SHARD__MAX_DISK_BYTES: String(1024 * 1024 * 1024),
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	const output = collectOutput(child);
	const report = (): string =>
		child.exitCode === null && child.signalCode === null
			? output()
			: `rivet-engine exited with ${child.exitCode ?? child.signalCode}:\n${output()}`;
	const stop = async (): Promise<void> => {
		const exit = exited(child);
		child.kill("SIGTERM");
		await withDeadline(exit, "rivet-engine stop", 15_000).catch(() => child.kill("SIGKILL"));
		await rm(directory, { force: true, recursive: true });
	};
	// The Engine answers before its storage partition is placed, so readiness is an API
	// call that reads storage. Nothing signals it, so the test polls.
	const deadline = Date.now() + 60_000;
	for (;;) {
		if (child.exitCode !== null || child.signalCode !== null) {
			const failure = report();
			await stop();
			return { report: failure };
		}
		const response = await fetch(`http://127.0.0.1:${guardPort}/actors/names?namespace=default`, {
			headers: { authorization: `Bearer ${token}` },
		}).catch(() => undefined);
		if (response?.status === 200) break;
		if (Date.now() > deadline) {
			const failure = report();
			await stop();
			assert.fail(`rivet-engine never became ready:\n${failure}`);
		}
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
	}
	return {
		engine: { endpoint: `http://default:${token}@127.0.0.1:${guardPort}`, guardPort, report, stop },
	};
}

export interface RunningServe {
	child: ChildProcess;
	output(): string;
}

export function spawnServe(
	projectDirectory: string,
	env: NodeJS.ProcessEnv,
	configs: readonly string[] = ["wrangler.jsonc"],
): RunningServe {
	const child = spawn(
		process.execPath,
		["--import", "tsx", cliEntrypoint, "serve", ...configs.flatMap((config) => ["--config", join(projectDirectory, config)])],
		{ cwd: repositoryRoot, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] },
	);
	return { child, output: collectOutput(child) };
}

export async function startServe(
	projectDirectory: string,
	endpoint: string,
	port: number,
	env: NodeJS.ProcessEnv = {},
	configs?: readonly string[],
): Promise<RunningServe> {
	const serve = spawnServe(
		projectDirectory,
		{
			PORT: String(port),
			RIVET_ENDPOINT: endpoint,
			...env,
		},
		configs,
	);
	const ready = new Promise<void>((resolveReady, rejectReady) => {
		serve.child.stdout?.on("data", () => {
			if (serve.output().includes("orange serve listening on")) resolveReady();
		});
		serve.child.once("exit", () => rejectReady(new Error(`orange serve exited:\n${serve.output()}`)));
	});
	await withDeadline(ready, "orange serve readiness", 60_000);
	return serve;
}
