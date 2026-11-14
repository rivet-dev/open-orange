import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { cp, glob, mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

export const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const cliEntrypoint = join(repositoryRoot, "src", "bin.ts");

type SocketListener = (...parameters: unknown[]) => void;

export interface ClientWebSocket {
	terminate(): void;
	binaryType: string;
	readonly readyState: number;
	close(code?: number, reason?: string): void;
	off(type: string, listener: SocketListener): void;
	on(type: string, listener: SocketListener): void;
	once(type: string, listener: SocketListener): void;
	send(data: string | ArrayBuffer | ArrayBufferView): void;
}

export interface RunningOrangeDev {
	/**
	 * Resolves when the actor finishes a sleep that starts after this call. It needs
	 * `startOrangeDev(..., { actorLifecycleLogs: true })`.
	 */
	actorSlept(actorId: string): Promise<void>;
	close(): Promise<void>;
	/** Kills orange dev and its runtime with SIGKILL, as a crash would. The Rivet Engine keeps running. */
	kill(): Promise<void>;
	// Resolves with the exit code once orange dev exits on its own or after close().
	exited: Promise<number | null>;
	origin: string;
	output(): string;
	pid: number;
	/**
	 * The runtime's JavaScript heap in bytes after a full collection. It needs
	 * `startOrangeDev(..., { environment: { NODE_OPTIONS: "--inspect-port=0" } })`.
	 */
	runtimeHeapUsed(): Promise<number>;
}

export interface TemporaryProject {
	// The copied project. Orange writes its local state here, never into the
	// repository.
	directory: string;
	dispose(): Promise<void>;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function processIsAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return isRecord(error) && error.code === "EPERM";
	}
}

/** Stops the Rivet Engine whose PID is in the given engine `runtime.json`, if it is still alive. */
export async function stopEngineFromRuntimeFile(runtimeFile: string): Promise<void> {
	let value: unknown;
	try {
		value = JSON.parse(await readFile(runtimeFile, "utf8"));
	} catch {
		return;
	}
	if (!isRecord(value) || typeof value.pid !== "number" || value.pid <= 0) return;
	const pid = value.pid;
	if (!processIsAlive(pid)) return;
	process.kill(pid, "SIGTERM");
	// The Engine needs about 6 seconds to stop. A SIGKILL before then makes the next Engine
	// on the same data wait out the storage lease.
	const deadline = Date.now() + 15_000;
	while (processIsAlive(pid) && Date.now() < deadline) await delay(25);
	if (processIsAlive(pid)) process.kill(pid, "SIGKILL");
}

// orange dev leaves its Rivet Engine running for the next start, so tests stop
// it by the PID in the engine's runtime file.
// A multi-Worker session keeps it under its first Worker's directory.
export async function stopProjectEngines(projectDirectory: string): Promise<void> {
	for await (const path of glob(
		"**/.open-orange/rivetkit/*/.rivetkit/var/engine/runtime.json",
		{ cwd: projectDirectory },
	)) {
		await stopEngineFromRuntimeFile(join(projectDirectory, path));
	}
}

const copyExcludedNames = new Set([".open-orange", ".wrangler", "node_modules"]);

export async function copyProject(sourceDirectory: string): Promise<TemporaryProject> {
	const temporaryDirectory = await mkdtemp(join(tmpdir(), "open-orange-example-"));
	const directory = join(temporaryDirectory, "project");
	await cp(sourceDirectory, directory, {
		// node_modules holds workspace symlinks that would point nowhere in the
		// copy. .open-orange and .wrangler hold the example's local state, whose
		// runtime file names the example's own engine. A copy of it would reuse
		// that engine and its data, and dispose() would stop it.
		filter: (source) => !copyExcludedNames.has(basename(source)),
		recursive: true,
	});
	return {
		directory,
		async dispose(): Promise<void> {
			try {
				await stopProjectEngines(directory);
			} finally {
				await rm(temporaryDirectory, { force: true, recursive: true });
			}
		},
	};
}

