import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import {
	mkdir,
	mkdtemp,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

import { PINNED_RIVETKIT_VERSION } from "../packages/runtime-node/src/internal/rivetkit-build.js";
import { isRecord, stopProjectEngines, waitFor } from "../tests/orange-dev.js";

const execFileAsync = promisify(execFile);
const repositoryRoot = new URL("../", import.meta.url).pathname;

function packedFilename(value: unknown): string {
	if (!Array.isArray(value) || value.length !== 1) {
		throw new Error("npm pack returned an invalid manifest");
	}
	const entry: unknown = value[0];
	if (
		typeof entry !== "object" ||
		entry === null ||
		!("filename" in entry) ||
		typeof entry.filename !== "string"
	) {
		throw new Error("npm pack did not report a tarball filename");
	}
	return entry.filename;
}

// `npm pack --json` prints the manifest after any output of the prepack script, which is
// absent when that script prints nothing.
function packManifest(output: string): unknown {
	const afterNewline = output.lastIndexOf("\n[");
	const manifestStart =
		afterNewline !== -1 ? afterNewline + 1 : output.startsWith("[") ? 0 : -1;
	if (manifestStart === -1) {
		throw new Error(`npm pack did not emit a JSON manifest: ${output.slice(-500)}`);
	}
	return JSON.parse(output.slice(manifestStart));
}

function dependencyVersion(manifest: string, name: string): string | undefined {
	const parsed: unknown = JSON.parse(manifest);
	if (typeof parsed !== "object" || parsed === null) {
		return undefined;
	}
	const dependencies = Reflect.get(parsed, "dependencies");
	if (typeof dependencies !== "object" || dependencies === null) {
		return undefined;
	}
	const version: unknown = Reflect.get(dependencies, name);
	return typeof version === "string" ? version : undefined;
}

interface PackedDevReadiness {
	output(): string;
	port: number;
}

interface RunningPackedDev {
	origin: string;
	output(): string;
	stop(): Promise<void>;
}

type SocketListener = (...parameters: unknown[]) => void;

interface ClientWebSocket {
	close(code?: number, reason?: string): void;
	off(type: string, listener: SocketListener): void;
	on(type: string, listener: SocketListener): void;
	once(type: string, listener: SocketListener): void;
	send(data: string | ArrayBuffer | ArrayBufferView): void;
}

function waitForReady(child: ChildProcess): Promise<PackedDevReadiness> {
	const stdoutStream = child.stdout;
	const stderrStream = child.stderr;
	if (stdoutStream === null || stderrStream === null) {
		return Promise.reject(new Error("Packed CLI process has no output pipes"));
	}
	return new Promise((resolveReady, rejectReady) => {
		let output = "";
		const timeout = setTimeout(() => {
			rejectReady(new Error(`Packed CLI readiness timed out: ${output}`));
		}, 15_000);
		stdoutStream.on("data", (rawChunk: unknown) => {
			output += rawChunk instanceof Uint8Array
				? Buffer.from(rawChunk).toString()
				: String(rawChunk);
			const match = /Local\s+http:\/\/127\.0\.0\.1:(\d+)/.exec(output);
			if (match?.[1] !== undefined) {
				clearTimeout(timeout);
				resolveReady({
					output: () => output,
					port: Number(match[1]),
				});
			}
		});
		stderrStream.on("data", (rawChunk: unknown) => {
			output += rawChunk instanceof Uint8Array
				? Buffer.from(rawChunk).toString()
				: String(rawChunk);
		});
		child.once("exit", (code, signal) => {
			clearTimeout(timeout);
			rejectReady(
				new Error(
					`Packed CLI exited before readiness (code ${code ?? "none"}, signal ${signal ?? "none"}): ${output}`,
				),
			);
		});
	});
}

function waitForExit(child: ChildProcess): Promise<number | null> {
	if (child.exitCode !== null) return Promise.resolve(child.exitCode);
	return new Promise((resolveExit, rejectExit) => {
		const timeout = setTimeout(() => {
			child.kill("SIGKILL");
			rejectExit(new Error("Packed CLI did not stop after SIGINT"));
		}, 10_000);
		child.once("exit", (code) => {
			clearTimeout(timeout);
			resolveExit(code);
		});
	});
}

async function startPackedDev(
	binaryPath: string,
	configPath: string,
): Promise<RunningPackedDev> {
	const child = spawn(
		binaryPath,
		[
			"dev",
			"--config",
			configPath,
			"--port",
			"0",
			"--ip",
			"0.0.0.0",
			"--host",
			"0.0.0.0",
			"--show-interactive-dev-session=false",
		],
		{
			env: { ...process.env, CI: "1", NO_COLOR: "1" },
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	let readiness: PackedDevReadiness;
	try {
		readiness = await waitForReady(child);
	} catch (error: unknown) {
		child.kill("SIGKILL");
		throw error;
	}
	let stopped = false;
	return {
		origin: `http://127.0.0.1:${readiness.port}`,
		output: readiness.output,
		async stop(): Promise<void> {
			if (stopped) return;
			stopped = true;
			try {
				const exit = waitForExit(child);
				child.kill("SIGINT");
				assert.equal(await exit, 0, readiness.output());
			} finally {
				if (child.exitCode === null && child.signalCode === null) {
					child.kill("SIGKILL");
				}
			}
		},
	};
}

async function runPackedDev(binaryPath: string, configPath: string): Promise<void> {
	const runtime = await startPackedDev(binaryPath, configPath);
	try {
		const response = await fetch(`${runtime.origin}/packed`);
		assert.equal(response.status, 200, runtime.output());
		assert.equal(await response.text(), "packed-runtime");
	} finally {
		await runtime.stop();
	}
}

function installedWebSocketConstructor(installDirectory: string): Function {
	const packageValue: unknown = createRequire(
		join(installDirectory, "package.json"),
	)("ws");
	if (typeof packageValue === "function") return packageValue;
	if (isRecord(packageValue) && typeof packageValue.default === "function") {
		return packageValue.default;
	}
	throw new Error("The installed ws package has no client constructor");
}

function createClientWebSocket(
	installDirectory: string,
	url: string,
): ClientWebSocket {
	const value: unknown = Reflect.construct(
		installedWebSocketConstructor(installDirectory),
		[url],
	);
	if (
		!isRecord(value) ||
		typeof value.close !== "function" ||
		typeof value.off !== "function" ||
		typeof value.on !== "function" ||
		typeof value.once !== "function" ||
		typeof value.send !== "function"
	) {
		throw new Error("The installed ws package returned an invalid client");
	}
	value.binaryType = "arraybuffer";
	const { close, off, on, once, send } = value;
	return {
		close: (code, reason) => Reflect.apply(close, value, [code, reason]),
		off: (type, listener) => Reflect.apply(off, value, [type, listener]),
		on: (type, listener) => Reflect.apply(on, value, [type, listener]),
		once: (type, listener) => Reflect.apply(once, value, [type, listener]),
		send: (data) => Reflect.apply(send, value, [data]),
	};
}

function once(socket: ClientWebSocket, type: string): Promise<unknown[]> {
	return new Promise((resolveEvent) => {
		socket.once(type, (...parameters) => resolveEvent(parameters));
	});
}

const socketEventDeadlineMs = 30_000;

// Fails the test when a WebSocket event the test waits for never arrives, instead of
// leaving it to hang until the runner's timeout.
async function socketEvent(
	socket: ClientWebSocket,
	type: string,
): Promise<unknown[]> {
	let timeout: NodeJS.Timeout | undefined;
	try {
		return await Promise.race([
			once(socket, type),
			new Promise<never>((_, rejectDeadline) => {
				timeout = setTimeout(
					() =>
						rejectDeadline(
							new Error(
								`Packed WebSocket got no ${type} event within ${socketEventDeadlineMs} ms`,
							),
						),
					socketEventDeadlineMs,
				);
			}),
		]);
	} finally {
		clearTimeout(timeout);
	}
}

function textMessage(value: unknown): string {
	if (typeof value === "string") return value;
	if (value instanceof ArrayBuffer) {
		return new TextDecoder().decode(value);
	}
	if (ArrayBuffer.isView(value)) {
		return new TextDecoder().decode(
			new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
		);
	}
	throw new TypeError("Packed WebSocket returned a non-text message");
}

async function openClientWebSocket(
	installDirectory: string,
	origin: string,
	path: string,
): Promise<ClientWebSocket> {
	const socket = createClientWebSocket(
		installDirectory,
		`${origin.replace("http:", "ws:")}${path}`,
	);
	await Promise.race([
		socketEvent(socket, "open"),
		once(socket, "error").then((parameters) =>
			Promise.reject(
				parameters[0] ?? new Error("Packed WebSocket connection failed"),
			),
		),
	]);
	return socket;
}

async function closeClientWebSocket(socket: ClientWebSocket): Promise<void> {
	const closed = socketEvent(socket, "close");
	socket.close(1000, "done");
	await closed;
}

async function readJson(origin: string, path: string): Promise<unknown> {
	const response = await fetch(`${origin}${path}`, {
		signal: AbortSignal.timeout(5_000),
	});
	const body = await response.text();
	assert.equal(response.status, 200, body);
	const value: unknown = JSON.parse(body);
	return value;
}

async function waitForAlarm(origin: string): Promise<void> {
	await waitFor(
		"the packed Durable Object alarm to fire",
		async () => {
			const status = await readJson(origin, "/alarm-status");
			return isRecord(status) && status.fired === true;
		},
		10_000,
	);
}

test("installs both packed CLI aliases and runs Durable Object smoke tests", async () => {
	const directory = await mkdtemp(join(tmpdir(), "open-orange-package-"));
	const packDirectory = join(directory, "pack");
	const installDirectory = join(directory, "install");
	const projectDirectory = join(directory, "project");
	try {
		await mkdir(projectDirectory, { recursive: true });
		await writeFile(
			join(projectDirectory, "worker.ts"),
			`import { DurableObject } from "cloudflare:workers";

export class PackedObject extends DurableObject {
  static generations = 0;

  constructor(ctx, env) {
    super(ctx, env);
    this.generation = ++PackedObject.generations;
  }

  async increment(amount) {
    const count = (this.ctx.storage.kv.get("count") ?? 0) + amount;
    this.ctx.storage.kv.put("count", count);
    return { count, generation: this.generation };
  }

  sqlite(value) {
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS packed_values (id INTEGER PRIMARY KEY, value INTEGER NOT NULL)");
    if (value !== null) {
      this.ctx.storage.sql.exec("INSERT INTO packed_values (id, value) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET value = excluded.value", value);
    }
    return this.ctx.storage.sql.exec("SELECT value FROM packed_values WHERE id = 1").toArray()[0]?.value ?? null;
  }

  async scheduleAlarm() {
    await this.ctx.storage.put("alarm-fired", false);
    await this.ctx.storage.setAlarm(Date.now() + 50);
  }

  async alarmStatus() {
    return (await this.ctx.storage.get("alarm-fired")) === true;
  }

  async alarm() {
    await this.ctx.storage.put("alarm-fired", true);
  }

  fetch(request) {
    const mode = new URL(request.url).pathname.slice(1);
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    if (mode === "standard") {
      server.accept();
      server.addEventListener("message", (event) => server.send(JSON.stringify({ generation: this.generation, message: event.data, mode })));
    } else {
      this.ctx.acceptWebSocket(server);
      server.serializeAttachment({ mode });
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(socket, message) {
    const attachment = socket.deserializeAttachment();
    socket.send(JSON.stringify({ generation: this.generation, message, mode: attachment.mode }));
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/packed") return new Response("packed-runtime");
    const stub = env.PACKED_OBJECT.getByName("singleton");
    if (url.pathname === "/rpc") return Response.json(await stub.increment(Number(url.searchParams.get("amount") ?? "1")));
    if (url.pathname === "/sqlite") {
      const rawValue = url.searchParams.get("value");
      return Response.json({ value: await stub.sqlite(rawValue === null ? null : Number(rawValue)) });
    }
    if (url.pathname === "/alarm") {
      await stub.scheduleAlarm();
      return Response.json({ scheduled: true });
    }
    if (url.pathname === "/alarm-status") return Response.json({ fired: await stub.alarmStatus() });
    if (url.pathname === "/standard" || url.pathname === "/hibernatable") return stub.fetch(request);
    return new Response("not found", { status: 404 });
  },
};
`,
			"utf8",
		);
		const configPath = join(projectDirectory, "wrangler.jsonc");
		await writeFile(
			configPath,
			JSON.stringify(
				{
					compatibility_date: "2026-09-03",
					compatibility_flags: [],
					durable_objects: {
						bindings: [{ class_name: "PackedObject", name: "PACKED_OBJECT" }],
					},
					main: "./worker.ts",
					migrations: [
						{ new_sqlite_classes: ["PackedObject"], tag: "v1" },
					],
					name: "packed-open-orange",
				},
				null,
				2,
			),
			"utf8",
		);
		await mkdir(installDirectory, { recursive: true });
		await writeFile(
			join(installDirectory, "package.json"),
			'{"name":"open-orange-install-test","private":true}',
			"utf8",
		);
		await mkdir(packDirectory, { recursive: true });
		const { stdout: packOutput } = await execFileAsync(
			process.platform === "win32" ? "npm.cmd" : "npm",
			["pack", "--json", "--silent", "--pack-destination", packDirectory],
			{ cwd: repositoryRoot, maxBuffer: 4 * 1024 * 1024 },
		);
		const tarballPath = join(
			packDirectory,
			packedFilename(packManifest(packOutput)),
		);
		await execFileAsync(
			process.platform === "win32" ? "npm.cmd" : "npm",
			[
				"install",
				"--no-audit",
				"--no-fund",
				"--save-exact",
				tarballPath,
			],
			{ cwd: installDirectory, maxBuffer: 4 * 1024 * 1024 },
		);
		const packageManifest = await readFile(
			join(installDirectory, "node_modules/open-orange/package.json"),
			"utf8",
		);
		assert.doesNotMatch(packageManifest, /"@open-orange\/runtime-node"\s*:/);
		assert.equal(
			dependencyVersion(packageManifest, "rivetkit"),
			PINNED_RIVETKIT_VERSION,
		);

		const binaryPath = (name: string): string =>
			join(
				installDirectory,
				"node_modules/.bin",
				process.platform === "win32" ? `${name}.cmd` : name,
			);

		let runtime: RunningPackedDev | undefined;
		try {
			runtime = await startPackedDev(binaryPath("orange"), configPath);
			assert.deepEqual(await readJson(runtime.origin, "/rpc?amount=1"), {
				count: 1,
				generation: 1,
			});
			assert.deepEqual(await readJson(runtime.origin, "/sqlite?value=7"), {
				value: 7,
			});
			assert.deepEqual(await readJson(runtime.origin, "/alarm"), {
				scheduled: true,
			});
			await waitForAlarm(runtime.origin);

			const standard = await openClientWebSocket(
				installDirectory,
				runtime.origin,
				"/standard",
			);
			const standardMessage = socketEvent(standard, "message");
			standard.send("standard-message");
			assert.deepEqual(JSON.parse(textMessage((await standardMessage)[0])), {
				generation: 1,
				message: "standard-message",
				mode: "standard",
			});
			await closeClientWebSocket(standard);

			const hibernatable = await openClientWebSocket(
				installDirectory,
				runtime.origin,
				"/hibernatable",
			);
			const beforeSleep = socketEvent(hibernatable, "message");
			hibernatable.send("before-sleep");
			const firstGeneration: unknown = JSON.parse(
				textMessage((await beforeSleep)[0]),
			);
			assert.ok(isRecord(firstGeneration));
			assert.equal(firstGeneration.mode, "hibernatable");
			assert.equal(firstGeneration.message, "before-sleep");
			assert.equal(typeof firstGeneration.generation, "number");
			// Stay idle past the 10-second hibernation timeout; a message before then restarts it.
			await delay(11_000);
			const afterSleep = socketEvent(hibernatable, "message");
			hibernatable.send("after-sleep");
			const nextGeneration: unknown = JSON.parse(
				textMessage((await afterSleep)[0]),
			);
			assert.ok(isRecord(nextGeneration));
			assert.equal(nextGeneration.mode, "hibernatable");
			assert.equal(nextGeneration.message, "after-sleep");
			assert.equal(typeof nextGeneration.generation, "number");
			assert.ok(
				Number(nextGeneration.generation) > Number(firstGeneration.generation),
				`Packed hibernatable socket did not wake a new generation: ${runtime.output()}`,
			);
			await closeClientWebSocket(hibernatable);

			await runtime.stop();
			runtime = await startPackedDev(binaryPath("orange"), configPath);
			const restarted = await readJson(runtime.origin, "/rpc?amount=2");
			assert.ok(isRecord(restarted));
			assert.equal(restarted.count, 3);
			assert.deepEqual(await readJson(runtime.origin, "/sqlite"), { value: 7 });
			await waitForAlarm(runtime.origin);
		} finally {
			await runtime?.stop();
		}

		await runPackedDev(binaryPath("open-orange"), configPath);
	} finally {
		await stopProjectEngines(projectDirectory);
		await rm(directory, { force: true, recursive: true });
	}
});
