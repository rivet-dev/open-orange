import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer as createHttpServer, type Server } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { AddressInfo } from "node:net";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Worker } from "node:worker_threads";

import { copyProject, repositoryRoot, startOrangeDev, type RunningOrangeDev, type TemporaryProject } from "../harness/orange-dev.js";

// The Worker connects to this hostname, which resolves to `first`, then `second`. Whether
// `localhost` has two addresses depends on the host's IPv6 setup, so tests/harness/test-hosts.ts
// sets the addresses, as an /etc/hosts entry would.
const hostname = "two-addresses.test";
const first = "::1";
const second = "127.0.0.1";

// Linux drops a SYN while a listener's accept queue is full, and the client sends it again about
// a second later, as for a slow or dead address. macOS resets a queued connection instead.
const silentAddresses =
	process.platform === "linux" ? false : "needs Linux, which drops a SYN when the accept queue is full";

interface HeldListener {
	// Connections the listener accepted, after release(), besides the ones that filled its queue.
	connections(): number;
	// Accepts connections from now on.
	release(): void;
	close(): Promise<void>;
}

// An HTTP server on `host:port` that answers `body`, and completes no TCP handshake until
// `release()`: its thread is blocked, and its accept queue is full.
async function startHeldListener(host: string, port: number, body: string): Promise<HeldListener> {
	const flag = new Int32Array(new SharedArrayBuffer(4));
	const thread = new Worker(
		`
		const { parentPort, workerData } = require("node:worker_threads");
		const server = require("node:http").createServer((request, response) => response.end(workerData.body));
		server.on("connection", () => parentPort.postMessage("connection"));
		server.listen({ backlog: 1, host: workerData.host, port: workerData.port }, () => {
			parentPort.postMessage("listening");
			Atomics.wait(workerData.flag, 0, 0);
		});
		`,
		{ eval: true, workerData: { body, flag, host, port } },
	);
	let accepted = 0;
	thread.on("message", (message) => {
		if (message === "connection") accepted++;
	});
	await new Promise((resolve, reject) => {
		thread.once("message", resolve);
		thread.once("error", reject);
	});
	const fillers: Socket[] = [];
	for (;;) {
		const filler = connect({ host, port }).on("error", () => {});
		const connected = await Promise.race([
			new Promise<boolean>((resolve) => filler.once("connect", () => resolve(true))),
			delay(200, false),
		]);
		if (!connected) {
			filler.destroy();
			break;
		}
		fillers.push(filler);
	}
	const release = (): void => {
		Atomics.store(flag, 0, 1);
		Atomics.notify(flag, 0);
	};
	return {
		connections: () => accepted - fillers.length,
		release,
		async close() {
			release();
			for (const filler of fillers) filler.destroy();
			await thread.terminate();
		},
	};
}

async function listen(server: Server, host: string, port: number): Promise<Server> {
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen({ host, port }, resolve);
	});
	return server;
}

function close(server: Server): Promise<void> {
	return new Promise((resolve) => server.close(() => resolve()));
}

// A port with no listener on either address, so tests in parallel areas never share one.
async function freePort(): Promise<number> {
	for (;;) {
		const probe = await listen(createHttpServer(), first, 0);
		const { port } = probe.address() as AddressInfo;
		try {
			await close(await listen(createHttpServer(), second, port));
			return port;
		} catch {
			// The port is in use on the second address. Try another one.
		} finally {
			await close(probe);
		}
	}
}

let project: TemporaryProject;
let dev: RunningOrangeDev;
let certificates: string;
let certificate: Buffer;
let key: Buffer;