// A packaged CLI, run by a JavaScript runtime other than the one running the tests.
export interface OrangeCli {
	entrypoint: string;
	runtime: string;
}

function spawnOrange(
	args: readonly string[],
	environment: NodeJS.ProcessEnv = {},
	cli?: OrangeCli,
): ChildProcess {
	const [command, prefix] =
		cli === undefined
			? [process.execPath, ["--import", "tsx", cliEntrypoint]]
			: [cli.runtime, [cli.entrypoint]];
	return spawn(command, [...prefix, ...args], {
		cwd: repositoryRoot,
		env: { ...process.env, ...environment, CI: "1", NO_COLOR: "1" },
		stdio: ["ignore", "pipe", "pipe"],
	});
}

function waitForExit(child: ChildProcess, label: string): Promise<number | null> {
	if (child.exitCode !== null) return Promise.resolve(child.exitCode);
	return new Promise((resolveExit, rejectExit) => {
		const timeout = setTimeout(() => {
			child.kill("SIGKILL");
			rejectExit(new Error(`${label} did not stop within 10 seconds`));
		}, 10_000);
		child.once("exit", (code) => {
			clearTimeout(timeout);
			resolveExit(code);
		});
	});
}

function collectOutput(child: ChildProcess, onOutput: (output: string) => void): () => string {
	let output = "";
	const collect = (chunk: unknown): void => {
		output += chunk instanceof Uint8Array
			? Buffer.from(chunk).toString()
			: String(chunk);
		onOutput(output);
	};
	child.stdout?.on("data", collect);
	child.stderr?.on("data", collect);
	return () => output;
}

// Runs a short-lived Orange command, such as `d1 migrations apply`, to completion.
export async function runOrange(
	projectDirectory: string,
	args: readonly string[],
	configFile = "wrangler.jsonc",
	options: { deadlineMs?: number; environment?: NodeJS.ProcessEnv } = {},
): Promise<{ code: number | null; output: string }> {
	const child = spawnOrange([...args, "--config", join(projectDirectory, configFile)], options.environment);
	const output = collectOutput(child, () => {});
	const exited = new Promise<number | null>((resolveExit) => {
		child.once("exit", (code) => resolveExit(code));
	});
	try {
		const code = await withDeadline(exited, `orange ${args.join(" ")}`, options.deadlineMs ?? 60_000);
		return { code, output: output() };
	} finally {
		// A command that misses its deadline would otherwise keep the test process alive.
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
	}
}

export interface StartOrangeDevOptions {
	// Prints RivetKit's info logs, which include each actor lifecycle transition.
	actorLifecycleLogs?: boolean;
	cli?: OrangeCli;
	environment?: NodeJS.ProcessEnv;
}

