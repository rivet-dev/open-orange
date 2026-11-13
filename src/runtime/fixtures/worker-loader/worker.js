import { abortIsolate, DurableObject, WorkerEntrypoint } from "cloudflare:workers";

globalThis.parentMarker = "parent-only";

export class EngineUser extends DurableObject {}

const filesystemCode = {
	compatibilityDate: "2026-09-03",
	mainModule: "main.js",
	modules: {
		"main.js": `
			import { createRequire } from "node:module";
			const fs = createRequire(import.meta.url)("fs");
			export default {
				write(path) { fs.writeFileSync(path, "dynamic secret"); return fs.readFileSync(path, "utf8"); },
				read(path) {
					try { return { content: fs.readFileSync(path, "utf8") }; } catch (error) { return { error: error.code ?? error.message }; }
				},
			};
		`,
	},
};

// Reports what a dynamic Worker can see of any other dynamic Worker: a file,
// a global, process.env, and the VM's Worker roots. Then it leaves its own,
// and tries to change Orange's runtime, which every VM reads from the host.
const poolProbeCode = (id, globalOutbound) => ({
	compatibilityDate: "2026-09-03",
	mainModule: "main.js",
	env: { ["POOL_SECRET_" + id]: id },
	globalOutbound,
	modules: {
		"main.js": `
			import { createRequire } from "node:module";
			const fs = createRequire(import.meta.url)("fs");
			const seenGlobal = globalThis.poolProbe ?? null;
			globalThis.poolProbe = ${JSON.stringify(id)};
			export default {
				probe() {
					let file;
					try { file = fs.readFileSync("/tmp/pool-probe.txt", "utf8"); } catch (error) { file = error.code; }
					fs.writeFileSync("/tmp/pool-probe.txt", ${JSON.stringify(id)});
					let runtime;
					try { fs.writeFileSync("/open-orange/runtime/manifest.json", "{}"); runtime = "written"; } catch (error) { runtime = error.code; }
					return {
						env: Object.keys(process.env).filter((key) => key.startsWith("POOL_SECRET_")),
						file,
						global: seenGlobal,
						id: ${JSON.stringify(id)},
						runtime,
						workerRoots: fs.readdirSync("/open-orange/workers").length,
					};
				},
			};
		`,
	},
});

const loopbackCode = (globalOutbound) => ({
	compatibilityDate: "2026-09-03",
	mainModule: "main.js",
	modules: {
		"main.js": `
			import { createRequire } from "node:module";
			const net = createRequire(import.meta.url)("net");
			function connect(port) {
				return new Promise((resolve) => {
					const socket = net.connect({ host: "127.0.0.1", port });
					const timer = setTimeout(() => { socket.destroy(); resolve("timed out"); }, 3000);
					socket.once("connect", () => { clearTimeout(timer); socket.destroy(); resolve("connected"); });
					socket.once("error", (error) => { clearTimeout(timer); resolve(error.code ?? error.message); });
				});
			}
			export default {
				async probe(ports) {
					const results = {};
					for (const port of ports) {
						let fetched;
						try { fetched = "status " + (await fetch("http://127.0.0.1:" + port + "/")).status; } catch (error) { fetched = "failed"; }
						results[port] = { fetch: fetched, net: await connect(port) };
					}
					return results;
				},
			};
		`,
	},
	...(globalOutbound === undefined ? {} : { globalOutbound }),
});

export class Greeter extends WorkerEntrypoint {
	greet(name) {
		return `${this.ctx.props.greeting}, ${name}!`;
	}
}

const counterCode = {
	compatibilityDate: "2026-09-03",
	mainModule: "main.js",
	modules: {
		"main.js": `
			import { abortIsolate, WorkerEntrypoint } from "cloudflare:workers";
			let count = 0;
			export default class extends WorkerEntrypoint {
				increment() { return ++count; }
				crash() { process.exit(137); }
				abort() { abortIsolate("secret reason"); }
			}
		`,
	},
};

