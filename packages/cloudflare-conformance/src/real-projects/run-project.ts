import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { createWriteStream, existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import type { CorpusProject } from "./corpus.js";
import { deriveStatus, type PhaseResult, type RealProjectResult, type SleepGate } from "./result.js";
import {
	openTestSocket,
	type Scenario,
	type ScenarioContext,
	type StepKind,
	type StepResult,
	type TestSocket,
} from "./scenario.js";

export interface RunProjectOptions {
	project: CorpusProject;
	scenario: Scenario | undefined;
	/** The Orange checkout whose `src/bin.ts` runs the project. */
	orangeRoot: string;
	orange: { sha: string; dirty: boolean | null };
	rivetkit: string;
	/** Clones and logs live under here, one directory per project. */
	scratch: string;
	/** The project's directory in `real-projects/`, for its `changes.patch`. */
	projectDirectory: string;
	/** Keep the clone and its node_modules. */
	keep: boolean;
	/** Runs `wrangler dev` instead of `orange dev`. For probes. */
	baseline: boolean;
	/** `emulated` also counts an object that Orange soft-hibernated as asleep. The default is `strict`. */
	sleepGate?: SleepGate;
	log(message: string): void;
}

const bootTimeoutMs = 120_000;
const installTimeoutMs = 600_000;
const buildTimeoutMs = 600_000;
const errorLimit = 1_200;

// Worker code and build tools get no credential from the machine that runs them.
function cleanEnvironment(home: string, paths: readonly string[]): NodeJS.ProcessEnv {
	return {
		CI: "1",
		HOME: home,
		LANG: "C.UTF-8",
		NO_COLOR: "1",
		PATH: [...paths, process.env.PATH ?? ""].join(":"),
		WRANGLER_SEND_METRICS: "false",
		XDG_CACHE_HOME: join(home, ".cache"),
		...(process.env.PNPM_HOME === undefined ? {} : { PNPM_HOME: process.env.PNPM_HOME }),
	};
}

function errorTail(output: string): string {
	return output.length <= errorLimit ? output.trim() : `…${output.slice(-errorLimit).trim()}`;
}

async function runCommand(
	argv: readonly string[],
	cwd: string,
	env: NodeJS.ProcessEnv,
	timeoutMs: number,
	logPath: string,
): Promise<{ ok: boolean; output: string; seconds: number }> {
	const started = Date.now();
	const log = createWriteStream(logPath, { flags: "a" });
	log.write(`$ ${argv.join(" ")}\n`);
	const child = spawn(argv[0]!, argv.slice(1), { cwd, detached: true, env, stdio: ["ignore", "pipe", "pipe"] });
	let output = "";
	const onData = (chunk: Buffer) => {
		output += chunk.toString("utf8");
		if (output.length > 64_000) output = output.slice(-32_000);
		log.write(chunk);
	};
	child.stdout?.on("data", onData);
	child.stderr?.on("data", onData);
	const code = await new Promise<number | string | null>((resolve) => {
		const timer = setTimeout(() => {
			if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
			resolve("timeout");
		}, timeoutMs);
		child.once("error", (error) => {
			clearTimeout(timer);
			resolve(error.message);
		});
		child.once("exit", (exitCode, signal) => {
			clearTimeout(timer);
			resolve(exitCode ?? signal);
		});
	});
	log.end();
	const ok = code === 0;
	if (code === "timeout") output += `\ntimed out after ${timeoutMs}ms`;
	return { ok, output, seconds: Math.round((Date.now() - started) / 1000) };
}

// What a signal must stop: running `orange dev` processes and the Worker directories that may hold an Engine.
const liveOrange = new Set<ChildProcess>();
const liveDirectories = new Set<string>();

export async function stopEverything(): Promise<void> {
	await Promise.all([...liveOrange].map((child) => stopOrange(child)));
	await Promise.all([...liveDirectories].map((directory) => stopEngines(directory)));
}

// Bazel leaves read-only directories, and rm cannot delete their entries until the directories are writable.
async function removeTree(path: string): Promise<void> {
	try {
		await rm(path, { force: true, recursive: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EACCES") throw error;
		// Best effort: the failed rm already removed part of the tree, so some paths are gone.
		// `find` does not follow symlinks. The second rm reports what is still left.
		spawnSync("find", [path, "-type", "d", "-exec", "chmod", "u+w", "{}", "+"]);
		await rm(path, { force: true, recursive: true });
	}
}

function words(command: string): string[] {
	return command.trim().split(/\s+/);
}

async function freePort(): Promise<number> {
	return await new Promise((resolve, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			const port = typeof address === "object" && address !== null ? address.port : 0;
			server.close(() => resolve(port));
		});
	});
}

function processIsAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function stopEngines(root: string): Promise<void> {
	const storageRoot = join(root, ".open-orange", "rivetkit");
	if (!existsSync(storageRoot)) return;
	for (const identity of readdirSync(storageRoot)) {
		const stampPath = join(storageRoot, identity, ".rivetkit", "var", "engine", "runtime.json");
		let pid: unknown;
		try {
			pid = (JSON.parse(readFileSync(stampPath, "utf8")) as { pid?: unknown }).pid;
		} catch {
			continue;
		}
		rmSync(stampPath, { force: true });
		if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0 || !processIsAlive(pid)) continue;
		process.kill(pid, "SIGTERM");
		// The Engine needs about 6 seconds to stop. A SIGKILL before then makes the next Engine
		// on the same data wait out the storage lease.
		const deadline = Date.now() + 15_000;
		while (processIsAlive(pid) && Date.now() < deadline) await delay(50);
		if (processIsAlive(pid)) process.kill(pid, "SIGKILL");
	}
}