// More than one config starts a multi-Worker session. The first Worker serves the port.
export async function startOrangeDev(
	projectDirectory: string,
	configFile: string | readonly string[] = "wrangler.jsonc",
	options: StartOrangeDevOptions = {},
): Promise<RunningOrangeDev> {
	const configFiles = typeof configFile === "string" ? [configFile] : configFile;
	const child = spawnOrange(
		[
			"dev",
			...configFiles.flatMap((file) => ["--config", join(projectDirectory, file)]),
			"--port",
			"0",
			"--ip",
			"0.0.0.0",
			"--host",
			"0.0.0.0",
			"--show-interactive-dev-session=false",
		],
		{
			...options.environment,
			...(options.actorLifecycleLogs === true ? { RIVET_LOG_LEVEL: "info" } : {}),
		},
		options.cli,
	);
	const exited = new Promise<number | null>((resolveExit) => {
		child.once("exit", (code) => resolveExit(code));
	});
	const readiness = Promise.withResolvers<number>();
	const outputWaiters = new Set<() => void>();
	const output = collectOutput(child, (current) => {
		const match = /Local\s+http:\/\/127\.0\.0\.1:(\d+)/.exec(current);
		if (match?.[1] !== undefined) readiness.resolve(Number(match[1]));
		for (const waiter of outputWaiters) waiter();
	});
	const timeout = setTimeout(() => {
		readiness.reject(new Error(`orange dev readiness timed out:\n${output()}`));
	}, 30_000);
	child.once("exit", (code, signal) => {
		readiness.reject(
			new Error(
				`orange dev exited before readiness (code ${code ?? "none"}, signal ${signal ?? "none"}):\n${output()}`,
			),
		);
	});

	let port: number;
	try {
		port = await readiness.promise;
	} catch (error) {
		child.kill("SIGKILL");
		throw error;
	} finally {
		clearTimeout(timeout);
	}

	let closed = false;
	let inspector: Inspector | undefined;
	return {
		async actorSlept(actorId): Promise<void> {
			if (options.actorLifecycleLogs !== true) {
				throw new Error("actorSlept() needs startOrangeDev(..., { actorLifecycleLogs: true })");
			}
			// The v3 Engine API does not report when an actor sleeps, so this waits for RivetKit's
			// own log of the actor's last sleep transition.
			const slept = `actor lifecycle transition" actor_id=${actorId} old=SleepFinalize new=Terminated`;
			const from = output().length;
			let waiter: (() => void) | undefined;
			try {
				await withDeadline(
					new Promise<void>((resolveSlept) => {
						waiter = () => {
							if (output().includes(slept, from)) resolveSlept();
						};
						outputWaiters.add(waiter);
						waiter();
					}),
					`actor ${actorId} sleep`,
					30_000,
				);
			} finally {
				if (waiter !== undefined) outputWaiters.delete(waiter);
			}
		},
		async close(): Promise<void> {
			if (closed) return;
			closed = true;
			// A Node.js process waits at exit for its inspector client to disconnect.
			inspector?.close();
			try {
				const exit = waitForExit(child, "orange dev");
				child.kill("SIGINT");
				assert.equal(await exit, 0, output());
			} finally {
				if (child.exitCode === null && child.signalCode === null) {
					child.kill("SIGKILL");
				}
			}
		},
		exited,
		async kill(): Promise<void> {
			if (closed) return;
			closed = true;
			inspector?.close();
			const pids = child.pid === undefined ? [] : [child.pid, ...descendantPids(child.pid)];
			for (const pid of pids) {
				try {
					process.kill(pid, "SIGKILL");
				} catch {
					// It already exited.
				}
			}
			await exited;
		},
		origin: `http://127.0.0.1:${port}`,
		output,
		pid: child.pid ?? 0,
		async runtimeHeapUsed(): Promise<number> {
			const runtime = (child.pid === undefined ? [] : descendantPids(child.pid)).find(isOrangeRuntime);
			assert.ok(runtime !== undefined, "orange dev has no runtime process");
			inspector ??= await openInspector(runtime, output);
			await inspector.call("HeapProfiler.collectGarbage");
			await inspector.call("HeapProfiler.collectGarbage");
			const usage = await inspector.call("Runtime.evaluate", {
				expression: "process.memoryUsage().heapUsed",
				returnByValue: true,
			});
			const value = isRecord(usage) && isRecord(usage.result) ? usage.result.value : undefined;
			assert.ok(typeof value === "number", "the runtime did not report its heap");
			return value;
		},
	};
}

interface Inspector {
	call(method: string, parameters?: Record<string, unknown>): Promise<unknown>;
	close(): void;
}

function isOrangeRuntime(pid: number): boolean {
	try {
		return /runtime-node\S*runner\.(ts|js)/.test(execFileSync("ps", ["-o", "args=", "-p", String(pid)], { encoding: "utf8" }));
	} catch {
		// The process already exited.
		return false;
	}
}

