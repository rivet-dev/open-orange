import { fetch as providerFetch, type Response as ProviderResponse } from "undici";

import { Headers, Response } from "../../globals/http.js";
import type { SecretSource } from "../secrets-store.js";
import {
	type AiModelMapping,
	type AiModelTask,
	type AiResponseShape,
	aiModelsVariable,
	resolveAiModels,
} from "./models.js";
import { errorMessage, isRecord } from "../unknown-values.js";

// The in-process backend behind `env.AI`. It accepts the requests that
// workerd's AI client sends to Cloudflare's AI service and translates them to
// an OpenAI-compatible provider, OpenRouter by default.
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/cloudflare/internal/ai-api.ts#L165-L197

export const aiBaseUrlVariable = "ORANGE_AI_BASE_URL";
export const aiApiKeyVariable = "ORANGE_AI_API_KEY";
export const openRouterApiKeyVariable = "OPENROUTER_API_KEY";
export const defaultBaseUrl = "https://openrouter.ai/api/v1";

// Cloudflare error codes, so the client builds the same `<code>: <message>`
// text as on Cloudflare.
const invalidInputCode = 5006;
const unknownModelCode = 5007;
const authenticationCode = 10000;
const internalErrorCode = 3000;

export interface AiFetcher {
	fetch(input: string | URL, init?: AiFetchInit): Promise<Response>;
}

export interface AiFetchInit {
	body?: unknown;
	headers?: Record<string, string>;
	method?: string;
	signal?: AbortSignal;
}

export interface AiBackendOptions {
	source: SecretSource;
	// Receives one line per provider call and one-time notices.
	log(line: string): void;
}

interface AiProviderConfig {
	apiKey: string | undefined;
	baseUrl: string;
	// Only the default provider requires a key. A provider at a configured
	// base URL, such as a local server, may need none.
	requiresApiKey: boolean;
	models: Map<string, AiModelMapping>;
}

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		headers: { "content-type": "application/json" },
		status,
	});
}

// The error body that workerd's client turns into `InferenceUpstreamError`.
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/cloudflare/internal/ai-api.ts#L368-L393
function errorResponse(status: number, code: number, message: string): Response {
	return jsonResponse(
		{ errors: [{ code, message }], messages: [], result: {}, success: false },
		status,
	);
}

class AiBackendError extends Error {
	constructor(
		readonly status: number,
		readonly code: number,
		message: string,
	) {
		super(message);
	}
}

const taskNames: Readonly<Record<AiModelTask, string>> = {
	embeddings: "Text Embeddings",
	text: "Text Generation",
};

const forwardedTextInputs = [
	"frequency_penalty",
	"max_tokens",
	"presence_penalty",
	"repetition_penalty",
	"seed",
	"temperature",
	"top_k",
	"top_p",
] as const;

// Legacy Workers AI tools are `{name, description, parameters}`. OpenAI tools
// wrap the same fields in `{type: "function", function}`.
function providerTool(tool: unknown): unknown {
	if (!isRecord(tool) || tool.function !== undefined) return tool;
	return { function: tool, type: "function" };
}

// Workers AI takes the JSON schema itself. OpenAI-compatible providers take it
// under `json_schema.schema` with a name.
function providerResponseFormat(format: unknown): unknown {
	if (
		!isRecord(format) ||
		format.type !== "json_schema" ||
		!isRecord(format.json_schema) ||
		format.json_schema.schema !== undefined
	) {
		return format;
	}
	return { json_schema: { name: "response", schema: format.json_schema }, type: "json_schema" };
}

