import assert from "node:assert/strict";
import test from "node:test";
import { FormData } from "undici";

import type { ExecutionContext } from "../context.js";
import { Request, type RequestInit, Response } from "../globals/http.js";
import { globalManifest } from "../globals/manifest.js";
import { Blob, ReadableStream } from "../globals/native.js";
import { URLSearchParams } from "../globals/url.js";
import { Socket } from "../modules/cloudflare-sockets/socket.js";
import { WorkerEntrypoint } from "../modules/cloudflare-workers/worker-entrypoint.js";
import { loadWorkerEntrypoint, type ServiceBindingOptions } from "../runtime.js";
import { isRecord } from "./unknown-values.js";

// Service bindings are driven through a loaded Worker: the caller is the
// Worker's own fetch handler, and the callee is one of its entrypoints.

type Handler = (
	request: Request,
	env: Record<string, unknown>,
	ctx: ExecutionContext,
) => Promise<Response> | Response;

async function withWorker(
	exports: Record<string, unknown>,
	handler: Handler,
	serviceBindings: ServiceBindingOptions[],
	run: (call: (request: Request) => Promise<Response>) => Promise<void>,
): Promise<void> {
	const descriptors = new Map(
		globalManifest.map((entry) => [
			entry.name,
			Object.getOwnPropertyDescriptor(globalThis, entry.name),
		]),
	);
	try {
		const worker = await loadWorkerEntrypoint({
			importWorker: async () => ({ ...exports, default: { fetch: handler } }),
			serviceBindings,
		});
		await run(async (request) => (await worker.dispatch(request, undefined)).response);
	} finally {
		for (const [name, descriptor] of descriptors) {
			if (descriptor === undefined) Reflect.deleteProperty(globalThis, name);
			else Object.defineProperty(globalThis, name, descriptor);
		}
	}
}

// Stubs and entrypoint factories are functions or Proxies, so members are
// read and called through Reflect.
function callable(value: unknown): (...args: unknown[]) => unknown {
	assert.ok(typeof value === "function");
	return (...args) => Reflect.apply(value, undefined, args);
}

function method(target: unknown, name: string): (...args: unknown[]) => unknown {
	assert.ok((typeof target === "object" && target !== null) || typeof target === "function");
	const member: unknown = Reflect.get(target, name);
	assert.ok(typeof member === "function", `${name}() is not a function`);
	return (...args) => Reflect.apply(member, target, args);
}

async function responseOf(value: unknown): Promise<Response> {
	const response = await value;
	assert.ok(response instanceof Response);
	return response;
}

function socketOf(value: unknown): Socket {
	assert.ok(value instanceof Socket);
	return value;
}

interface ServiceBinding {
	fetch(input: string, init?: RequestInit | Record<string, unknown>): Promise<Response>;
}

function service(env: Record<string, unknown>): ServiceBinding {
	const fetch = method(env.SERVICE, "fetch");
	return { fetch: (input, init) => responseOf(fetch(input, init)) };
}

test("delivers every request body type to the entrypoint with its content type", async () => {
	class Echo extends WorkerEntrypoint {
		async fetch(request: Request): Promise<Response> {
			return Response.json({
				body: await request.text(),
				contentType: request.headers.get("content-type"),
				method: request.method,
			});
		}
	}
	const form = new FormData();
	form.set("field", "value");
	const bodies: [string, unknown][] = [
		["string", "text body"],
		["arrayBuffer", new TextEncoder().encode("bytes").buffer],
		["view", new TextEncoder().encode("view")],
		["search", new URLSearchParams({ a: "1", b: "two" })],
		["blob", new Blob(["blob body"], { type: "text/custom" })],
		[
			"stream",
			new ReadableStream({
				start(controller: ReadableStreamDefaultController<Uint8Array>) {
					controller.enqueue(new TextEncoder().encode("str"));
					controller.enqueue(new TextEncoder().encode("eamed"));
					controller.close();
				},
			}),
		],
		["form", form],
	];
	await withWorker(
		{ Echo },
		async (_request, env) => {
			const results: Record<string, unknown> = {};
			for (const [name, body] of bodies) {
				const init: Record<string, unknown> = { body, method: "POST" };
				if (name === "stream") init.duplex = "half";
				const response = await service(env).fetch("https://service.example/", init);
				results[name] = await response.json();
			}
			return Response.json(results);
		},
		[{ binding: "SERVICE", entrypoint: "Echo" }],
		async (call) => {
			const results: unknown = await (await call(new Request("https://caller.example/"))).json();
			assert.ok(isRecord(results));
			assert.deepEqual(results.string, {
				body: "text body",
				contentType: "text/plain;charset=UTF-8",
				method: "POST",
			});
			assert.deepEqual(results.arrayBuffer, { body: "bytes", contentType: null, method: "POST" });
			assert.deepEqual(results.view, { body: "view", contentType: null, method: "POST" });
			assert.deepEqual(results.search, {
				body: "a=1&b=two",
				contentType: "application/x-www-form-urlencoded;charset=UTF-8",
				method: "POST",
			});
			assert.deepEqual(results.blob, { body: "blob body", contentType: "text/custom", method: "POST" });
			assert.deepEqual(results.stream, { body: "streamed", contentType: null, method: "POST" });
			const form = results.form;
			assert.ok(isRecord(form));
			assert.match(String(form.contentType), /^multipart\/form-data; boundary=/);
			assert.match(String(form.body), /name="field"\r\n\r\nvalue\r\n/);
		},
	);
});