interface OrangeProcess {
	child: ChildProcess;
	port: number;
	output(): string;
}

async function startOrange(
	options: RunProjectOptions,
	workerDirectory: string,
	env: NodeJS.ProcessEnv,
	logPath: string,
): Promise<OrangeProcess | { error: string }> {
	const port = await freePort();
	const log = createWriteStream(logPath, { flags: "a" });
	const configFlags = [
		...options.project.configs.flatMap((config) => ["--config", join(workerDirectory, config)]),
		...(options.project.env === undefined ? [] : ["--env", options.project.env]),
	];
	const child = spawn(
		process.execPath,
		options.baseline
			? [
					join(options.orangeRoot, "packages", "cloudflare-conformance", "node_modules", "wrangler", "bin", "wrangler.js"),
					"dev",
					...configFlags,
					"--port",
					String(port),
					"--ip",
					"127.0.0.1",
					"--show-interactive-dev-session=false",
				]
			: [
					"--import",
					"tsx",
					join(options.orangeRoot, "src", "bin.ts"),
					"dev",
					...configFlags,
					"--port",
					String(port),
					"--ip",
					"127.0.0.1",
					"--show-interactive-dev-session=false",
				],
		{
			cwd: options.orangeRoot,
			detached: true,
			// Info logs carry the actor lifecycle transitions that waitForSleep reads.
			env: { ...env, RIVET_LOG_LEVEL: "info" },
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	liveOrange.add(child);
	child.once("exit", () => liveOrange.delete(child));
	let output = "";
	const ready = await new Promise<string>((resolve) => {
		const timer = setTimeout(() => resolve(`no ready line within ${bootTimeoutMs}ms`), bootTimeoutMs);
		const onData = (chunk: Buffer) => {
			output += chunk.toString("utf8");
			log.write(chunk);
			if (/^\s+Local\s+http|Ready on http/m.test(output)) {
				clearTimeout(timer);
				resolve("ok");
			}
		};
		child.stdout?.on("data", onData);
		child.stderr?.on("data", onData);
		child.once("error", (error) => {
			clearTimeout(timer);
			resolve(error.message);
		});
		child.once("exit", (code, signal) => {
			clearTimeout(timer);
			resolve(`orange dev exited (code ${code ?? "none"}, signal ${signal ?? "none"})`);
		});
	});
	if (ready !== "ok") {
		await stopOrange(child);
		return { error: `${ready}\n${errorTail(output)}` };
	}
	return { child, port, output: () => output };
}

async function stopOrange(child: ChildProcess): Promise<void> {
	if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
	const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
	try {
		process.kill(-child.pid, "SIGINT");
	} catch {
		return;
	}
	await Promise.race([exited, delay(15_000)]);
	try {
		process.kill(-child.pid, "SIGKILL");
	} catch {
		// The whole group already exited.
	}
	await exited;
}

export async function runProject(options: RunProjectOptions): Promise<RealProjectResult> {
	const { project } = options;
	const base: RealProjectResult = {
		schemaVersion: 1,
		id: project.id,
		repo: project.repo,
		commit: project.commit,
		stars: project.stars,
		origin: project.origin,
		directory: project.directory,
		ranAt: new Date().toISOString(),
		orange: options.orange,
		rivetkit: options.rivetkit,
		runtime: options.baseline ? "workerd" : "orange",
		...(options.sleepGate === "emulated" ? { sleepGate: "emulated" as const } : {}),
		node: process.version,
		status: "not-run",
		install: null,
		build: null,
		boot: null,
		steps: [],
		changes: project.changes,
		durableObjects: project.durableObjects,
	};
	if (project.notRun !== undefined) return { ...base, notRun: project.notRun };
	if (options.scenario === undefined) return { ...base, notRun: "No scenario is written yet." };

	const root = join(options.scratch, project.id);
	const checkout = join(root, "repo");
	const home = join(root, "home");
	const logPath = join(root, "run.log");
	const workerDirectory = join(checkout, project.directory);
	await mkdir(home, { recursive: true });
	const engineDirectories = [workerDirectory, ...project.configs.map((config) => join(workerDirectory, config, ".."))];
	for (const directory of engineDirectories) liveDirectories.add(directory);
	const env = cleanEnvironment(home, [
		join(workerDirectory, "node_modules", ".bin"),
		join(checkout, project.installDirectory, "node_modules", ".bin"),
		join(checkout, "node_modules", ".bin"),
	]);
	// Package caches are shared by every project in this run, so a store does not repeat per project.
	const caches = join(options.scratch, ".package-caches");
	Object.assign(env, {
		BUN_INSTALL_CACHE_DIR: join(caches, "bun"),
		YARN_CACHE_FOLDER: join(caches, "yarn"),
		npm_config_cache: join(caches, "npm"),
		npm_config_store_dir: join(caches, "pnpm"),
	});
	const finish = (result: RealProjectResult): RealProjectResult => ({
		...result,
		status: deriveStatus([result.install, result.build, result.boot], result.steps),
	});
	try {
		if (project.local === true) {
			await rm(checkout, { force: true, recursive: true });
			await cp(join(options.projectDirectory, "worker"), checkout, { recursive: true });
		} else if (!existsSync(join(checkout, ".git"))) {
			await mkdir(checkout, { recursive: true });
			const gitEnv = { ...env, GIT_TERMINAL_PROMPT: "0" };
			for (const argv of [
				["git", "init", "-q"],
				["git", "remote", "add", "origin", `https://github.com/${project.repo}.git`],
				["git", "fetch", "-q", "--depth", "1", "origin", project.commit],
				["git", "-c", "advice.detachedHead=false", "checkout", "-q", "FETCH_HEAD"],
			]) {
				const fetched = await runCommand(argv, checkout, gitEnv, 300_000, logPath);
				if (!fetched.ok) {
					return finish({
						...base,
						install: { ok: false, seconds: fetched.seconds, command: argv.join(" "), error: errorTail(fetched.output) },
					});
				}
			}
			const patch = join(options.projectDirectory, "changes.patch");
			if (existsSync(patch)) {
				const patched = await runCommand(["git", "apply", patch], checkout, gitEnv, 30_000, logPath);
				if (!patched.ok) throw new Error(`${patch} does not apply: ${patched.output}`);
			}
		}
		await rm(join(checkout, ".open-orange"), { force: true, recursive: true });

		let install: PhaseResult | null = null;
		if (project.local !== true || project.install !== "") {
			options.log(`${project.id}: install`);
			const installed = await runCommand(
				words(project.install),
				join(checkout, project.installDirectory),
				env,
				installTimeoutMs,
				logPath,
			);
			install = {
				ok: installed.ok,
				seconds: installed.seconds,
				command: project.install,
				...(installed.ok ? {} : { error: errorTail(installed.output) }),
			};
			if (!installed.ok) return finish({ ...base, install });
		}

		let build: PhaseResult | null = null;
		let buildSeconds = 0;
		for (const command of project.build ?? []) {
			options.log(`${project.id}: build: ${command}`);
			const built = await runCommand(words(command), workerDirectory, env, buildTimeoutMs, logPath);
			buildSeconds += built.seconds;
			build = {
				ok: built.ok,
				seconds: buildSeconds,
				command: project.build?.join(" && ") ?? command,
				...(built.ok ? {} : { error: errorTail(built.output) }),
			};
			if (!built.ok) return finish({ ...base, install, build });
		}

		if (project.devVars !== undefined) {
			// Orange reads .dev.vars next to the configuration, as Wrangler does.
			await writeFile(
				join(workerDirectory, project.configs[0]!, "..", ".dev.vars"),
				Object.entries(project.devVars)
					.map(([key, value]) => `${key}=${JSON.stringify(value)}`)
					.join("\n"),
			);
		}
		for (const binding of project.d1Migrations ?? []) {
			const migrated = await runCommand(
				[
					process.execPath,
					"--import",
					"tsx",
					join(options.orangeRoot, "src", "bin.ts"),
					"d1",
					"migrations",
					"apply",
					binding,
					"--local",
					"--config",
					join(workerDirectory, project.configs[0]!),
				],
				options.orangeRoot,
				env,
				180_000,
				logPath,
			);
			if (!migrated.ok) {
				return finish({
					...base,
					install,
					build,
					boot: {
						ok: false,
						seconds: migrated.seconds,
						command: `orange d1 migrations apply ${binding}`,
						error: errorTail(migrated.output),
					},
				});
			}
		}

		options.log(`${project.id}: orange dev`);
		const bootStarted = Date.now();
		const started = await startOrange(options, workerDirectory, env, logPath);
		const bootSeconds = Math.round((Date.now() - bootStarted) / 1000);
		if ("error" in started) {
			return finish({ ...base, install, build, boot: { ok: false, seconds: bootSeconds, error: started.error } });
		}
		let current = started;
		const steps: StepResult[] = [];
		try {
			await options.scenario(contextFor(options, workerDirectory, env, logPath, steps, () => current, (next) => (current = next)));
		} catch (error) {
			steps.push({
				name: "scenario stopped",
				kind: "http",
				status: "fail",
				seconds: 0,
				error: errorText(error),
			});
		} finally {
			await stopOrange(current.child);
		}
		return finish({
			...base,
			install,
			build,
			boot: { ok: true, seconds: bootSeconds },
			steps,
		});
	} finally {
		// The Engine outlives `orange dev`, and it may run under any Worker's storage.
		for (const directory of engineDirectories) {
			await stopEngines(directory);
			liveDirectories.delete(directory);
		}
		await rm(join(workerDirectory, ".open-orange"), { force: true, recursive: true });
		if (!options.keep) await removeTree(join(root, "repo"));
		await removeTree(home);
	}
}

// True when actors have run and none of them runs now. Under the `emulated` gate, an actor whose
// object Orange dropped while its sockets stay open (a soft hibernation) counts as asleep until it
// wakes, although the Rivet actor still runs.
function everyActorAsleep(output: string, gate: SleepGate): boolean {
	const asleep = new Map<string, boolean>();
	const pattern = /actor lifecycle transition" actor_id=(\S+) old=\S+ new=(\S+)|soft hibernation actor_id=(\S+) event=(\S+)/g;
	for (const match of output.matchAll(pattern)) {
		if (match[1] !== undefined) asleep.set(match[1], match[2] === "Terminated");
		else if (gate === "emulated") asleep.set(match[3]!, match[4] === "hibernated");
	}
	return asleep.size > 0 && [...asleep.values()].every(Boolean);
}

// Results are published, so a machine's path never goes in one.
function withoutMachinePaths(text: string, options: RunProjectOptions): string {
	return text.replaceAll(options.scratch, "<scratch>").replaceAll(options.orangeRoot, "<orange>");
}

function errorText(error: unknown): string {
	const text = error instanceof Error
		? error.cause instanceof Error
			? `${error.message}: ${error.cause.message}`
			: error.message
		: String(error);
	return text.length <= 600 ? text : `${text.slice(0, 600)}…`;
}

function contextFor(
	options: RunProjectOptions,
	workerDirectory: string,
	env: NodeJS.ProcessEnv,
	logPath: string,
	steps: StepResult[],
	current: () => OrangeProcess,
	replace: (next: OrangeProcess) => void,
): ScenarioContext {
	const origin = () => `http://127.0.0.1:${current().port}`;
	const openedInStep = new Set<TestSocket>();
	const request = (path: string, init?: RequestInit) =>
		fetch(`${origin()}${path}`, {
			redirect: "manual",
			signal: AbortSignal.timeout(30_000),
			...init,
		});
	const expectStatus = async (response: Response, status: number): Promise<string> => {
		const body = await response.text();
		if (response.status !== status) {
			throw new Error(`Expected HTTP ${status}, got ${response.status}: ${body.slice(0, 400)}`);
		}
		return body;
	};
	const stopAndStart = async (stop: () => Promise<void>): Promise<void> => {
		await stop();
		for (const directory of [workerDirectory, ...options.project.configs.map((config) => join(workerDirectory, config, ".."))]) {
			await stopEngines(directory);
		}
		const restarted = await startOrange(options, workerDirectory, env, logPath);
		if ("error" in restarted) throw new Error(`orange dev did not restart: ${restarted.error}`);
		replace(restarted);
	};
	const context: ScenarioContext = {
		actorIds: () => [
			...new Set(
				[...current().output().matchAll(/actor lifecycle transition" actor_id=(\S+) old=\S+ new=Started/g)].map(
					(match) => match[1]!,
				),
			),
		],
		get origin() {
			return origin();
		},
		directory: workerDirectory,
		async step(name: string, kind: StepKind, body: () => Promise<void>) {
			const started = Date.now();
			options.log(`${options.project.id}: step: ${name}`);
			const seconds = () => Math.round((Date.now() - started) / 100) / 10;
			openedInStep.clear();
			try {
				await body();
				steps.push({ name, kind, status: "pass", seconds: seconds() });
			} catch (error) {
				// A step that throws never reaches its own close. Its open sockets would keep the object awake and fail later steps for the wrong reason.
				await Promise.all([...openedInStep].map((socket) => socket.close()));
				steps.push({ name, kind, status: "fail", seconds: seconds(), error: withoutMachinePaths(errorText(error), options) });
			}
		},
		needsSecrets(name, kind, secrets) {
			steps.push({ name, kind, status: "needs-secrets", seconds: 0, secrets: [...secrets] });
		},
		fetch: request,
		async json(path, init, status = 200) {
			return JSON.parse(await expectStatus(await request(path, init), status));
		},
		async text(path, init, status = 200) {
			return await expectStatus(await request(path, init), status);
		},
		async webSocket(path, socketOptions) {
			const socket = await openTestSocket(`${origin()}${path}`, socketOptions);
			openedInStep.add(socket);
			return socket;
		},
		async waitForSleep(timeoutMs = 45_000) {
			// wrangler dev does not log evictions, so the baseline only waits past the idle window.
			if (options.baseline) {
				await delay(11_000);
				return;
			}
			const deadline = Date.now() + timeoutMs;
			while (Date.now() < deadline) {
				// Internal actors sleep too, so one actor's sleep says nothing about the object under test.
				if (everyActorAsleep(current().output(), options.sleepGate ?? "strict")) return;
				await delay(100);
			}
			throw new Error(`Some actor was still awake ${timeoutMs}ms after the last client activity`);
		},
		restart: async () => await stopAndStart(() => stopOrange(current().child)),
		crash: async () =>
			await stopAndStart(async () => {
				const { child } = current();
				if (child.pid === undefined) return;
				const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
				process.kill(-child.pid, "SIGKILL");
				await exited;
			}),
		delay: (milliseconds) => delay(milliseconds).then(() => undefined),
		output: () => current().output(),
	};
	return context;
}