function chatCompletionBody(
	mapping: AiModelMapping,
	inputs: Record<string, unknown>,
): Record<string, unknown> {
	let messages: unknown;
	if (Array.isArray(inputs.messages)) {
		messages = inputs.messages;
	} else if (typeof inputs.prompt === "string") {
		messages = [{ content: inputs.prompt, role: "user" }];
	} else if (inputs.input !== undefined) {
		throw new AiBackendError(
			400,
			invalidInputCode,
			"OpenOrange does not support Responses API input (`input`) yet. Pass `messages` instead.",
		);
	} else {
		throw new AiBackendError(
			400,
			invalidInputCode,
			"Text generation needs a `prompt` string or a `messages` array.",
		);
	}
	// Chat completion models take OpenAI's request fields, so they pass through.
	if (mapping.shape === "openai") {
		const { prompt: _prompt, ...rest } = inputs;
		return { ...rest, messages, model: mapping.model };
	}
	const body: Record<string, unknown> = { messages, model: mapping.model };
	for (const key of forwardedTextInputs) {
		if (inputs[key] !== undefined) body[key] = inputs[key];
	}
	if (Array.isArray(inputs.tools)) body.tools = inputs.tools.map(providerTool);
	if (inputs.response_format !== undefined) {
		body.response_format = providerResponseFormat(inputs.response_format);
	}
	if (inputs.stream === true) body.stream = true;
	return body;
}

interface CloudflareToolCall {
	arguments: unknown;
	function: { arguments: string; name: string };
	id: string;
	name: string;
	type: "function";
}

function parsedArguments(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}

// Workers AI declares each tool call as both its legacy `{name, arguments}`
// shape and the OpenAI `{id, type, function}` shape, so it carries both.
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/types/defines/ai.d.ts#L190-L218
function cloudflareToolCall(id: string, name: string, args: string): CloudflareToolCall {
	return {
		arguments: parsedArguments(args),
		function: { arguments: args, name },
		id,
		name,
		type: "function",
	};
}

function cloudflareUsage(usage: unknown): Record<string, number> | undefined {
	if (!isRecord(usage)) return undefined;
	const tokens = (value: unknown): number => (typeof value === "number" ? value : 0);
	return {
		completion_tokens: tokens(usage.completion_tokens),
		prompt_tokens: tokens(usage.prompt_tokens),
		total_tokens: tokens(usage.total_tokens),
	};
}

function textGenerationResult(body: unknown): Record<string, unknown> {
	const choice = isRecord(body) && Array.isArray(body.choices) ? body.choices[0] : undefined;
	const message = isRecord(choice) && isRecord(choice.message) ? choice.message : {};
	const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
	const result: Record<string, unknown> = {
		response: typeof message.content === "string" ? message.content : "",
		tool_calls: toolCalls.flatMap((call: unknown, index: number) => {
			if (!isRecord(call) || !isRecord(call.function)) return [];
			const name = typeof call.function.name === "string" ? call.function.name : "";
			const args = typeof call.function.arguments === "string" ? call.function.arguments : "{}";
			const id = typeof call.id === "string" ? call.id : `call_${index}`;
			return [cloudflareToolCall(id, name, args)];
		}),
	};
	const usage = isRecord(body) ? cloudflareUsage(body.usage) : undefined;
	if (usage !== undefined) result.usage = usage;
	return result;
}

function embeddingsResult(body: unknown): Record<string, unknown> {
	const entries = isRecord(body) && Array.isArray(body.data) ? body.data : [];
	const vectors = entries
		.filter(
			(entry): entry is { embedding: number[]; index: number } =>
				isRecord(entry) && Array.isArray(entry.embedding) && typeof entry.index === "number",
		)
		.sort((left, right) => left.index - right.index)
		.map((entry) => entry.embedding);
	return { data: vectors, shape: [vectors.length, vectors[0]?.length ?? 0] };
}

interface StreamedToolCall {
	arguments: string;
	id: string;
	name: string;
}