// SIGUSR1 makes a running Node.js process listen for an inspector. With `--inspect-port=0` it
// picks a free port and prints the address.
async function openInspector(pid: number, output: () => string): Promise<Inspector> {
	const from = output().length;
	process.kill(pid, "SIGUSR1");
	const inspectorAddress = (): string | undefined => /Debugger listening on (ws:\/\/\S+)/.exec(output().slice(from))?.[1];
	await waitFor("the runtime to open an inspector", () => inspectorAddress() !== undefined, 10_000);
	const address = inspectorAddress()!;
	const socket = new WebSocket(address);
	await withDeadline(
		new Promise((resolveOpen, rejectOpen) => {
			socket.addEventListener("open", resolveOpen, { once: true });
			socket.addEventListener("error", () => rejectOpen(new Error("inspector connection failed")), { once: true });
		}),
		"inspector connection",
	);
	const calls = new Map<number, PromiseWithResolvers<unknown>>();
	socket.addEventListener("message", (event) => {
		const message: unknown = JSON.parse(String(event.data));
		if (!isRecord(message) || typeof message.id !== "number") return;
		const call = calls.get(message.id);
		calls.delete(message.id);
		if (message.error === undefined) call?.resolve(message.result);
		else call?.reject(new Error(`inspector call failed: ${JSON.stringify(message.error)}`));
	});
	let nextId = 1;
	return {
		call(method, parameters = {}) {
			const id = nextId++;
			const call = Promise.withResolvers<unknown>();
			calls.set(id, call);
			socket.send(JSON.stringify({ id, method, params: parameters }));
			return withDeadline(call.promise, `inspector ${method}`);
		},
		close: () => socket.close(),
	};
}

function commandOf(pid: number): string | undefined {
	try {
		return basename(execFileSync("ps", ["-o", "comm=", "-p", String(pid)], { encoding: "utf8" }).trim());
	} catch {
		// The process already exited.
		return undefined;
	}
}

/** The processes under `pid`, except the Rivet Engine and its children, with their command names. */
export function descendantProcesses(pid: number): { command: string; pid: number }[] {
	return descendantPids(pid).flatMap((child) => {
		const command = commandOf(child);
		return command === undefined ? [] : [{ command, pid: child }];
	});
}

function isRivetEngine(pid: number): boolean {
	try {
		return basename(execFileSync("ps", ["-o", "comm=", "-p", String(pid)], { encoding: "utf8" }).trim()) === "rivet-engine";
	} catch {
		// The process already exited.
		return false;
	}
}

// The Engine is a child of the runtime process, but a crash of `orange dev` does not take it
// down, so the Engine and its children are left out.
function descendantPids(pid: number): number[] {
	let output = "";
	try {
		output = execFileSync("pgrep", ["-P", String(pid)], { encoding: "utf8" });
	} catch {
		// pgrep exits 1 when the process has no children.
	}
	const children = output
		.split("\n")
		.filter((line) => line.length > 0)
		.map(Number)
		.filter((child) => !isRivetEngine(child));
	return children.flatMap((child) => [child, ...descendantPids(child)]);
}

