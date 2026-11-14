import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { isRecord } from "../harness/orange-dev.js";

// Drives `env.AI` through a real `orange dev` process against a mock
// OpenAI-compatible provider that runs as a real HTTP server.

const cliEntrypoint = fileURLToPath(new URL("../../src/bin.ts", import.meta.url));
const fixtureWorker = fileURLToPath(new URL("../fixtures/ai/worker.js", import.meta.url));
const apiKey = "test-provider-key";

const testModels = {
	"@cf/test/broken": { model: "mock/broken", task: "text" },
	"@cf/test/chat": { model: "mock/text", shape: "openai", task: "text" },
	"@cf/test/rate-limited": { model: "mock/rate-limited", task: "text" },
	"@cf/test/stream-broken": { model: "mock/stream-broken", task: "text" },
	"@cf/test/text": { model: "mock/text", task: "text" },
};

interface ProviderRequest {
	authorization: string | undefined;
	body: Record<string, unknown>;
	path: string;
}

interface MockProvider {
	baseUrl: string;
	requests: ProviderRequest[];
	close(): Promise<void>;
}

function sse(response: ServerResponse, events: readonly string[]): void {
	response.writeHead(200, { "content-type": "text/event-stream" });
	for (const event of events) response.write(`${event}\n\n`);
	response.end();
}

function chunk(delta: Record<string, unknown>): string {
	return `data: ${JSON.stringify({ choices: [{ delta, index: 0 }] })}`;
}

function chatCompletion(model: string, messages: unknown, tools: unknown) {
	const last: unknown = Array.isArray(messages) ? messages.at(-1) : undefined;
	return {
		choices: [
			{
				finish_reason: "stop",
				index: 0,
				message: {
					content: `reply from ${model} to ${isRecord(last) ? String(last.content) : undefined}`,
					role: "assistant",
					...(Array.isArray(tools)
						? {
								tool_calls: [
									{ function: { arguments: '{"city":"Paris"}', name: "weather" }, id: "call_9", type: "function" },
								],
							}
						: {}),
				},
			},
		],
		created: 1_760_000_000,
		id: "gen-1",
		model,
		object: "chat.completion",
		usage: { completion_tokens: 4, prompt_tokens: 6, total_tokens: 10 },
	};
}

// With `requiredKey`, the provider rejects requests without that bearer token.
async function startMockProvider(requiredKey?: string): Promise<MockProvider> {
	const requests: ProviderRequest[] = [];
	const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
		let text = "";
		for await (const part of request) text += String(part);
		const parsed: unknown = JSON.parse(text);
		const body = isRecord(parsed) ? parsed : {};
		requests.push({ authorization: request.headers.authorization, body, path: request.url ?? "" });
		const json = (status: number, value: unknown): void => {
			response.writeHead(status, { "content-type": "application/json" });
			response.end(JSON.stringify(value));
		};
		if (requiredKey !== undefined && request.headers.authorization !== `Bearer ${requiredKey}`) {
			json(401, { error: { code: 401, message: "No auth credentials found" } });
			return;
		}
		if (request.url === "/v1/embeddings") {
			json(200, {
				data: [
					{ embedding: [0.3, 0.4, 0.5], index: 1, object: "embedding" },
					{ embedding: [0.1, 0.2, 0.3], index: 0, object: "embedding" },
				],
				model: body.model,
			});
			return;
		}
		const model = String(body.model);
		if (model === "mock/rate-limited") {
			json(429, { error: { code: 429, message: "Rate limit exceeded: free-models-per-day" } });
		} else if (model === "mock/broken") {
			json(500, { error: { code: 500, message: "Internal provider failure" } });
		} else if (model === "mock/stream-broken") {
			sse(response, [
				chunk({ content: "partial" }),
				`data: ${JSON.stringify({ error: { code: 502, message: "Provider died mid-stream" } })}`,
			]);
		} else if (body.stream === true) {
			sse(response, [
				": OPENROUTER PROCESSING",
				chunk({ content: "", role: "assistant" }),
				chunk({ content: "Hel" }),
				chunk({ content: `lo from ${model}` }),
				chunk({ tool_calls: [{ function: { arguments: "", name: "weather" }, id: "call_1", index: 0, type: "function" }] }),
				chunk({ tool_calls: [{ function: { arguments: '{"city":' }, index: 0 }] }),
				chunk({ tool_calls: [{ function: { arguments: '"Paris"}' }, index: 0 }] }),
				`data: ${JSON.stringify({ choices: [], usage: { completion_tokens: 3, prompt_tokens: 5, total_tokens: 8 } })}`,
				"data: [DONE]",
			]);
		} else {
			json(200, chatCompletion(model, body.messages, body.tools));
		}
	};
	const server: Server = createServer((request, response) => {
		handle(request, response).catch((error: unknown) => {
			response.writeHead(599);
			response.end(String(error));
		});
	});
	await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
	const address = server.address();
	assert.ok(address !== null && typeof address === "object");
	const { port } = address;
	return {
		baseUrl: `http://127.0.0.1:${port}/v1`,
		requests,
		close: () => new Promise((resolveClose) => server.close(() => resolveClose())),
	};
}