// Rewrites an OpenAI-compatible SSE stream into Workers AI's stream. The
// `legacy` shape sends `data: {"response": "..."}` events, then one event with
// any tool calls and usage. The `openai` shape forwards each chunk. Both end
// with `data: [DONE]`, and a provider error event fails the stream. Both
// framings are the ones workers-ai-provider parses.
// https://github.com/cloudflare/ai/blob/0e5bc3b2f489e4b8215905812a36fe69d37afb8d/packages/workers-ai-provider/src/streaming.ts#L67-L69
function cloudflareEventStream(
	upstream: ReadableStream<Uint8Array>,
	shape: AiResponseShape,
): ReadableStream<Uint8Array> {
	const reader = upstream.getReader();
	const decoder = new TextDecoder();
	const encoder = new TextEncoder();
	const toolCalls = new Map<number, StreamedToolCall>();
	let usage: Record<string, number> | undefined;
	let buffered = "";
	let dataLines: string[] = [];
	let done = false;
	let produced = false;

	const emit = (controller: ReadableStreamDefaultController<Uint8Array>, data: unknown): void => {
		produced = true;
		controller.enqueue(
			encoder.encode(`data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`),
		);
	};

	const finish = (controller: ReadableStreamDefaultController<Uint8Array>): void => {
		done = true;
		if (toolCalls.size > 0 || usage !== undefined) {
			const last: Record<string, unknown> = { response: "" };
			if (toolCalls.size > 0) {
				last.tool_calls = [...toolCalls.entries()]
					.sort(([left], [right]) => left - right)
					.map(([, call]) => cloudflareToolCall(call.id, call.name, call.arguments));
			}
			if (usage !== undefined) last.usage = usage;
			emit(controller, last);
		}
		emit(controller, "[DONE]");
		controller.close();
		void reader.cancel().catch(() => {});
	};

	const dispatch = (data: string, controller: ReadableStreamDefaultController<Uint8Array>): void => {
		if (data === "[DONE]") {
			finish(controller);
			return;
		}
		let chunk: unknown;
		try {
			chunk = JSON.parse(data);
		} catch {
			return;
		}
		if (!isRecord(chunk)) return;
		if (chunk.error !== undefined) {
			const message = isRecord(chunk.error) && typeof chunk.error.message === "string"
				? chunk.error.message
				: JSON.stringify(chunk.error);
			throw new Error(`The AI provider failed during the stream: ${message}`);
		}
		if (shape === "openai") {
			emit(controller, data);
			return;
		}
		usage = cloudflareUsage(chunk.usage) ?? usage;
		const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : undefined;
		const delta = isRecord(choice) && isRecord(choice.delta) ? choice.delta : undefined;
		if (delta === undefined) return;
		if (typeof delta.content === "string" && delta.content.length > 0) {
			emit(controller, { response: delta.content });
		}
		if (Array.isArray(delta.tool_calls)) {
			for (const call of delta.tool_calls) {
				if (!isRecord(call)) continue;
				const index = typeof call.index === "number" ? call.index : toolCalls.size;
				const current = toolCalls.get(index) ?? { arguments: "", id: `call_${index}`, name: "" };
				if (typeof call.id === "string") current.id = call.id;
				if (isRecord(call.function)) {
					if (typeof call.function.name === "string") current.name += call.function.name;
					if (typeof call.function.arguments === "string") {
						current.arguments += call.function.arguments;
					}
				}
				toolCalls.set(index, current);
			}
		}
	};

	// SSE: `data:` lines accumulate until a blank line ends the event. Comment
	// lines, such as OpenRouter's `: OPENROUTER PROCESSING`, are skipped.
	const consumeLines = (controller: ReadableStreamDefaultController<Uint8Array>): void => {
		let newline = buffered.indexOf("\n");
		while (newline !== -1 && !done) {
			const line = buffered.slice(0, newline).replace(/\r$/, "");
			buffered = buffered.slice(newline + 1);
			if (line.length === 0) {
				if (dataLines.length > 0) {
					const data = dataLines.join("\n");
					dataLines = [];
					dispatch(data, controller);
				}
			} else if (line.startsWith("data:")) {
				dataLines.push(line.slice(5).replace(/^ /, ""));
			}
			newline = buffered.indexOf("\n");
		}
	};

	return new ReadableStream<Uint8Array>({
		async pull(controller): Promise<void> {
			produced = false;
			try {
				// Stop once a read produced output so the consumer sets the pace.
				while (!done && !produced) {
					const { done: upstreamDone, value } = await reader.read();
					buffered += upstreamDone ? `${decoder.decode()}\n\n` : decoder.decode(value, { stream: true });
					consumeLines(controller);
					if (upstreamDone && !done) finish(controller);
				}
			} catch (error: unknown) {
				done = true;
				void reader.cancel(error).catch(() => {});
				throw error;
			}
		},
		async cancel(reason): Promise<void> {
			done = true;
			await reader.cancel(reason);
		},
	});
}

