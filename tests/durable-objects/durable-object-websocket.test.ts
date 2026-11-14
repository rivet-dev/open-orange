import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

import { readWorkerdMetadata } from "../../packages/cloudflare-conformance/src/runners/workerd.js";
import { bundleWorker } from "../../src/build/bundle-worker.js";
import { runtimeModuleRewrites } from "../../src/build/rewrite-module-imports.js";
import { spawnRuntime, type RuntimeProcess } from "../../src/runtime/spawn.js";
import { isRecord, stopEngineFromRuntimeFile } from "../harness/orange-dev.js";

const workerEntrypoint = new URL(
	"../fixtures/durable-object-websocket-worker.js",
	import.meta.url,
).pathname;
const workerdConfig = new URL(
	"../fixtures/durable-object-websocket-workerd.capnp",
	import.meta.url,
).pathname;

type SocketListener = (...parameters: unknown[]) => void;

interface ClientWebSocket {
	binaryType: string;
	readonly bufferedAmount: number;
	readonly protocol: string;
	close(code?: number, reason?: string): void;
	on(type: string, listener: SocketListener): void;
	once(type: string, listener: SocketListener): void;
	send(data: string | ArrayBuffer | ArrayBufferView): void;
	terminate(): void;
}

interface RuntimeEndpoint {
	close(): Promise<void>;
	origin: string;
}

interface ScenarioOutcome {
	abruptActorEvent: unknown;
	burst: {
		count: number;
		first: unknown;
		last: unknown;
	};
	close: { code: number; reason: string };
	handshake: { protocol: string; upgradeHeader: string | null };
	messages: { binary: unknown; text: unknown; terminal: unknown };
	rejection: { header: string | null; status: number; statusText: string };
	serverEvents: unknown;
}

function eventProperty(value: unknown, name: string): unknown {
	return typeof value === "object" && value !== null
		? Reflect.get(value, name)
		: undefined;
}

function isClientWebSocket(value: unknown): value is ClientWebSocket {
	return (
		isRecord(value) &&
		typeof value.close === "function" &&
		typeof value.on === "function" &&
		typeof value.once === "function" &&
		typeof value.send === "function" &&
		typeof value.terminate === "function"
	);
}

function webSocketConstructor(): Function {
	const packageValue: unknown = createRequire(import.meta.url)("ws");
	if (typeof packageValue === "function") return packageValue;
	if (isRecord(packageValue) && typeof packageValue.default === "function") {
		return packageValue.default;
	}
	throw new Error("The ws package does not export a client constructor");
}

function createClientWebSocket(url: string): ClientWebSocket {
	const value: unknown = Reflect.construct(webSocketConstructor(), [
		url,
		["orange.v1"],
		{ headers: { "x-client-id": new URL(url).searchParams.get("id") ?? "client" } },
	]);
	if (!isClientWebSocket(value)) {
		throw new Error("The ws package returned an invalid client WebSocket");
	}
	value.binaryType = "arraybuffer";
	return value;
}

function bytes(value: unknown): Uint8Array | undefined {
	if (value instanceof ArrayBuffer) return new Uint8Array(value);
	if (ArrayBuffer.isView(value)) {
		return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
	}
	return undefined;
}

function text(value: unknown): string {
	if (typeof value === "string") return value;
	const valueBytes = bytes(value);
	return valueBytes === undefined ? String(value) : new TextDecoder().decode(valueBytes);
}

function normalizedMessage(data: unknown, binary: unknown): string | number[] {
	if (binary !== true) return text(data);
	const valueBytes = bytes(data);
	if (valueBytes === undefined) {
		throw new TypeError("WebSocket fixture received invalid binary data");
	}
	return [...valueBytes];
}

function frameSummary(value: unknown): unknown {
	if (!Array.isArray(value) || !value.every((entry) => typeof entry === "number")) {
		return value;
	}
	return [value.length, value[0], value[value.length - 1]];
}

function once(socket: ClientWebSocket, type: string): Promise<unknown[]> {
	return new Promise((resolve) => socket.once(type, (...parameters) => resolve(parameters)));
}

function responseHeader(response: unknown, name: string): string | null {
	const headers = eventProperty(response, "headers");
	if (!isRecord(headers)) return null;
	const value = headers[name.toLowerCase()];
	if (typeof value === "string") return value;
	if (Array.isArray(value)) {
		return value.every((entry) => typeof entry === "string")
			? value.join(", ")
			: null;
	}
	return null;
}