interface DevServer {
	origin: string;
	output(): string;
	stop(): Promise<void>;
}

async function startDev(projectRoot: string): Promise<DevServer> {
	// The developer's own provider settings must not leak into the run.
	const environment = Object.fromEntries(
		Object.entries(process.env).filter(
			([name]) => !name.startsWith("ORANGE_AI_") && name !== "OPENROUTER_API_KEY",
		),
	);
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
		{ env: { ...environment, CI: "1", NO_COLOR: "1" }, stdio: ["ignore", "pipe", "pipe"] },
	);
	let output = "";
	const port = await new Promise<number>((resolveReady, rejectReady) => {
		const timeout = setTimeout(
			() => rejectReady(new Error(`orange dev readiness timed out: ${output}`)),
			60_000,
		);
		const onData = (part: unknown): void => {
			output += String(part);
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
	return {
		origin: `http://127.0.0.1:${port}`,
		output: () => output,
		stop: () =>
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
			}),
	};
}

async function startProject(devVars: string): Promise<{ projectRoot: string; server: DevServer }> {
	const projectRoot = await mkdtemp(join(tmpdir(), "open-orange-ai-"));
	await cp(fixtureWorker, join(projectRoot, "worker.js"));
	await writeFile(
		join(projectRoot, "wrangler.json"),
		JSON.stringify({
			ai: { binding: "AI" },
			compatibility_date: "2026-09-03",
			main: "./worker.js",
			name: "ai-e2e",
		}),
	);
	await writeFile(join(projectRoot, ".dev.vars"), devVars);
	return { projectRoot, server: await startDev(projectRoot) };
}

async function getJson(server: DevServer, path: string): Promise<unknown> {
	const response = await fetch(`${server.origin}${path}`);
	const text = await response.text();
	assert.equal(response.status, 200, `${path}: ${text}\n${server.output()}`);
	return JSON.parse(text);
}

const upstreamError = (message: string) => ({
	error: { inferenceUpstreamError: true, message, name: "InferenceUpstreamError" },
});

