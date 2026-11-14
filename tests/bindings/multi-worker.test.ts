import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { rm } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { isRecord } from "../../src/unknown-values.js";

const cliEntrypoint = fileURLToPath(new URL("../../src/bin.ts", import.meta.url));
const fixtures = new URL("../fixtures/multi-worker/", import.meta.url);
const callerConfig = fileURLToPath(new URL("a/wrangler.jsonc", fixtures));
const calleeConfig = fileURLToPath(new URL("b/wrangler.jsonc", fixtures));
const scopedFixtures = new URL("../fixtures/multi-worker-scoped/", import.meta.url);

function waitForReady(child: ChildProcess): Promise<number> {
	return new Promise((resolveReady, rejectReady) => {
		let output = "";
		const timeout = setTimeout(() => {
			rejectReady(new Error(`orange dev readiness timed out: ${output}`));
		}, 60_000);
		const onData = (chunk: unknown): void => {
			output += String(chunk);
			const match = /Local\s+http:\/\/127\.0\.0\.1:(\d+)/.exec(output);
			if (match?.[1] !== undefined) {
				clearTimeout(timeout);
				resolveReady(Number(match[1]));
			}
		};
		child.stdout?.on("data", onData);
		child.stderr?.on("data", onData);
		child.once("exit", (code) => {
			clearTimeout(timeout);
			rejectReady(new Error(`orange dev exited before readiness (code ${code}): ${output}`));
		});
	});
}

function stop(child: ChildProcess): Promise<void> {
	return new Promise((resolveStop) => {
		if (child.exitCode !== null || child.signalCode !== null) {
			resolveStop();
			return;
		}
		const timeout = setTimeout(() => child.kill("SIGKILL"), 15_000);
		child.once("exit", () => {
			clearTimeout(timeout);
			resolveStop();
		});
		child.kill("SIGINT");
	});
}

async function getJson(origin: string, path: string): Promise<unknown> {
	const response = await fetch(`${origin}${path}`);
	assert.equal(response.status, 200, await response.clone().text());
	return response.json();
}

async function getRecords(origin: string, path: string): Promise<Record<string, unknown>[]> {
	const value = await getJson(origin, path);
	assert.ok(Array.isArray(value) && value.every(isRecord), JSON.stringify(value));
	return value;
}

async function getNumbers(origin: string, path: string): Promise<number[]> {
	const value = await getJson(origin, path);
	assert.ok(
		Array.isArray(value) && value.every((item: unknown): item is number => typeof item === "number"),
		JSON.stringify(value),
	);
	return value;
}

test("orange dev with two configs routes service bindings and script_name Durable Objects between Workers", async () => {
	await rm(fileURLToPath(new URL("a/.open-orange", fixtures)), { force: true, recursive: true });
	const child = spawn(
		process.execPath,
		[
			"--import",
			"tsx",
			cliEntrypoint,
			"dev",
			"-c",
			callerConfig,
			"-c",
			calleeConfig,
			"--port",
			"0",
			"--ip",
			"127.0.0.1",
		],
		{ env: { ...process.env, CI: "1", NO_COLOR: "1" }, stdio: ["ignore", "pipe", "pipe"] },
	);
	try {
		const origin = `http://127.0.0.1:${await waitForReady(child)}`;

		// fetch() reaches the other Worker's default entrypoint with its method,
		// body, status, and headers.
		assert.deepEqual(await getJson(origin, "/fetch"), {
			from: "worker-b",
			status: 201,
			text: "POST /echo hello",
		});

		// RPC reaches a named entrypoint, and an error thrown there reaches the
		// caller with its type and message, marked remote.
		assert.deepEqual(await getJson(origin, "/rpc"), {
			failure: {
				isRangeError: true,
				message: "callee failed",
				name: "RangeError",
				remote: true,
			},
			sum: 5,
		});

		// One Durable Object keeps its state across calls from both Workers.
		assert.deepEqual(await getJson(origin, "/count"), { caller: "worker-a", count: 1 });
		assert.deepEqual(await getJson(origin, "/count-in-b"), { caller: "worker-b", count: 2 });
		assert.deepEqual(await getJson(origin, "/count"), { caller: "worker-a", count: 3 });

		// A Workflow bound with script_name runs in the Worker that exports it.
		const notFoundMessage = 'Worker "worker-gone" not found. Make sure it is running locally.';
		assert.deepEqual(await getJson(origin, "/workflow"), {
			missing: { isRangeError: false, message: notFoundMessage, name: "Error", remote: false },
			output: "hello worker-a from worker-b",
			status: "complete",
		});

		// A Worker that is not running fails like Wrangler's dev registry.
		const notFound = 'Worker "worker-gone" not found. Make sure it is running locally.';
		const thrown = { isRangeError: false, message: notFound, name: "Error", remote: false };
		assert.deepEqual(await getJson(origin, "/missing"), {
			durableObjectFetch: { status: 503, text: notFound },
			durableObjectRpc: thrown,
			fetch: { status: 503, text: notFound },
			rpc: thrown,
		});
	} finally {
		await stop(child);
		await rm(fileURLToPath(new URL("a/.open-orange", fixtures)), { force: true, recursive: true });
	}
});

type WorkerEvent = Record<string, unknown>;

