import assert from "node:assert/strict";
import { glob, readFile } from "node:fs/promises";
import {
	createServer,
	type IncomingMessage,
	type Server,
	type ServerResponse,
} from "node:http";
import { createRequire } from "node:module";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
	copyProject,
	isRecord,
	repositoryRoot,
	startOrangeDev,
	type RunningOrangeDev,
} from "../harness/orange-dev.js";

// How long the engine stays stopped while the test checks that the peer saw nothing.
const stoppedWindowMs = 1_500;

async function enginePid(projectDirectory: string): Promise<number> {
	for await (const path of glob(
		".open-orange/rivetkit/*/.rivetkit/var/engine/runtime.json",
		{ cwd: projectDirectory },
	)) {
		const value: unknown = JSON.parse(
			await readFile(join(projectDirectory, path), "utf8"),
		);
		if (isRecord(value) && typeof value.pid === "number" && value.pid > 0) {
			return value.pid;
		}
	}
	throw new Error("orange dev did not record its Rivet engine process");
}

interface PeerSocket {
	on(type: "message", listener: (data: unknown) => void): void;
	terminate(): void;
}

interface PeerSocketServer {
	readonly clients: Set<PeerSocket>;
	close(): void;
	on(type: "connection", listener: (socket: PeerSocket) => void): void;
}

function createPeerSocketServer(server: Server): PeerSocketServer {
	const packageValue: unknown = createRequire(import.meta.url)("ws");
	const constructor: unknown = isRecord(packageValue)
		? packageValue.WebSocketServer
		: typeof packageValue === "function"
			? Reflect.get(packageValue, "WebSocketServer")
			: undefined;
	if (typeof constructor !== "function") {
		throw new Error("The ws package does not export WebSocketServer");
	}
	return Reflect.construct(constructor, [{ path: "/socket", server }]);
}

function listeningPort(server: Server): number {
	const address = server.address();
	assert.ok(address !== null && typeof address === "object", "the server is not listening on a port");
	return address.port;
}

// The Durable Object's outside peer. It holds `/arrived` until the test releases it and records
// every outgoing message the object sends after its write.
class Peer {
	readonly arrived: PromiseWithResolvers<() => void>[] = [];
	readonly messages: string[] = [];
	#messageWaiters: (() => void)[] = [];
	readonly #server = createServer((request, response) => this.#handle(request, response));
	readonly #sockets = createPeerSocketServer(this.#server);

	constructor() {
		this.#sockets.on("connection", (socket) => {
			socket.on("message", (data) => this.#record(String(data)));
		});
	}

	get origin(): string {
		return `http://127.0.0.1:${listeningPort(this.#server)}`;
	}

	listen(): Promise<void> {
		return new Promise((resolveListen) => {
			this.#server.listen(0, "127.0.0.1", resolveListen);
		});
	}

	nextArrival(): Promise<() => void> {
		const arrival = Promise.withResolvers<() => void>();
		this.arrived.push(arrival);
		return arrival.promise;
	}

	async waitForMessages(count: number, timeoutMs: number): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		while (this.messages.length < count) {
			const remaining = deadline - Date.now();
			if (remaining <= 0) {
				throw new Error(`peer received ${JSON.stringify(this.messages)}`);
			}
			const next = Promise.withResolvers<void>();
			this.#messageWaiters.push(next.resolve);
			await Promise.race([next.promise, delay(remaining)]);
		}
	}

	close(): Promise<void> {
		for (const client of this.#sockets.clients) client.terminate();
		this.#sockets.close();
		this.#server.closeAllConnections();
		return new Promise((resolveClose) => this.#server.close(() => resolveClose()));
	}

	#record(message: string): void {
		this.messages.push(message);
		for (const waiter of this.#messageWaiters.splice(0)) waiter();
	}

	#handle(request: IncomingMessage, response: ServerResponse): void {
		const url = new URL(request.url ?? "/", "http://peer");
		if (url.pathname === "/arrived") {
			const arrival = this.arrived.shift();
			const release = (): void => {
				response.end("ok");
			};
			if (arrival === undefined) release();
			else arrival.resolve(release);
			return;
		}
		this.#record(`${url.pathname}?${url.searchParams}`);
		response.end("ok");
	}
}

interface OutputGateCase {
	readonly expected: readonly string[];
	readonly heldWhileEngineStopped: boolean;
	readonly kind: string;
}

const cases: readonly OutputGateCase[] = [
	{ expected: ["/out?kind=fetch"], heldWhileEngineStopped: true, kind: "fetch" },
	{ expected: ["/out?kind=rpc"], heldWhileEngineStopped: true, kind: "rpc" },
	{ expected: ["first", "second"], heldWhileEngineStopped: true, kind: "websocket" },
	{ expected: ["/out?kind=unconfirmed"], heldWhileEngineStopped: false, kind: "unconfirmed" },
];

test("holds a Durable Object's outgoing fetch, RPC call, and WebSocket messages until its writes are durable", async () => {
	const project = await copyProject(join(repositoryRoot, "tests", "fixtures", "durable-object-output-gate"));
	const projectDirectory = project.directory;
	const peer = new Peer();
	await peer.listen();
	let orange: RunningOrangeDev | undefined;
	let stoppedEngine: number | undefined;
	try {
		orange = await startOrangeDev(projectDirectory);
		for (const { expected, heldWhileEngineStopped, kind } of cases) {
			peer.messages.splice(0);
			const arrival = peer.nextArrival();
			const response = fetch(
				`${orange.origin}/?kind=${kind}&name=${kind}&peer=${encodeURIComponent(peer.origin)}`,
			);
			response.catch(() => undefined);
			const release = await arrival;

			// With the engine stopped, the object's write cannot become durable.
			stoppedEngine = await enginePid(projectDirectory);
			process.kill(stoppedEngine, "SIGSTOP");
			release();
			if (heldWhileEngineStopped) {
				await delay(stoppedWindowMs);
				assert.deepEqual(peer.messages, [], `${kind} left before its write was durable`);
			} else {
				await peer.waitForMessages(expected.length, stoppedWindowMs);
			}

			process.kill(stoppedEngine, "SIGCONT");
			stoppedEngine = undefined;
			await peer.waitForMessages(expected.length, 20_000);
			assert.deepEqual(peer.messages, expected);
			const result = await response;
			assert.equal(result.status, 200, orange.output());
			assert.deepEqual(await result.json(), { written: kind });
		}
	} finally {
		if (stoppedEngine !== undefined) process.kill(stoppedEngine, "SIGCONT");
		try {
			await orange?.close();
		} finally {
			await peer.close();
			await project.dispose();
		}
	}
});