describe("Workers AI through orange dev", () => {
	let provider: MockProvider;
	let projectRoot: string;
	let server: DevServer;
	const get = (path: string): Promise<unknown> => getJson(server, path);

	before(async () => {
		provider = await startMockProvider(apiKey);
		({ projectRoot, server } = await startProject(
			[
				`ORANGE_AI_BASE_URL=${provider.baseUrl}`,
				`ORANGE_AI_API_KEY=${apiKey}`,
				`ORANGE_AI_MODELS='${JSON.stringify(testModels)}'`,
			].join("\n"),
		));
	});

	after(async () => {
		try {
			await server?.stop();
		} finally {
			await provider?.close();
			await rm(projectRoot, { force: true, recursive: true });
		}
	});

	it("returns text generation in the Workers AI shape from the mapped provider model", async () => {
		assert.deepEqual(await get("/text"), {
			value: {
				response: "reply from meta-llama/llama-3.1-8b-instruct to hello",
				tool_calls: [
					{
						arguments: { city: "Paris" },
						function: { arguments: '{"city":"Paris"}', name: "weather" },
						id: "call_9",
						name: "weather",
						type: "function",
					},
				],
				usage: { completion_tokens: 4, prompt_tokens: 6, total_tokens: 10 },
			},
		});
	});

	it("rejects with InferenceUpstreamError carrying the provider's 4xx or 5xx message", async () => {
		assert.deepEqual(
			await get("/run?model=@cf/test/rate-limited"),
			upstreamError("429: Rate limit exceeded: free-models-per-day"),
		);
		assert.deepEqual(
			await get("/run?model=@cf/test/broken"),
			upstreamError("500: Internal provider failure"),
		);
		// With returnRawResponse the Worker gets the failed response instead.
		assert.deepEqual(await get("/raw?model=@cf/test/rate-limited"), {
			body: {
				errors: [{ code: 429, message: "Rate limit exceeded: free-models-per-day" }],
				messages: [],
				result: {},
				success: false,
			},
			isResponse: true,
			status: 429,
		});
	});

	it("streams Workers AI server-sent events that reassemble into the provider text", async () => {
		const expected = {
			events: [
				{ response: "Hel" },
				{ response: "lo from mock/text" },
				{
					response: "",
					tool_calls: [
						{
							arguments: { city: "Paris" },
							function: { arguments: '{"city":"Paris"}', name: "weather" },
							id: "call_1",
							name: "weather",
							type: "function",
						},
					],
					usage: { completion_tokens: 3, prompt_tokens: 5, total_tokens: 8 },
				},
				"[DONE]",
			],
			text: "Hello from mock/text",
		};
		assert.deepEqual(await get("/stream?model=@cf/test/text"), expected);
		assert.deepEqual(await get("/stream-raw?model=@cf/test/text"), {
			contentType: "text/event-stream",
			...expected,
		});
	});

	it("fails the stream when the provider reports an error mid-stream", async () => {
		assert.deepEqual(await get("/stream-error?model=@cf/test/stream-broken"), {
			error: {
				inferenceUpstreamError: false,
				message: "The AI provider failed during the stream: Provider died mid-stream",
				name: "Error",
			},
		});
	});

	it("rejects an unmapped model with the fix and never calls another model", async () => {
		const before = provider.requests.length;
		for (const model of ["@cf/baai/bge-small-en-v1.5", "@cf/black-forest-labs/flux-1-schnell"]) {
			assert.deepEqual(
				await get(`/run?model=${model}`),
				upstreamError(
					`5007: Model ${JSON.stringify(model)} has no OpenOrange mapping. Add it to ORANGE_AI_MODELS.`,
				),
			);
		}
		assert.equal(provider.requests.length, before);
	});

	it("returns embeddings from the same model in input order", async () => {
		const requestsBefore = provider.requests.length;
		assert.deepEqual(await get("/embeddings"), {
			data: [
				[0.1, 0.2, 0.3],
				[0.3, 0.4, 0.5],
			],
			shape: [2, 3],
		});
		assert.deepEqual(provider.requests.slice(requestsBefore).map((request) => request.body), [
			{ input: ["first", "second"], model: "baai/bge-base-en-v1.5" },
		]);
	});

	it("serves runs with the gateway option and warns once that gateway features are ignored", async () => {
		const reply = { response: "reply from mock/text to hello", tool_calls: [], usage: { completion_tokens: 4, prompt_tokens: 6, total_tokens: 10 } };
		assert.deepEqual(await get("/gateway?model=@cf/test/text"), [reply, reply]);
		await get("/gateway?model=@cf/test/text");
		const notices = server.output().split("\n").filter((line) => line.includes("AI Gateway option is ignored"));
		assert.equal(notices.length, 1, server.output());
		assert.deepEqual(await get("/gateway-methods"), {
			error: {
				inferenceUpstreamError: false,
				message:
					"env.AI.gateway() is not supported by OpenOrange. Pass the `gateway` option to env.AI.run() instead. OpenOrange ignores gateway caching and logs.",
				name: "NotSupportedError",
			},
		});
	});

	it("keeps each overlapping run's options separate", async () => {
		const results = await Promise.all(
			Array.from({ length: 5 }, () => get("/overlap?model=@cf/test/text")),
		);
		for (const result of results) {
			assert.deepEqual(result, {
				parsed: { response: "reply from mock/text to hello", tool_calls: [], usage: { completion_tokens: 4, prompt_tokens: 6, total_tokens: 10 } },
				rawIsResponse: true,
			});
		}
	});

	it("lists mapped models, including ORANGE_AI_MODELS overrides, in the Workers AI shape", async () => {
		const models = await get("/models");
		assert.ok(Array.isArray(models));
		assert.deepEqual(
			models.map((model: { name: string; task: { name: string } }) => [model.name, model.task.name]),
			Object.keys(testModels).map((name) => [name, "Text Generation"]),
		);
	});

	it("returns OpenAI chat completions and chunks for models with the openai shape", async () => {
		// GLM 4.7 Flash has this shape in the built-in table, and @cf/test/chat
		// gets it from ORANGE_AI_MODELS.
		for (const [model, providerModel] of [
			["@cf/zai-org/glm-4.7-flash", "z-ai/glm-4.7-flash"],
			["@cf/test/chat", "mock/text"],
		] as const) {
			assert.deepEqual(await get(`/chat?model=${model}`), {
				value: chatCompletion(providerModel, [{ content: "hello" }], undefined),
			});
		}
		const chunkEvent = (delta: Record<string, unknown>) => ({ choices: [{ delta, index: 0 }] });
		assert.deepEqual(await get("/chat-stream?model=@cf/zai-org/glm-4.7-flash"), {
			events: [
				chunkEvent({ content: "", role: "assistant" }),
				chunkEvent({ content: "Hel" }),
				chunkEvent({ content: "lo from z-ai/glm-4.7-flash" }),
				chunkEvent({ tool_calls: [{ function: { arguments: "", name: "weather" }, id: "call_1", index: 0, type: "function" }] }),
				chunkEvent({ tool_calls: [{ function: { arguments: '{"city":' }, index: 0 }] }),
				chunkEvent({ tool_calls: [{ function: { arguments: '"Paris"}' }, index: 0 }] }),
				{ choices: [], usage: { completion_tokens: 3, prompt_tokens: 5, total_tokens: 8 } },
				"[DONE]",
			],
			text: "Hello from z-ai/glm-4.7-flash",
		});
	});
});

