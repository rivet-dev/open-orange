import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { readWorkerdMetadata } from "../../packages/cloudflare-conformance/src/runners/workerd.js";
import { bundleWorker } from "../../src/build/bundle-worker.js";
import { runtimeModuleRewrites } from "../../src/build/rewrite-module-imports.js";
import { type RuntimeProcess, spawnRuntime } from "../../src/runtime/spawn.js";
import {
	closeWebSocket,
	collectMessages,
	isRecord,
	openWebSocket,
	stopEngineFromRuntimeFile,
	type ClientWebSocket,
} from "../harness/orange-dev.js";

const workerEntrypoint = new URL(
	"../fixtures/durable-object-hibernation-registration-worker.js",
	import.meta.url,
).pathname;
const workerdConfig = new URL(
	"../fixtures/durable-object-hibernation-registration-workerd.capnp",
	import.meta.url,
).pathname;

interface RuntimeEndpoint {
	close(): Promise<void>;
	origin: string;
}

function once(socket: ClientWebSocket, type: string): Promise<unknown[]> {
	return new Promise((resolve) =>
		socket.once(type, (...parameters) => resolve(parameters)),
	);
}

function normalizedMessage(data: unknown, binary: unknown): string | number[] {
	const bytes =
		data instanceof ArrayBuffer
			? new Uint8Array(data)
			: ArrayBuffer.isView(data)
				? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
				: undefined;
	if (binary !== true) {
		if (typeof data === "string") return data;
		if (bytes !== undefined) return new TextDecoder().decode(bytes);
	}
	if (bytes !== undefined) return [...bytes];
	throw new TypeError("Hibernatable WebSocket fixture received invalid data");
}

async function readHibernatableMessages(origin: string): Promise<unknown[]> {
	const socket = await openWebSocket(`${origin}/socket?id=event-methods`);

	const autoResponse = once(socket, "message");
	socket.send("ping");
	const [autoData, autoBinary] = await autoResponse;
	const textResponse = once(socket, "message");
	socket.send("hello");
	const [textData, textBinary] = await textResponse;
	const binaryResponse = once(socket, "message");
	socket.send(Uint8Array.of(1, 2, 3));
	const [binaryData, binaryBinary] = await binaryResponse;
	await closeWebSocket(socket);
	return [
		normalizedMessage(autoData, autoBinary),
		normalizedMessage(textData, textBinary),
		normalizedMessage(binaryData, binaryBinary),
	];
}

async function readPhysicalHibernation(origin: string): Promise<{
	events: Array<Record<string, unknown>>;
	inspection: unknown;
}> {
	const socket = await openWebSocket(`${origin}/socket?id=physical&physical=1`);

	// Orange configures the same ten-second idle deadline as workerd. Crossing
	// it before the first frame makes a changed class-generation number a
	// deterministic proof that Rivet physically slept and woke the actor.
	await delay(11_000);
	const received = collectMessages(socket, 3);
	socket.send("first");
	socket.send("second");
	socket.send("third");
	const messages = await Promise.race([
		received,
		delay(5_000).then(() => {
			throw new Error("Physical hibernation messages timed out");
		}),
	]);
	const events = messages.map((message) => {
		const value: unknown = JSON.parse(message);
		if (!isRecord(value)) {
			throw new TypeError("Physical hibernation fixture returned invalid JSON");
		}
		return value;
	});

	await closeWebSocket(socket);
	let inspection: unknown;
	const deadline = Date.now() + 5_000;
	do {
		inspection = await readOutcome(`${origin}/?id=physical&physical-inspect=1`);
		if (
			isRecord(inspection) &&
			inspection.active === 0 &&
			inspection.closeEvents === 1
		) {
			break;
		}
		await delay(20);
	} while (Date.now() < deadline);
	return { events, inspection };
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
		throw new Error("Failed to reserve a workerd hibernation fixture port");
	}
	return address.port;
}

async function startWorkerd(): Promise<RuntimeEndpoint> {
	const port = await reserveLoopbackPort();
	const child = spawn(
		readWorkerdMetadata().binaryPath,
		["serve", workerdConfig, `--socket-addr=http=127.0.0.1:${port}`],
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
			const response = await fetch(`${origin}/?id=readiness`, {
				signal: AbortSignal.timeout(500),
			});
			if (response.ok) {
				ready = true;
				break;
			}
		} catch {
			await delay(20);
		}
	}
	if (!ready)
		throw new Error(`workerd hibernation fixture timed out: ${stderr}`);
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

async function closeRuntime(
	runtime: RuntimeProcess | undefined,
): Promise<void> {
	if (runtime === undefined) return;
	const exit = await runtime.stop();
	assert.deepEqual(exit, { code: 0, reason: "parent", signal: null });
}

