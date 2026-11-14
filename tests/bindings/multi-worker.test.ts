import assert from "node:assert/strict";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

import {
	copyProject,
	isRecord,
	repositoryRoot,
	runOrange,
	type RunningOrangeDev,
	startOrangeDev,
	withOrangeDev,
} from "../harness/orange-dev.js";

const twoWorkers = ["a/wrangler.jsonc", "b/wrangler.jsonc"];

async function getRecords(dev: RunningOrangeDev, path: string): Promise<Record<string, unknown>[]> {
	const value = await dev.json(path);
	assert.ok(Array.isArray(value) && value.every(isRecord), JSON.stringify(value));
	return value;
}

async function getNumbers(dev: RunningOrangeDev, path: string): Promise<number[]> {
	const value = await dev.json(path);
	assert.ok(
		Array.isArray(value) && value.every((item: unknown): item is number => typeof item === "number"),
		JSON.stringify(value),
	);
	return value;
}

test("orange dev with two configs routes service bindings and script_name Durable Objects between Workers", async () => {
	await withOrangeDev("multi-worker", async (dev) => {
		// fetch() reaches the other Worker's default entrypoint with its method,
		// body, status, and headers.
		assert.deepEqual(await dev.json("/fetch"), {
			from: "worker-b",
			status: 201,
			text: "POST /echo hello",
		});

		// RPC reaches a named entrypoint, and an error thrown there reaches the
		// caller with its type and message, marked remote.
		assert.deepEqual(await dev.json("/rpc"), {
			failure: {
				isRangeError: true,
				message: "callee failed",
				name: "RangeError",
				remote: true,
			},
			sum: 5,
		});

		// One Durable Object keeps its state across calls from both Workers.
		assert.deepEqual(await dev.json("/count"), { caller: "worker-a", count: 1 });
		assert.deepEqual(await dev.json("/count-in-b"), { caller: "worker-b", count: 2 });
		assert.deepEqual(await dev.json("/count"), { caller: "worker-a", count: 3 });

		// A Workflow bound with script_name runs in the Worker that exports it.
		const notFoundMessage = 'Worker "worker-gone" not found. Make sure it is running locally.';
		assert.deepEqual(await dev.json("/workflow"), {
			missing: { isRangeError: false, message: notFoundMessage, name: "Error", remote: false },
			output: "hello worker-a from worker-b",
			status: "complete",
		});

		// A Worker that is not running fails like Wrangler's dev registry.
		const notFound = 'Worker "worker-gone" not found. Make sure it is running locally.';
		const thrown = { isRangeError: false, message: notFound, name: "Error", remote: false };
		assert.deepEqual(await dev.json("/missing"), {
			durableObjectFetch: { status: 503, text: notFound },
			durableObjectRpc: thrown,
			fetch: { status: 503, text: notFound },
			rpc: thrown,
		});
	}, { config: twoWorkers });
});

type WorkerEvent = Record<string, unknown>;

test("two Workers of one session each get their own cron ticks, and a queue that A produces to is consumed by B", { timeout: 180_000 }, async () => {
	await withOrangeDev("multi-worker-scoped", async (dev) => {
		assert.equal((await fetch(`${dev.origin}/send`)).status, 200);
		const events = async (): Promise<[WorkerEvent[], WorkerEvent[]]> => [
			await getRecords(dev, "/events"),
			await getRecords(dev, "/b/events"),
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
	}, { config: twoWorkers });
});

test("orange dev fails at startup when two Workers declare a consumer for one queue", async () => {
	const fixture = join(repositoryRoot, "tests", "fixtures", "multi-worker-scoped");
	const { code, output } = await runOrange(
		fixture,
		["dev", "-c", join(fixture, "b", "wrangler.jsonc"), "--port", "0"],
		join("c", "wrangler.jsonc"),
	);
	assert.notEqual(code, 0, output);
	assert.match(output, /Queue "jobs" has a consumer in both scoped-b and scoped-c/);
	assert.doesNotMatch(output, /Local\s+http/);
});

test("a Worker that joins the session does not stop the queue consumer that another Worker already runs", { timeout: 180_000 }, async () => {
	const project = await copyProject(join(repositoryRoot, "tests", "fixtures", "multi-worker-sweep"));
	const messageCount = 30;
	let dev: RunningOrangeDev | undefined;
	try {
		// The first session stops with most of the messages still in the queue.
		dev = await startOrangeDev(project.directory, "consumer/wrangler.jsonc");
		assert.equal((await fetch(`${dev.origin}/send?count=${messageCount}`)).status, 200);
		await dev.close();

		// The consumer Worker starts first and drains the backlog. The producer
		// Worker starts while the backlog drains.
		dev = await startOrangeDev(project.directory, ["consumer/wrangler.jsonc", "producer/wrangler.jsonc"]);
		let delivered = await getNumbers(dev, "/");
		const deadline = Date.now() + 60_000;
		while (delivered.at(-1) !== messageCount - 1) {
			assert.ok(Date.now() < deadline, `the backlog stopped draining: ${JSON.stringify(delivered)}`);
			await delay(500);
			delivered = await getNumbers(dev, "/");
		}
	} finally {
		try {
			await dev?.close();
		} finally {
			await project.dispose();
		}
	}
});