async function providerErrorMessage(response: ProviderResponse): Promise<string> {
	const text = await response.text();
	try {
		const body: unknown = JSON.parse(text);
		if (isRecord(body) && isRecord(body.error) && typeof body.error.message === "string") {
			return body.error.message;
		}
		if (isRecord(body) && typeof body.message === "string") return body.message;
	} catch {}
	return text.length > 0 ? text : `HTTP ${response.status}`;
}

async function resolveApiKey(source: SecretSource): Promise<string | undefined> {
	const apiKey =
		(await source.resolve(aiApiKeyVariable)) ?? (await source.resolve(openRouterApiKeyVariable));
	return apiKey === undefined || apiKey.length === 0 ? undefined : apiKey;
}

function missingApiKeyMessage(baseUrl: string): string {
	return `Workers AI needs an API key for ${baseUrl}. Set ${aiApiKeyVariable} or ${openRouterApiKeyVariable} in .dev.vars or the environment.`;
}

// The startup warning for an `ai` binding without an API key.
export async function aiApiKeyWarning(
	binding: string,
	source: SecretSource,
): Promise<string | undefined> {
	if ((await resolveApiKey(source)) !== undefined) return undefined;
	if ((await source.resolve(aiBaseUrlVariable)) !== undefined) return undefined;
	return `${missingApiKeyMessage(defaultBaseUrl)} Calls to env.${binding}.run() throw until it is set.`;
}