async function readOutcome(origin: string): Promise<unknown> {
	const response = await fetch(origin, { signal: AbortSignal.timeout(5_000) });
	if (!response.ok)
		throw new Error(`Hibernation fixture returned ${response.status}`);
	return await response.json();
}

async function runAlarmDispatch(
	origin: string,
	id: string,
	retry = false,
): Promise<unknown> {
	await readOutcome(
		`${origin}/?alarm-dispatch-start=1&id=${id}${retry ? "&alarm-dispatch-retry=1" : ""}`,
	);
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		const outcome = await readOutcome(
			`${origin}/?alarm-dispatch-status=1&id=${id}`,
		);
		if (isRecord(outcome) && outcome.complete === true) return outcome;
		await delay(25);
	}
	throw new Error("Durable Object alarm retry fixture timed out");
}

test("matches pinned workerd APIs and physically hibernates on Rivet", async () => {
	const directory = await mkdtemp(
		join(tmpdir(), "open-orange-hibernation-registration-"),
	);
	const rivetStoragePath = join(directory, "rivetkit");
	let workerd: RuntimeEndpoint | undefined;
	let runtime: RuntimeProcess | undefined;
	const diagnostics: string[] = [];
	try {
		workerd = await startWorkerd();
		const reference = {
			alarm: await readOutcome(
				`${workerd.origin}/?alarm-storage&id=alarm-reference`,
			),
			events: await readHibernatableMessages(workerd.origin),
			registration: await readOutcome(`${workerd.origin}/?id=reference`),
		};
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
			deploymentIdentity: "durable-hibernation-registration-e2e",
			durableObjectManifest: {
				bindings: [{ binding: "SOCKETS", className: "SocketRegistry" }],
				classes: [
					{
						className: "SocketRegistry",
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
		const runtimeOrigin = `http://127.0.0.1:${runtime.port}`;
		const candidate = {
			alarm: await readOutcome(
				`${runtimeOrigin}/?alarm-storage&id=alarm-candidate`,
			),
			events: await readHibernatableMessages(runtimeOrigin),
			registration: await readOutcome(`${runtimeOrigin}/?id=candidate`),
		};
		assert.deepEqual(candidate, reference, diagnostics.join("\n"));
		assert.deepEqual(candidate.alarm, {
			afterCommit: 2_000_000_001_000,
			afterDelete: null,
			afterRollback: 2_000_000_000_000,
			first: 2_000_000_000_000,
			initial: null,
		});
		const retryAlarm = await runAlarmDispatch(
			runtimeOrigin,
			"alarm-retry-candidate",
			true,
		);
		assert.deepEqual(retryAlarm, {
			attempts: [
				{
					isRetry: false,
					retryCount: 0,
					scheduledTimeMatches: true,
					visibleAlarm: null,
				},
				{
					isRetry: true,
					retryCount: 1,
					scheduledTimeMatches: true,
					visibleAlarm: null,
				},
			],
			complete: true,
			currentAlarm: null,
		});
		assert.deepEqual(candidate.events, [
			"pong",
			JSON.stringify({
				autoResponse: { request: "ping", response: "pong" },
				attachmentCount: 1,
				message: "hello",
				tags: ["event-methods"],
				timestampIsDate: true,
			}),
			[1, 2, 3],
		]);

		const physical = await readPhysicalHibernation(runtimeOrigin);
		assert.deepEqual(
			physical.events.map((event) => ({
				attachmentCount: event.attachmentCount,
				autoResponse: event.autoResponse,
				message: event.message,
				tags: event.tags,
			})),
			[
				{
					attachmentCount: 1,
					autoResponse: { request: "ping", response: "pong" },
					message: "first",
					tags: ["physical"],
				},
				{
					attachmentCount: 2,
					autoResponse: { request: "ping", response: "pong" },
					message: "second",
					tags: ["physical"],
				},
				{
					attachmentCount: 3,
					autoResponse: { request: "ping", response: "pong" },
					message: "third",
					tags: ["physical"],
				},
			],
		);
		const firstPhysicalEvent = physical.events[0];
		assert.ok(firstPhysicalEvent);
		const connectionGeneration = firstPhysicalEvent.connectionGeneration;
		const eventGeneration = firstPhysicalEvent.eventGeneration;
		if (
			typeof connectionGeneration !== "number" ||
			typeof eventGeneration !== "number"
		) {
			throw new TypeError("Physical hibernation generations are invalid");
		}
		assert.ok(
			eventGeneration > connectionGeneration,
			"expected a new Durable Object generation after actor sleep",
		);
		assert.ok(
			physical.events.every(
				(event) => event.eventGeneration === eventGeneration,
			),
			"expected ordered frames to stay in one awakened generation",
		);
		assert.deepEqual(physical.inspection, {
			active: 0,
			closeEvents: 1,
		});

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
