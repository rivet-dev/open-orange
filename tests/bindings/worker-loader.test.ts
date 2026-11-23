import assert from "node:assert/strict";
import { glob, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { builtinModules } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";

import { build, type Plugin } from "esbuild";

import { copyProject, isRecord, repositoryRoot, startOrangeDev, withOrangeDev } from "../harness/orange-dev.js";

const fixtureRoot = join(repositoryRoot, "tests", "fixtures", "worker-loader");

interface EngineStamp {
	endpoint: string;
	pid: number;
}

async function readEngineStamps(projectRoot: string): Promise<EngineStamp[]> {
	const stamps: EngineStamp[] = [];
	for await (const path of glob(".open-orange/rivetkit/*/.rivetkit/var/engine/runtime.json", {
		cwd: projectRoot,
	})) {
		try {
			const stamp: unknown = JSON.parse(await readFile(join(projectRoot, path), "utf8"));
			if (isRecord(stamp) && typeof stamp.endpoint === "string" && typeof stamp.pid === "number") {
				stamps.push({ endpoint: stamp.endpoint, pid: stamp.pid });
			}
		} catch {
			continue;
		}
	}
	return stamps;
}

// Bundles the Express fixture app into one ES module. Express requires Node.js
// built-ins, so each require reads a namespace that the module imports, and
// node:http resolves to the runtime's module as in any dynamic Worker.
async function bundleExpressApp(): Promise<string> {
	const builtins = new Set<string>();
	const builtinRequires: Plugin = {
		name: "builtin-requires",
		setup(pluginBuild) {
			pluginBuild.onResolve({ filter: /.*/ }, (args) => {
				const name = args.path.replace(/^node:/, "");
				if (args.kind !== "require-call" || !builtinModules.includes(name)) return undefined;
				builtins.add(name);
				return { namespace: "builtin", path: name };
			});
			pluginBuild.onLoad({ filter: /.*/, namespace: "builtin" }, (args) => ({
				contents: `module.exports = globalThis.__expressBuiltins[${JSON.stringify(args.path)}];`,
				loader: "js",
			}));
		},
	};
	const result = await build({
		bundle: true,
		entryPoints: [join(fixtureRoot, "express-app.js")],
		external: ["cloudflare:*"],
		format: "esm",
		logLevel: "silent",
		platform: "node",
		plugins: [builtinRequires],
		write: false,
	});
	const names = [...builtins];
	const imports = names.map((name, i) => `import * as builtin${i} from "node:${name}";`);
	const table = names.map((name, i) => `${JSON.stringify(name)}: builtin${i}.default ?? builtin${i}`);
	return `${imports.join("\n")}\nglobalThis.__expressBuiltins = { ${table.join(", ")} };\n${result.outputFiles[0]?.text ?? ""}`;
}

test("loads dynamic Workers with workerd Worker Loader semantics in agentOS VMs", async () => {
	const project = await copyProject(fixtureRoot);
	try {
		const dev = await startOrangeDev(project.directory);
		try {
				const port = new URL(dev.origin).port;
				const get = (route: string): Promise<unknown> => dev.json(`/${route}`);

			// When the parent calls fetch() and RPC on a loaded Worker, it gets the
			// dynamic Worker's responses, with env and props capabilities working.
			// The dynamic Worker's stdout reaches the log and leaves RPC intact.
			assert.deepEqual(await get("basic"), {
				fetch: [200, "yes", "/path 123!"],
				rpc: ["props", "Hello, Ada!"],
			});
			assert.match(dev.output(), /dynamic Worker stdout/);

			// WebCrypto in a dynamic Worker reads every algorithm member, so an AES-GCM key generates
			// and round-trips data.
			assert.deepEqual(await get("crypto"), {
				algorithm: { length: 256, name: "AES-GCM" },
				plaintext: "secret",
			});

			// A dynamic Worker's node:http server answers fetches through
			// cloudflare:node with its status, headers, cookies, and streamed body.
			// Its requests, responses, and server are instances of the node:http
			// classes, and a response gets the standard reason phrase.
			assert.deepEqual(await get("http"), {
				cookies: { body: "cookies", cookies: ["a=1", "b=2"], header: null, status: 200 },
				get: { body: "hello node", cookies: [], header: "GET /hi?x=1", status: 201 },
				implicit: { body: "flushed", cookies: [], header: "implicit", status: 203 },
				incoming: { fields: [null, "", {}], socket: true },
				kinds: { instances: [true, true, true], statusMessage: "Accepted" },
				post: { body: "echo ping", cookies: [], header: null, status: 200 },
			});

			// An Express app in a dynamic Worker serves params, JSON, status codes,
			// repeated cookies, and parsed JSON bodies.
			const expressResponse = await fetch(`${dev.origin}/express`, {
				body: await bundleExpressApp(),
				method: "POST",
			});
			assert.equal(expressResponse.status, 200, await expressResponse.clone().text());
			assert.deepEqual(await expressResponse.json(), {
				cookies: {
					body: "cookies",
					cookies: ["a=1; Path=/", "b=2; Path=/"],
					status: 200,
					type: "text/html; charset=utf-8",
				},
				missing: {
					body: '<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<title>Error</title>\n</head>\n<body>\n<pre>Cannot GET /missing</pre>\n</body>\n</html>\n',
					cookies: [],
					status: 404,
					type: "text/html; charset=utf-8",
				},
				post: { body: "hello Ada", cookies: [], status: 201, type: "text/html; charset=utf-8" },
				user: { body: '{"id":"42"}', cookies: [], status: 200, type: "application/json; charset=utf-8" },
			});

			// A dynamic Worker reads a read-only project directory and
			// sees its own empty scratch mount. A hostPath outside the project and a guestPath in
			// Orange's reserved /open-orange fail the load. The project file is unchanged.
			const mounts = await get("mounts");
			assert.ok(isRecord(mounts), JSON.stringify(mounts));
			assert.deepEqual(mounts.mounted, { value: { read: "mounted file\n", readOnly: true, scratch: true } });
			const loadError = (value: unknown): string =>
				isRecord(value) && isRecord(value.error) ? String(value.error.message) : JSON.stringify(value);
			assert.match(loadError(mounts.outside), /hostPath "\.\." is outside the project directory/);
			assert.match(loadError(mounts.reserved), /is in \/open-orange, which OpenOrange reserves/);
			assert.equal(await readFile(join(project.directory, "mounted", "hello.txt"), "utf8"), "mounted file\n");

			// A Worker that needs more heap than the agentOS default fails, and runs with
			// vmLimits.heapMb. A request above the runtime cap fails the load and names the setting.
			const vmLimits = await get("vmLimits");
			assert.ok(isRecord(vmLimits), JSON.stringify(vmLimits));
			assert.ok(isRecord(vmLimits.defaults) && "error" in vmLimits.defaults, JSON.stringify(vmLimits.defaults));
			assert.deepEqual(vmLimits.larger, { value: 300 });
			assert.match(loadError(vmLimits.overCap), /vmLimits\.heapMb is 1000000, above the runtime cap of 4096\. Set ORANGE_WORKER_LOADER_MAX_VM_HEAP_MB/);

			// A dynamic Worker sees only the env it was given, not the parent's
			// globals, vars, or process.env.
			assert.deepEqual(await get("isolation"), {
				envKeys: ["given"],
				marker: "undefined",
				secret: null,
			});

			// With `globalOutbound: null`, fetch() rejects and connect() throws with
			// workerd's message.
			const blockedMessage =
				"This worker is not permitted to access the internet via global functions like fetch(). It must use capabilities (such as bindings in 'env') to talk to the outside world.";
			assert.deepEqual(await get("outbound"), {
				connect: blockedMessage,
				fetch: { error: { message: blockedMessage, name: "Error" } },
			});

			// Values that JSON cannot carry cross to a dynamic Worker RPC method and
			// back intact, including types, shared references, and cycles.
			const described = {
				bytes: [1, 2, 250],
				cycle: true,
				date: "2026-01-02T00:00:00.000Z",
				edges: [true, true, true],
				error: [true, "outer", true, true, "inner"],
				map: [
					["big", "1180591620717411303424n"],
					[7, "1970-01-01T00:00:00.000Z"],
				],
				sharedBytes: true,
			};
			assert.deepEqual(await get("values"), { child: described, parent: described });

			// The same name reuses the loaded Worker and its module state; another
			// name or no name loads a fresh Worker and calls the code callback.
			assert.deepEqual(await get("cache"), { counts: [1, 2, 3, 1, 1], loads: 3 });

			// A syntax error in a module rejects the call with V8's SyntaxError.
			assert.deepEqual(await get("syntax"), {
				error: { message: "Unexpected token ';'", name: "SyntaxError" },
			});

			// An unsupported `cloudflare:*` import rejects with workerd's error,
			// at load for a static import and at the call for a dynamic import.
			const noSuchModule = {
				error: { message: 'No such module "cloudflare:nope".\n  imported from "lib.js"', name: "Error" },
			};
			assert.deepEqual(await get("unsupported"), {
				dynamic: {
					error: { message: 'No such module "cloudflare:nope".\n  imported from "main.js"', name: "Error" },
				},
				static: noSuchModule,
			});

			// When a dynamic Worker process dies, its call rejects, the parent keeps
			// serving, and the next get() with that name loads a fresh Worker.
			const crash = await get("crash");
			assert.ok(
				isRecord(crash) &&
					isRecord(crash.crashed) &&
					isRecord(crash.crashed.error) &&
					typeof crash.crashed.error.message === "string",
				JSON.stringify(crash),
			);
			assert.match(crash.crashed.error.message, /exited unexpectedly \(code 137\)/);
			assert.equal(crash.afterReload, 1);

			// A dynamic Worker without a default export serves its named entrypoints.
			assert.equal(await get("namedOnly"), "named");

			// abortIsolate() in a dynamic Worker fails its call with workerd's internal error, which
			// does not show the reason, and the next get() with that name loads a fresh Worker. The
			// parent Worker cannot abort its own isolate.
			const abort = await get("abort");
			assert.ok(isRecord(abort) && isRecord(abort.aborted) && isRecord(abort.aborted.error), JSON.stringify(abort));
			assert.match(String(abort.aborted.error.message), /^internal error; reference = [0-9a-f-]+$/);
			assert.equal(abort.afterReload, 1);
			assert.ok(isRecord(abort.parent) && isRecord(abort.parent.error), JSON.stringify(abort));
			assert.match(String(abort.parent.error.message), /only in a dynamic Worker/);

			// Text, JSON, CommonJS, data, and Wasm modules import like in workerd,
			// and so does a specifier computed at runtime.
			assert.deepEqual(await get("modules"), ["text", 42, "cjs Bo", "data", 5, "text"]);

			// A computed import() finds a module by a URL, bare, nested, text, or CommonJS module
			// name, as a literal one does, and gets the same module.
			assert.deepEqual(await get("computed-imports"), ["url", "rel", "nested", "text", "cjs", true]);

			// Wasm, data, text, and JSON modules larger than agentOS's 16 MiB file message load
			// whole, in two dynamic Workers in a row.
			const large = { data: [20 * 1024 * 1024, 7], json: "last", text: [20 * 1024 * 1024, "z"], wasm: [1, 7] };
			assert.deepEqual(await get("large-modules"), [large, large]);

			// Wasm that catches and rethrows an exception with exnref, as Rust
			// `panic=unwind` builds do, compiles and runs like in workerd.
			assert.equal(await get("wasm-exceptions"), 42);

			// Two dynamic Workers run in separate VMs, so a file that one writes is
			// not visible to the other.
			assert.deepEqual(await get("filesystem"), {
				reader: { error: "ENOENT" },
				writer: "dynamic secret",
			});

			// A dynamic Worker cannot reach host loopback ports, such as the parent's
			// own `orange dev` port or the Rivet Engine port, by fetch() or node:net,
			// with the default `globalOutbound` or with `null`.
			const engine = (await readEngineStamps(project.directory))[0];
			assert.ok(engine !== undefined, "orange dev started no Rivet Engine");
			const enginePort = Number(new URL(engine.endpoint).port);
			const loopback = await get(`loopback?engine=${enginePort}`);
			assert.ok(isRecord(loopback), JSON.stringify(loopback));
			for (const outbound of ["blocked", "network"]) {
				const probes: unknown = loopback[outbound];
				for (const target of [String(port), String(enginePort)]) {
					const probe: unknown = isRecord(probes) ? probes[target] : undefined;
					assert.ok(isRecord(probe), `no ${outbound} probe for port ${target}`);
					assert.equal(probe.fetch, "failed", `${outbound} fetch reached port ${target}`);
					assert.notEqual(probe.net, "connected", `${outbound} node:net reached port ${target}`);
				}
			}

			// A dynamic Worker in a VM gets the blocked error from fetch() and
			// cannot read a file on the host, even through the real node:fs.
			const hostFile = join(await mkdtemp(join(tmpdir(), "orange-host-")), "secret.txt");
			await writeFile(hostFile, "host secret");
			const sandbox = await get(`sandbox?path=${encodeURIComponent(hostFile)}`);
			assert.ok(isRecord(sandbox) && isRecord(sandbox.read), JSON.stringify(sandbox));
			assert.equal(sandbox.net, blockedMessage);
			assert.equal(sandbox.read.content, undefined);
			assert.equal(sandbox.read.error, "ENOENT");
			await rm(dirname(hostFile), { force: true, recursive: true });
		} finally {
			await dev.close();
		}
	} finally {
		await project.dispose();
	}
});

test("stops idle dynamic Workers without interrupting calls in flight", async () => {
	const environment = {
		ORANGE_WORKER_LOADER_IDLE_TIMEOUT_MS: "1500",
		ORANGE_WORKER_LOADER_MAX_WORKERS: "2",
	};
	await withOrangeDev("worker-loader", async (dev) => {
		const result = await dev.json("/eviction");
		assert.ok(isRecord(result), JSON.stringify(result));
		const { full, ...rest } = result;
		assert.deepEqual(rest, {
			// After the idle timeout, get() with the same name calls getCode again and
			// the Worker starts with fresh module state.
			named: [1, 2, 1],
			loads: 2,
			// A held load() stub keeps working after its idle Worker stops: the next
			// call loads the same code again.
			heldCounts: [1, 1],
			// Calls that outlast the idle timeout finish, and a full pool of busy
			// Workers does not stop them.
			slept: [{ value: 3_000 }, { value: 3_000 }],
			// Idle Workers give up their slots, so more load() calls than the limit
			// all succeed.
			sequential: [1, 1, 1, 1, 1, 1],
			// With both Workers handling a call made in the same tick, load() throws
			// and both calls finish.
			sameTick: "WorkerLoaderLimitError",
			sameTickCalls: [{ value: 2 }, { value: 2 }],
		});
		// With every slot busy, load() throws the typed error that names the limit.
		assert.ok(isRecord(full) && isRecord(full.error), JSON.stringify(full));
		assert.equal(full.error.name, "WorkerLoaderLimitError");
		assert.match(String(full.error.message), /the limit is 2\. Raise ORANGE_WORKER_LOADER_MAX_WORKERS/);

		// A Worker with idleTimeoutMs keeps running and keeps its state past the 1.5 s runtime
		// timeout. An idleTimeoutMs out of range fails the load.
		const kept = await dev.json("/idleTimeout");
		assert.ok(isRecord(kept), JSON.stringify(kept));
		assert.deepEqual(kept.counts, [1, 2]);
		assert.equal(kept.loads, 1);
		assert.ok(isRecord(kept.invalid) && isRecord(kept.invalid.error), JSON.stringify(kept.invalid));
		assert.match(String(kept.invalid.error.message), /idleTimeoutMs must be an integer from 1 to 2147483647\. Got: 0/);
	}, { environment });
});

test("keeps a dynamic Worker running until every body it streams ends, and frees the slots of Workers that fail to start", async () => {
	const environment = {
		// The parent collects garbage to drop its stubs while a body streams.
		NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --expose-gc`,
		ORANGE_WORKER_LOADER_IDLE_TIMEOUT_MS: "1000",
		ORANGE_WORKER_LOADER_MAX_WORKERS: "2",
	};
	await withOrangeDev("worker-loader", async (dev) => {
		const lines = Array.from({ length: 10 }, (_, i) => `line ${i}\n`).join("");
		// A body that streams for 3 s, past the idle timeout, arrives in full, also when the
		// parent holds no stub for the dynamic Worker while it streams.
		for (const query of ["", "?drop=1"]) {
			const response = await fetch(`${dev.origin}/stream${query}`);
			assert.equal(response.status, 200);
			assert.equal(await response.text(), lines, `stream${query}`);
		}
		// A body that a dynamic Worker streams into an `env` capability for 3 s, from
		// ctx.waitUntil() after its response and while the parent holds no stub, arrives in full.
		assert.deepEqual(await dev.json("/upload"), { received: lines, started: "started" });

		// Each load whose getCode throws fails with that error, and more of them than the limit
		// leave room for the next load.
		assert.deepEqual(await dev.json("/failedStarts"), {
			errors: [0, 1, 2].map((i) => ({ error: { message: `no code for broken-${i}`, name: "Error" } })),
			loaded: { value: 1 },
		});
	}, { environment });
});

test("refuses to start with an idle timeout that Node.js timers cannot hold", async () => {
	const project = await copyProject(fixtureRoot);
	try {
		await assert.rejects(
			startOrangeDev(project.directory, "wrangler.jsonc", {
				environment: { ORANGE_WORKER_LOADER_IDLE_TIMEOUT_MS: "2147483648" },
			}),
			/exited before readiness \(code 1, signal none\)[\s\S]*ORANGE_WORKER_LOADER_IDLE_TIMEOUT_MS must be an integer from 1 to 2147483647/,
		);
	} finally {
		await project.dispose();
	}
});

test("loads bursts of dynamic Workers larger than the VM pool, each in a fresh VM even after idle Workers stop", async () => {
	const environment = {
		ORANGE_WORKER_LOADER_IDLE_TIMEOUT_MS: "1000",
		ORANGE_WORKER_LOADER_POOL_SIZE: "2",
	};
	await withOrangeDev("worker-loader", async (dev) => {
		const loadAtOnce = async (n: number): Promise<unknown[]> => {
			const results = await dev.json(`/pool?n=${n}`);
			assert.ok(Array.isArray(results) && results.length === n, JSON.stringify(results));
			return results;
		};
		// The first dynamic Worker of each network mode boots on demand and
		// starts filling that mode's pool.
		await loadAtOnce(2);
		for (let round = 0; round < 2; round += 1) {
			// Leaves time for the pool to fill and, after round 0, for every
			// Worker to pass its idle timeout and stop. A stopped Worker's VM
			// must be disposed, never handed to the next Worker.
			await new Promise((resolveWait) => setTimeout(resolveWait, 5_000));
			// A burst larger than the pool loads every Worker: some from the pool,
			// the rest on demand. None sees another's files, globals, or env, each
			// VM holds only its own Worker, and none can change Orange's runtime.
			const results = await loadAtOnce(10);
			for (const result of results) {
				assert.ok(isRecord(result) && isRecord(result.value), JSON.stringify(result));
				const id = String(result.value.id);
				assert.deepEqual(result.value, {
					env: [`POOL_SECRET_${id}`],
					file: "ENOENT",
					global: null,
					id,
					runtime: "EROFS",
					workerRoots: 1,
				});
			}
		}
	}, { environment });
});