test("follows redirects through the entrypoint like workerd's fetch()", async () => {
	class Redirector extends WorkerEntrypoint {
		async fetch(request: Request): Promise<Response> {
			const url = new URL(request.url);
			switch (url.pathname) {
				case "/found":
					return Response.redirect("https://service.example/landing", 302);
				case "/temporary":
					return Response.redirect("https://service.example/landing", 307);
				case "/cross-origin":
					return Response.redirect("https://elsewhere.example/landing", 307);
				case "/loop":
					return Response.redirect("https://service.example/loop", 301);
				default:
					return Response.json({
						authorization: request.headers.get("authorization"),
						body: await request.text(),
						method: request.method,
					});
			}
		}
	}
	const outcome = async (response: Promise<Response>) => {
		try {
			const result = await response;
			return {
				body: result.status === 200 ? await result.json() : result.headers.get("location"),
				redirected: result.redirected,
				status: result.status,
				url: result.url,
			};
		} catch (error: unknown) {
			assert.ok(error instanceof Error);
			return { message: error.message, name: error.name };
		}
	};
	await withWorker(
		{ Redirector },
		async (_request, env) => {
			const target = service(env);
			const headers = { authorization: "Bearer secret" };
			const streamBody = (): ReadableStream<Uint8Array> =>
				new ReadableStream({
					start(controller: ReadableStreamDefaultController<Uint8Array>) {
						controller.enqueue(new TextEncoder().encode("streamed"));
						controller.close();
					},
				});
			return Response.json({
				crossOrigin: await outcome(
					target.fetch("https://service.example/cross-origin", { headers }),
				),
				loop: await outcome(target.fetch("https://service.example/loop")),
				manual: await outcome(
					target.fetch("https://service.example/found", { redirect: "manual" }),
				),
				postFound: await outcome(
					target.fetch("https://service.example/found", { body: "form", headers, method: "POST" }),
				),
				putTemporary: await outcome(
					target.fetch("https://service.example/temporary", { body: "again", method: "PUT" }),
				),
				streamTemporary: await outcome(
					target.fetch("https://service.example/temporary", {
						body: streamBody(),
						duplex: "half",
						method: "PUT",
					}),
				),
				unredirected: await outcome(target.fetch("https://service.example/plain#fragment")),
			});
		},
		[{ binding: "SERVICE", entrypoint: "Redirector" }],
		async (call) => {
			const landing = "https://service.example/landing";
			assert.deepEqual(await (await call(new Request("https://caller.example/"))).json(), {
				crossOrigin: {
					body: { authorization: null, body: "", method: "GET" },
					redirected: true,
					status: 200,
					url: "https://elsewhere.example/landing",
				},
				loop: { message: "Too many redirects.", name: "TypeError" },
				manual: {
					body: landing,
					redirected: false,
					status: 302,
					url: "https://service.example/found",
				},
				// A 302 after POST becomes a GET without the body.
				postFound: {
					body: { authorization: "Bearer secret", body: "", method: "GET" },
					redirected: true,
					status: 200,
					url: landing,
				},
				// A 307 sends a buffered body again with the same method.
				putTemporary: {
					body: { authorization: null, body: "again", method: "PUT" },
					redirected: true,
					status: 200,
					url: landing,
				},
				streamTemporary: {
					message:
						"A request with a one-time-use body (it was initialized from a stream, not a buffer) encountered a redirect requiring the body to be retransmitted. To avoid this error in the future, construct this request from a buffer-like body initializer.",
					name: "TypeError",
				},
				unredirected: {
					body: { authorization: null, body: "", method: "GET" },
					redirected: false,
					status: 200,
					url: "https://service.example/plain",
				},
			});
		},
	);
});