describe("Workers AI without an API key", () => {
	let localProvider: MockProvider;
	let openRouter: { projectRoot: string; server: DevServer };
	let local: { projectRoot: string; server: DevServer };

	before(async () => {
		localProvider = await startMockProvider();
		[openRouter, local] = await Promise.all([
			// No ORANGE_AI_BASE_URL, so the run targets OpenRouter. It fails
			// before any network call.
			startProject(""),
			startProject(`ORANGE_AI_BASE_URL=${localProvider.baseUrl}`),
		]);
	});

	after(async () => {
		try {
			await Promise.all([openRouter?.server.stop(), local?.server.stop()]);
		} finally {
			await localProvider?.close();
			await Promise.all(
				[openRouter, local].map((project) =>
					project === undefined ? undefined : rm(project.projectRoot, { force: true, recursive: true }),
				),
			);
		}
	});

	it("warns at startup and rejects OpenRouter runs with an error that names the variables", async () => {
		const message =
			"Workers AI needs an API key for https://openrouter.ai/api/v1. Set ORANGE_AI_API_KEY or OPENROUTER_API_KEY in .dev.vars or the environment.";
		assert.deepEqual(
			await getJson(openRouter.server, "/run?model=@cf/meta/llama-3.1-8b-instruct"),
			upstreamError(`10000: ${message}`),
		);
		const warnings = openRouter.server
			.output()
			.split("\n")
			.filter((line) => line.includes("needs an API key"));
		assert.deepEqual(warnings, [`! ${message} Calls to env.AI.run() throw until it is set.`]);
	});

	it("calls a provider at a configured base URL without a key or a warning", async () => {
		assert.deepEqual(await getJson(local.server, "/run?model=@cf/meta/llama-3.1-8b-instruct"), {
			value: {
				response: "reply from meta-llama/llama-3.1-8b-instruct to hello",
				tool_calls: [],
				usage: { completion_tokens: 4, prompt_tokens: 6, total_tokens: 10 },
			},
		});
		assert.deepEqual(
			localProvider.requests.map((request) => request.authorization),
			[undefined],
		);
		assert.doesNotMatch(local.server.output(), /needs an API key/);
	});
});