async function rejectionOutcome(origin: string): Promise<ScenarioOutcome["rejection"]> {
	const socket = createClientWebSocket(`${origin.replace("http:", "ws:")}/reject?id=reject`);
	return await new Promise((resolve, reject) => {
		socket.once("unexpected-response", (_request, response) => {
			const status = eventProperty(response, "statusCode");
			const statusText = eventProperty(response, "statusMessage");
			const resume = eventProperty(response, "resume");
			if (typeof resume === "function") Reflect.apply(resume, response, []);
			if (typeof status !== "number" || typeof statusText !== "string") {
				reject(new Error("WebSocket rejection did not expose an HTTP status"));
				return;
			}
			resolve({
				header: responseHeader(response, "x-do-rejection"),
				status,
				statusText,
			});
		});
		socket.once("error", (error) => reject(error));
	});
}

async function openSocket(
	origin: string,
	id: string,
): Promise<{ socket: ClientWebSocket; upgradeHeader: string | null }> {
	const socket = createClientWebSocket(
		`${origin.replace("http:", "ws:")}/socket?id=${encodeURIComponent(id)}`,
	);
	const upgrade = once(socket, "upgrade");
	const opened = once(socket, "open");
	const error = once(socket, "error").then((parameters) =>
		Promise.reject(parameters[0] ?? new Error("WebSocket connection failed")),
	);
	await Promise.race([opened, error]);
	const [response] = await upgrade;
	return {
		socket,
		upgradeHeader: responseHeader(response, "x-do-upgrade"),
	};
}

function collectMessages(
	socket: ClientWebSocket,
	count: number,
): Promise<Array<string | number[]>> {
	return new Promise((resolve, reject) => {
		const messages: Array<string | number[]> = [];
		socket.on("message", (data, binary) => {
			try {
				messages.push(normalizedMessage(data, binary));
				if (messages.length === count) resolve(messages);
			} catch (error: unknown) {
				reject(error);
			}
		});
	});
}

async function readEvents(origin: string): Promise<unknown> {
	const response = await fetch(`${origin}/events`, {
		signal: AbortSignal.timeout(2_000),
	});
	if (!response.ok) throw new Error(`Event endpoint returned ${response.status}`);
	return await response.json();
}

async function waitForEvent(
	origin: string,
	predicate: (events: unknown) => boolean,
): Promise<unknown> {
	const deadline = Date.now() + 5_000;
	let lastEvents: unknown;
	while (Date.now() < deadline) {
		const events = await readEvents(origin);
		lastEvents = events;
		if (predicate(events)) return events;
		await delay(20);
	}
	throw new Error(
		`Timed out waiting for Durable Object WebSocket events: ${JSON.stringify(lastEvents)}`,
	);
}

function hasAbruptClose(events: unknown): boolean {
	return (
		Array.isArray(events) &&
		events.some(
			(event) =>
				Array.isArray(event) &&
				event[0] === "close" &&
				event[1] === 1006,
		)
	);
}

function abruptCloseEvent(events: unknown): unknown {
	return Array.isArray(events)
		? events.find(
				(event) =>
					Array.isArray(event) &&
					event[0] === "close" &&
					event[1] === 1006,
			)
		: undefined;
}

async function runScenario(origin: string): Promise<ScenarioOutcome> {
	const rejection = await rejectionOutcome(origin);
	const { socket, upgradeHeader } = await openSocket(origin, "ordered");
	const messagesPromise = collectMessages(socket, 67);
	socket.send("hello");
	socket.send(Uint8Array.of(1, 2, 3));
	socket.send("burst");
	const messages = await messagesPromise;
	const terminalMessage = once(socket, "message");
	const closeEvent = once(socket, "close");
	socket.send("server-close");
	const [terminalData, terminalBinary] = await terminalMessage;
	const [closeCode, closeReason] = await closeEvent;
	if (typeof closeCode !== "number") {
		throw new TypeError("WebSocket close event did not include a code");
	}

	const abrupt = await openSocket(origin, "abrupt");
	const abruptClosed = once(abrupt.socket, "close");
	abrupt.socket.terminate();
	await abruptClosed;
	const serverEvents = await waitForEvent(origin, hasAbruptClose);

	return {
		abruptActorEvent: abruptCloseEvent(serverEvents),
		burst: {
			count: messages.slice(2, 66).length,
			first: frameSummary(messages[2]),
			last: frameSummary(messages[65]),
		},
		close: { code: closeCode, reason: text(closeReason) },
		handshake: { protocol: socket.protocol, upgradeHeader },
		messages: {
			binary: messages[1],
			terminal: normalizedMessage(terminalData, terminalBinary),
			text: messages[0],
		},
		rejection,
		serverEvents,
	};
}

async function reserveLoopbackPort(): Promise<number> {
	const server = createServer();
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	await new Promise<void>((resolve, reject) => {
		server.close((error) => (error === undefined ? resolve() : reject(error)));
	});
	if (address === null || typeof address === "string") {
		throw new Error("Failed to reserve a workerd WebSocket fixture port");
	}
	return address.port;
}