test("two Workers of one session each get their own cron ticks, and a queue that A produces to is consumed by B", { timeout: 180_000 }, async () => {
	const storage = fileURLToPath(new URL("a/.open-orange", scopedFixtures));
	await rm(storage, { force: true, recursive: true });
	const child = spawn(
		process.execPath,
		[
			"--import",
			"tsx",
			cliEntrypoint,
			"dev",
			"-c",
			fileURLToPath(new URL("a/wrangler.jsonc", scopedFixtures)),
			"-c",
			fileURLToPath(new URL("b/wrangler.jsonc", scopedFixtures)),
			"--port",
			"0",
			"--ip",
			"127.0.0.1",
		],
		{ env: { ...process.env, CI: "1", NO_COLOR: "1" }, stdio: ["ignore", "pipe", "pipe"] },
	);
	try {
		const origin = `http://127.0.0.1:${await waitForReady(child)}`;
		assert.equal((await fetch(`${origin}/send`)).status, 200);
		const events = async (): Promise<[WorkerEvent[], WorkerEvent[]]> => [
			await getRecords(origin, "/events"),
			await getRecords(origin, "/b/events"),
		];
		// Cron ticks arrive on the minute, so the test polls until both Workers saw
		// a tick and B saw the queue delivery.
		const ticked = (received: WorkerEvent[]): boolean =>
			received.some((event) => event.kind === "scheduled");
		let [a, b] = await events();
		const deadline = Date.now() + 150_000;
		while (!(ticked(a) && ticked(b) && b.some((event) => event.kind === "queue"))) {
			assert.ok(Date.now() < deadline, `cron ticks did not reach both Workers: ${JSON.stringify({ a, b })}`);
			await delay(1_000);
			[a, b] = await events();
		}
		assert.deepEqual(
			b.filter((event) => event.kind === "queue"),
			[{ body: "from scoped-a", kind: "queue", queue: "jobs" }],
		);
		assert.deepEqual(a.filter((event) => event.kind === "queue"), []);
		for (const received of [a, b]) {
			assert.ok(received.every((event) => event.kind === "queue" || event.cron === "* * * * *"));
		}
	} finally {
		await stop(child);
		await rm(storage, { force: true, recursive: true });
	}
});

test("orange dev fails at startup when two Workers declare a consumer for one queue", async () => {
	const child = spawn(
		process.execPath,
		[
			"--import",
			"tsx",
			cliEntrypoint,
			"dev",
			"-c",
			fileURLToPath(new URL("b/wrangler.jsonc", scopedFixtures)),
			"-c",
			fileURLToPath(new URL("c/wrangler.jsonc", scopedFixtures)),
			"--port",
			"0",
		],
		{ env: { ...process.env, CI: "1", NO_COLOR: "1" }, stdio: ["ignore", "pipe", "pipe"] },
	);
	let output = "";
	child.stdout?.on("data", (chunk: unknown) => (output += String(chunk)));
	child.stderr?.on("data", (chunk: unknown) => (output += String(chunk)));
	const code = await new Promise<number | null>((resolveExit) => child.once("exit", resolveExit));
	assert.notEqual(code, 0, output);
	assert.match(output, /Queue "jobs" has a consumer in both scoped-b and scoped-c/);
	assert.doesNotMatch(output, /Local\s+http/);
});

test("a Worker that joins the session does not stop the queue consumer that another Worker already runs", { timeout: 180_000 }, async () => {
	const sweepFixtures = new URL("../fixtures/multi-worker-sweep/", import.meta.url);
	const consumerConfig = fileURLToPath(new URL("consumer/wrangler.jsonc", sweepFixtures));
	const producerConfig = fileURLToPath(new URL("producer/wrangler.jsonc", sweepFixtures));
	const storage = fileURLToPath(new URL("consumer/.open-orange", sweepFixtures));
	const dev = (configs: string[]): ChildProcess =>
		spawn(
			process.execPath,
			[
				"--import",
				"tsx",
				cliEntrypoint,
				"dev",
				...configs.flatMap((config) => ["-c", config]),
				"--port",
				"0",
				"--ip",
				"127.0.0.1",
			],
			{ env: { ...process.env, CI: "1", NO_COLOR: "1" }, stdio: ["ignore", "pipe", "pipe"] },
		);
	await rm(storage, { force: true, recursive: true });
	const messageCount = 30;
	let child = dev([consumerConfig]);
	try {
		// The first session stops with most of the messages still in the queue.
		const first = `http://127.0.0.1:${await waitForReady(child)}`;
		assert.equal((await fetch(`${first}/send?count=${messageCount}`)).status, 200);
		await stop(child);

		// The consumer Worker starts first and drains the backlog. The producer
		// Worker starts while the backlog drains.
		child = dev([consumerConfig, producerConfig]);
		const origin = `http://127.0.0.1:${await waitForReady(child)}`;
		let delivered = await getNumbers(origin, "/");
		const deadline = Date.now() + 60_000;
		while (delivered.at(-1) !== messageCount - 1) {
			assert.ok(Date.now() < deadline, `the backlog stopped draining: ${JSON.stringify(delivered)}`);
			await delay(500);
			delivered = await getNumbers(origin, "/");
		}
	} finally {
		await stop(child);
		await rm(storage, { force: true, recursive: true });
	}
});
