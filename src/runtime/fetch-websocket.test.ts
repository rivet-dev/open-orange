import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import test from "node:test";

import { bundleWorker } from "../build/bundle-worker.js";
import { spawnRuntime } from "./spawn.js";

interface OriginSocket {
	close(code: number, reason: string): void;
	on(type: "message", listener: (data: Buffer, isBinary: boolean) => void): void;
	send(data: string | Uint8Array): void;
}

const { WebSocketServer } = createRequire(import.meta.url)("ws") as {
	WebSocketServer: new (options: {
		handleProtocols: (protocols: Set<string>) => string | false;
		noServer: true;
	}) => {
		close(): void;
		handleUpgrade(
			request: IncomingMessage,
			socket: Duplex,
			head: Buffer,
			callback: (webSocket: OriginSocket) => void,
		): void;
	};
};

test("a Worker proxies a WebSocket by passing the upgrade request to fetch()", async () => {
	const directory = await mkdtemp(join(tmpdir(), "open-orange-runtime-"));
	const sockets = new WebSocketServer({
		handleProtocols: (protocols) => [...protocols][0] ?? false,
		noServer: true,
	});
	const originServer = createServer();
	originServer.on("upgrade", (request, socket, head) => {
		sockets.handleUpgrade(request, socket, head, (webSocket) => {
			webSocket.on("message", (data, isBinary) => {
				if (isBinary) webSocket.send(data);
				else if (data.toString() === "close-me") webSocket.close(4001, "bye");
				else webSocket.send(`echo:${data.toString()}`);
			});
			// The client address that Orange added must not reach the origin.
			webSocket.send(`hello from ${request.url}, cf-connecting-ip ${request.headers["cf-connecting-ip"] ?? "absent"}`);
		});
	});
	let runtime: Awaited<ReturnType<typeof spawnRuntime>> | undefined;
	try {
		await new Promise<void>((resolveListen) => originServer.listen(0, "127.0.0.1", resolveListen));
		const origin = `http://127.0.0.1:${(originServer.address() as AddressInfo).port}`;
		const bundle = await bundleWorker({
			entrypoint: new URL("./fixtures/fetch-websocket-proxy-worker.js", import.meta.url).pathname,
			outputPath: join(directory, "worker.mjs"),
		});
		runtime = await spawnRuntime({
			bindingConfigurations: [],
			builtAt: new Date("2026-09-04T12:00:00.000Z"),
			bundlePath: bundle.outputPath,
			deploymentIdentity: "runtime-fetch-websocket-test",
			host: "0.0.0.0",
			normalizedConfiguration: "{}",
			port: 0,
			projectRoot: directory,
			rivetNamespace: "openorange_runtime_fetch_websocket_test",
			rivetStoragePath: join(directory, "rivetkit"),
		});
		const client = new WebSocket(
			`ws://127.0.0.1:${runtime.port}/?origin=${encodeURIComponent(origin)}`,
			["probe.v1"],
		);
		client.binaryType = "arraybuffer";
		const received: unknown[] = [];
		const closed = new Promise<{ code: number; reason: string; wasClean: boolean }>((resolveClose, rejectClose) => {
			client.addEventListener("close", ({ code, reason, wasClean }) => resolveClose({ code, reason, wasClean }));
			client.addEventListener("error", () => rejectClose(new Error("The proxied WebSocket failed")));
		});
		client.addEventListener("message", ({ data }) => {
			received.push(data instanceof ArrayBuffer ? [...new Uint8Array(data)] : data);
		});
		await new Promise((resolveOpen) => client.addEventListener("open", resolveOpen));
		assert.equal(client.protocol, "probe.v1");
		client.send("hi");
		client.send(new Uint8Array([1, 2, 3]));
		client.send("close-me");
		assert.deepEqual(await closed, { code: 4001, reason: "bye", wasClean: true });
		assert.deepEqual(received, ["hello from /ws, cf-connecting-ip absent", "echo:hi", [1, 2, 3]]);
	} finally {
		await runtime?.stop();
		sockets.close();
		originServer.closeAllConnections();
		await new Promise((resolveClose) => originServer.close(resolveClose));
		await rm(directory, { force: true, recursive: true });
	}
});
