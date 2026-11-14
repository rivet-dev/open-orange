import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { isRecord } from "../../tests/orange-dev.js";

// Drives Queues producers and the queue() consumer through a real `orange dev`
// process, Wrangler configuration, and Rivet Engine.

const cliEntrypoint = fileURLToPath(new URL("../bin.ts", import.meta.url));
const fixtureWorker = fileURLToPath(new URL("./fixtures/queues/worker.js", import.meta.url));

const wranglerConfiguration = {
	compatibility_date: "2026-09-03",
	kv_namespaces: [{ binding: "LOG", id: "log" }],
	main: "./worker.js",
	name: "queues-e2e",
	queues: {
		consumers: [
			{ dead_letter_queue: "jobs-dlq", max_batch_timeout: 0, max_retries: 2, queue: "jobs" },
			{ max_batch_timeout: 0, queue: "jobs-dlq" },
			{ max_batch_timeout: 0, queue: "delayed" },
			{ max_batch_size: 10, max_batch_timeout: 1, queue: "bulk" },
			{ max_batch_timeout: 0, queue: "slow" },
		],
		producers: [
			{ binding: "BULK", queue: "bulk" },
			{ binding: "DELAYED", queue: "delayed" },
			{ binding: "JOBS", queue: "jobs" },
			{ binding: "SLOW", queue: "slow" },
		],
	},
};

interface Delivery {
	at: number;
	attempts: number;
	batchSize: number;
	body: unknown;
	id: string;
	queue: string;
	timestamp: number;
}

function isDelivery(value: unknown): value is Delivery {
	return (
		isRecord(value) &&
		typeof value.at === "number" &&
		typeof value.attempts === "number" &&
		typeof value.batchSize === "number" &&
		typeof value.id === "string" &&
		typeof value.queue === "string" &&
		typeof value.timestamp === "number"
	);
}

interface DevServer {
	origin: string;
	output(): string;
	// Kills `orange dev` and its runtime process without a graceful shutdown.
	crash(): Promise<void>;
	stop(): Promise<void>;
}

function waitForExit(child: ChildProcess): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
	return new Promise((resolveExit) => child.once("exit", () => resolveExit()));
}