// Describes a value from the "values" route as JSON, so each side can show
// what it received.
function describeValues(v) {
	return {
		bytes: v.bytes instanceof Uint8Array ? [...v.bytes] : null,
		cycle: v.self === v,
		date: v.date instanceof Date ? v.date.toISOString() : null,
		edges: [Object.is(v.negZero, -0), Number.isNaN(v.nan), Object.hasOwn(v, "missing") && v.missing === undefined],
		error: [
			v.error instanceof TypeError,
			v.error.message,
			v.error.stack.startsWith("TypeError: outer"),
			v.error.cause instanceof RangeError,
			v.error.cause.message,
		],
		map: [...v.map].map(([key, entry]) => [
			key,
			typeof entry === "bigint" ? `${entry}n` : entry instanceof Date ? entry.toISOString() : entry,
		]),
		sharedBytes: v.sameBytes === v.bytes,
	};
}

// Receives a stream that a dynamic Worker sends, and hands its text to the route that waits.
const uploads = new Map();
export class Sink extends WorkerEntrypoint {
	async consume(stream) {
		let received;
		try {
			received = await new Response(stream).text();
		} catch (error) {
			received = `stream failed: ${error.message}`;
		}
		uploads.get(this.ctx.props.id)?.(received);
	}
}

// Answers at once and streams 10 lines into env.sink from ctx.waitUntil(), one every 300 ms.
const uploadCode = (sink) => ({
	compatibilityDate: "2026-09-03",
	mainModule: "main.js",
	env: { sink },
	modules: {
		"main.js": `
			export default {
				fetch(request, env, ctx) {
					let i = 0;
					const body = new ReadableStream({
						async pull(controller) {
							await new Promise((r) => setTimeout(r, 300));
							controller.enqueue(new TextEncoder().encode("line " + i + "\\n"));
							if (++i === 10) controller.close();
						},
					});
					ctx.waitUntil(env.sink.consume(body));
					return new Response("started");
				},
			};
		`,
	},
});

// Streams 10 lines, one every 300 ms, so the body outlasts a 1 s idle timeout.
const streamCode = {
	compatibilityDate: "2026-09-03",
	mainModule: "main.js",
	modules: {
		"main.js": `
			export default {
				fetch() {
					let i = 0;
					const body = new ReadableStream({
						async pull(controller) {
							await new Promise((r) => setTimeout(r, 300));
							controller.enqueue(new TextEncoder().encode("line " + i + "\\n"));
							if (++i === 10) controller.close();
						},
					});
					return new Response(body);
				},
			};
		`,
	},
};

// Returns a dynamic Worker's streamed response. With `drop`, the parent keeps no stub and
// collects garbage while the body streams, so the Worker is released mid-body.
async function streamThroughDynamicWorker(env, ctx, drop) {
	const response = await env.LOADER.load(streamCode).getEntrypoint().fetch("http://dynamic/stream");
	if (drop) {
		ctx.waitUntil(
			(async () => {
				for (let i = 0; i < 20; i++) {
					globalThis.gc();
					await new Promise((r) => setTimeout(r, 200));
				}
			})(),
		);
	}
	return response;
}

async function settle(promise) {
	try {
		return { value: await promise };
	} catch (error) {
		return { error: { message: error.message, name: error.name } };
	}
}

