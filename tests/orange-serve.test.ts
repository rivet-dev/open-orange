import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { connect, createServer, type AddressInfo, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { GetObjectCommand } from "@aws-sdk/client-s3";

import { minioBucketSettings, minioSkip, s3Client, startMinio } from "./minio.js";
import { mailpitSkip, startMailpit } from "./mailpit.js";
import { signForwardedHost } from "../src/serve/front.js";
import { collectMessages, copyProject, openWebSocket, repositoryRoot, startOrangeDev, withDeadline, type ClientWebSocket } from "./orange-dev.js";
import { freePort } from "./free-port.js";

// The Engine binary that the pinned RivetKit spawns for `orange dev`. It is a
// RivetKit dependency, not a root one, so it resolves from RivetKit's package.
const requireFromRivetKit = createRequire(createRequire(import.meta.url).resolve("rivetkit"));
const { getEnginePath } = requireFromRivetKit("@rivetkit/engine-cli") as { getEnginePath(): string };
const cliEntrypoint = join(repositoryRoot, "src", "bin.ts");
const adminToken = "orange-serve-test";

function collectOutput(child: ChildProcess): () => string {
	let output = "";
	child.stdout?.on("data", (chunk: Buffer) => (output += chunk.toString()));
	child.stderr?.on("data", (chunk: Buffer) => (output += chunk.toString()));
	return () => output;
}

function exited(child: ChildProcess): Promise<number | null> {
	if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(child.exitCode);
	return new Promise((resolveExit) => child.once("exit", (code) => resolveExit(code)));
}

interface StandaloneEngine {
	endpoint: string;
	stop(): Promise<void>;
}

// A Rivet 3 Engine in its own directory stands in for a Rivet cluster. It runs the
// way RivetKit runs its local Engine: one storage worker on the local file system.
// https://github.com/rivet-dev/rivet/blob/a00b07f483aa3fb07ab403614bcb79d7a8be0322/rivetkit-rust/packages/engine-process/src/lib.rs
async function startStandaloneEngine(): Promise<StandaloneEngine> {
	const directory = await mkdtemp(join(tmpdir(), "open-orange-engine-"));
	const [guardPort, peerPort, metricsPort] = [await freePort(), await freePort(), await freePort()];
	const configPath = join(directory, "config.json");
	await mkdir(join(directory, "log"));
	// The datacenter's public URL matches the endpoint that orange serve connects to.
	await writeFile(
		configPath,
		JSON.stringify({
			topology: {
				datacenter_label: 1,
				datacenters: {
					default: {
						datacenter_label: 1,
						is_leader: true,
						peer_url: `http://127.0.0.1:${peerPort}/`,
						public_url: `http://127.0.0.1:${guardPort}/`,
					},
				},
			},
		}),
	);
	const child = spawn(getEnginePath(), ["--config", configPath], {
		cwd: directory,
		env: {
			...process.env,
			RIVET__API_PEER__HOST: "127.0.0.1",
			RIVET__API_PEER__PORT: String(peerPort),
			RIVET__AUTH__ADMIN_TOKEN: adminToken,
			RIVET__GUARD__HOST: "127.0.0.1",
			RIVET__GUARD__PORT: String(guardPort),
			RIVET__METRICS__HOST: "127.0.0.1",
			RIVET__METRICS__PORT: String(metricsPort),
			// A killed runner keeps its actors until the Engine judges it lost, 40 s by default.
			// RivetKit's local Engine uses 7 s, so restart tests move actors on as `orange dev` does.
			RIVET__PEGBOARD__NODE_LOST_THRESHOLD: "7000",
			RIVET__OBJECT_STORAGE__PRIMARY__FILE_SYSTEM__PATH: join(directory, "objects"),
			RIVET__STORAGE__AUTO_PROVISION_PARTITIONS: "1",
			RIVET__STORAGE__BALANCING__ENABLED: "false",
			RIVET__STORAGE__COLD_STORE__DISK_CACHE_BYTES: "0",
			RIVET__STORAGE__LOG_DIRECTORY: join(directory, "log"),
			RIVET__STORAGE__LOG_SHARD__MAX_DISK_BYTES: String(1024 * 1024 * 1024),
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	const output = collectOutput(child);
	const stop = async (): Promise<void> => {
		const exit = exited(child);
		child.kill("SIGTERM");
		await withDeadline(exit, "rivet-engine stop", 15_000).catch(() => child.kill("SIGKILL"));
		await rm(directory, { force: true, recursive: true });
	};
	let exitedEarly = false;
	child.once("exit", () => (exitedEarly = true));
	// The Engine answers before its storage partition is placed, so readiness is an API
	// call that reads storage. Nothing signals it, so the test polls.
	const deadline = Date.now() + 60_000;
	for (;;) {
		if (exitedEarly) {
			await stop();
			assert.fail(`rivet-engine exited:\n${output()}`);
		}
		const response = await fetch(`http://127.0.0.1:${guardPort}/actors/names?namespace=default`, {
			headers: { authorization: `Bearer ${adminToken}` },
		}).catch(() => undefined);
		if (response?.status === 200) break;
		if (Date.now() > deadline) {
			await stop();
			assert.fail(`rivet-engine never became ready:\n${output()}`);
		}
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
	}
	return { endpoint: `http://default:${adminToken}@127.0.0.1:${guardPort}`, stop };
}

interface RunningServe {
	child: ChildProcess;
	output(): string;
}

function spawnServe(
	projectDirectory: string,
	env: NodeJS.ProcessEnv,
	configs: readonly string[] = ["wrangler.jsonc"],
): RunningServe {
	const child = spawn(
		process.execPath,
		["--import", "tsx", cliEntrypoint, "serve", ...configs.flatMap((config) => ["--config", join(projectDirectory, config)])],
		{ cwd: repositoryRoot, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] },
	);
	return { child, output: collectOutput(child) };
}

async function startServe(
	projectDirectory: string,
	endpoint: string,
	port: number,
	env: NodeJS.ProcessEnv = {},
	configs?: readonly string[],
): Promise<RunningServe> {
	const serve = spawnServe(
		projectDirectory,
		{
			PORT: String(port),
			RIVET_ENDPOINT: endpoint,
			...env,
		},
		configs,
	);
	const ready = new Promise<void>((resolveReady, rejectReady) => {
		serve.child.stdout?.on("data", () => {
			if (serve.output().includes("orange serve listening on")) resolveReady();
		});
		serve.child.once("exit", () => rejectReady(new Error(`orange serve exited:\n${serve.output()}`)));
	});
	await withDeadline(ready, "orange serve readiness", 60_000);
	return serve;
}

async function greet(serve: RunningServe, port: number, name: string): Promise<unknown> {
	const response = await fetch(`http://127.0.0.1:${port}/${name}`);
	assert.equal(response.status, 200, serve.output());
	return await response.json();
}

test("orange serve keeps Durable Object state in the external Engine across a runner restart on an empty disk", async () => {
	const engine = await startStandaloneEngine();
	const project = await copyProject(join(repositoryRoot, "examples", "hello-durable-object"));
	const running: ChildProcess[] = [];
	try {
		const firstPort = await freePort();
		const first = await startServe(project.directory, engine.endpoint, firstPort);
		running.push(first.child);
		assert.deepEqual(await greet(first, firstPort, "alice"), { greeting: "Hello, alice!", visits: 1 });
		assert.deepEqual(await greet(first, firstPort, "alice"), { greeting: "Hello, alice!", visits: 2 });

		// The runner crashes and a new instance starts on another port with none of
		// the first instance's local files.
		const firstExit = exited(first.child);
		first.child.kill("SIGKILL");
		await firstExit;
		await rm(join(project.directory, ".open-orange"), { force: true, recursive: true });
		const secondPort = await freePort();
		const second = await startServe(project.directory, engine.endpoint, secondPort);
		running.push(second.child);
		assert.deepEqual(await greet(second, secondPort, "alice"), { greeting: "Hello, alice!", visits: 3 });
	} finally {
		for (const child of running) {
			if (child.exitCode === null && child.signalCode === null) {
				const exit = exited(child);
				child.kill("SIGTERM");
				await withDeadline(exit, "orange serve stop", 15_000).catch(() => child.kill("SIGKILL"));
			}
		}
		await project.dispose();
		await engine.stop();
	}
});

test("orange serve pings an idle WebSocket, and the pings neither reach its object nor keep it awake", { timeout: 180_000 }, async () => {
	const engine = await startStandaloneEngine();
	const project = await copyProject(join(repositoryRoot, "tests", "fixtures", "accepted-websockets"));
	let child: ChildProcess | undefined;
	try {
		const port = await freePort();
		const serve = await startServe(project.directory, engine.endpoint, port);
		child = serve.child;
		const origin = `http://127.0.0.1:${port}`;
		const socket = await openWebSocket(`${origin}/socket?room=idle&name=idle`);
		const closed = new Promise<void>((resolveClose) => socket.once("close", () => resolveClose()));
		await withDeadline(
			new Promise<void>((resolvePing) => socket.once("ping", () => resolvePing())),
			"a ping from orange serve",
			45_000,
		);

		// The fixture counts each webSocketMessage, so a ping or its pong would raise the count.
		const replies = collectMessages(socket, 1);
		socket.send("first");
		const [reply] = await withDeadline(replies, "the reply");
		const { boot, count } = JSON.parse(String(reply)) as { boot: string; count: number };
		assert.equal(count, 1, serve.output());

		socket.close(1000, "done");
		await withDeadline(closed, "the close");
		// Past Orange's 10 second sleep timeout, with a margin.
		await delay(16_000);
		const bootAfter = await (await fetch(`${origin}/boot?room=idle`)).text();
		assert.notEqual(bootAfter, boot, "the object stayed awake after its last socket closed");
	} finally {
		if (child !== undefined) {
			const exit = exited(child);
			child.kill("SIGTERM");
			await withDeadline(exit, "orange serve stop", 15_000).catch(() => child?.kill("SIGKILL"));
		}
		await project.dispose();
		await engine.stop();
	}
});

test("orange serve delivers 1006 for a client that is gone, and its object sleeps, while a live client stays connected", { timeout: 240_000 }, async () => {
	const engine = await startStandaloneEngine();
	const project = await copyProject(join(repositoryRoot, "tests", "fixtures", "accepted-websockets"));
	let child: ChildProcess | undefined;
	try {
		const port = await freePort();
		const serve = await startServe(project.directory, engine.endpoint, port);
		child = serve.child;
		const origin = `http://127.0.0.1:${port}`;
		const boot = async (room: string) => await (await fetch(`${origin}/boot?room=${room}`)).text();
		const closedIn = async (room: string) =>
			(await (await fetch(`${origin}/closed?room=${room}`)).json()) as { code: number; reason: string }[];
		const abnormal = [{ code: 1006, name: "client", reason: "WebSocket disconnected without sending Close frame." }];
		// Reading a room counts as activity, so these stop as soon as the close is there.
		const waitForClose = async (room: string, within: number) => {
			const deadline = Date.now() + within;
			while ((await closedIn(room)).length === 0) {
				assert.ok(Date.now() < deadline, `${room} got no webSocketClose\n${serve.output()}`);
				await delay(1_000);
			}
			return await closedIn(room);
		};

		const live = await openWebSocket(`${origin}/socket?room=live&name=client`);
		const liveBoot = await boot("live");

		// The connection ends with no close frame, as when a client process dies.
		const killed = await openWebSocket(`${origin}/socket?room=killed&name=client`);
		const killedBoot = await boot("killed");
		const killedClosed = new Promise<void>((resolveClose) => killed.once("close", () => resolveClose()));
		killed.terminate();
		await withDeadline(killedClosed, "the local close");
		assert.deepEqual(await waitForClose("killed", 15_000), abnormal);

		// The connection stays up, but nothing answers: a client that lost the network.
		const WebSocketClient = createRequire(import.meta.url)("ws") as new (
			url: string,
			options: { autoPong: boolean },
		) => ClientWebSocket;
		const silent = new WebSocketClient(`ws://127.0.0.1:${port}/socket?room=silent&name=client`, { autoPong: false });
		await withDeadline(new Promise<void>((resolveOpen) => silent.once("open", () => resolveOpen())), "the silent open");
		const silentBoot = await boot("silent");
		assert.deepEqual(await waitForClose("silent", 120_000), abnormal);

		// Past Orange's 10 second sleep timeout, with a margin. Neither room has been read since its close.
		await delay(16_000);
		assert.notEqual(await boot("killed"), killedBoot, "the object stayed awake after its killed client");
		assert.notEqual(await boot("silent"), silentBoot, "the object stayed awake after its silent client");

		// The live client answered every ping, so it kept its socket. Its idle object hibernated, as on
		// Cloudflare, so the message reaches a new instance.
		const replies = collectMessages(live, 1);
		live.send("still here");
		const [reply] = await withDeadline(replies, "the live reply");
		assert.notEqual((JSON.parse(String(reply)) as { boot: string }).boot, liveBoot);
		assert.deepEqual(await closedIn("live"), []);
		silent.terminate();
		live.close(1000, "done");
	} finally {
		if (child !== undefined) {
			const exit = exited(child);
			child.kill("SIGTERM");
			await withDeadline(exit, "orange serve stop", 15_000).catch(() => child?.kill("SIGKILL"));
		}
		await project.dispose();
		await engine.stop();
	}
});

test("orange serve imports a find_additional_modules module at run time", { timeout: 120_000 }, async () => {
	const engine = await startStandaloneEngine();
	const project = await copyProject(join(repositoryRoot, "tests", "fixtures", "migrate-modules"));
	let child: ChildProcess | undefined;
	try {
		const port = await freePort();
		const serve = await startServe(project.directory, engine.endpoint, port);
		child = serve.child;
		// The Worker imports `./skills/greet.mjs` by a computed specifier, so the bundler leaves it
		// to run time, where it resolves against the Worker's own module.
		const response = await fetch(`http://127.0.0.1:${port}/`);
		const body = await response.text();
		assert.equal(response.status, 200, `${body}\n${serve.output()}`);
		assert.deepEqual(JSON.parse(body), { file: "hello from a skill", imported: "imported" });
	} finally {
		if (child !== undefined) {
			const exit = exited(child);
			child.kill("SIGTERM");
			await withDeadline(exit, "orange serve stop", 15_000).catch(() => child?.kill("SIGKILL"));
		}
		await project.dispose();
		await engine.stop();
	}
});

test("orange serve puts the files from find_additional_modules under /bundle", { timeout: 120_000 }, async () => {
	const engine = await startStandaloneEngine();
	const project = await copyProject(join(repositoryRoot, "tests", "fixtures", "additional-modules"));
	let child: ChildProcess | undefined;
	try {
		const port = await freePort();
		const serve = await startServe(project.directory, engine.endpoint, port);
		child = serve.child;
		const response = await fetch(`http://127.0.0.1:${port}/read?path=skills/nested/deep.md`);
		assert.equal(await response.text(), "# deep\n", serve.output());
	} finally {
		if (child !== undefined) {
			const exit = exited(child);
			child.kill("SIGTERM");
			await withDeadline(exit, "orange serve stop", 15_000).catch(() => child?.kill("SIGKILL"));
		}
		await project.dispose();
		await engine.stop();
	}
});

// A deploy stops the old runner with SIGTERM while the Engine stays up.
test("a deploy closes an accepted WebSocket, and a reconnect through the new runner finds the object's storage", { timeout: 180_000 }, async () => {
	const engine = await startStandaloneEngine();
	const project = await copyProject(join(repositoryRoot, "tests", "fixtures", "accepted-websockets"));
	const running: ChildProcess[] = [];
	let silent: Socket | undefined;
	const ask = async (socket: ClientWebSocket, message: string): Promise<{ boot: string; count: number; everyone: number }> => {
		const replies = collectMessages(socket, 1);
		socket.send(message);
		const [reply] = await withDeadline(replies, `reply to ${message}`);
		return JSON.parse(String(reply)) as { boot: string; count: number; everyone: number };
	};
	try {
		const firstPort = await freePort();
		const first = await startServe(project.directory, engine.endpoint, firstPort);
		running.push(first.child);
		const socket = await openWebSocket(`http://127.0.0.1:${firstPort}/socket?room=deploy&name=ann`);
		const before = await ask(socket, "before");
		const closed = new Promise<{ code: number; reason: string }>((resolveClose) => {
			socket.once("close", (code: unknown, reason: unknown) => resolveClose({ code: Number(code), reason: String(reason) }));
		});
		// A client that never answers the close can't hold up the old runner's exit.
		silent = await new Promise<Socket>((resolveUpgrade, rejectUpgrade) => {
			const raw = connect(firstPort, "127.0.0.1", () => {
				raw.write(
					`GET /socket?room=deploy&name=silent HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
						`Sec-WebSocket-Key: ${Buffer.alloc(16, 1).toString("base64")}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
				);
			});
			raw.once("data", (data: Buffer) => {
				if (data.toString().startsWith("HTTP/1.1 101")) resolveUpgrade(raw);
				else rejectUpgrade(new Error(data.toString()));
			});
			raw.once("error", rejectUpgrade);
		});
		const firstExit = exited(first.child);
		first.child.kill("SIGTERM");
		const close = await withDeadline(closed, "the client's close after a deploy", 60_000);
		assert.equal(close.code, 1012, `the client did not get a clean close: ${close.code} ${close.reason}`);
		await withDeadline(firstExit, "the old runner's exit", 15_000);

		const secondPort = await freePort();
		const second = await startServe(project.directory, engine.endpoint, secondPort);
		running.push(second.child);
		const again = await openWebSocket(`http://127.0.0.1:${secondPort}/socket?room=deploy&name=ann`);
		const reply = await ask(again, "after");
		assert.notEqual(reply.boot, before.boot);
		assert.equal(reply.count, 2, "storage did not survive the deploy");
		assert.equal(reply.everyone, 1, "the dead socket came back");
	} finally {
		silent?.destroy();
		for (const child of running) {
			if (child.exitCode === null && child.signalCode === null) {
				const exit = exited(child);
				child.kill("SIGTERM");
				await withDeadline(exit, "orange serve stop", 15_000).catch(() => child.kill("SIGKILL"));
			}
		}
		await project.dispose();
		await engine.stop();
	}
});

// Rivet's gateway closes the socket with 1011 and a Rivet error, such as `ups.consumer_closed#<ray>`,
// when the Engine stops or the object's runner crashes.
test("when the Rivet Engine goes away, a Durable Object WebSocket closes with 1012 and no Rivet error", { timeout: 180_000 }, async () => {
	const engine = await startStandaloneEngine();
	const project = await copyProject(join(repositoryRoot, "tests", "fixtures", "accepted-websockets"));
	let child: ChildProcess | undefined;
	try {
		const port = await freePort();
		const serve = await startServe(project.directory, engine.endpoint, port);
		child = serve.child;
		const closeOf = (socket: ClientWebSocket): Promise<{ code: number; reason: string }> =>
			new Promise((resolveClose) => {
				socket.once("close", (code: unknown, reason: unknown) => resolveClose({ code: Number(code), reason: String(reason) }));
			});
		const accepted = await openWebSocket(`http://127.0.0.1:${port}/socket?room=engine&name=ann`);
		const standard = await openWebSocket(`http://127.0.0.1:${port}/socket?room=engine&mode=standard`);
		const closes = Promise.all([closeOf(accepted), closeOf(standard)]);
		const replies = collectMessages(accepted, 1);
		accepted.send("hello");
		await withDeadline(replies, "the reply");

		await engine.stop();
		const restart = { code: 1012, reason: "Service Restart" };
		assert.deepEqual(await withDeadline(closes, "the clients' closes", 30_000), [restart, restart], serve.output());
	} finally {
		if (child !== undefined && child.exitCode === null && child.signalCode === null) {
			const exit = exited(child);
			child.kill("SIGTERM");
			await withDeadline(exit, "orange serve stop", 15_000).catch(() => child?.kill("SIGKILL"));
		}
		await project.dispose();
		await engine.stop();
	}
});

// Rivet's gateway refuses a WebSocket by accepting it and closing it with 1011 and the Rivet error,
// such as `actor.not_found#<ray>`. Only an error that means the runner or the Engine went away is a
// restart. A client must not reconnect forever on any other error, and the ray ID finds the Engine's
// log line.
// https://github.com/rivet-dev/rivet/blob/cf8679c670bc1e0e22252a6daf0523b9a1771ed6/engine/packages/pegboard-gateway/src/routes.rs#L654-L690
test("a Rivet error that is not a restart reaches the Durable Object WebSocket client unchanged, with its ray ID", { timeout: 180_000 }, async () => {
	const engine = await startStandaloneEngine();
	const project = await copyProject(join(repositoryRoot, "tests", "fixtures", "accepted-websockets"));
	const refusal = { code: 1011, reason: "actor.not_found#p2acxk5577tuk4vbe5ixduhevucl00" };
	// The runtime reaches the Engine through this proxy, which refuses each Durable Object WebSocket
	// as the gateway does. Other traffic passes through.
	const upstream = new URL(engine.endpoint);
	const proxy = createServer((client) => {
		client.on("error", () => undefined);
		let head = Buffer.alloc(0);
		const readHead = (data: Buffer): void => {
			head = Buffer.concat([head, data]);
			const text = head.toString("latin1");
			if (!text.includes("\r\n\r\n")) return;
			client.off("data", readHead);
			if (/upgrade: websocket/i.test(text) && text.split("\r\n", 1)[0]?.includes("/__open-orange/durable-object/websocket")) {
				const key = /sec-websocket-key: *(\S+)/i.exec(text)?.[1] ?? "";
				const accept = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
				const reason = Buffer.from(refusal.reason);
				const payload = Buffer.concat([Buffer.from([refusal.code >> 8, refusal.code & 0xff]), reason]);
				// The gateway selects the first requested protocol that carries no token.
				const protocol = (/sec-websocket-protocol: *([^\r]*)/i.exec(text)?.[1] ?? "")
					.split(",")
					.map((entry) => entry.trim())
					.find((entry) => entry !== "" && !entry.startsWith("rivet_token."));
				client.write(
					"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
						`Sec-WebSocket-Accept: ${accept}\r\n${protocol === undefined ? "" : `Sec-WebSocket-Protocol: ${protocol}\r\n`}\r\n`,
				);
				client.write(Buffer.concat([Buffer.from([0x88, payload.length]), payload]));
				client.end();
				return;
			}
			const server = connect(Number(upstream.port), upstream.hostname);
			server.on("error", () => client.destroy());
			client.on("close", () => server.destroy());
			server.on("close", () => client.destroy());
			server.write(head);
			client.pipe(server);
			server.pipe(client);
		};
		client.on("data", readHead);
	});
	await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
	const proxyPort = (proxy.address() as AddressInfo).port;
	let serve: RunningServe | undefined;
	try {
		const port = await freePort();
		serve = await startServe(project.directory, `http://127.0.0.1:${proxyPort}`, port, { RIVET_TOKEN: adminToken });
		const socket = await openWebSocket(`http://127.0.0.1:${port}/socket?room=refused&name=ann`);
		const closed = new Promise<{ code: number; reason: string }>((resolveClose) => {
			socket.once("close", (code: unknown, reason: unknown) => resolveClose({ code: Number(code), reason: String(reason) }));
		});
		assert.deepEqual(await withDeadline(closed, "the client's close", 30_000), refusal, serve.output());
	} finally {
		if (serve !== undefined) {
			const exit = exited(serve.child);
			serve.child.kill("SIGTERM");
			await withDeadline(exit, "orange serve stop", 15_000).catch(() => serve?.child.kill("SIGKILL"));
		}
		proxy.close();
		await project.dispose();
		await engine.stop();
	}
});

// Rivet 3 clusters run the image as a runner and set the endpoint and the token in
// separate variables, so the endpoint URL carries no credentials.
test("orange serve as a runner serves Durable Objects with RIVET_TOKEN set apart from RIVET_ENDPOINT", async () => {
	const engine = await startStandaloneEngine();
	const project = await copyProject(join(repositoryRoot, "examples", "hello-durable-object"));
	let serve: RunningServe | undefined;
	try {
		const port = await freePort();
		serve = await startServe(project.directory, `http://${new URL(engine.endpoint).host}`, port, {
			RIVET_TOKEN: adminToken,
		});
		assert.deepEqual(await greet(serve, port, "bob"), { greeting: "Hello, bob!", visits: 1 });
		assert.deepEqual(await greet(serve, port, "bob"), { greeting: "Hello, bob!", visits: 2 });
	} finally {
		if (serve !== undefined) {
			const exit = exited(serve.child);
			serve.child.kill("SIGTERM");
			await withDeadline(exit, "orange serve stop", 15_000).catch(() => serve?.child.kill("SIGKILL"));
		}
		await project.dispose();
		await engine.stop();
	}
});

test("orange serve builds a Worker for production, as wrangler deploy does", async () => {
	const engine = await startStandaloneEngine();
	const project = await copyProject(join(repositoryRoot, "tests", "fixtures", "node-env"));
	let serve: RunningServe | undefined;
	try {
		const port = await freePort();
		serve = await startServe(project.directory, `http://${new URL(engine.endpoint).host}`, port, {
			NODE_ENV: "",
			RIVET_TOKEN: adminToken,
		});
		assert.equal(await (await fetch(`http://127.0.0.1:${port}/`)).text(), "production");
	} finally {
		if (serve !== undefined) {
			const exit = exited(serve.child);
			serve.child.kill("SIGTERM");
			await withDeadline(exit, "orange serve stop", 15_000).catch(() => serve?.child.kill("SIGKILL"));
		}
		await project.dispose();
		await engine.stop();
	}
});

test("orange serve has no local email route, so nobody can forge a deployed Worker's mail over HTTP", async () => {
	const engine = await startStandaloneEngine();
	const project = await copyProject(join(repositoryRoot, "tests", "fixtures", "email-handler"));
	let serve: RunningServe | undefined;
	try {
		const port = await freePort();
		serve = await startServe(project.directory, `http://${new URL(engine.endpoint).host}`, port, {
			RIVET_TOKEN: adminToken,
		});
		const response = await fetch(`http://127.0.0.1:${port}/cdn-cgi/handler/email?from=a%40example.net&to=b%40example.com`, {
			body: "Message-ID: <1@example.net>\r\nSubject: forged\r\n\r\nbody\r\n",
			method: "POST",
		});
		assert.deepEqual(await response.json(), { last: null, reachedFetch: "/cdn-cgi/handler/email" });
	} finally {
		if (serve !== undefined) {
			const exit = exited(serve.child);
			serve.child.kill("SIGTERM");
			await withDeadline(exit, "orange serve stop", 15_000).catch(() => serve?.child.kill("SIGKILL"));
		}
		await project.dispose();
		await engine.stop();
	}
});

test("orange serve has no local cron route, so nobody can fire a deployed Worker's crons over HTTP", async () => {
	const engine = await startStandaloneEngine();
	const project = await copyProject(join(repositoryRoot, "tests", "fixtures", "email-handler"));
	let serve: RunningServe | undefined;
	try {
		const port = await freePort();
		serve = await startServe(project.directory, `http://${new URL(engine.endpoint).host}`, port, {
			RIVET_TOKEN: adminToken,
		});
		const response = await fetch(`http://127.0.0.1:${port}/cdn-cgi/local/scheduled?cron=*`);
		assert.deepEqual(await response.json(), { last: null, reachedFetch: "/cdn-cgi/local/scheduled" });
	} finally {
		if (serve !== undefined) {
			const exit = exited(serve.child);
			serve.child.kill("SIGTERM");
			await withDeadline(exit, "orange serve stop", 15_000).catch(() => serve?.child.kill("SIGKILL"));
		}
		await project.dispose();
		await engine.stop();
	}
});

test("a D1 query reports the real failure when the database's actor can't be reached", { timeout: 180_000 }, async () => {
	const engine = await startStandaloneEngine();
	const project = await copyProject(join(repositoryRoot, "tests", "fixtures", "d1-actor-failure"));
	// The runner reaches the Engine through this proxy, which can stop carrying data on the runner's
	// WebSocket. The Engine then has no runner to start actors on, and answers with a Rivet error.
	const webSockets = new Set<{ silent: boolean }>();
	const upstream = new URL(engine.endpoint);
	const proxy = createServer((client) => {
		const server = connect(Number(upstream.port), upstream.hostname);
		const socket = { silent: false };
		client.once("data", (data) => {
			if (/upgrade: websocket/i.test(data.toString("latin1"))) webSockets.add(socket);
		});
		client.on("data", (data) => socket.silent || server.write(data));
		server.on("data", (data) => socket.silent || client.write(data));
		for (const side of [client, server]) {
			side.on("error", () => undefined);
			side.on("close", () => {
				client.destroy();
				server.destroy();
			});
		}
	});
	await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
	const proxyPort = (proxy.address() as AddressInfo).port;
	let serve: RunningServe | undefined;
	try {
		const port = await freePort();
		serve = await startServe(project.directory, `http://127.0.0.1:${proxyPort}`, port, { RIVET_TOKEN: adminToken });
		assert.equal(await (await fetch(`http://127.0.0.1:${port}/`)).text(), "1");

		assert.notEqual(webSockets.size, 0);
		for (const socket of webSockets) socket.silent = true;
		const failure = await (await fetch(`http://127.0.0.1:${port}/`)).text();
		// Which Rivet error arrives depends on timing, so this checks that one is named.
		assert.match(failure, /^D1_ERROR: The D1 database could not answer \(status \d+\): [a-z_]+\.[a-z_]+: /);
	} finally {
		if (serve !== undefined) {
			const exit = exited(serve.child);
			serve.child.kill("SIGKILL");
			await withDeadline(exit, "orange serve stop", 15_000).catch(() => undefined);
		}
		proxy.close();
		await project.dispose();
		await engine.stop();
	}
});

test("orange serve keeps Durable Objects in RIVET_NAMESPACE when the endpoint names no namespace", async () => {
	const engine = await startStandaloneEngine();
	const project = await copyProject(join(repositoryRoot, "examples", "hello-durable-object"));
	let serve: RunningServe | undefined;
	try {
		const host = new URL(engine.endpoint).host;
		const authorization = `Bearer ${adminToken}`;
		const created = await fetch(`http://${host}/namespaces`, {
			body: JSON.stringify({ name: "cluster" }),
			headers: { authorization, "content-type": "application/json" },
			method: "POST",
		});
		assert.equal(created.status, 200, await created.clone().text());
		const port = await freePort();
		serve = await startServe(project.directory, `http://${host}`, port, {
			RIVET_NAMESPACE: "cluster",
			RIVET_TOKEN: adminToken,
		});
		assert.deepEqual(await greet(serve, port, "carol"), { greeting: "Hello, carol!", visits: 1 });

		const actorNames = async (namespace: string): Promise<string[]> => {
			const response = await fetch(`http://${host}/actors/names?namespace=${namespace}`, {
				headers: { authorization },
			});
			assert.equal(response.status, 200, await response.clone().text());
			return Object.keys(((await response.json()) as { names: Record<string, unknown> }).names);
		};
		const greeter = (await actorNames("cluster")).filter((name) => !name.startsWith("openorange:"));
		assert.notEqual(greeter.length, 0, "the Durable Object actor is in RIVET_NAMESPACE");
		for (const name of greeter) assert.ok(!(await actorNames("default")).includes(name), `${name} leaked into default`);
	} finally {
		if (serve !== undefined) {
			const exit = exited(serve.child);
			serve.child.kill("SIGTERM");
			await withDeadline(exit, "orange serve stop", 15_000).catch(() => serve?.child.kill("SIGKILL"));
		}
		await project.dispose();
		await engine.stop();
	}
});

// A Rivet cluster scrapes each runner's metrics from 127.0.0.1:$RIVETKIT_METRICS_PORT.
test("orange serve serves the runner's Prometheus metrics on RIVETKIT_METRICS_PORT", async () => {
	const engine = await startStandaloneEngine();
	const project = await copyProject(join(repositoryRoot, "examples", "hello-durable-object"));
	let serve: RunningServe | undefined;
	try {
		const [port, metricsPort] = [await freePort(), await freePort()];
		serve = await startServe(project.directory, engine.endpoint, port, {
			RIVETKIT_METRICS_PORT: String(metricsPort),
		});
		await greet(serve, port, "dana");
		const metrics = await fetch(`http://127.0.0.1:${metricsPort}/metrics`);
		assert.equal(metrics.status, 200, serve.output());
		assert.match(await metrics.text(), /^# (HELP|TYPE) /m);
		const other = await fetch(`http://127.0.0.1:${metricsPort}/`);
		assert.equal(other.status, 404);
		// The Worker's own port does not expose the runner's metrics.
		const worker = await fetch(`http://127.0.0.1:${port}/metrics`);
		assert.doesNotMatch(await worker.text(), /^# (HELP|TYPE) /m);
	} finally {
		if (serve !== undefined) {
			const exit = exited(serve.child);
			serve.child.kill("SIGTERM");
			await withDeadline(exit, "orange serve stop", 15_000).catch(() => serve?.child.kill("SIGKILL"));
		}
		await project.dispose();
		await engine.stop();
	}
});

test("orange serve with an invalid RIVETKIT_METRICS_PORT exits with an error that names it", async () => {
	const engine = await startStandaloneEngine();
	const project = await copyProject(join(repositoryRoot, "examples", "hello-durable-object"));
	try {
		const serve = spawnServe(project.directory, {
			PORT: String(await freePort()),
			RIVET_ENDPOINT: engine.endpoint,
			RIVETKIT_METRICS_PORT: "not-a-port",
		});
		assert.equal(await withDeadline(exited(serve.child), "orange serve", 60_000), 1);
		assert.match(serve.output(), /RIVETKIT_METRICS_PORT must be a TCP port/);
	} finally {
		await project.dispose();
		await engine.stop();
	}
});

test("orange serve without RIVET_ENDPOINT exits with an error that names it", async () => {
	const project = await copyProject(join(repositoryRoot, "examples", "hello-durable-object"));
	try {
		const serve = spawnServe(project.directory, {});
		assert.equal(await withDeadline(exited(serve.child), "orange serve", 30_000), 1);
		assert.match(serve.output(), /RIVET_ENDPOINT/);
	} finally {
		await project.dispose();
	}
});

test("a Worker under orange serve never sees the Rivet endpoint or tokens", async () => {
	const engine = await startStandaloneEngine();
	const directory = await mkdtemp(join(tmpdir(), "open-orange-serve-env-"));
	let serve: RunningServe | undefined;
	try {
		await writeFile(
			join(directory, "wrangler.jsonc"),
			JSON.stringify({
				compatibility_date: "2026-09-03",
				compatibility_flags: ["nodejs_compat"],
				main: "index.js",
				name: "env-probe",
			}),
		);
		await writeFile(
			join(directory, "index.js"),
			`import process from "node:process";
const names = ["RIVET_ENDPOINT", "RIVET_TOKEN"];
export default {
	fetch(request, env) {
		return Response.json(names.map((name) => [name, process.env[name] ?? null, env[name] ?? null]));
	},
};
`,
		);
		const port = await freePort();
		serve = await startServe(directory, engine.endpoint, port, { RIVET_TOKEN: adminToken });
		const response = await fetch(`http://127.0.0.1:${port}/`);
		assert.deepEqual(await response.json(), [
			["RIVET_ENDPOINT", null, null],
			["RIVET_TOKEN", null, null],
		]);
	} finally {
		if (serve !== undefined) {
			const exit = exited(serve.child);
			serve.child.kill("SIGTERM");
			await withDeadline(exit, "orange serve stop", 15_000).catch(() => serve?.child.kill("SIGKILL"));
		}
		await rm(directory, { force: true, recursive: true });
		await engine.stop();
	}
});

interface EngineActor {
	destroy_ts?: number | null;
}

async function listActors(engine: StandaloneEngine, name: string): Promise<EngineActor[]> {
	const url = new URL(engine.endpoint);
	const response = await fetch(
		`http://${url.host}/actors?namespace=default&name=${encodeURIComponent(name)}`,
		{ headers: { authorization: `Bearer ${adminToken}` } },
	);
	assert.equal(response.status, 200, await response.clone().text());
	return ((await response.json()) as { actors: EngineActor[] }).actors;
}

// The cron sync runs in the background after `serve` listens and has no
// completion signal, so the test polls the Engine until the deadline.
async function waitForLiveActorCount(engine: StandaloneEngine, name: string, count: number): Promise<void> {
	const deadline = Date.now() + 30_000;
	for (;;) {
		const actors = (await listActors(engine, name)).filter((actor) => (actor.destroy_ts ?? null) === null);
		if (actors.length === count) return;
		if (Date.now() > deadline) assert.fail(`expected ${count} live ${name} actors, found ${actors.length}`);
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
	}
}

test("orange serve deletes the cron jobs of a removed configuration after a restart on an empty disk", async () => {
	const engine = await startStandaloneEngine();
	const directory = await mkdtemp(join(tmpdir(), "open-orange-serve-cron-removed-"));
	const running: ChildProcess[] = [];
	const writeConfig = (crons: string[]): Promise<void> =>
		writeFile(
			join(directory, "wrangler.jsonc"),
			JSON.stringify({
				compatibility_date: "2026-09-03",
				main: "index.js",
				name: "cron-removed",
				triggers: { crons },
			}),
		);
	try {
		await writeFile(
			join(directory, "index.js"),
			"export default { fetch: () => new Response(\"ok\"), scheduled() {} };\n",
		);
		const port = await freePort();
		await writeConfig(["*/5 * * * *"]);
		const first = await startServe(directory, engine.endpoint, port);
		running.push(first.child);
		await waitForLiveActorCount(engine, "openorange:cron", 1);

		// The next deploy has no crons and starts on an empty disk.
		const firstExit = exited(first.child);
		first.child.kill("SIGKILL");
		await firstExit;
		await rm(join(directory, ".open-orange"), { force: true, recursive: true });
		await writeConfig([]);
		const second = await startServe(directory, engine.endpoint, port);
		running.push(second.child);
		await waitForLiveActorCount(engine, "openorange:cron", 0);
	} finally {
		for (const child of running) {
			if (child.exitCode === null && child.signalCode === null) {
				const exit = exited(child);
				child.kill("SIGTERM");
				await withDeadline(exit, "orange serve stop", 15_000).catch(() => child.kill("SIGKILL"));
			}
		}
		await rm(directory, { force: true, recursive: true });
		await engine.stop();
	}
});

async function runCli(
	args: readonly string[],
	env: NodeJS.ProcessEnv,
): Promise<{ code: number | null; output: string }> {
	const child = spawn(process.execPath, ["--import", "tsx", cliEntrypoint, ...args], {
		cwd: repositoryRoot,
		env: { ...process.env, ...env },
		stdio: ["ignore", "pipe", "pipe"],
	});
	const output = collectOutput(child);
	const code = await withDeadline(exited(child), `orange ${args.join(" ")}`, 60_000);
	return { code, output: output() };
}

test("orange d1 migrations apply --remote migrates the database that orange serve uses", async () => {
	const engine = await startStandaloneEngine();
	const project = await copyProject(join(repositoryRoot, "tests", "fixtures", "examples", "d1-migrations"));
	let serve: RunningServe | undefined;
	try {
		const config = join(project.directory, "wrangler.jsonc");
		const apply = ["d1", "migrations", "apply", "DB", "--remote", "--config", config];
		const withoutEndpoint = await runCli(apply, {});
		assert.equal(withoutEndpoint.code, 1, withoutEndpoint.output);
		assert.match(withoutEndpoint.output, /--remote needs RIVET_ENDPOINT/);

		const port = await freePort();
		serve = await startServe(project.directory, engine.endpoint, port);
		const before = await fetch(`http://127.0.0.1:${port}/comments`);
		assert.equal(before.status, 500, "the table does not exist before the migrations");

		const applied = await runCli(apply, { RIVET_ENDPOINT: engine.endpoint });
		assert.equal(applied.code, 0, applied.output);
		const after = await fetch(`http://127.0.0.1:${port}/comments`);
		assert.equal(after.status, 200, serve.output());
		const again = await runCli(apply, { RIVET_ENDPOINT: engine.endpoint });
		assert.match(again.output, /No migrations to apply/);
	} finally {
		if (serve !== undefined) {
			const exit = exited(serve.child);
			serve.child.kill("SIGTERM");
			await withDeadline(exit, "orange serve stop", 15_000).catch(() => serve?.child.kill("SIGKILL"));
		}
		await project.dispose();
		await engine.stop();
	}
});

// A deployed Worker binds the stores that `wrangler deploy` binds: R2 `bucket_name`, KV `id`, and
// D1 `database_id`. Their preview variants are for `wrangler dev` only.
const previewBindingsFixture = join(repositoryRoot, "tests", "fixtures", "preview-bindings");

async function stopServe(serve: RunningServe | undefined): Promise<void> {
	if (serve === undefined || serve.child.exitCode !== null || serve.child.signalCode !== null) return;
	const exit = exited(serve.child);
	serve.child.kill("SIGTERM");
	await withDeadline(exit, "orange serve stop", 15_000).catch(() => serve.child.kill("SIGKILL"));
}

async function put(serve: RunningServe, port: number, path: string, body: string): Promise<void> {
	const response = await fetch(`http://127.0.0.1:${port}${path}`, { body, method: "PUT" });
	assert.equal(response.status, 200, `${await response.text()}\n${serve.output()}`);
}

// The fixture's config with only the deployed store of each binding, as another deployment of
// the same Worker would name it.
async function writeDeployedOnlyConfig(projectDirectory: string): Promise<void> {
	await writeFile(
		join(projectDirectory, "wrangler.jsonc"),
		JSON.stringify({
			compatibility_date: "2026-08-01",
			d1_databases: [{ binding: "DB", database_id: "00000000-0000-4000-8000-00000000000a", database_name: "notes" }],
			kv_namespaces: [{ binding: "KV", id: "live-kv" }],
			main: "worker.js",
			name: "preview-bindings",
			r2_buckets: [{ binding: "BUCKET", bucket_name: "live-uploads" }],
		}),
	);
}

test("under orange serve, an R2 binding with a preview bucket stores objects in the S3 store set for bucket_name", { skip: minioSkip }, async () => {
	const engine = await startStandaloneEngine();
	const store = await startMinio();
	const project = await copyProject(previewBindingsFixture);
	let serve: RunningServe | undefined;
	try {
		// Settings exist only for the deployed bucket name.
		const { bucket, env } = await minioBucketSettings(store, "live-uploads");
		const port = await freePort();
		serve = await startServe(project.directory, engine.endpoint, port, env);
		await put(serve, port, "/r2/report", "quarterly numbers");

		const client = s3Client(store);
		try {
			const object = await client.send(new GetObjectCommand({ Bucket: bucket, Key: "report" }));
			assert.equal(await object.Body?.transformToString(), "quarterly numbers");
		} finally {
			client.destroy();
		}
	} finally {
		await stopServe(serve);
		await project.dispose();
		await store.stop();
		await engine.stop();
	}
});

// The value must be in the store that a config without the preview name reaches too.
async function assertWritesReachTheDeployedStore(path: string): Promise<void> {
	const engine = await startStandaloneEngine();
	const project = await copyProject(previewBindingsFixture);
	let serve: RunningServe | undefined;
	try {
		const firstPort = await freePort();
		serve = await startServe(project.directory, engine.endpoint, firstPort);
		await put(serve, firstPort, path, "hello from the deployed store");
		await stopServe(serve);

		await writeDeployedOnlyConfig(project.directory);
		const secondPort = await freePort();
		serve = await startServe(project.directory, engine.endpoint, secondPort);
		const response = await fetch(`http://127.0.0.1:${secondPort}${path}`);
		assert.equal(response.status, 200, `${await response.clone().text()}\n${serve.output()}`);
		assert.equal(await response.text(), "hello from the deployed store");
	} finally {
		await stopServe(serve);
		await project.dispose();
		await engine.stop();
	}
}

test("under orange serve, a KV binding with a preview_id writes to the namespace named by id", async () => {
	await assertWritesReachTheDeployedStore("/kv/greeting");
});

test("under orange serve, a D1 binding with a preview_database_id writes to the database named by database_id", async () => {
	await assertWritesReachTheDeployedStore("/d1/greeting");
});

test("under orange serve, inbound email needs the shared secret, and a provider's form post with it runs email()", { skip: mailpitSkip, timeout: 240_000 }, async () => {
	const engine = await startStandaloneEngine();
	const mailpit = await startMailpit();
	const project = await copyProject(join(repositoryRoot, "tests", "fixtures", "inbound-email"));
	let serve: RunningServe | undefined;
	const message = "From: Alice <alice@example.org>\r\nTo: inbox@example.com\r\nSubject: Webhook\r\nMessage-ID: <webhook-1@example.org>\r\n\r\nHi.\r\n";
	const form = (): FormData => {
		const body = new FormData();
		// SendGrid Inbound Parse with "POST the raw, full MIME message" on.
		body.set("email", message);
		body.set("envelope", JSON.stringify({ from: "alice@example.org", to: ["inbox@example.com"] }));
		return body;
	};
	try {
		// Without the secret, a deployed Worker has no mail route: the request reaches its fetch().
		const firstPort = await freePort();
		serve = await startServe(project.directory, engine.endpoint, firstPort, { ORANGE_EMAIL_INBOUND_SECRET: "", ORANGE_EMAIL_SMTP_URL: mailpit.smtpUrl });
		const noRoute = await fetch(`http://127.0.0.1:${firstPort}/cdn-cgi/handler/email`, { body: form(), method: "POST" });
		assert.equal(await noRoute.text(), "the Worker's own fetch()");
		await stopServe(serve);

		const port = await freePort();
		serve = await startServe(project.directory, engine.endpoint, port, { ORANGE_EMAIL_INBOUND_SECRET: "s3cret-value", ORANGE_EMAIL_SMTP_URL: mailpit.smtpUrl });
		const route = `http://127.0.0.1:${port}/cdn-cgi/handler/email`;
		const unauthenticated = await fetch(route, { body: form(), method: "POST" });
		assert.equal(unauthenticated.status, 401);
		const wrong = await fetch(route, { body: form(), headers: { authorization: "Bearer not-the-secret" }, method: "POST" });
		assert.equal(wrong.status, 401);
		// The secret as the Basic auth password, as a webhook URL https://inbound:<secret>@host carries it.
		const basic = `Basic ${Buffer.from("inbound:s3cret-value").toString("base64")}`;
		const delivered = await fetch(route, { body: form(), headers: { authorization: basic }, method: "POST" });
		assert.equal(delivered.status, 200, `${await delivered.clone().text()}\n${serve.output()}`);
	} finally {
		await stopServe(serve);
		await project.dispose();
		await engine.stop();
	}
	try {
		const received = await mailpit.messages();
		assert.deepEqual(received.map((received) => received.Subject).sort(), ["Re: Webhook", "Webhook"]);
	} finally {
		await mailpit.stop();
	}
});


const multiWorkerFixture = join(repositoryRoot, "tests", "fixtures", "serve-multi-worker");

test("orange serve with several Workers sends each request to the Worker its route names, and the Workers reach each other", { timeout: 240_000 }, async () => {
	const engine = await startStandaloneEngine();
	const project = await copyProject(multiWorkerFixture);
	const port = await freePort();
	const metricsPort = await freePort();
	const serve = await startServe(project.directory, engine.endpoint, port, { RIVETKIT_METRICS_PORT: String(metricsPort) }, [
		"wrangler.jsonc",
		"wrangler.peer.jsonc",
	]);
	try {
		const origin = `http://127.0.0.1:${port}`;
		// Only one runtime serves the cluster's metrics port, so the deployment starts.
		const metrics = await fetch(`http://127.0.0.1:${metricsPort}/metrics`);
		assert.equal(metrics.status, 200, serve.output());
		const json = async (path: string): Promise<unknown> => {
			const response = await fetch(`${origin}${path}`);
			assert.equal(response.status, 200, serve.output());
			return await response.json();
		};
		assert.deepEqual(await json("/"), { host: `127.0.0.1:${port}`, worker: "primary" });
		assert.deepEqual(await json("/api/hello?x=1"), { path: "/api/hello", worker: "peer" });
		// /apix is outside the route's /api/ prefix.
		assert.deepEqual(await json("/apix"), { host: `127.0.0.1:${port}`, worker: "primary" });
		// The first Worker calls the other Worker's Durable Object, which keeps its storage.
		assert.deepEqual(await json("/count"), { count: 1 });
		assert.deepEqual(await json("/count"), { count: 2 });
		const socket = await openWebSocket(`${origin}/ws`);
		const replies = collectMessages(socket, 1);
		socket.send("hi");
		assert.deepEqual(await withDeadline(replies, "WebSocket echo through the front", 15_000), ["echo:hi"]);
		socket.close();
	} finally {
		await stopServe(serve);
		await project.dispose();
		await engine.stop();
	}
});

test("under orange serve, each Worker's cron runs its own handler, and a queue reaches the Worker that consumes it", { timeout: 240_000 }, async () => {
	const engine = await startStandaloneEngine();
	const project = await copyProject(multiWorkerFixture);
	const port = await freePort();
	const serve = await startServe(project.directory, engine.endpoint, port, {}, ["wrangler.jsonc", "wrangler.peer.jsonc"]);
	try {
		const origin = `http://127.0.0.1:${port}`;
		const kv = async (key: string): Promise<unknown> => await (await fetch(`${origin}/kv?key=${key}`)).json();
		assert.deepEqual(await (await fetch(`${origin}/send?text=hello`)).json(), { sent: true });
		// Both crons fire once a minute.
		const deadline = Date.now() + 150_000;
		while ((await kv("cron-primary")) === null || (await kv("cron-peer")) === null || (await kv("queued")) === null) {
			assert.ok(Date.now() < deadline, `crons or queue never ran:\n${serve.output()}`);
			await delay(2_000);
		}
		assert.equal(await kv("cron-primary"), "primary");
		assert.equal(await kv("cron-peer"), "peer");
		assert.equal(await kv("queued"), "peer:hello");
	} finally {
		await stopServe(serve);
		await project.dispose();
		await engine.stop();
	}
});

test("orange serve routes a forwarded host only when its signature matches the secret, and the Worker never sees the forwarding headers", { timeout: 240_000 }, async () => {
	const engine = await startStandaloneEngine();
	const project = await copyProject(multiWorkerFixture);
	const port = await freePort();
	const secret = "test-forwarding-secret";
	const serve = await startServe(project.directory, engine.endpoint, port, { ORANGE_FORWARDED_HOST_SECRET: secret }, [
		"wrangler.jsonc",
		"wrangler.status.jsonc",
	]);
	try {
		const ask = async (headers: Record<string, string>): Promise<unknown> => {
			const response = await fetch(`http://127.0.0.1:${port}/`, { headers });
			assert.equal(response.status, 200, serve.output());
			return await response.json();
		};
		assert.deepEqual(
			await ask({
				"x-orange-forwarded-host": "status.example.test",
				"x-orange-forwarded-host-signature": signForwardedHost(secret, "status.example.test"),
			}),
			{ forwarded: [], host: "status.example.test", worker: "status" },
		);
		assert.deepEqual(
			await ask({
				"x-orange-forwarded-host": "status.example.test",
				"x-orange-forwarded-host-signature": signForwardedHost("wrong-secret", "status.example.test"),
			}),
			{ host: `127.0.0.1:${port}`, worker: "primary" },
		);
		assert.deepEqual(await ask({ "x-orange-forwarded-host": "status.example.test" }), {
			host: `127.0.0.1:${port}`,
			worker: "primary",
		});
	} finally {
		await stopServe(serve);
		await project.dispose();
		await engine.stop();
	}
});

test("orange serve refuses a route with * inside its path and names the route", { timeout: 120_000 }, async () => {
	const project = await copyProject(multiWorkerFixture);
	try {
		const serve = spawnServe(project.directory, { PORT: String(await freePort()), RIVET_ENDPOINT: "http://default:x@127.0.0.1:1" }, [
			"wrangler.jsonc",
			"wrangler.bad-route.jsonc",
		]);
		assert.notEqual(await withDeadline(exited(serve.child), "orange serve exit", 60_000), 0);
		assert.match(serve.output(), /Route "127\.0\.0\.1\/a\*b" is not valid/);
	} finally {
		await project.dispose();
	}
});

test("under orange serve, request.url takes the scheme the gateway forwards, and orange dev ignores the header", { timeout: 180_000 }, async () => {
	const engine = await startStandaloneEngine();
	const project = await copyProject(join(repositoryRoot, "tests", "fixtures", "serve-request-url"));
	const port = await freePort();
	const serve = await startServe(project.directory, engine.endpoint, port);
	try {
		const url = async (origin: string, headers: Record<string, string>): Promise<unknown> => {
			const response = await fetch(`${origin}/path?q=1`, { headers });
			assert.equal(response.status, 200, serve.output());
			return ((await response.json()) as { url: string }).url;
		};
		const origin = `http://127.0.0.1:${port}`;
		assert.equal(await url(origin, { "x-forwarded-proto": "https" }), `https://127.0.0.1:${port}/path?q=1`);
		assert.equal(await url(origin, {}), `http://127.0.0.1:${port}/path?q=1`);
		assert.equal(await url(origin, { "x-forwarded-proto": "gopher" }), `http://127.0.0.1:${port}/path?q=1`);
		const dev = await startOrangeDev(project.directory);
		try {
			const devUrl = (await url(dev.origin, { "x-forwarded-proto": "https" })) as string;
			assert.ok(devUrl.startsWith("http://"), devUrl);
		} finally {
			await dev.close();
		}
	} finally {
		await stopServe(serve);
		await project.dispose();
		await engine.stop();
	}
});

// Sums the resident memory of a process and its children, in MiB, from /proc.
async function treeRssMiB(pid: number): Promise<number> {
	const { readFile, readdir } = await import("node:fs/promises");
	const children = new Map<number, number[]>();
	const rss = new Map<number, number>();
	for (const entry of await readdir("/proc")) {
		if (!/^\d+$/.test(entry)) continue;
		const status = await readFile(`/proc/${entry}/status`, "utf8").catch(() => "");
		const parent = Number(/^PPid:\s+(\d+)/m.exec(status)?.[1]);
		rss.set(Number(entry), Number(/^VmRSS:\s+(\d+)/m.exec(status)?.[1] ?? 0));
		children.set(parent, [...(children.get(parent) ?? []), Number(entry)]);
	}
	let total = 0;
	const pending = [pid];
	while (pending.length > 0) {
		const next = pending.pop() ?? 0;
		total += rss.get(next) ?? 0;
		pending.push(...(children.get(next) ?? []));
	}
	return total / 1024;
}

// Measured on the devbox, 2026-11-06: 3765 MiB before orange serve dropped the unused inline
// source map and stopped esbuild after bundling, 1485 MiB after.
const largeWorkerLimitMiB = 2400;

test("a large Worker under orange serve keeps its deployment's memory small", { skip: process.platform !== "linux", timeout: 240_000 }, async () => {
	const engine = await startStandaloneEngine();
	const project = await copyProject(join(repositoryRoot, "tests", "fixtures", "serve-request-url"));
	const port = await freePort();
	// About 40 MB of code, as a large real Worker bundles with its dependencies.
	const functions = Array.from({ length: 200_000 }, (_, index) => `export function f${index}(value) { return value + ${index} * 2 + "${"x".repeat(120)}"; }`);
	await writeFile(join(project.directory, "big.js"), functions.join("\n"));
	await writeFile(
		join(project.directory, "worker.js"),
		'import * as big from "./big.js";\nexport default { fetch() { return Response.json({ functions: Object.keys(big).length }); } };\n',
	);
	const serve = await startServe(project.directory, engine.endpoint, port);
	try {
		const response = await fetch(`http://127.0.0.1:${port}/`);
		assert.deepEqual(await response.json(), { functions: 200_000 }, serve.output());
		const pid = serve.child.pid;
		assert.ok(pid !== undefined);
		const used = await treeRssMiB(pid);
		assert.ok(used < largeWorkerLimitMiB, `orange serve uses ${Math.round(used)} MiB`);
	} finally {
		await stopServe(serve);
		await project.dispose();
		await engine.stop();
	}
});