export async function withDeadline<T>(
	promise: Promise<T>,
	label: string,
	milliseconds = 20_000,
): Promise<T> {
	let timer: NodeJS.Timeout | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_, rejectDeadline) => {
				timer = setTimeout(() => {
					rejectDeadline(new Error(`${label} timed out after ${milliseconds}ms`));
				}, milliseconds);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Polls `done` until it is true, and fails with `what` after `milliseconds`. Use it to wait for an
 * effect that has no event to await, in place of a fixed sleep that is too short on a loaded host.
 */
export async function waitFor(what: string, done: () => boolean | Promise<boolean>, milliseconds = 30_000): Promise<void> {
	const deadline = Date.now() + milliseconds;
	while (!(await done())) {
		if (Date.now() > deadline) throw new Error(`Timed out after ${milliseconds}ms waiting for ${what}`);
		await delay(50);
	}
}

function webSocketConstructor(): Function {
	const packageValue: unknown = createRequire(import.meta.url)("ws");
	if (typeof packageValue === "function") return packageValue;
	if (isRecord(packageValue) && typeof packageValue.default === "function") {
		return packageValue.default;
	}
	throw new Error("The ws package does not export a client constructor");
}

function isClientWebSocket(value: unknown): value is ClientWebSocket {
	return (
		isRecord(value) &&
		typeof value.close === "function" &&
		typeof value.off === "function" &&
		typeof value.on === "function" &&
		typeof value.once === "function" &&
		typeof value.send === "function"
	);
}

function once(socket: ClientWebSocket, type: string): Promise<unknown[]> {
	return new Promise((resolveEvent) => {
		socket.once(type, (...parameters) => resolveEvent(parameters));
	});
}

export async function openWebSocket(url: string): Promise<ClientWebSocket> {
	const socket: unknown = Reflect.construct(webSocketConstructor(), [
		url.replace(/^http/, "ws"),
	]);
	if (!isClientWebSocket(socket)) {
		throw new Error("The ws package returned an invalid client WebSocket");
	}
	socket.binaryType = "arraybuffer";
	inboxes.set(socket, new Inbox(socket));
	await withDeadline(
		Promise.race([
			once(socket, "open"),
			once(socket, "error").then((parameters) =>
				Promise.reject(parameters[0] ?? new Error("WebSocket open failed")),
			),
		]),
		"WebSocket open",
	);
	return socket;
}

export async function closeWebSocket(socket: ClientWebSocket): Promise<void> {
	// A socket that the server already closed fires no second close event.
	if (socket.readyState === 3) return;
	const closed = once(socket, "close");
	socket.close(1000, "test complete");
	await withDeadline(closed, "WebSocket close");
}

function messageText(value: unknown): string {
	if (typeof value === "string") return value;
	if (value instanceof ArrayBuffer) return new TextDecoder().decode(value);
	if (ArrayBuffer.isView(value)) {
		return new TextDecoder().decode(
			new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
		);
	}
	throw new TypeError("WebSocket returned an invalid message");
}

// Buffers every message from the moment the socket is created, so a message
// sent right after the upgrade is never missed.
class Inbox {
	#failure: Error | undefined;
	#messages: string[] = [];
	#notify: (() => void) | undefined;

	constructor(socket: ClientWebSocket) {
		socket.on("message", (data) => {
			try {
				this.#messages.push(messageText(data));
			} catch (error) {
				this.#failure = error instanceof Error ? error : new Error(String(error));
			}
			this.#notify?.();
		});
		socket.on("close", () => {
			this.#failure ??= new Error("WebSocket closed");
			this.#notify?.();
		});
		socket.on("error", (error) => {
			this.#failure = error instanceof Error ? error : new Error("WebSocket failed");
			this.#notify?.();
		});
	}

	async take(count: number): Promise<string[]> {
		while (this.#messages.length < count) {
			if (this.#failure !== undefined) {
				throw new Error(
					`${this.#failure.message} after ${this.#messages.length} of ${count} expected messages`,
				);
			}
			const wake = Promise.withResolvers<void>();
			this.#notify = wake.resolve;
			await wake.promise;
		}
		this.#notify = undefined;
		return this.#messages.splice(0, count);
	}
}

const inboxes = new WeakMap<ClientWebSocket, Inbox>();

// Resolves with the next `count` text messages the socket received.
export function collectMessages(
	socket: ClientWebSocket,
	count: number,
): Promise<string[]> {
	const inbox = inboxes.get(socket);
	if (inbox === undefined) {
		throw new Error("Open the WebSocket with openWebSocket()");
	}
	return inbox.take(count);
}

export async function assertResponse(
	response: Response,
	status: number,
	text: string,
	output: string,
): Promise<void> {
	assert.equal(response.status, status, output);
	assert.equal(await response.text(), text, output);
}