before(async () => {
	// A certificate for the hostname that the Worker trusts through NODE_EXTRA_CA_CERTS.
	certificates = await mkdtemp(join(tmpdir(), "orange-outbound-"));
	execFileSync("openssl", [
		"req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", `/CN=${hostname}`,
		"-addext", `subjectAltName=DNS:${hostname}`,
		"-keyout", join(certificates, "key.pem"), "-out", join(certificates, "certificate.pem"),
	], { stdio: "ignore" });
	certificate = await readFile(join(certificates, "certificate.pem"));
	key = await readFile(join(certificates, "key.pem"));
	project = await copyProject(join(repositoryRoot, "tests", "fixtures", "outbound-connect"));
	dev = await startOrangeDev(project.directory, "wrangler.jsonc", {
		environment: {
			NODE_EXTRA_CA_CERTS: join(certificates, "certificate.pem"),
			NODE_OPTIONS: `--import=${join(repositoryRoot, "tests", "harness", "test-hosts.ts")}`,
			ORANGE_TEST_HOSTS: JSON.stringify({ [hostname]: [first, second] }),
		},
	});
	// Load the Worker, so a test's request connects at once.
	assert.equal(await (await fetch(dev.origin)).text(), "ready");
});

after(async () => {
	await dev?.close();
	await project?.dispose();
	if (certificates !== undefined) await rm(certificates, { force: true, recursive: true });
});

for (const api of ["fetch", "socket"] as const) {
	const label = api === "fetch" ? "fetch()" : "cloudflare:sockets connect()";

	test(`${label} gets the second address's response when the first address never answers`, { skip: silentAddresses, timeout: 60_000 }, async () => {
		const port = await freePort();
		const held = await startHeldListener(first, port, "first");
		const working = await listen(createHttpServer((_request, response) => response.end("second")), second, port);
		try {
			const started = Date.now();
			assert.deepEqual(await dev.json(`/${api}?port=${port}`), { body: "second" });
			// The OS gives up on a silent address after more than a minute.
			assert.ok(Date.now() - started < 5_000, `took ${Date.now() - started} ms`);
		} finally {
			await close(working);
			await held.close();
		}
	});

	test(`${label} gets the first address's response when it answers after the second address fails`, { skip: silentAddresses, timeout: 60_000 }, async () => {
		// Nothing listens on the second address, so its connect is refused at once.
		const port = await freePort();
		const held = await startHeldListener(first, port, "first");
		try {
			const response = dev.json(`/${api}?port=${port}`);
			// The first address stays silent past Node's own 250 ms attempt timer, which closes it.
			// After release(), the Worker's next SYN, about a second after the first, connects.
			const early = await Promise.race([response.then(() => "settled", () => "settled"), delay(500, "pending")]);
			if (early !== "pending") assert.fail(`settled before the first address answered: ${JSON.stringify(await response)}`);
			held.release();
			assert.deepEqual(await response, { body: "first" });
		} finally {
			await held.close();
		}
	});

	test(`${label} rejects with the same error as before when no address accepts`, { timeout: 60_000 }, async () => {
		const expected =
			api === "fetch"
				? { name: "TypeError", message: "fetch failed", cause: { name: "AggregateError", code: "ECONNREFUSED" } }
				: { name: "Error", message: "proxy request failed, cannot connect to the specified address" };
		assert.deepEqual(await dev.json(`/${api}?port=${await freePort()}`), { error: expected });
	});
}

test("fetch() over https verifies the hostname's certificate on the address that accepts", { timeout: 60_000 }, async () => {
	// Nothing listens on the first address, so the Worker connects to the second one.
	const port = await freePort();
	const server = await listen(
		createHttpsServer({ cert: certificate, key }, (_request, response) => response.end("secure")),
		second,
		port,
	);
	try {
		assert.deepEqual(await dev.json(`/fetch?scheme=https&port=${port}`), { body: "secure" });
	} finally {
		await close(server);
	}
});

test("a cloudflare:sockets socket canceled while connecting never connects", { skip: silentAddresses, timeout: 60_000 }, async () => {
	const port = await freePort();
	const held = await startHeldListener(first, port, "first");
	try {
		assert.deepEqual(await dev.json(`/socket-cancel?port=${port}`), { closed: true });
		held.release();
		// A connect attempt that was left running sends its SYN again about a second after the first.
		await delay(1_500);
		assert.equal(held.connections(), 0);
	} finally {
		await held.close();
	}
});