async function startDev(projectRoot: string): Promise<DevServer> {
	// Its own process group, so a crash can kill the runtime child with it.
	const child: ChildProcess = spawn(
		process.execPath,
		[
			"--import",
			"tsx",
			cliEntrypoint,
			"dev",
			"--config",
			join(projectRoot, "wrangler.json"),
			"--port",
			"0",
			"--ip",
			"127.0.0.1",
			"--show-interactive-dev-session=false",
		],
		{
			detached: true,
			env: { ...process.env, CI: "1", NO_COLOR: "1" },
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	let output = "";
	const port = await new Promise<number>((resolveReady, rejectReady) => {
		const timeout = setTimeout(
			() => rejectReady(new Error(`orange dev readiness timed out: ${output}`)),
			60_000,
		);
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
	const pid = child.pid;
	if (pid === undefined) throw new Error("orange dev has no process ID");
	return {
		origin: `http://127.0.0.1:${port}`,
		output: () => output,
		async crash(): Promise<void> {
			const exited = waitForExit(child);
			process.kill(-pid, "SIGKILL");
			await exited;
		},
		async stop(): Promise<void> {
			if (child.exitCode !== null || child.signalCode !== null) return;
			const exited = waitForExit(child);
			const timeout = setTimeout(() => process.kill(-pid, "SIGKILL"), 15_000);
			child.kill("SIGINT");
			await exited;
			clearTimeout(timeout);
		},
	};
}

describe("Queues through orange dev", () => {
	let projectRoot: string;
	let server: DevServer;

	async function getJson(path: string, init?: RequestInit): Promise<unknown> {
		const response = await fetch(`${server.origin}${path}`, init);
		const text = await response.text();
		assert.equal(response.status, 200, `${path}: ${text}\n${server.output()}`);
		return JSON.parse(text);
	}

	async function send(
		binding: string,
		messages: readonly Record<string, unknown>[],
		delaySeconds?: number,
	): Promise<unknown> {
		return getJson(`/send?binding=${binding}`, {
			body: JSON.stringify({ delaySeconds, messages }),
			method: "POST",
		});
	}

	async function deliveries(queue: string): Promise<Delivery[]> {
		const value = await getJson(`/deliveries?queue=${queue}`);
		assert.ok(Array.isArray(value) && value.every(isDelivery));
		return value;
	}

	// Delivery is asynchronous to the request that sent the message, so the
	// test polls the consumer's record until it matches or the deadline passes.
	async function waitForDeliveries(
		queue: string,
		done: (records: Delivery[]) => boolean,
		timeoutMs = 30_000,
	): Promise<Delivery[]> {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			const records = await deliveries(queue);
			if (done(records)) return records;
			if (Date.now() > deadline) {
				assert.fail(
					`${queue} deliveries did not settle: ${JSON.stringify(records)}\n${server.output()}`,
				);
			}
			await delay(200);
		}
	}

	before(async () => {
		projectRoot = await mkdtemp(join(tmpdir(), "open-orange-queues-"));
		await cp(fixtureWorker, join(projectRoot, "worker.js"));
		await writeFile(join(projectRoot, "wrangler.json"), JSON.stringify(wranglerConfiguration));
		server = await startDev(projectRoot);
	});

	after(async () => {
		try {
			await server?.stop();
		} finally {
			await rm(projectRoot, { force: true, recursive: true });
		}
	});

	it("redelivers a message whose handler throws up to max_retries, then delivers it to the dead-letter queue", async () => {
		await send("JOBS", [{ body: { fail: true, name: "poison" } }]);
		const failed = await waitForDeliveries("jobs-dlq", (records) => records.length > 0);
		const attempts = await deliveries("jobs");
		assert.deepEqual(
			attempts.map((delivery) => [delivery.id, delivery.attempts]),
			[1, 2, 3].map((attempt) => [failed[0]?.id, attempt]),
		);
		assert.deepEqual(
			failed.map(({ attempts: attempt, body, id, timestamp }) => ({
				attempt,
				body,
				id,
				timestamp,
			})),
			[
				{
					attempt: 1,
					body: { fail: true, name: "poison" },
					id: attempts[0]?.id,
					timestamp: attempts[0]?.timestamp,
				},
			],
		);
		// No more deliveries arrive after the message reached the dead-letter queue.
		await delay(1_000);
		assert.equal((await deliveries("jobs")).length, 3);
	});

	it("redelivers a message that called retry({ delaySeconds }) no earlier than the delay, and only that message", async () => {
		await send("DELAYED", [{ body: { name: "later", retryDelay: 3 } }, { body: { name: "now" } }]);
		const records = await waitForDeliveries(
			"delayed",
			(found) => found.filter((delivery) => isRecord(delivery.body) && delivery.body.name === "later").length === 2,
		);
		const later = records.filter((delivery) => isRecord(delivery.body) && delivery.body.name === "later");
		const now = records.filter((delivery) => isRecord(delivery.body) && delivery.body.name === "now");
		assert.deepEqual(later.map((delivery) => delivery.attempts), [1, 2]);
		const [first, second] = later;
		assert.ok(first !== undefined && second !== undefined);
		assert.ok(second.at - first.at >= 3_000, `redelivered after ${second.at - first.at} ms`);
		// Time for a wrong redelivery of "now" to arrive.
		await delay(500);
		assert.equal(
			(await deliveries("delayed")).filter((delivery) => isRecord(delivery.body) && delivery.body.name === "now").length,
			1,
			JSON.stringify(now),
		);
	});

	it("delivers every message from concurrent producers in batches of at most max_batch_size", async () => {
		const producers = Array.from({ length: 20 }, (_, producer) =>
			producer % 2 === 0
				? send("BULK", [{ body: { n: producer * 10 } }])
				: send(
						"BULK",
						Array.from({ length: 5 }, (_, index) => ({ body: { n: producer * 10 + index } })),
					),
		);
		await Promise.all(producers);
		const expected = new Set<number>();
		for (let producer = 0; producer < 20; producer += 1) {
			const count = producer % 2 === 0 ? 1 : 5;
			for (let index = 0; index < count; index += 1) expected.add(producer * 10 + index);
		}
		const records = await waitForDeliveries("bulk", (found) => {
			const seen = new Set(found.map((delivery) => (isRecord(delivery.body) ? delivery.body.n : undefined)));
			return [...expected].every((n) => seen.has(n));
		});
		assert.equal(records.length, expected.size, "a message was delivered more than once");
		assert.ok(
			records.every((delivery) => delivery.batchSize <= 10),
			JSON.stringify(records.map((delivery) => delivery.batchSize)),
		);
	});

	it("delivers a 128,000-byte message intact, and takes a message over Cloudflare's 128 KB", async () => {
		assert.deepEqual(await getJson("/send-bytes?size=128000"), { sent: 1 });
		const records = await waitForDeliveries("delayed", (found) =>
			found.some((delivery) => isRecord(delivery.body) && delivery.body.type === "Uint8Array"),
		);
		let expectedSum = 0;
		for (let index = 0; index < 128_000; index += 1) expectedSum = (expectedSum + (index % 251)) % 65_521;
		assert.deepEqual(
			records.filter((delivery) => isRecord(delivery.body) && delivery.body.type === "Uint8Array").map((delivery) => delivery.body),
			[{ byteLength: 128_000, sum: expectedSum, type: "Uint8Array" }],
		);
		assert.deepEqual(await getJson("/send-bytes?size=140000"), { sent: 1 });
	});

	it("rejects invalid sends like workerd", async () => {
		assert.deepEqual(await getJson("/send-invalid"), {
			badContentType: { message: "Unsupported queue message content type: xml", name: "TypeError" },
			badDelay: {
				message:
					"Queue send failed: message delay -1 is invalid. It must be a whole number of seconds, 0 or more.",
				name: "Error",
			},
			emptyBatch: { message: "sendBatch() requires at least one message", name: "TypeError" },
			textNotString: {
				message: 'Content Type "text" requires a value of type string, but received: number',
				name: "TypeError",
			},
			undefinedBody: { message: "Message body cannot be undefined", name: "TypeError" },
		});
	});

	it("delivers a batch again after orange dev crashes while queue() runs", async () => {
		await send("SLOW", [{ body: { hang: true } }]);
		const [started] = await waitForDeliveries("slow", (found) => found.length === 1);
		await server.crash();
		server = await startDev(projectRoot);
		const records = await waitForDeliveries("slow", (found) => found.length === 2, 60_000);
		assert.deepEqual(
			records.map((delivery) => delivery.id),
			[started?.id, started?.id],
		);
	});

	it("delivers a delayed message after orange dev restarts", async () => {
		const sentAt = Date.now();
		await send("DELAYED", [{ body: { name: "after-restart" }, delaySeconds: 5 }]);
		await server.stop();
		server = await startDev(projectRoot);
		const records = await waitForDeliveries(
			"delayed",
			(found) => found.some((delivery) => isRecord(delivery.body) && delivery.body.name === "after-restart"),
			60_000,
		);
		const delivered = records.filter(
			(delivery) => isRecord(delivery.body) && delivery.body.name === "after-restart",
		);
		assert.equal(delivered.length, 1);
		assert.ok((delivered[0]?.at ?? 0) - sentAt >= 5_000);
	});
});