async function startWorkerd(): Promise<RuntimeEndpoint> {
	const port = await reserveLoopbackPort();
	const child = spawn(
		readWorkerdMetadata().binaryPath,
		[
			"serve",
			workerdConfig,
			`--socket-addr=http=127.0.0.1:${port}`,
		],
		{
			cwd: dirname(workerdConfig),
			env: { ...process.env, NO_COLOR: "1" },
			stdio: ["ignore", "ignore", "pipe"],
		},
	);
	let stderr = "";
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk: string) => {
		stderr = `${stderr}${chunk}`.slice(-8_192);
	});
	const origin = `http://127.0.0.1:${port}`;
	const deadline = Date.now() + 10_000;
	let ready = false;
	while (Date.now() < deadline) {
		if (child.exitCode !== null) {
			throw new Error(`workerd exited before readiness: ${stderr}`);
		}
		try {
			await readEvents(origin);
			ready = true;
			break;
		} catch {
			await delay(20);
		}
	}
	if (!ready) {
		throw new Error(`workerd WebSocket fixture timed out: ${stderr}`);
	}
	return {
		async close(): Promise<void> {
			if (child.exitCode !== null) return;
			const exited = new Promise<void>((resolve) =>
				child.once("exit", () => resolve()),
			);
			child.kill("SIGTERM");
			await Promise.race([exited, delay(2_000)]);
			if (child.exitCode === null) {
				child.kill("SIGKILL");
				await exited;
			}
		},
		origin,
	};
}

async function closeRuntime(runtime: RuntimeProcess | undefined): Promise<void> {
	if (runtime === undefined) return;
	const exit = await runtime.stop();
	assert.deepEqual(exit, { code: 0, reason: "parent", signal: null });
}

test("matches pinned workerd standard Durable Object WebSockets end to end", async () => {
	const directory = await mkdtemp(join(tmpdir(), "open-orange-websocket-e2e-"));
	const rivetStoragePath = join(directory, "rivetkit");
	let workerd: RuntimeEndpoint | undefined;
	let runtime: RuntimeProcess | undefined;
	const diagnostics: string[] = [];
	try {
		workerd = await startWorkerd();
		const reference = await runScenario(workerd.origin);
		await workerd.close();
		workerd = undefined;

		const bundle = await bundleWorker({
			entrypoint: workerEntrypoint,
			moduleRewrites: runtimeModuleRewrites(),
			outputPath: join(directory, "worker.mjs"),
		});
		runtime = await spawnRuntime({
			bindingConfigurations: [],
			builtAt: new Date("2026-09-04T12:00:00.000Z"),
			bundlePath: bundle.outputPath,
			deploymentIdentity: "durable-websocket-e2e",
			durableObjectManifest: {
				bindings: [{ binding: "ROOMS", className: "Room" }],
				classes: [
					{
						className: "Room",
						migrationTag: "v1",
						storageBackend: "sqlite",
					},
				],
				latestMigrationTag: "v1",
			},
			host: "0.0.0.0",
			normalizedConfiguration: "{}",
			onDiagnostic(diagnostic): void {
				diagnostics.push(diagnostic.stack ?? diagnostic.message);
			},
			port: 0,
			projectRoot: directory,
			rivetNamespace: "default",
			rivetStoragePath,
			startupTimeoutMs: 30_000,
		});
		const candidate = await runScenario(`http://127.0.0.1:${runtime.port}`);

		assert.deepEqual(candidate, reference, diagnostics.join("\n"));
		assert.deepEqual(candidate.handshake, {
			protocol: "orange.v1",
			upgradeHeader: "accepted",
		});
		assert.deepEqual(candidate.rejection, {
			header: "expected",
			status: 426,
			statusText: "Upgrade Required",
		});
		assert.deepEqual(candidate.messages, {
			binary: [1, 2, 3],
			terminal: "before-close",
			text: "echo:1:hello",
		});
		assert.deepEqual(candidate.burst, {
			count: 64,
			first: [16 * 1024, 0, 255],
			last: [16 * 1024, 63, 192],
		});
		assert.deepEqual(candidate.close, { code: 3001, reason: "server done" });
		assert.deepEqual(candidate.abruptActorEvent, [
			"close",
			1006,
			"WebSocket disconnected without sending Close frame.",
			false,
		]);

		await closeRuntime(runtime);
		runtime = undefined;
	} finally {
		await workerd?.close();
		try {
			await closeRuntime(runtime);
		} finally {
			await stopEngineFromRuntimeFile(join(rivetStoragePath, ".rivetkit", "var", "engine", "runtime.json"));
			await rm(directory, { force: true, recursive: true });
		}
	}
});