test("aborting the caller's request disconnects the entrypoint and rejects the caller", async () => {
	const calleeSignals: AbortSignal[] = [];
	const calleeStarted = Promise.withResolvers<void>();
	class Slow extends WorkerEntrypoint {
		fetch(request: Request): Promise<Response> {
			calleeSignals.push(request.signal);
			calleeStarted.resolve();
			return new Promise(() => undefined);
		}
	}
	await withWorker(
		{ Slow },
		async (_request, env) => {
			const controller = new AbortController();
			const pending = service(env).fetch("https://service.example/", {
				signal: controller.signal,
			});
			await calleeStarted.promise;
			controller.abort(new Error("caller gave up"));
			const outcome = await pending.then(
				() => "resolved",
				(error: Error) => error.message,
			);
			const calleeReason: unknown = calleeSignals[0]?.reason;
			assert.ok(typeof calleeReason === "object" && calleeReason !== null);
			return Response.json({
				calleeAborted: calleeSignals[0]?.aborted,
				calleeReason: {
					message: Reflect.get(calleeReason, "message"),
					name: Reflect.get(calleeReason, "name"),
				},
				outcome,
			});
		},
		[{ binding: "SERVICE", entrypoint: "Slow" }],
		async (call) => {
			assert.deepEqual(await (await call(new Request("https://caller.example/"))).json(), {
				calleeAborted: true,
				calleeReason: { message: "The client has disconnected", name: "AbortError" },
				outcome: "caller gave up",
			});
		},
	);
});

test("overlapping calls with different props each see only their own props", async () => {
	class Tenant extends WorkerEntrypoint<unknown, { tenant: string }> {
		async whoAmI(delayMs: number): Promise<string> {
			await new Promise((resolve) => setTimeout(resolve, delayMs));
			return this.ctx.props.tenant;
		}

		async fetch(): Promise<Response> {
			await new Promise((resolve) => setTimeout(resolve, 5));
			return new Response(this.ctx.props.tenant);
		}
	}
	await withWorker(
		{ Tenant },
		async (_request, env, ctx) => {
			const tenantStub = callable(Reflect.get(ctx.exports, "Tenant"));
			const stubs = ["a", "b", "c"].map((tenant) => tenantStub({ props: { tenant } }));
			// Staggered delays make the calls overlap and finish in reverse order.
			const rpc = await Promise.all(
				stubs.map((stub, index) => method(stub, "whoAmI")(15 - index * 5)),
			);
			const fetched = await Promise.all(
				stubs.map(async (stub) =>
					(await responseOf(method(stub, "fetch")("https://tenant.example/"))).text(),
				),
			);
			const configured = await method(env.CONFIGURED, "whoAmI")(0);
			return Response.json({ configured, fetched, rpc });
		},
		[{ binding: "CONFIGURED", entrypoint: "Tenant", props: { tenant: "from-config" } }],
		async (call) => {
			assert.deepEqual(await (await call(new Request("https://caller.example/"))).json(), {
				configured: "from-config",
				fetched: ["a", "b", "c"],
				rpc: ["a", "b", "c"],
			});
		},
	);
});

test("connect() reaches the entrypoint's connect handler and ends the socket when the handler returns", async () => {
	const lateWrite = Promise.withResolvers<string>();
	class Greeter extends WorkerEntrypoint {
		async connect(socket: Socket): Promise<void> {
			const writer = socket.writable.getWriter();
			await writer.write(new TextEncoder().encode(`hello ${(await socket.opened).localAddress}`));
			// A write after the handler returns must fail, not reach the caller.
			setImmediate(() => {
				writer.write(new Uint8Array([1])).then(
					() => lateWrite.resolve("written"),
					(error: Error) => lateWrite.resolve(error.message),
				);
			});
		}
	}
	class NoHandler extends WorkerEntrypoint {}
	await withWorker(
		{ Greeter, NoHandler },
		async (_request, env) => {
			const socket = socketOf(method(env.SERVICE, "connect")("db.internal:5432"));
			const info = await socket.opened;
			const text = await new Response(socket.readable).text();
			await socket.closed;
			const missing = socketOf(method(env.MISSING, "connect")("db.internal:5432"));
			const missingOutcome = await missing.opened.then(
				() => "opened",
				(error: Error) => error.message,
			);
			return Response.json({ info, lateWrite: await lateWrite.promise, missingOutcome, text });
		},
		[
			{ binding: "SERVICE", entrypoint: "Greeter" },
			{ binding: "MISSING", entrypoint: "NoHandler" },
		],
		async (call) => {
			assert.deepEqual(await (await call(new Request("https://caller.example/"))).json(), {
				info: { remoteAddress: "db.internal:5432" },
				lateWrite: "Can't read from request stream because client disconnected.",
				missingOutcome: "proxy request failed, cannot connect to the specified address",
				text: "hello db.internal:5432",
			});
		},
	);
});