const routes = {
	async basic(env, ctx) {
		const worker = env.LOADER.get("basic", () => ({
			compatibilityDate: "2026-09-03",
			mainModule: "main.js",
			modules: {
				"main.js": `
					import { WorkerEntrypoint } from "cloudflare:workers";
					import { suffix } from "./lib/util.js";
					export default {
						fetch(request, env) {
							// Stdout output that looks like an RPC frame must reach the
							// log, not the RPC session.
							console.log(JSON.stringify({ openOrangeWorkerLoaderRpc: '["abort",["error","Error","dynamic Worker stdout"]]' }));
							return new Response(new URL(request.url).pathname + " " + env.hello + suffix, {
								headers: { "x-dynamic": "yes" },
							});
						},
					};
					export class Named extends WorkerEntrypoint {
						async run(name) {
							return [this.ctx.props.label, await this.env.greeter.greet(name)];
						}
					}
				`,
				"lib/util.js": `export const suffix = "!";`,
			},
			env: { greeter: ctx.exports.Greeter({ props: { greeting: "Hello" } }), hello: 123 },
		}));
		const response = await worker.getEntrypoint().fetch("https://example.com/path");
		return {
			fetch: [response.status, response.headers.get("x-dynamic"), await response.text()],
			rpc: await worker.getEntrypoint("Named", { props: { label: "props" } }).run("Ada"),
		};
	},
	// A dynamic Worker serves a node:http server through cloudflare:node.
	async http(env) {
		const worker = env.LOADER.get("http", () => ({
			compatibilityDate: "2026-09-03",
			compatibilityFlags: ["nodejs_compat"],
			mainModule: "main.js",
			modules: {
				"main.js": `
					import http from "node:http";
					import { httpServerHandler } from "cloudflare:node";
					const server = http.createServer((req, res) => {
						if (req.url === "/kinds") {
							res.writeHead(202);
							res.end(JSON.stringify({
								instances: [req instanceof http.IncomingMessage, res instanceof http.ServerResponse, server instanceof http.Server],
								statusMessage: res.statusMessage,
							}));
							return;
						}
						if (req.url === "/cookies") {
							res.setHeader("set-cookie", ["a=1", "b=2"]);
							res.end("cookies");
							return;
						}
						if (req.method === "POST") {
							const chunks = [];
							req.on("data", (chunk) => chunks.push(chunk));
							req.on("end", () => res.end("echo " + Buffer.concat(chunks).toString()));
							return;
						}
						res.writeHead(201, { "x-node": req.method + " " + req.url });
						res.write("hello ");
						res.end("node");
					});
					server.listen(8080);
					export default httpServerHandler({ port: 8080 });
				`,
			},
		})).getEntrypoint();
		const describe = async (response) => ({
			body: await response.text(),
			cookies: response.headers.getSetCookie(),
			header: response.headers.get("x-node"),
			status: response.status,
		});
		return {
			cookies: await describe(await worker.fetch("https://example.com/cookies")),
			get: await describe(await worker.fetch("https://example.com/hi?x=1")),
			kinds: JSON.parse(await (await worker.fetch("https://example.com/kinds")).text()),
			post: await describe(await worker.fetch("https://example.com/echo", { body: "ping", method: "POST" })),
		};
	},
	// A dynamic Worker runs an Express app that the test bundled and posted.
	async express(env, _ctx, request) {
		const app = await request.text();
		const worker = env.LOADER.load({
			compatibilityDate: "2026-09-03",
			compatibilityFlags: ["nodejs_compat"],
			mainModule: "main.js",
			modules: { "main.js": app },
		}).getEntrypoint();
		const describe = async (response) => ({
			body: await response.text(),
			cookies: response.headers.getSetCookie(),
			status: response.status,
			type: response.headers.get("content-type"),
		});
		return {
			cookies: await describe(await worker.fetch("https://example.com/cookies")),
			missing: await describe(await worker.fetch("https://example.com/missing")),
			post: await describe(
				await worker.fetch("https://example.com/echo", {
					body: JSON.stringify({ name: "Ada" }),
					headers: { "content-type": "application/json" },
					method: "POST",
				}),
			),
			user: await describe(await worker.fetch("https://example.com/users/42")),
		};
	},
	async isolation(env) {
		const worker = env.LOADER.load({
			compatibilityDate: "2026-09-03",
			mainModule: "main.js",
			modules: {
				"main.js": `export default {
					inspect(_arg, env) {
						return {
							envKeys: Object.keys(env),
							marker: typeof globalThis.parentMarker,
							secret: process.env.SECRET ?? null,
						};
					},
				};`,
			},
			env: { given: "yes" },
		});
		return worker.getEntrypoint().inspect(null);
	},
	// A dynamic Worker with no outbound tries the network and a host file.
	async sandbox(env, _ctx, request) {
		const path = new URL(request.url).searchParams.get("path");
		const worker = env.LOADER.load({
			compatibilityDate: "2026-09-03",
			globalOutbound: null,
			mainModule: "main.js",
			modules: {
				"main.js": `
					import { createRequire } from "node:module";
					const fs = createRequire(import.meta.url)("fs");
					export default {
						async net() {
							try { await fetch("https://example.com/"); return "reached"; } catch (error) { return error.message; }
						},
						read(path) {
							try { return { content: fs.readFileSync(path, "utf8") }; } catch (error) { return { error: error.code ?? error.message }; }
						},
					};
				`,
			},
		}).getEntrypoint();
		return { net: await worker.net(null), read: await worker.read(path) };
	},
	async filesystem(env) {
		const path = "/tmp/open-orange-isolation.txt";
		const writer = env.LOADER.get("fs-writer", () => filesystemCode).getEntrypoint();
		const reader = env.LOADER.get("fs-reader", () => filesystemCode).getEntrypoint();
		const written = await writer.write(path);
		return { reader: await reader.read(path), writer: written };
	},
	// Loads `n` dynamic Workers at once, alternating the VM network mode.
	async pool(env, _ctx, request) {
		const n = Number(new URL(request.url).searchParams.get("n"));
		const tag = crypto.randomUUID().slice(0, 8);
		return Promise.all(
			Array.from({ length: n }, (_, i) => {
				const code = poolProbeCode(`${tag}_${i}`, i % 2 === 0 ? null : undefined);
				return settle(env.LOADER.load(code).getEntrypoint().probe(null));
			}),
		);
	},
	async loopback(env, _ctx, request) {
		const url = new URL(request.url);
		const ports = [Number(url.port), Number(url.searchParams.get("engine"))];
		return {
			blocked: await env.LOADER.load(loopbackCode(null)).getEntrypoint().probe(ports),
			network: await env.LOADER.load(loopbackCode(undefined)).getEntrypoint().probe(ports),
		};
	},
	async outbound(env) {
		const code = (globalOutbound) => ({
			compatibilityDate: "2026-09-03",
			mainModule: "main.js",
			modules: {
				"main.js": `
					import { connect } from "cloudflare:sockets";
					export default {
						async fetch() { return fetch("http://127.0.0.1:9/"); },
						tryConnect() {
							try { connect("127.0.0.1:9"); return "connected"; } catch (error) { return error.message; }
						},
					};
				`,
			},
			...(globalOutbound === undefined ? {} : { globalOutbound }),
		});
		const blocked = env.LOADER.load(code(null)).getEntrypoint();
		return {
			connect: await blocked.tryConnect(null),
			fetch: await settle(blocked.fetch("https://example.com/")),
		};
	},
	async cache(env) {
		let loads = 0;
		const getCode = () => {
			loads += 1;
			return counterCode;
		};
		const first = env.LOADER.get("cache-a", getCode).getEntrypoint();
		const counts = [await first.increment(), await first.increment()];
		counts.push(await env.LOADER.get("cache-a", getCode).getEntrypoint().increment());
		counts.push(await env.LOADER.get("cache-b", getCode).getEntrypoint().increment());
		counts.push(await env.LOADER.get(null, getCode).getEntrypoint().increment());
		return { counts, loads };
	},
	// The parent keeps no stub and collects garbage while the dynamic Worker streams to it.
	async upload(env, ctx) {
		const id = crypto.randomUUID();
		const received = new Promise((resolve) => uploads.set(id, resolve));
		const response = await env.LOADER.load(uploadCode(ctx.exports.Sink({ props: { id } })))
			.getEntrypoint()
			.fetch("http://dynamic/upload");
		const started = await response.text();
		for (let i = 0; i < 50; i++) {
			const done = await Promise.race([received, new Promise((r) => setTimeout(() => r(undefined), 200))]);
			if (done !== undefined) return { received: done, started };
			globalThis.gc();
		}
		return { received: "timed out", started };
	},
	// Runs with ORANGE_WORKER_LOADER_MAX_WORKERS=2: more failed loads than the limit, then a load.
	async failedStarts(env) {
		const errors = [];
		for (let i = 0; i < 3; i++) {
			const getCode = () => {
				throw new Error(`no code for broken-${i}`);
			};
			errors.push(await settle(Promise.resolve().then(() => env.LOADER.get(`broken-${i}`, getCode).getEntrypoint().increment())));
		}
		const loaded = await settle(Promise.resolve().then(() => env.LOADER.load(counterCode).getEntrypoint().increment()));
		return { errors, loaded };
	},
	// Runs with ORANGE_WORKER_LOADER_MAX_WORKERS=2 and ORANGE_WORKER_LOADER_IDLE_TIMEOUT_MS=1500.
	async eviction(env) {
		const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
		let loads = 0;
		const getCode = () => {
			loads += 1;
			return counterCode;
		};
		const named = [];
		named.push(await env.LOADER.get("idle", getCode).getEntrypoint().increment());
		named.push(await env.LOADER.get("idle", getCode).getEntrypoint().increment());
		const held = env.LOADER.load(counterCode).getEntrypoint();
		const heldCounts = [await held.increment()];
		await pause(2_500);
		named.push(await env.LOADER.get("idle", getCode).getEntrypoint().increment());
		heldCounts.push(await held.increment());

		const slowCode = {
			compatibilityDate: "2026-09-03",
			mainModule: "main.js",
			modules: {
				"main.js": `export default { async sleep(ms) { await new Promise((r) => setTimeout(r, ms)); return ms; } };`,
			},
		};
		const slow = [
			env.LOADER.load(slowCode).getEntrypoint().sleep(3_000),
			env.LOADER.load(slowCode).getEntrypoint().sleep(3_000),
		];
		const full = await settle(Promise.resolve().then(() => env.LOADER.load(counterCode)));
		const slept = await Promise.all(slow.map(settle));

		const sequential = [];
		for (let i = 0; i < 6; i++) {
			sequential.push(await env.LOADER.load(counterCode).getEntrypoint().increment());
		}
		// A call made in the same tick as a load() keeps its Worker from being stopped.
		const a = env.LOADER.load(counterCode).getEntrypoint();
		const b = env.LOADER.load(counterCode).getEntrypoint();
		await Promise.all([a.increment(), b.increment()]);
		const calls = [a.increment(), b.increment()];
		let sameTick;
		try {
			env.LOADER.load(counterCode);
			sameTick = "loaded";
		} catch (error) {
			sameTick = error.name;
		}
		const sameTickCalls = await Promise.all(calls.map(settle));
		return { full, heldCounts, loads, named, sameTick, sameTickCalls, sequential, slept };
	},
	async syntax(env) {
		const worker = env.LOADER.get("syntax", () => ({
			compatibilityDate: "2026-09-03",
			mainModule: "main.js",
			modules: { "main.js": "export default {\n  greet( {\n};" },
		}));
		return settle(worker.getEntrypoint().greet("x"));
	},
	async unsupported(env) {
		const staticImport = env.LOADER.load({
			compatibilityDate: "2026-09-03",
			mainModule: "main.js",
			modules: {
				"main.js": `import "./lib.js";\nexport default { ping() { return "pong"; } };`,
				"lib.js": `import { thing } from "cloudflare:nope";\nexport { thing };`,
			},
		});
		const dynamicImport = env.LOADER.load({
			compatibilityDate: "2026-09-03",
			mainModule: "main.js",
			modules: {
				"main.js": `export default { async load() { await import("cloudflare:nope"); } };`,
			},
		});
		return {
			dynamic: await settle(dynamicImport.getEntrypoint().load(null)),
			static: await settle(staticImport.getEntrypoint().ping(null)),
		};
	},
	async crash(env) {
		const worker = env.LOADER.get("crash", () => counterCode).getEntrypoint();
		await worker.increment();
		const crashed = await settle(worker.crash());
		const reloaded = env.LOADER.get("crash", () => counterCode).getEntrypoint();
		return { afterReload: await reloaded.increment(), crashed };
	},
	async namedOnly(env) {
		const worker = env.LOADER.get("named-only", () => ({
			compatibilityDate: "2026-09-03",
			mainModule: "main.js",
			modules: {
				"main.js": `
					import { WorkerEntrypoint } from "cloudflare:workers";
					export class Named extends WorkerEntrypoint {
						ping() { return "named"; }
					}
				`,
			},
		}));
		return await worker.getEntrypoint("Named").ping();
	},
	async abort(env) {
		const worker = env.LOADER.get("abort", () => counterCode).getEntrypoint();
		await worker.increment();
		const aborted = await settle(worker.abort());
		const reloaded = env.LOADER.get("abort", () => counterCode).getEntrypoint();
		const parent = await settle(Promise.resolve().then(() => abortIsolate("parent")));
		return { afterReload: await reloaded.increment(), aborted, parent };
	},
	async modules(env) {
		const wasm = new Uint8Array([
			0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x01, 0x07, 0x01, 0x60, 0x02, 0x7f, 0x7f,
			0x01, 0x7f, 0x03, 0x02, 0x01, 0x00, 0x07, 0x07, 0x01, 0x03, 0x61, 0x64, 0x64, 0x00, 0x00,
			0x0a, 0x09, 0x01, 0x07, 0x00, 0x20, 0x00, 0x20, 0x01, 0x6a, 0x0b,
		]);
		const worker = env.LOADER.load({
			compatibilityDate: "2026-09-03",
			mainModule: "main.js",
			modules: {
				"main.js": {
					js: `
						import text from "./a.txt";
						import json from "./b.json";
						import cjs from "./c.cjs";
						import data from "./d.bin";
						import wasm from "./e.wasm";
						export default {
							async read() {
								const instance = await WebAssembly.instantiate(wasm);
								const computed = await import(["./a", "txt"].join("."));
								return [text, json.value, cjs.greet("Bo"), new TextDecoder().decode(data), instance.exports.add(2, 3), computed.default];
							},
						};
					`,
				},
				"a.txt": { text: "text" },
				"b.json": { json: { value: 42 } },
				"c.cjs": {
					cjs: "const { prefix } = require('./lib/prefix.cjs');\nmodule.exports = { greet: (name) => prefix + name };",
				},
				"lib/prefix.cjs": { cjs: "module.exports = { prefix: 'cjs ' };" },
				"d.bin": { data: new TextEncoder().encode("data") },
				"e.wasm": { wasm },
			},
		});
		return worker.getEntrypoint().read(null);
	},
	async values(env) {
		const worker = env.LOADER.load({
			compatibilityDate: "2026-09-03",
			mainModule: "main.js",
			modules: {
				"main.js": `
					${describeValues.toString()}
					export default {
						echo(value) { return { echo: value, seen: describeValues(value) }; },
					};
				`,
			},
		});
		const bytes = new Uint8Array([1, 2, 250]);
		const value = {
			bytes,
			date: new Date(Date.UTC(2026, 0, 2)),
			error: new TypeError("outer", { cause: new RangeError("inner") }),
			map: new Map([
				["big", 2n ** 70n],
				[7, new Date(0)],
			]),
			missing: undefined,
			nan: Number.NaN,
			negZero: -0,
			sameBytes: bytes,
		};
		value.self = value;
		const { echo, seen } = await worker.getEntrypoint().echo(value);
		return { child: seen, parent: describeValues(echo) };
	},
};

export default {
	async fetch(request, env, ctx) {
		const url = new URL(request.url);
		if (url.pathname === "/stream") {
			return streamThroughDynamicWorker(env, ctx, url.searchParams.get("drop") === "1");
		}
		const route = routes[url.pathname.slice(1)];
		if (route === undefined) return new Response("not found", { status: 404 });
		return Response.json(await route(env, ctx, request));
	},
};
