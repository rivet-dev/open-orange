import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { isRecord } from "../harness/orange-dev.js";

// One `orange dev` with every binding that Orange backs with its own Rivet
// Actors: cron, Queues, Workflows, facets, R2, and Rate Limiting, plus Workers
// AI against a mock provider that runs as a real HTTP server. Each binding's
// own suite covers its semantics. This test covers the seams between them: the
// internal actors share one registry, and handlers that those actors run, such
// as queue() and a Workflow step, call the other bindings.

const cliEntrypoint = fileURLToPath(new URL("../../src/bin.ts", import.meta.url));
const fixtureWorker = fileURLToPath(new URL("../fixtures/all-bindings/worker.js", import.meta.url));

// Answers every chat completion with the prompt it got.
async function startMockProvider(): Promise<{ baseUrl: string; close(): Promise<void> }> {
	const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
		let text = "";
		for await (const part of request) text += String(part);
		const body: unknown = JSON.parse(text);
		const messages = isRecord(body) && Array.isArray(body.messages) ? body.messages : [];
		const last: unknown = messages.at(-1);
		const prompt = isRecord(last) ? String(last.content) : "";
		response.writeHead(200, { "content-type": "application/json" });
		response.end(
			JSON.stringify({
				choices: [
					{
						finish_reason: "stop",
						index: 0,
						message: { content: `answer to ${prompt}`, role: "assistant" },
					},
				],
				usage: { completion_tokens: 1, prompt_tokens: 1, total_tokens: 2 },
			}),
		);
	};
	const server = createServer((request, response) => {
		handle(request, response).catch((error: unknown) => {
			response.writeHead(500);
			response.end(String(error));
		});
	});
	await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
	const address = server.address();
	assert.ok(isRecord(address) && typeof address.port === "number");
	return {
		baseUrl: `http://127.0.0.1:${address.port}/v1`,
		close: () => new Promise((resolveClose) => server.close(() => resolveClose())),
	};
}

describe("every Rivet-backed binding in one orange dev", () => {
	let projectRoot: string;
	let provider: Awaited<ReturnType<typeof startMockProvider>>;
	let origin: string;
	let output = "";
	let stop: () => Promise<void> = async () => undefined;

	before(async () => {
		provider = await startMockProvider();
		projectRoot = await mkdtemp(join(tmpdir(), "open-orange-all-bindings-"));
		await cp(fixtureWorker, join(projectRoot, "worker.js"));
		await writeFile(
			join(projectRoot, "wrangler.json"),
			JSON.stringify({
				ai: { binding: "AI" },
				compatibility_date: "2026-09-03",
				durable_objects: { bindings: [{ class_name: "Parent", name: "PARENT" }] },
				main: "./worker.js",
				migrations: [{ new_sqlite_classes: ["Parent"], tag: "v1" }],
				name: "all-bindings-e2e",
				queues: {
					consumers: [{ max_batch_timeout: 0, queue: "questions" }],
					producers: [{ binding: "QUESTIONS", queue: "questions" }],
				},
				r2_buckets: [{ binding: "BUCKET", bucket_name: "answers" }],
				ratelimits: [
					{ name: "LIMITER", namespace_id: "1001", simple: { limit: 2, period: 60 } },
				],
				triggers: { crons: ["* * * * *"] },
				workflows: [{ binding: "ANSWER", class_name: "Answer", name: "answer" }],
			}),
		);
		await writeFile(
			join(projectRoot, ".dev.vars"),
			`ORANGE_AI_BASE_URL=${provider.baseUrl}\nORANGE_AI_API_KEY=test-key\n`,
		);
		const environment = Object.fromEntries(
			Object.entries(process.env).filter(
				([name]) => !name.startsWith("ORANGE_") && name !== "OPENROUTER_API_KEY",
			),
		);
		const child = spawn(
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
			{ env: { ...environment, CI: "1", NO_COLOR: "1" }, stdio: ["ignore", "pipe", "pipe"] },
		);
		stop = () =>
			new Promise<void>((resolveStop) => {
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
		origin = await new Promise<string>((resolveReady, rejectReady) => {
			const timeout = setTimeout(
				() => rejectReady(new Error(`orange dev readiness timed out: ${output}`)),
				90_000,
			);
			const onData = (part: unknown): void => {
				output += String(part);
				const match = /Local\s+(http:\/\/127\.0\.0\.1:\d+)/.exec(output);
				// The ready block lists the next cron runs once the cron actor synced.
				if (match?.[1] !== undefined && output.includes("Run one now: curl")) {
					clearTimeout(timeout);
					resolveReady(match[1]);
				}
			};
			child.stdout.on("data", onData);
			child.stderr.on("data", onData);
			child.once("exit", (code) => {
				clearTimeout(timeout);
				rejectReady(new Error(`orange dev exited before readiness (code ${code}): ${output}`));
			});
		});
	});

	after(async () => {
		await stop();
		await provider?.close();
		if (projectRoot !== undefined) {
			await rm(projectRoot, { force: true, recursive: true });
		}
	});

	async function getJson(path: string): Promise<unknown> {
		const response = await fetch(`${origin}${path}`);
		const text = await response.text();
		assert.equal(response.status, 200, `${path}: ${text}\n${output}`);
		return JSON.parse(text);
	}

	it("runs a cron tick through a queue, R2, a Workflow, and Workers AI while facets and Rate Limiting answer", async () => {
		assert.match(output, /Cron\s+"\* \* \* \* \*" next /);
		assert.deepEqual(await getJson("/limit?key=caller"), [true, true, false]);
		assert.equal(await getJson("/facet"), 1);
		assert.equal(await getJson("/facet"), 2);

		const scheduledTime = 1_760_000_000_000;
		const tick = await fetch(
			`${origin}/cdn-cgi/local/scheduled?cron=${encodeURIComponent("* * * * *")}&time=${scheduledTime}`,
		);
		assert.equal(tick.status, 200, `${await tick.text()}\n${output}`);
		// The queue consumer and the Workflow run in the background, so the
		// result appears only after they finish.
		const deadline = Date.now() + 60_000;
		let result: unknown = null;
		while (Date.now() < deadline) {
			result = await getJson(`/answer?id=${scheduledTime}`);
			if (isRecord(result) && ["complete", "errored", "terminated"].includes(String(result.status))) break;
			await delay(250);
		}
		assert.deepEqual(
			result,
			{ answer: "answer to what runs at * * * * *?", status: "complete" },
			output,
		);
	});
});
