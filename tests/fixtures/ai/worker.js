import { InferenceUpstreamError } from "cloudflare:ai";

function failure(error) {
	return {
		inferenceUpstreamError: error instanceof InferenceUpstreamError,
		message: error.message,
		name: error.name,
	};
}

async function attempt(operation) {
	try {
		return { value: await operation() };
	} catch (error) {
		return { error: failure(error) };
	}
}

// Reads a Workers AI event stream the way workers-ai-provider does: one JSON
// payload per `data:` line until `[DONE]`, with text in `response` or in
// `choices[0].delta.content`.
async function readEvents(stream) {
	const text = await new Response(stream).text();
	const events = text
		.split("\n\n")
		.filter((block) => block.length > 0)
		.map((block) => {
			if (!block.startsWith("data: ")) throw new Error(`Not an SSE data event: ${block}`);
			const data = block.slice("data: ".length);
			return data === "[DONE]" ? data : JSON.parse(data);
		});
	return {
		events,
		text: events
			.map((event) =>
				typeof event === "object" ? (event.response ?? event.choices?.[0]?.delta?.content ?? "") : "",
			)
			.join(""),
	};
}

const prompt = { prompt: "hello" };
const messages = [{ content: "hello", role: "user" }];

export default {
	async fetch(request, env) {
		const url = new URL(request.url);
		const model = url.searchParams.get("model");
		let result;
		switch (url.pathname) {
			case "/text":
				result = await attempt(() =>
					env.AI.run("@cf/meta/llama-3.1-8b-instruct", {
						messages: [{ content: "hello", role: "user" }],
						tools: [{ description: "Look up weather", name: "weather", parameters: { type: "object", properties: {}, required: [] } }],
					}),
				);
				break;
			case "/run":
				result = await attempt(() => env.AI.run(model, prompt));
				break;
			case "/chat":
				result = await attempt(() => env.AI.run(model, { messages }));
				break;
			case "/chat-stream": {
				const stream = await env.AI.run(model, { messages, stream: true });
				result = await readEvents(stream);
				break;
			}
			case "/raw": {
				const response = await env.AI.run(model, prompt, { returnRawResponse: true });
				result = { body: await response.json(), isResponse: response instanceof Response, status: response.status };
				break;
			}
			case "/stream": {
				const stream = await env.AI.run(model, { prompt: "hello", stream: true });
				result = await readEvents(stream);
				break;
			}
			case "/stream-raw": {
				const response = await env.AI.run(model, { prompt: "hello", stream: true }, { returnRawResponse: true });
				result = { contentType: response.headers.get("content-type"), ...(await readEvents(response.body)) };
				break;
			}
			case "/stream-error": {
				const stream = await env.AI.run(model, { prompt: "hello", stream: true });
				result = await attempt(() => readEvents(stream));
				break;
			}
			case "/embeddings":
				result = await env.AI.run("@cf/baai/bge-base-en-v1.5", { text: ["first", "second"] });
				break;
			case "/gateway":
				result = await Promise.all([
					env.AI.run(model, prompt, { gateway: { id: "my-gateway" } }),
					env.AI.run(model, prompt, { gateway: { id: "my-gateway", skipCache: true } }),
				]);
				break;
			case "/overlap": {
				// Both calls start before either finishes, on the same env.AI.
				const [raw, parsed] = await Promise.all([
					env.AI.run(model, prompt, { returnRawResponse: true }),
					env.AI.run(model, prompt),
				]);
				result = { parsed, rawIsResponse: raw instanceof Response };
				break;
			}
			case "/models":
				result = await env.AI.models({ search: "@cf/test/" });
				break;
			case "/gateway-methods":
				result = await attempt(() => env.AI.gateway("my-gateway"));
				break;
			default:
				return new Response("not found", { status: 404 });
		}
		return Response.json(result);
	},
};