export function createAiBackend(options: AiBackendOptions): AiFetcher {
	let gatewayNoticeLogged = false;

	async function resolveConfig(): Promise<AiProviderConfig> {
		const { source } = options;
		const configuredBaseUrl = await source.resolve(aiBaseUrlVariable);
		const baseUrl = configuredBaseUrl ?? defaultBaseUrl;
		const apiKey = await resolveApiKey(source);
		let models: Map<string, AiModelMapping>;
		try {
			models = resolveAiModels(await source.resolve(aiModelsVariable));
		} catch (error: unknown) {
			throw new AiBackendError(
				500,
				internalErrorCode,
				errorMessage(error),
			);
		}
		return {
			apiKey,
			baseUrl: baseUrl.replace(/\/+$/, ""),
			models,
			requiresApiKey: configuredBaseUrl === undefined,
		};
	}

	async function run(init: AiFetchInit | undefined): Promise<Response> {
		const headers = new Headers(init?.headers);
		const name = headers.get("cf-consn-model-id") ?? "";
		const config = await resolveConfig();
		const mapping = config.models.get(name);
		if (mapping === undefined) {
			throw new AiBackendError(
				400,
				unknownModelCode,
				`Model ${JSON.stringify(name)} has no OpenOrange mapping. Add it to ${aiModelsVariable}.`,
			);
		}
		if (config.apiKey === undefined && config.requiresApiKey) {
			throw new AiBackendError(401, authenticationCode, missingApiKeyMessage(config.baseUrl));
		}
		if (headers.get("content-type") !== "application/json" || typeof init?.body !== "string") {
			throw new AiBackendError(
				400,
				invalidInputCode,
				"OpenOrange sends only JSON inputs to the AI provider.",
			);
		}
		const request: unknown = JSON.parse(init.body);
		const inputs = isRecord(request) && isRecord(request.inputs) ? request.inputs : {};
		let path: string;
		let body: Record<string, unknown>;
		if (mapping.task === "text") {
			path = "/chat/completions";
			body = chatCompletionBody(mapping, inputs);
		} else {
			const text = inputs.text;
			if (typeof text !== "string" && !Array.isArray(text)) {
				throw new AiBackendError(
					400,
					invalidInputCode,
					"Text embeddings need a `text` string or array of strings.",
				);
			}
			path = "/embeddings";
			body = { input: typeof text === "string" ? [text] : text, model: mapping.model };
		}

		const startedAt = performance.now();
		let response: ProviderResponse;
		try {
			response = await providerFetch(`${config.baseUrl}${path}`, {
				body: JSON.stringify(body),
				headers: {
					...(config.apiKey === undefined ? {} : { authorization: `Bearer ${config.apiKey}` }),
					"content-type": "application/json",
				},
				method: "POST",
				...(init.signal === undefined ? {} : { signal: init.signal }),
			});
		} catch (error: unknown) {
			if (init.signal?.aborted === true) throw error;
			throw new AiBackendError(
				502,
				internalErrorCode,
				`Could not reach the AI provider at ${config.baseUrl}: ${errorMessage(error)}`,
			);
		}
		options.log(
			`${name} -> ${mapping.model} ${response.status} ${Math.round(performance.now() - startedAt)}ms`,
		);
		if (!response.ok) {
			throw new AiBackendError(
				response.status,
				response.status,
				await providerErrorMessage(response),
			);
		}
		if (body.stream === true && response.body !== null) {
			return new Response(cloudflareEventStream(response.body, mapping.shape), {
				headers: { "content-type": "text/event-stream" },
			});
		}
		const result: unknown = await response.json();
		if (mapping.task === "embeddings") return jsonResponse(embeddingsResult(result));
		return jsonResponse(mapping.shape === "openai" ? result : textGenerationResult(result));
	}

	async function searchModels(url: URL): Promise<Response> {
		const { models } = await resolveConfig();
		const search = url.searchParams.get("search")?.toLowerCase();
		const task = url.searchParams.get("task")?.toLowerCase();
		const result = [...models.entries()]
			.filter(
				([name, mapping]) =>
					(search === undefined || name.toLowerCase().includes(search)) &&
					(task === undefined || taskNames[mapping.task].toLowerCase() === task),
			)
			.map(([name, mapping]) => ({
				description: `Served by OpenOrange as ${mapping.model}.`,
				id: name,
				name,
				properties: [],
				source: 1,
				tags: [],
				task: { description: "", id: mapping.task, name: taskNames[mapping.task] },
			}));
		return jsonResponse({ result, success: true });
	}

	return {
		async fetch(input, init): Promise<Response> {
			const url = new URL(String(input));
			try {
				if (url.pathname === "/run" && init?.method === "POST") return await run(init);
				if (url.pathname === "/ai-gateway/run" && init?.method === "POST") {
					if (!gatewayNoticeLogged) {
						gatewayNoticeLogged = true;
						options.log(
							"the AI Gateway option is ignored. Requests go to the provider directly, without gateway caching or logs.",
						);
					}
					return await run(init);
				}
				if (url.pathname === "/ai-api/models/search") return await searchModels(url);
				return errorResponse(
					404,
					internalErrorCode,
					`OpenOrange's Workers AI backend does not serve ${url.pathname}.`,
				);
			} catch (error: unknown) {
				if (error instanceof AiBackendError) {
					return errorResponse(error.status, error.code, error.message);
				}
				throw error;
			}
		},
	};
}
