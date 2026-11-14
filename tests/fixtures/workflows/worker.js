import { WorkflowEntrypoint } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";

// One Workflow class runs a script of steps from its params, so each scenario is data.
// KV records what ran: `count:<instance>:<step>` counts step bodies, and `gate:<instance>:<name>`
// releases a step that waits for the test.

async function bump(env, instanceId, name) {
	const key = `count:${instanceId}:${name}`;
	const next = Number((await env.KV.get(key)) ?? "0") + 1;
	await env.KV.put(key, String(next));
	return next;
}

async function waitForGate(env, instanceId, gate) {
	for (;;) {
		if ((await env.KV.get(`gate:${instanceId}:${gate}`)) !== null) return;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}

function stepResult(op, context) {
	switch (op.returns) {
		case "bytes":
			return "x".repeat(op.bytes);
		case "function":
			return () => 1;
		case "date":
			return new Date(0);
		case "undefined":
			return undefined;
		case "now":
			return Date.now();
		default:
			return op.value ?? { attempt: context.attempt, step: op.name };
	}
}

async function runOp(op, env, step, instanceId) {
	switch (op.kind) {
		case "do":
			return await step.do(op.name, op.config ?? {}, async (context) => {
				await bump(env, instanceId, op.name);
				if (op.opens !== undefined) await env.KV.put(`gate:${instanceId}:${op.opens}`, "open");
				if (op.gate !== undefined) await waitForGate(env, instanceId, op.gate);
				if (op.busyMs !== undefined) {
					await new Promise((resolve) => setTimeout(resolve, op.busyMs));
				}
				if (op.failUntilAttempt !== undefined && context.attempt < op.failUntilAttempt) {
					throw new Error(`attempt ${context.attempt} failed`);
				}
				if (op.throws !== undefined) {
					if (op.throws.nonRetryable) throw new NonRetryableError(op.throws.message);
					const error = new Error(op.throws.message);
					if (op.throws.name !== undefined) error.name = op.throws.name;
					throw error;
				}
				return stepResult(op, context);
			});
		case "sleep":
			await step.sleep(op.name, op.duration);
			return "slept";
		case "sleepUntil":
			await step.sleepUntil(op.name, new Date(Date.now() + op.inMs));
			return "slept";
		case "wait": {
			const event = await step.waitForEvent(op.name, { type: op.type, timeout: op.timeout });
			if (op.measure) return { payloadLength: event.payload.length, type: event.type };
			return {
				payload: event.payload,
				timestampIsDate: event.timestamp instanceof Date,
				type: event.type,
			};
		}
		case "send":
			return await step.do(op.name, async () => {
				const instance = await env[op.binding].get(instanceId);
				await instance.sendEvent({ payload: op.payload, type: op.type });
				return "sent";
			});
		case "all":
			return await Promise.all(op.ops.map((inner) => runOp(inner, env, step, instanceId)));
		case "catch":
			try {
				return await runOp(op.op, env, step, instanceId);
			} catch (error) {
				return { caught: { message: error.message, name: error.name } };
			}
		case "time":
			return Date.now();
		default:
			throw new Error(`unknown op ${op.kind}`);
	}
}

export class ScriptWorkflow extends WorkflowEntrypoint {
	async run(event, step) {
		const results = [];
		for (const op of event.payload.ops ?? []) {
			results.push(await runOp(op, this.env, step, event.instanceId));
		}
		return { instanceId: event.instanceId, results };
	}
}

function failure(error) {
	return { message: error.message, name: error.name };
}

async function settle(operation) {
	try {
		return { value: await operation() };
	} catch (error) {
		return { error: failure(error) };
	}
}

async function body(request) {
	return request.method === "POST" ? await request.json() : undefined;
}

export default {
	async fetch(request, env) {
		const url = new URL(request.url);
		const binding = env[url.searchParams.get("workflow") ?? "SCRIPT"];
		const id = url.searchParams.get("id") ?? undefined;
		const instance = async () => await binding.get(id);
		let result;
		switch (url.pathname) {
			case "/create": {
				const params = await body(request);
				result = await settle(async () => (await binding.create({ id, params })).id);
				break;
			}
			case "/create-raw":
				result = await settle(async () => (await binding.create(await body(request))).id);
				break;
			case "/create-batch":
				result = await settle(async () => {
					const created = await binding.createBatch(await body(request));
					return Array.isArray(created)
						? created.map((entry) => entry.id)
						: { created: created.created.map((entry) => entry.id), errors: created.errors };
				});
				break;
			case "/delete-batch":
				result = await settle(async () => await binding.deleteBatch(await body(request)));
				break;
			case "/status":
				result = await settle(async () => await (await instance()).status());
				break;
			case "/event": {
				const payload = await body(request);
				result = await settle(async () => {
					await (await instance()).sendEvent({
						payload,
						type: url.searchParams.get("type") ?? "approval",
					});
					return null;
				});
				break;
			}
			case "/event-bytes": {
				const size = Number(url.searchParams.get("bytes"));
				result = await settle(async () => {
					await (await instance()).sendEvent({
						payload: "x".repeat(size),
						type: url.searchParams.get("type") ?? "approval",
					});
					return null;
				});
				break;
			}
			case "/pause":
			case "/resume":
			case "/terminate":
			case "/delete": {
				const method = url.pathname.slice(1);
				result = await settle(async () => (await (await instance())[method]()) ?? null);
				break;
			}
			case "/restart": {
				const options = await body(request);
				result = await settle(async () => (await (await instance()).restart(options)) ?? null);
				break;
			}
			case "/gate":
				await env.KV.put(`gate:${id}:${url.searchParams.get("gate")}`, "open");
				result = { value: null };
				break;
			case "/count":
				result = {
					value: Number((await env.KV.get(`count:${id}:${url.searchParams.get("step")}`)) ?? "0"),
				};
				break;
			default:
				return new Response("not found", { status: 404 });
		}
		return Response.json(result);
	},
};
