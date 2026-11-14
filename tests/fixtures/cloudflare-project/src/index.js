import { Ai, InferenceUpstreamError } from "cloudflare:ai";
import { BrowserRendering } from "cloudflare:br";
import { EmailMessage } from "cloudflare:email";
import { PipelineTransformationEntrypoint } from "cloudflare:pipelines";
import { DistanceMetric } from "cloudflare:vectorize";
import { DurableObject, tracing, WorkflowEntrypoint } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import runtime from "#runtime";
import generated from "../generated/build.txt";
import data from "./data.bin";
import wasm from "./empty.wasm";
import legacy from "./legacy.cjs";
import page from "./page.html";

export class Counter extends DurableObject {
	increment() {
		const count = (this.ctx.storage.kv.get("count") ?? 0) + 1;
		this.ctx.storage.kv.put("count", count);
		return count;
	}

	tracingType() {
		return typeof this.ctx.tracing;
	}

	async incrementThroughExports(name) {
		const namespace = this.ctx.exports.Counter;
		return await namespace.get(namespace.idFromName(name)).increment();
	}
}

export class Pipeline extends WorkflowEntrypoint {
	async run() {}
}

export class Transform extends PipelineTransformationEntrypoint {}

function errorOf(callback) {
	try {
		callback();
	} catch (error) {
		return `${error.name}: ${error.message}`;
	}
	return null;
}

export default {
	async fetch(request, env, ctx) {
		env.EVENTS.writeDataPoint({ blobs: ["request"] });
		const counter = env.COUNTER.get(env.COUNTER.idFromName("main"));
		return Response.json({
			aiService: errorOf(() => new Ai(env.AI)),
			cached: (await caches.default.match(request)) ?? null,
			cloudflareModules: [
				new InferenceUpstreamError("upstream").name,
				typeof BrowserRendering,
				typeof PipelineTransformationEntrypoint,
				DistanceMetric.COSINE,
			],
			colo: request.cf?.colo ?? null,
			connectingIp: request.headers.get("cf-connecting-ip"),
			data: data instanceof ArrayBuffer ? [...new Uint8Array(data)] : null,
			emailFrom: new EmailMessage("from@example.com", "to@example.com", "raw").from,
			env: { GREETING: process.env.GREETING, SETTINGS: process.env.SETTINGS },
			generated,
			legacy,
			nonRetryable: new NonRetryableError("stop").name,
			page,
			runtime,
			throughExports: await counter.incrementThroughExports("other"),
			traced: await ctx.tracing.enterSpan(
				"load",
				async (span, suffix) => `${span.isTraced}${suffix}`,
				"!",
			),
			tracedFailure: errorOf(() =>
				tracing.enterSpan("fail", () => {
					throw new TypeError("traced failure");
				}),
			),
			objectTracing: await counter.tracingType(),
			wasm: wasm instanceof WebAssembly.Module,
		});
	},
	async scheduled() {},
};
