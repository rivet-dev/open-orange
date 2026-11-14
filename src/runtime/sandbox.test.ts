import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { request as httpRequest } from "node:http";
import { cp, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { isRecord } from "../../tests/orange-dev.js";
import { freePort } from "../../tests/free-port.js";

// Drives `@cloudflare/sandbox` through a real `orange dev` process and real
// HTTP, with a fixture Worker that uses the SDK as Cloudflare's docs show. The
// default (local) provider and the embedded agentOS provider run here. E2B,
// Daytona, and Freestyle need API keys, so only their configuration errors are
// covered.

const cliEntrypoint = fileURLToPath(new URL("../bin.ts", import.meta.url));
const fixtureWorker = fileURLToPath(new URL("./fixtures/sandbox/worker.js", import.meta.url));
const containerFixtureWorker = fileURLToPath(new URL("./fixtures/sandbox/worker-v1.js", import.meta.url));

interface DevServer {
	origin: string;
	port: number;
	stop(): Promise<void>;
}

function stopChild(child: ChildProcess): Promise<void> {
	return new Promise<void>((resolveStop) => {
		if (child.exitCode !== null || child.signalCode !== null) {
			resolveStop();
			return;
		}
		const timeout = setTimeout(() => child.kill("SIGKILL"), 15_000);
		child.once("exit", () => {
			clearTimeout(timeout);
			resolveStop();
		});
		child.kill("SIGINT");
	});
}

async function startDev(projectRoot: string, env: Record<string, string> = {}): Promise<DevServer> {
	const environment: Record<string, string | undefined> = { ...process.env, CI: "1", NO_COLOR: "1", ...env };
	delete environment.ORANGE_SANDBOX_PROVIDER;
	delete environment.E2B_API_KEY;
	Object.assign(environment, env);
	const child: ChildProcess = spawn(
		process.execPath,
		[
			"--import",
			"tsx",
			cliEntrypoint,
			"dev",
			"--config",
			join(projectRoot, "wrangler.json"),
			"--port",
			"0",
			"--ip",
			"127.0.0.1",
			"--show-interactive-dev-session=false",
		],
		{ env: environment, stdio: ["ignore", "pipe", "pipe"] },
	);
	let output = "";
	const port = await new Promise<number>((resolveReady, rejectReady) => {
		const timeout = setTimeout(() => rejectReady(new Error(`orange dev readiness timed out: ${output}`)), 60_000);
		const onData = (data: unknown): void => {
			output += String(data);
			const match = /Local\s+http:\/\/127\.0\.0\.1:(\d+)/.exec(output);
			if (match?.[1] !== undefined) {
				clearTimeout(timeout);
				resolveReady(Number(match[1]));
			}
		};
		child.stdout?.on("data", onData);
		child.stderr?.on("data", onData);
		child.once("exit", (code) => {
			clearTimeout(timeout);
			rejectReady(new Error(`orange dev exited before readiness (code ${code}): ${output}`));
		});
	});
	return { origin: `http://127.0.0.1:${port}`, port, stop: () => stopChild(child) };
}

async function createProject(): Promise<string> {
	const projectRoot = await mkdtemp(join(tmpdir(), "open-orange-sandbox-"));
	await cp(fixtureWorker, join(projectRoot, "worker.js"));
	await writeFile(join(projectRoot, "Dockerfile"), "FROM docker.io/cloudflare/sandbox:0.4.18\n");
	// The configuration from Cloudflare's Sandbox SDK getting-started guide.
	await writeFile(
		join(projectRoot, "wrangler.json"),
		JSON.stringify({
			compatibility_date: "2026-09-03",
			compatibility_flags: ["nodejs_compat"],
			containers: [{ class_name: "Sandbox", image: "./Dockerfile", instance_type: "lite", max_instances: 1 }],
			durable_objects: { bindings: [{ class_name: "Sandbox", name: "Sandbox" }] },
			main: "./worker.js",
			migrations: [{ new_sqlite_classes: ["Sandbox"], tag: "v1" }],
			name: "sandbox-e2e",
		}),
	);
	return projectRoot;
}

async function call(server: DevServer, path: string, init?: RequestInit): Promise<{ status: number; body: Record<string, unknown> }> {
	const response = await fetch(`${server.origin}${path}`, init);
	const body: unknown = await response.json();
	assert.ok(isRecord(body), JSON.stringify(body));
	return { body, status: response.status };
}

// Reads a route that answers with a JSON array of stream events.
async function callEvents(server: DevServer, path: string): Promise<Record<string, unknown>[]> {
	const response = await fetch(`${server.origin}${path}`);
	const body: unknown = await response.json();
	assert.ok(Array.isArray(body) && body.every(isRecord), JSON.stringify(body));
	return body;
}

// Sends a request with a preview host (`<port>-<sandbox name>-<token>.localhost`) to orange dev.
function preview(server: DevServer, hostPrefix: string, path: string): Promise<{ status: number; body: string }> {
	return new Promise((resolveRequest, rejectRequest) => {
		const request = httpRequest(
			{ headers: { host: `${hostPrefix}.localhost:${server.port}` }, host: "127.0.0.1", path, port: server.port },
			(response) => {
				let body = "";
				response.setEncoding("utf8").on("data", (chunk: string) => (body += chunk));
				response.on("end", () => resolveRequest({ body, status: response.statusCode ?? 0 }));
			},
		);
		request.once("error", rejectRequest);
		request.end();
	});
}

// The `<port>-<sandbox name>-<token>` part of a preview URL from exposePort().
function previewPrefix(url: unknown): string {
	assert.equal(typeof url, "string");
	const { hostname } = new URL(String(url));
	assert.ok(hostname.endsWith(".localhost"), hostname);
	return hostname.slice(0, -".localhost".length);
}

// Cloudflare's answer to a preview URL with a wrong token or an unexposed port.
const invalidToken = {
	body: JSON.stringify({ error: "Access denied: Invalid token or port not exposed", code: "INVALID_TOKEN" }),
	status: 404,
};

function query(values: Record<string, string>): string {
	return new URLSearchParams(values).toString();
}

describe("@cloudflare/sandbox on orange dev with the local provider", { timeout: 180_000 }, () => {
	let projectRoot: string;
	let server: DevServer;

	before(async () => {
		projectRoot = await createProject();
		server = await startDev(projectRoot, { ORANGE_SANDBOX_TEST_SECRET: "host-only" });
	});

	after(async () => {
		await server?.stop();
		if (projectRoot !== undefined) {
			await rm(projectRoot, { force: true, recursive: true });
		}
	});

	it("when a command fails, exec returns its exit code and stderr instead of throwing", async () => {
		const ok = await call(server, `/exec?${query({ cmd: "echo hello && echo warn >&2" })}`);
		assert.equal(ok.status, 200);
		assert.deepEqual([ok.body.stdout, ok.body.stderr, ok.body.exitCode, ok.body.success], ["hello\n", "warn\n", 0, true]);

		const failed = await call(server, `/exec?${query({ cmd: "echo partial; exit 7" })}`);
		assert.equal(failed.status, 200);
		assert.deepEqual([failed.body.stdout, failed.body.exitCode, failed.body.success], ["partial\n", 7, false]);
	});

	it("when orange dev has a secret in its environment, sandbox commands do not see it", async () => {
		const { body } = await call(server, `/exec?${query({ cmd: "echo ${ORANGE_SANDBOX_TEST_SECRET:-unset}" })}`);
		assert.equal(body.stdout, "unset\n");
	});

	it("when execStream runs a failing command, the stream carries its output and exit code", async () => {
		const events = await callEvents(server, `/exec-stream?${query({ cmd: "echo one; echo two >&2; exit 3" })}`);
		assert.equal(events[0]?.type, "start");
		assert.deepEqual(
			events
				.filter((event) => event.type === "stdout" || event.type === "stderr")
				.map((event) => [event.type, event.data])
				.sort(),
			[
				["stdout", "one\n"],
				["stderr", "two\n"],
			].sort(),
		);
		assert.deepEqual([events.at(-1)?.type, events.at(-1)?.exitCode], ["complete", 3]);
	});

	it("when files are written, exec and the file APIs see the same files, and a missing file is an error", async () => {
		const write = await call(server, `/write?${query({ path: "/workspace/notes/a.txt" })}`, { body: "héllo", method: "POST" });
		assert.equal(write.status, 200);
		assert.equal((await call(server, `/read?${query({ path: "/workspace/notes/a.txt" })}`)).body.content, "héllo");
		assert.equal((await call(server, `/exec?${query({ cmd: "cat notes/a.txt" })}`)).body.stdout, "héllo");

		await call(server, `/rename?${query({ from: "/workspace/notes/a.txt", to: "/workspace/notes/b.txt" })}`);
		const listing = await call(server, `/list?${query({ path: "/workspace/notes" })}`);
		const { files } = listing.body;
		assert.ok(Array.isArray(files) && files.every(isRecord), JSON.stringify(listing.body));
		assert.deepEqual(
			files.map((file) => [file.name, file.type]),
			[["b.txt", "file"]],
		);
		assert.equal((await call(server, `/exists?${query({ path: "/workspace/notes/a.txt" })}`)).body.exists, false);

		const missing = await call(server, `/read?${query({ path: "/workspace/missing.txt" })}`);
		assert.equal(missing.status, 500);
		assert.match(String(missing.body.error), /ENOENT/);
	});

	it("when a background process writes output, its log stream delivers each line and ends with the exit code", async () => {
		const started = await call(server, `/start?${query({ cmd: "for i in 1 2 3; do echo line$i; sleep 0.1; done; exit 4", pid: "counter" })}`);
		assert.equal(started.body.status, "running");
		const events = await callEvents(server, `/logs?${query({ pid: "counter" })}`);
		assert.equal(events.filter((event) => event.type === "stdout").map((event) => event.data).join(""), "line1\nline2\nline3\n");
		assert.deepEqual([events.at(-1)?.type, events.at(-1)?.exitCode], ["exit", 4]);
	});

	it("when a long-running process is killed, a status read right after kill says killed and its log stream ends", async () => {
		await call(server, `/start?${query({ cmd: "echo up; sleep 60", pid: "sleeper" })}`);
		const logs = callEvents(server, `/logs?${query({ pid: "sleeper" })}`);
		// The /kill route reads getProcess() right after killProcess() resolves.
		const killed = await call(server, `/kill?${query({ pid: "sleeper" })}`);
		assert.equal(killed.body.status, "killed");
		const events = await logs;
		assert.equal(events.at(-1)?.type, "exit");
	});

	it("when CF code kills a Process object, the process ends and getStatus reports it", async () => {
		const { body, status } = await call(server, "/process-object");
		assert.equal(status, 200, JSON.stringify(body));
		assert.deepEqual(body, {
			after: "killed",
			before: "running",
			exit: { exitCode: 137 },
			listedHasKill: true,
			logs: { stderr: "", stdout: "listening on 4321\n" },
			matched: "4321",
			startTimeIsDate: true,
		});
	});

	it("when two sandbox ids write the same path, each sees only its own file", async () => {
		await call(server, `/write?${query({ id: "alpha", path: "/workspace/owner.txt" })}`, { body: "alpha", method: "POST" });
		await call(server, `/write?${query({ id: "beta", path: "/workspace/owner.txt" })}`, { body: "beta", method: "POST" });
		assert.equal((await call(server, `/read?${query({ id: "alpha", path: "/workspace/owner.txt" })}`)).body.content, "alpha");
		assert.equal((await call(server, `/exec?${query({ cmd: "cat owner.txt", id: "beta" })}`)).body.stdout, "beta");
		assert.equal((await call(server, `/exists?${query({ id: "gamma", path: "/workspace/owner.txt" })}`)).body.exists, false);
	});

	it("when a sandbox is destroyed, the same id starts empty", async () => {
		await call(server, `/write?${query({ id: "doomed", path: "/workspace/keep.txt" })}`, { body: "x", method: "POST" });
		await call(server, `/destroy?${query({ id: "doomed" })}`);
		assert.equal((await call(server, `/exists?${query({ id: "doomed", path: "/workspace/keep.txt" })}`)).body.exists, false);
	});

	it("when a port is exposed, only its preview URL with the token reaches the process", async () => {
		const port = await freePort();
		const id = "web-app";
		await call(server, `/start?${query({ cmd: `node -e "require('http').createServer((q,s)=>s.end('preview '+q.url)).listen(${port},'127.0.0.1')"`, id, pid: "web" })}`);
		const exposed = await call(server, `/expose?${query({ id, port: String(port) })}`);
		assert.match(String(exposed.body.url), new RegExp(`^http://${port}-web-app-[a-z0-9_]{16}\\.localhost:${server.port}/$`));
		const prefix = previewPrefix(exposed.body.url);
		const token = prefix.slice(prefix.lastIndexOf("-") + 1);
		assert.equal((await call(server, `/wait-port?${query({ id, pid: "web", port: String(port) })}`)).body.ready, true);

		assert.deepEqual(await preview(server, prefix, "/hello?x=1"), { body: "preview /hello?x=1", status: 200 });
		// Without a token, the last hyphen of the sandbox name splits off "app" as the token.
		assert.deepEqual(await preview(server, `${port}-web-app`, "/"), invalidToken);
		assert.deepEqual(await preview(server, `${port}-web-app-${token.slice(1)}x`, "/"), invalidToken);
		assert.deepEqual(await preview(server, `${port + 1}-web-app-${token}`, "/"), invalidToken);
		assert.deepEqual((await fetch(`${server.origin}/exposed?${query({ id })}`).then((response) => response.json())), [
			{ port, status: "active", url: exposed.body.url },
		]);
		await call(server, `/kill?${query({ id, pid: "web" })}`);
	});

	it("when a port is unexposed and exposed again, the old preview URL is rejected and the new one works", async () => {
		const port = await freePort();
		const id = "rotate";
		await call(server, `/start?${query({ cmd: `node -e "require('http').createServer((q,s)=>s.end('rotated')).listen(${port},'127.0.0.1')"`, id, pid: "web" })}`);
		const first = await call(server, `/expose?${query({ id, port: String(port) })}`);
		assert.equal((await call(server, `/wait-port?${query({ id, pid: "web", port: String(port) })}`)).body.ready, true);
		// Exposing an exposed port again keeps its URL, as on Cloudflare.
		assert.equal((await call(server, `/expose?${query({ id, port: String(port) })}`)).body.url, first.body.url);

		await call(server, `/unexpose?${query({ id, port: String(port) })}`);
		assert.deepEqual(await preview(server, previewPrefix(first.body.url), "/"), invalidToken);
		assert.deepEqual((await fetch(`${server.origin}/exposed?${query({ id })}`).then((response) => response.json())), []);

		const second = await call(server, `/expose?${query({ id, port: String(port) })}`);
		assert.notEqual(second.body.url, first.body.url);
		assert.deepEqual(await preview(server, previewPrefix(first.body.url), "/"), invalidToken);
		assert.deepEqual(await preview(server, previewPrefix(second.body.url), "/"), { body: "rotated", status: 200 });
		await call(server, `/kill?${query({ id, pid: "web" })}`);
	});

	it("when exposePort gets a custom token, the URL uses it, and an invalid or reused token is rejected", async () => {
		const port = await freePort();
		const id = "custom";
		await call(server, `/start?${query({ cmd: `node -e "require('http').createServer((q,s)=>s.end('custom')).listen(${port},'127.0.0.1')"`, id, pid: "web" })}`);
		const exposed = await call(server, `/expose?${query({ id, port: String(port), token: "my_token_v1" })}`);
		assert.equal(exposed.body.url, `http://${port}-custom-my_token_v1.localhost:${server.port}/`);
		assert.equal((await call(server, `/wait-port?${query({ id, pid: "web", port: String(port) })}`)).body.ready, true);
		assert.deepEqual(await preview(server, `${port}-custom-my_token_v1`, "/"), { body: "custom", status: 200 });

		const invalid = await call(server, `/expose?${query({ id, port: String(port + 1), token: "Bad-Token" })}`);
		assert.equal(invalid.status, 500);
		assert.match(String(invalid.body.error), /Custom token must contain only lowercase letters \(a-z\), numbers \(0-9\), and underscores \(_\)/);
		const long = await call(server, `/expose?${query({ id, port: String(port + 1), token: "a".repeat(17) })}`);
		assert.match(String(long.body.error), /Custom token too long\. Maximum 16 characters allowed/);
		const reused = await call(server, `/expose?${query({ id, port: String(port + 1), token: "my_token_v1" })}`);
		assert.match(String(reused.body.error), new RegExp(`Token 'my_token_v1' is already in use by port ${port}`));
		await call(server, `/kill?${query({ id, pid: "web" })}`);
	});
});

describe("@cloudflare/sandbox on orange dev with the agentos provider", { timeout: 180_000 }, () => {
	let projectRoot: string;
	let server: DevServer;

	before(async () => {
		projectRoot = await createProject();
		server = await startDev(projectRoot, { ORANGE_SANDBOX_PROVIDER: "agentos", ORANGE_SANDBOX_TEST_SECRET: "host-only" });
	});

	after(async () => {
		await server?.stop();
		if (projectRoot !== undefined) {
			await rm(projectRoot, { force: true, recursive: true });
		}
	});

	it("when a command fails, exec returns its exit code and output, and host secrets stay out of the VM", async () => {
		const ok = await call(server, `/exec?${query({ cmd: "echo hello && echo warn >&2 && echo ${ORANGE_SANDBOX_TEST_SECRET:-unset}" })}`);
		assert.equal(ok.status, 200, JSON.stringify(ok.body));
		assert.deepEqual([ok.body.stdout, ok.body.stderr, ok.body.exitCode, ok.body.success], ["hello\nunset\n", "warn\n", 0, true]);

		const failed = await call(server, `/exec?${query({ cmd: "echo partial; exit 7" })}`);
		assert.deepEqual([failed.body.stdout, failed.body.exitCode, failed.body.success], ["partial\n", 7, false]);
	});

	it("when files are written, exec in /workspace sees them, and a missing file is an error", async () => {
		await call(server, `/write?${query({ path: "/workspace/notes/a.txt" })}`, { body: "héllo", method: "POST" });
		assert.equal((await call(server, `/read?${query({ path: "/workspace/notes/a.txt" })}`)).body.content, "héllo");
		assert.equal((await call(server, `/exec?${query({ cmd: "cat notes/a.txt" })}`)).body.stdout, "héllo");

		const missing = await call(server, `/read?${query({ path: "/workspace/missing.txt" })}`);
		assert.equal(missing.status, 500);
		assert.match(String(missing.body.error), /ENOENT/);
	});

	it("when a server started through a shell is exposed, its preview URL reaches it over real HTTP", async () => {
		const serverSource = "require('http').createServer((q,s)=>s.end('vm preview '+q.method+' '+q.url)).listen(3001,'127.0.0.1',()=>console.log('ready'))";
		await call(server, `/write?${query({ id: "vmweb", path: "/workspace/server.js" })}`, { body: serverSource, method: "POST" });
		await call(server, `/start?${query({ cmd: "node server.js", id: "vmweb", pid: "vmweb" })}`);
		assert.equal((await call(server, `/wait-log?${query({ id: "vmweb", pattern: "ready", pid: "vmweb" })}`)).body.line, "ready");
		const exposed = await call(server, `/expose?${query({ id: "vmweb", port: "3001" })}`);
		assert.equal(exposed.status, 200, JSON.stringify(exposed.body));
		const prefix = previewPrefix(exposed.body.url);
		assert.deepEqual(await preview(server, prefix, "/hello?x=1"), { body: "vm preview GET /hello?x=1", status: 200 });
		assert.deepEqual(await preview(server, prefix.replace("3001-", "3002-"), "/"), invalidToken);
		await call(server, `/kill?${query({ id: "vmweb", pid: "vmweb" })}`);
	});

	it("when a server started through a shell listens, waitForPort resolves, and a closed port times out", async () => {
		const serverSource = "require('http').createServer((q,s)=>s.end('up')).listen(3003,'127.0.0.1')";
		await call(server, `/write?${query({ id: "vmport", path: "/workspace/server.js" })}`, { body: serverSource, method: "POST" });
		await call(server, `/start?${query({ cmd: "node server.js", id: "vmport", pid: "vmport" })}`);
		const closed = await call(server, `/wait-port?${query({ id: "vmport", pid: "vmport", port: "3004" })}`);
		assert.equal(closed.status, 500, JSON.stringify(closed.body));
		assert.match(String(closed.body.error), /Timed out after 10000ms waiting for port 3004/);
		const open = await call(server, `/wait-port?${query({ id: "vmport", pid: "vmport", port: "3003" })}`);
		assert.deepEqual([open.status, open.body], [200, { ready: true }]);
		await call(server, `/kill?${query({ id: "vmport", pid: "vmport" })}`);
	});

	it("when the Sandbox object sleeps and wakes, it still has its VM", async () => {
		await call(server, `/write?${query({ id: "napper", path: "/workspace/kept.txt" })}`, { body: "kept", method: "POST" });
		// A Durable Object sleeps after 10 s without requests.
		await new Promise((resolveWait) => setTimeout(resolveWait, 12_000));
		const read = await call(server, `/read?${query({ id: "napper", path: "/workspace/kept.txt" })}`);
		assert.deepEqual([read.status, read.body.content], [200, "kept"]);
	});
});

// Real E2B, Daytona, and Freestyle sandboxes. Root tests remove provider keys
// from the environment, so each provider runs only when SANDBOX_TEST_<key> is
// set, for example SANDBOX_TEST_E2B_API_KEY. The provider SDK must be installed.
const remoteProviders = [
	{ key: "E2B_API_KEY", name: "e2b" },
	{ key: "DAYTONA_API_KEY", name: "daytona" },
	{ key: "FREESTYLE_API_KEY", name: "freestyle" },
] as const;

for (const { key, name } of remoteProviders) {
	const apiKey = process.env[`SANDBOX_TEST_${key}`];
	describe(`@cloudflare/sandbox on orange dev with the ${name} provider`, { skip: apiKey === undefined ? `set SANDBOX_TEST_${key}` : false, timeout: 300_000 }, () => {
		let projectRoot: string;
		let server: DevServer;

		before(async () => {
			projectRoot = await createProject();
			server = await startDev(projectRoot, { ORANGE_SANDBOX_PROVIDER: name, [key]: apiKey ?? "" });
		});

		after(async () => {
			// Delete the provider sandboxes, which cost money while they run.
			if (server !== undefined) {
				for (const id of ["remote-files", "remote-port"]) await call(server, `/destroy?${query({ id })}`);
				await server.stop();
			}
			if (projectRoot !== undefined) await rm(projectRoot, { force: true, recursive: true });
		});

		it("when a file is written to /workspace, commands run there and see it", async () => {
			const written = await call(server, `/write?${query({ id: "remote-files", path: "/workspace/notes/a.txt" })}`, { body: "héllo", method: "POST" });
			assert.equal(written.status, 200, JSON.stringify(written.body));
			assert.equal((await call(server, `/read?${query({ id: "remote-files", path: "/workspace/notes/a.txt" })}`)).body.content, "héllo");
			const listed = await call(server, `/exec?${query({ cmd: "pwd && cat notes/a.txt", id: "remote-files" })}`);
			assert.equal(listed.body.stdout, "/workspace\nhéllo");
		});

		it("when the API key is wrong, calls fail naming the provider and the variable", async () => {
			// A second orange dev in the same project would share its Engine, so it gets its own project.
			const wrongKeyProject = await createProject();
			const wrongKey = await startDev(wrongKeyProject, { ORANGE_SANDBOX_PROVIDER: name, [key]: "wrong-key-for-orange-tests" });
			try {
				const response = await call(wrongKey, `/exec?${query({ cmd: "echo hi", id: "remote-wrong-key" })}`);
				assert.equal(response.status, 500);
				assert.match(String(response.body.error), new RegExp(`^The ${name} sandbox provider failed: .+\\. Check ${key}, and that orange dev can reach ${name}\\.$`));
			} finally {
				await wrongKey.stop();
				await rm(wrongKeyProject, { force: true, recursive: true });
			}
		});

		it("when a server listens, waitForPort resolves, and a closed port times out", async () => {
			const serverSource = "require('http').createServer((q,s)=>s.end('up')).listen(3003,'127.0.0.1')";
			await call(server, `/write?${query({ id: "remote-port", path: "/workspace/server.js" })}`, { body: serverSource, method: "POST" });
			await call(server, `/start?${query({ cmd: "node server.js", id: "remote-port", pid: "web" })}`);
			const open = await call(server, `/wait-port?${query({ id: "remote-port", pid: "web", port: "3003" })}`);
			assert.deepEqual([open.status, open.body], [200, { ready: true }]);
			const closed = await call(server, `/wait-port?${query({ id: "remote-port", pid: "web", port: "3004" })}`);
			assert.equal(closed.status, 500, JSON.stringify(closed.body));
			assert.match(String(closed.body.error), /Timed out after 10000ms waiting for port 3004/);
		});
	});
}

// The wrangler configuration of the @cloudflare/sandbox 1.x minimal example,
// plus a second Container class whose image is not a Sandbox image.
async function createContainerProject(): Promise<string> {
	const projectRoot = await mkdtemp(join(tmpdir(), "open-orange-sandbox-"));
	await cp(containerFixtureWorker, join(projectRoot, "worker.js"));
	await writeFile(join(projectRoot, "Dockerfile"), "FROM docker.io/cloudflare/sandbox:1.0.1 AS sandbox-tools\nFROM alpine:3.24\nCOPY --from=sandbox-tools /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim\n");
	await writeFile(join(projectRoot, "plain.Dockerfile"), "FROM alpine:3.24\n");
	await writeFile(
		join(projectRoot, "wrangler.json"),
		JSON.stringify({
			compatibility_date: "2026-09-03",
			compatibility_flags: ["nodejs_compat"],
			containers: [
				{ class_name: "Sandbox", image: "./Dockerfile" },
				{ class_name: "Plain", image: "./plain.Dockerfile" },
			],
			durable_objects: {
				bindings: [
					{ class_name: "Sandbox", name: "SANDBOX" },
					{ class_name: "Plain", name: "PLAIN" },
				],
			},
			main: "./worker.js",
			migrations: [{ new_sqlite_classes: ["Sandbox", "Plain"], tag: "v1" }],
			name: "sandbox-container-e2e",
		}),
	);
	return projectRoot;
}

describe("ctx.container on orange dev with the local provider", { timeout: 180_000 }, () => {
	let projectRoot: string;
	let server: DevServer;

	before(async () => {
		projectRoot = await createContainerProject();
		server = await startDev(projectRoot);
	});

	after(async () => {
		await server?.stop();
		if (projectRoot !== undefined) {
			await rm(projectRoot, { force: true, recursive: true });
		}
	});

	const exec = (argv: string[], id = "v1") => call(server, `/exec?${query({ id })}`, { body: JSON.stringify(argv), method: "POST" });

	it("when a command fails, exec output() returns its exit code and both streams", async () => {
		const { body, status } = await exec(["sh", "-c", "echo out; echo err >&2; pwd; exit 5"]);
		assert.equal(status, 200, JSON.stringify(body));
		assert.equal(body.exitCode, 5);
		assert.equal(body.stderr, "err\n");
		assert.match(String(body.stdout), /^out\n.*\/workspace\n$/s);
	});

	it("when an argv item has shell characters, the command receives it as one literal argument", async () => {
		const { body } = await exec(["printf", "%s|", "a b", "$HOME", "it's"]);
		assert.equal(body.stdout, "a b|$HOME|it's|");
	});

	it("when a container is destroyed, the next start gets a new, empty sandbox", async () => {
		await exec(["sh", "-c", "echo kept > state.txt"], "doomed");
		assert.equal((await exec(["cat", "state.txt"], "doomed")).body.stdout, "kept\n");
		await call(server, `/destroy?${query({ id: "doomed" })}`);
		assert.notEqual((await exec(["cat", "state.txt"], "doomed")).body.exitCode, 0);
	});

	it("when Files writes a file, exec sees it, and a missing file is a SandboxFileError with ENOENT", async () => {
		await call(server, `/write?${query({ id: "files", path: "/workspace/notes.txt" })}`, { body: "héllo", method: "POST" });
		assert.deepEqual((await call(server, `/read?${query({ id: "files", path: "/workspace/notes.txt" })}`)).body, {
			size: 6,
			text: "héllo",
			type: "file",
		});
		assert.equal((await exec(["cat", "notes.txt"], "files")).body.stdout, "héllo");
		assert.deepEqual((await call(server, `/read?${query({ id: "files", path: "/workspace/missing.txt" })}`)).body, {
			code: "ENOENT",
			operation: "stat",
			path: "/workspace/missing.txt",
		});
	});

	it("when start() names an image that is not a Sandbox image, it fails with an error naming the image and the provider", async () => {
		const { body, status } = await call(server, `/start-plain?${query({ id: "plain" })}`);
		assert.equal(status, 500);
		assert.match(String(body.error), /Container image ".*plain\.Dockerfile" cannot run on the local sandbox provider/);
	});
});

describe("@cloudflare/sandbox across orange dev restarts and configuration", { timeout: 180_000 }, () => {
	const projects: string[] = [];

	after(async () => {
		for (const projectRoot of projects) {
			await rm(projectRoot, { force: true, recursive: true });
		}
	});

	it("when orange dev restarts, the same sandbox id reconnects to its files and no sandbox process outlives the old server", async () => {
		const projectRoot = await createProject();
		projects.push(projectRoot);
		const first = await startDev(projectRoot);
		const marker = `sleep ${30_000 + Math.floor(Math.random() * 10_000)}`;
		try {
			await call(first, `/write?${query({ id: "durable", path: "/workspace/state.txt" })}`, { body: "kept", method: "POST" });
			await call(first, `/start?${query({ cmd: marker, id: "durable", pid: "orphan" })}`);
			assert.equal(spawnSync("pgrep", ["-f", marker]).status, 0);
		} finally {
			await first.stop();
		}
		assert.equal(spawnSync("pgrep", ["-f", marker]).status, 1, "a sandbox process outlived orange dev");
		const second = await startDev(projectRoot);
		try {
			assert.equal((await call(second, `/read?${query({ id: "durable", path: "/workspace/state.txt" })}`)).body.content, "kept");
			assert.equal((await call(second, `/exists?${query({ id: "other", path: "/workspace/state.txt" })}`)).body.exists, false);
		} finally {
			await second.stop();
		}
	});

	it("when the provider changes after a sandbox was created, calls fail naming both, and destroy() deletes the old sandbox", async () => {
		const projectRoot = await createProject();
		projects.push(projectRoot);
		const sandboxDir = join(projectRoot, "local-sandboxes");
		const first = await startDev(projectRoot, { ORANGE_SANDBOX_DIR: sandboxDir });
		try {
			await call(first, `/write?${query({ id: "switch", path: "/workspace/a.txt" })}`, { body: "local", method: "POST" });
		} finally {
			await first.stop();
		}
		assert.equal((await readdir(sandboxDir)).length, 1);
		const second = await startDev(projectRoot, { ORANGE_SANDBOX_DIR: sandboxDir, ORANGE_SANDBOX_PROVIDER: "agentos" });
		try {
			const switched = await call(second, `/exec?${query({ cmd: "echo hi", id: "switch" })}`);
			assert.equal(switched.status, 500);
			assert.match(String(switched.body.error), /created with the local provider, but ORANGE_SANDBOX_PROVIDER is now agentos/);
			assert.deepEqual(await call(second, `/destroy?${query({ id: "switch" })}`), { body: { ok: true }, status: 200 });
			assert.deepEqual(await readdir(sandboxDir), [], "destroy() left the local sandbox behind");
			assert.equal((await call(second, `/exec?${query({ cmd: "echo fresh", id: "switch" })}`)).body.stdout, "fresh\n");
		} finally {
			await second.stop();
		}
	});

	it("when a remote provider has no API key, sandbox calls fail with an error naming the missing variable", async () => {
		const projectRoot = await createProject();
		projects.push(projectRoot);
		const server = await startDev(projectRoot, { ORANGE_SANDBOX_PROVIDER: "e2b" });
		try {
			const response = await call(server, `/exec?${query({ cmd: "echo hi" })}`);
			assert.equal(response.status, 500);
			assert.match(String(response.body.error), /ORANGE_SANDBOX_PROVIDER=e2b needs E2B_API_KEY/);
		} finally {
			await server.stop();
		}
	});

	it("when the provider name is unknown, sandbox calls fail with the list of providers", async () => {
		const projectRoot = await createProject();
		projects.push(projectRoot);
		const server = await startDev(projectRoot, { ORANGE_SANDBOX_PROVIDER: "docker" });
		try {
			const response = await call(server, `/exec?${query({ cmd: "echo hi" })}`);
			assert.equal(response.status, 500);
			assert.match(String(response.body.error), /"docker" is not a sandbox provider\. Use one of: local, e2b, daytona, freestyle, agentos/);
		} finally {
			await server.stop();
		}
	});
});
