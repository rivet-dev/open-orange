import assert from "node:assert/strict";
import { builtinModules } from "node:module";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { build, type Plugin } from "esbuild";

import {
	collectMessages,
	openWebSocket,
	repositoryRoot,
	waitFor,
	withDeadline,
	withOrangeDev,
	type ClientWebSocket,
	type RunningOrangeDev,
} from "../harness/orange-dev.js";

const fixtureRoot = join(repositoryRoot, "tests", "fixtures", "worker-loader-websocket");

// "pair" answers with a WebSocketPair in a 101 response. "node" runs a node:http server whose
// "upgrade" listener hands the socket to the `ws` package.
const kinds = ["pair", "node"] as const;

// Bundles the node:http fixture with `ws` into one ES module. `ws` requires Node.js built-ins, so
// each require reads a namespace that the module imports.
async function bundleNodeServer(): Promise<string> {
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
				contents: `module.exports = globalThis.__nodeServerBuiltins[${JSON.stringify(args.path)}];`,
				loader: "js",
			}));
		},
	};
	const result = await build({
		bundle: true,
		entryPoints: [join(fixtureRoot, "node-server.js")],
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
	return `${imports.join("\n")}\nglobalThis.__nodeServerBuiltins = { ${table.join(", ")} };\n${result.outputFiles[0]?.text ?? ""}`;
}

async function postNodeServer(dev: RunningOrangeDev): Promise<void> {
	const response = await fetch(`${dev.origin}/node-code`, { body: await bundleNodeServer(), method: "POST" });
	assert.equal(response.status, 200, await response.text());
}

function closeOf(socket: ClientWebSocket): Promise<{ code: number; reason: string }> {
	return withDeadline(
		new Promise((resolveClose) => {
			socket.once("close", (code, reason) => resolveClose({ code: Number(code), reason: String(reason) }));
		}),
		"WebSocket close",
	);
}

for (const kind of kinds) {
	test(`a WebSocket through a parent Worker reaches a dynamic Worker (${kind})`, async () => {
		await withOrangeDev("worker-loader-websocket", async (dev) => {
			if (kind === "node") await postNodeServer(dev);
			const a = await openWebSocket(`${dev.origin}/${kind}/a/socket`);
			const b = await openWebSocket(`${dev.origin}/${kind}/b/socket`);

			// Two sockets to two dynamic Workers send at the same time. Each gets its own Worker's
			// greeting and only its own echoes, in order.
			const sent = Array.from({ length: 20 }, (_, i) => `message ${i}`);
			for (const text of sent) {
				a.send(text);
				b.send(text);
			}
			assert.deepEqual(await collectMessages(a, 21), ["hello a", ...sent.map((text) => `a:${text}`)]);
			assert.deepEqual(await collectMessages(b, 21), ["hello b", ...sent.map((text) => `b:${text}`)]);

			// A binary message arrives as the same bytes in the dynamic Worker, and one from the
			// dynamic Worker arrives as binary at the client.
			a.send(new Uint8Array([0, 255, 1]));
			assert.deepEqual(await collectMessages(a, 1), ["binary 0,255,1"]);
			const binary = new Promise<unknown[]>((resolveMessage) => {
				a.once("message", (...parameters) => resolveMessage(parameters));
			});
			a.send("binary");
			const [data, isBinary] = await withDeadline(binary, "binary message");
			assert.equal(isBinary, true);
			assert.ok(data instanceof ArrayBuffer);
			assert.deepEqual([...new Uint8Array(data)], [0, 255, 1]);

			// When the dynamic Worker closes, the client gets its code and reason.
			const aClosed = closeOf(a);
			a.send("close:4001:worker says bye");
			assert.deepEqual(await aClosed, { code: 4001, reason: "worker says bye" });

			// When the client closes, the dynamic Worker gets its code and reason.
			const bClosed = closeOf(b);
			b.close(4002, "client says bye");
			assert.deepEqual(await bClosed, { code: 4002, reason: "client says bye" });
			let seen: unknown;
			await waitFor("the dynamic Worker to see the client's close", async () => {
				seen = await dev.json(`/${kind}/b/last-close`);
				return seen !== null;
			});
			assert.deepEqual(seen, { code: 4002, reason: "client says bye" });

			// When the dynamic Worker's process stops with a socket open, the client gets an
			// abnormal close instead of a socket that hangs, and the next socket reaches a new Worker.
			const stopped = await openWebSocket(`${dev.origin}/${kind}/a/socket`);
			const stoppedClosed = closeOf(stopped);
			stopped.send("exit");
			assert.equal((await stoppedClosed).code, 1006);
			const next = await openWebSocket(`${dev.origin}/${kind}/a/socket`);
			assert.deepEqual(await collectMessages(next, 1), ["hello a"]);
			next.terminate();

			// When the server's "upgrade" listener answers with an HTTP response instead of a
			// handshake, the client's upgrade fails with that status.
			// One that ends the socket without an HTTP response fails the upgrade too.
			if (kind === "node") {
				await assert.rejects(openWebSocket(`${dev.origin}/node/a/refuse`), /Unexpected server response: 403/);
				await assert.rejects(openWebSocket(`${dev.origin}/node/a/unauthorized`), /Unexpected server response: 500/);

				// The subprotocol that the server picks reaches the client.
				const chosen = new WebSocket(`${dev.origin.replace(/^http/, "ws")}/node/a/socket`, ["chat"]);
				await withDeadline(
					new Promise((resolveOpen, rejectOpen) => {
						chosen.addEventListener("open", resolveOpen);
						chosen.addEventListener("error", rejectOpen);
					}),
					"WebSocket open with a subprotocol",
				);
				assert.equal(chosen.protocol, "chat");
				chosen.close();
			}
		});
	});
}

test("an open WebSocket keeps its dynamic Worker running, and a WebSocket above the buffer limit closes", async () => {
	const environment = {
		ORANGE_WORKER_LOADER_IDLE_TIMEOUT_MS: "1500",
		ORANGE_WORKER_LOADER_MAX_WEBSOCKET_BUFFER_BYTES: "65536",
	};
	await withOrangeDev("worker-loader-websocket", async (dev) => {
		const instanceOf = async (socket: ClientWebSocket): Promise<string> => {
			socket.send("instance");
			return (await collectMessages(socket, 1))[0] ?? "";
		};
		const quiet = await openWebSocket(`${dev.origin}/pair/a/socket`);
		assert.deepEqual(await collectMessages(quiet, 1), ["hello a"]);
		const instance = await instanceOf(quiet);
		// More than twice the idle timeout with no message on the socket: the Worker is the same
		// one, so an open socket without traffic does not let it stop.
		await delay(4_000);
		assert.equal(await instanceOf(quiet), instance);

		// A message above the limit closes the socket with the limit's name, and the typed error
		// reaches the log. A message below it passes.
		quiet.send("x".repeat(60_000));
		assert.equal((await collectMessages(quiet, 1))[0]?.length, 60_002);
		const closed = closeOf(quiet);
		quiet.send("x".repeat(70_000));
		assert.deepEqual(await closed, { code: 1011, reason: "ORANGE_WORKER_LOADER_MAX_WEBSOCKET_BUFFER_BYTES exceeded" });
		// The close frame can reach the client before orange dev writes the error to its log.
		await waitFor("the WebSocket limit error in the orange dev log", () =>
			/WorkerLoaderLimitError: A dynamic Worker WebSocket held more than 65536 bytes[^\n]*Set ORANGE_WORKER_LOADER_MAX_WEBSOCKET_BUFFER_BYTES to raise the limit\./.test(
				dev.output(),
			),
		);

		// With its last socket closed, the Worker is idle again and stops after the idle timeout:
		// the next socket reaches a new one.
		await delay(4_000);
		const later = await openWebSocket(`${dev.origin}/pair/a/socket`);
		assert.deepEqual(await collectMessages(later, 1), ["hello a"]);
		assert.notEqual(await instanceOf(later), instance);
		later.terminate();
	}, { environment });
});
