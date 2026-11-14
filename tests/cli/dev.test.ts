import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { glob, readFile, rename } from "node:fs/promises";
import { get, type IncomingHttpHeaders } from "node:http";
import { join } from "node:path";
import test from "node:test";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import {
	copyProject,
	isRecord,
	repositoryRoot,
	runOrange,
	startOrangeDev,
	stopProjectEngines,
} from "../harness/orange-dev.js";

const cliEntrypoint = join(repositoryRoot, "src", "bin.ts");
const configDirectory = join(repositoryRoot, "src", "config", "fixtures");
const configPath = join(configDirectory, "wrangler.toml");

function waitForReady(child: ChildProcess): Promise<number> {
	const stdoutStream = child.stdout;
	const stderrStream = child.stderr;
	if (stdoutStream === null || stderrStream === null) {
		return Promise.reject(new Error("Orange test process has no output pipes"));
	}
	return new Promise((resolveReady, rejectReady) => {
		let stdout = "";
		let stderr = "";
		const timeout = setTimeout(() => {
			rejectReady(new Error(`orange dev readiness timed out: ${stderr}`));
		}, 10_000);
		stdoutStream.on("data", (rawChunk: unknown) => {
			const chunk = rawChunk instanceof Uint8Array ? Buffer.from(rawChunk).toString() : String(rawChunk);
			stdout += chunk;
			const match = /Local\s+http:\/\/127\.0\.0\.1:(\d+)/.exec(stdout);
			if (match?.[1] !== undefined) {
				clearTimeout(timeout);
				resolveReady(Number(match[1]));
			}
		});
		stderrStream.on("data", (rawChunk: unknown) => {
			stderr += rawChunk instanceof Uint8Array ? Buffer.from(rawChunk).toString() : String(rawChunk);
		});
		child.once("exit", (code, signal) => {
			clearTimeout(timeout);
			rejectReady(
				new Error(
					`orange dev exited before readiness (code ${code ?? "none"}, signal ${signal ?? "none"}): ${stderr}`,
				),
			);
		});
	});
}

function waitForExit(child: ChildProcess): Promise<{
	code: number | null;
	signal: NodeJS.Signals | null;
}> {
	return new Promise((resolveExit, rejectExit) => {
		const timeout = setTimeout(() => {
			child.kill("SIGKILL");
			rejectExit(new Error("orange dev did not stop after SIGINT"));
		}, 10_000);
		child.once("exit", (code, signal) => {
			clearTimeout(timeout);
			resolveExit({ code, signal });
		});
	});
}

test("serves a Worker request through orange dev", async () => {
	const dev = await startOrangeDev(configDirectory, "wrangler.toml");
	try {
		const response = await fetch(`${dev.origin}/hello`);
		assert.equal(response.status, 200);
		assert.equal(await response.text(), "ok");
	} finally {
		// close() asserts that SIGINT stops orange dev with exit code 0.
		await dev.close();
	}
});

test("orange dev logs each request and shows a thrown error with the Worker's own stack frame", async () => {
	const child = spawn(
		process.execPath,
		[
			"--import",
			"tsx",
			cliEntrypoint,
			"dev",
			"--config",
			configPath,
			"--port",
			"0",
		],
		{ env: { ...process.env, CI: "1", NO_COLOR: "1" }, stdio: ["ignore", "pipe", "pipe"] },
	);
	let output = "";
	const collect = (chunk: unknown): void => {
		output += chunk instanceof Uint8Array ? Buffer.from(chunk).toString() : String(chunk);
	};
	child.stdout?.on("data", collect);
	child.stderr?.on("data", collect);
	try {
		const port = await waitForReady(child);
		assert.equal((await fetch(`http://127.0.0.1:${port}/hello?name=a`)).status, 200);
		assert.equal((await fetch(`http://127.0.0.1:${port}/throws`, { method: "POST" })).status, 500);
		child.kill("SIGINT");
		assert.deepEqual(await waitForExit(child), { code: 0, signal: null });
		assert.match(output, /^ {2}GET +200 +[\d.]+ms {2}\/hello\?name=a$/m);
		assert.match(output, /^ {2}POST +500 +[\d.]+ms {2}\/throws$/m);
		assert.match(output, /^× TypeError: fixture failure\n\s+at fetch \(.*worker\.ts:\d+:\d+\)$/m);
		// Orange's runtime frames are not the Worker author's code.
		assert.doesNotMatch(output, /runtime-node|node:internal|node_modules/);
	} finally {
		if (child.exitCode === null && child.signalCode === null) {
			child.kill("SIGKILL");
		}
	}
});

test("open-orange dev --json writes only JSON Lines events an agent can follow from start to stop", async () => {
	const child = spawn(
		process.execPath,
		["--import", "tsx", cliEntrypoint, "dev", "--config", configPath, "--port", "0", "--json"],
		{ env: { ...process.env, CI: "1" }, stdio: ["ignore", "pipe", "pipe"] },
	);
	let stdout = "";
	const events: Record<string, unknown>[] = [];
	const ready = Promise.withResolvers<string>();
	child.stdout?.on("data", (chunk: unknown) => {
		stdout += chunk instanceof Uint8Array ? Buffer.from(chunk).toString() : String(chunk);
		const lines = stdout.split("\n");
		stdout = lines.pop() ?? "";
		for (const line of lines) {
			// Standard output carries nothing but JSON, even the Worker's console output.
			const event: unknown = JSON.parse(line);
			assert.ok(isRecord(event), line);
			events.push(event);
			if (event.type === "ready" && typeof event.url === "string") ready.resolve(event.url);
		}
	});
	child.once("exit", () => ready.reject(new Error(`exited before ready: ${JSON.stringify(events)}`)));
	try {
		const url = await ready.promise;
		assert.equal(await (await fetch(`${url}/log`)).text(), "logged");
		assert.equal((await fetch(`${url}/throws`)).status, 500);
		child.kill("SIGINT");
		assert.deepEqual(await waitForExit(child), { code: 0, signal: null });
		const types = events.map((event) => event.type);
		assert.equal(types[0], "config");
		assert.ok(types.indexOf("ready") < types.indexOf("request"), JSON.stringify(types));
		// `stopping` comes on the signal and `stopped` after the runtime exits. A
		// request that is still in flight at the signal is reported between them.
		const stopping = types.indexOf("stopping");
		assert.ok(stopping > types.indexOf("ready"), JSON.stringify(types));
		assert.equal(types.lastIndexOf("stopping"), stopping, JSON.stringify(types));
		assert.equal(types.at(-1), "stopped", JSON.stringify(types));
		assert.deepEqual(
			types.slice(stopping + 1, -1).filter((type) => !["error", "log", "request"].includes(String(type))),
			[],
			JSON.stringify(types),
		);
		assert.ok(
			events.some((event) => event.type === "log" && String(event.text).includes("fixture log line")),
			JSON.stringify(events),
		);
		assert.ok(
			events.some(
				(event) => event.type === "request" && event.path === "/throws" && event.status === 500,
			),
		);
		assert.ok(
			events.some(
				(event) =>
					event.type === "error" && event.message === "fixture failure" && typeof event.stack === "string",
			),
		);
		assert.deepEqual(events.at(-1), { exitCode: 0, type: "stopped" });
	} finally {
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
	}
});

test("orange dev marks stubbed bindings with their alternative, in the header and the --json config event", async () => {
	const project = await copyFixture("stub-bindings");
	const config = join(project.directory, "wrangler.jsonc");
	const children: ChildProcess[] = [];
	try {
		const human = spawnDev(config);
		children.push(human);
		let output = "";
		human.stdout?.on("data", (chunk: unknown) => {
			output += chunk instanceof Uint8Array ? Buffer.from(chunk).toString() : String(chunk);
		});
		await waitForReady(human);
		human.kill("SIGINT");
		assert.deepEqual(await waitForExit(human), { code: 0, signal: null });
		assert.match(
			output,
			/^! env\.IMAGES +Images +stub · calls throw\n +See the OpenOrange bindings documentation for supported bindings\.$/m,
		);
		assert.match(output, /^ {2}env\.GREETING +Variable +local$/m);

		const json = spawn(
			process.execPath,
			["--import", "tsx", cliEntrypoint, "dev", "--config", config, "--port", "0", "--json"],
			{ env: { ...process.env, CI: "1" }, stdio: ["ignore", "pipe", "pipe"] },
		);
		children.push(json);
		let stdout = "";
		json.stdout?.on("data", (chunk: unknown) => {
			stdout += chunk instanceof Uint8Array ? Buffer.from(chunk).toString() : String(chunk);
			if (stdout.includes('"type":"ready"') && json.signalCode === null && !json.killed) json.kill("SIGINT");
		});
		assert.deepEqual(await waitForExit(json), { code: 0, signal: null });
		const event: unknown = JSON.parse(stdout.split("\n")[0] ?? "");
		assert.ok(isRecord(event));
		assert.equal(event.type, "config");
		assert.deepEqual(event.bindings, [
			{ name: "AI", status: "pluggable", type: "ai" },
			{ name: "GREETING", status: "local", type: "plain_text" },
			{
				alternative: "See the OpenOrange bindings documentation for supported bindings.",
				name: "IMAGES",
				status: "stub",
				type: "images",
			},
		]);
	} finally {
		for (const child of children) {
			if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		}
		await project.dispose();
	}
});

test("open-orange dev --json reports a startup failure as one failure event", async () => {
	const child = spawn(
		process.execPath,
		["--import", "tsx", cliEntrypoint, "dev", "--config", "missing/wrangler.jsonc", "--json"],
		{ env: { ...process.env, CI: "1" }, stdio: ["ignore", "pipe", "pipe"] },
	);
	let stdout = "";
	child.stdout?.on("data", (chunk: unknown) => {
		stdout += chunk instanceof Uint8Array ? Buffer.from(chunk).toString() : String(chunk);
	});
	assert.deepEqual(await waitForExit(child), { code: 1, signal: null });
	const lines = stdout.trim().split("\n");
	assert.equal(lines.length, 1, stdout);
	const event: unknown = JSON.parse(lines[0] ?? "");
	assert.ok(isRecord(event));
	assert.equal(event.type, "failure");
	assert.equal(typeof event.message, "string");
});

test("injects stable version metadata through orange dev", async () => {
	const earliestTimestamp = Date.now();
	const dev = await startOrangeDev(configDirectory, "wrangler.toml");
	try {
		const first = await dev.json("/version-metadata");
		assert.ok(isRecord(first));
		assert.match(String(first.id), /^[a-f0-9]{64}$/);
		assert.equal(first.tag, "dev");
		assert.equal(typeof first.timestamp, "string");
		const parsedTimestamp = Date.parse(String(first.timestamp));
		assert.ok(parsedTimestamp >= earliestTimestamp);
		assert.ok(parsedTimestamp <= Date.now());

		const secondResponse = await fetch(`${dev.origin}/version-metadata`);
		const second: unknown = await secondResponse.json();
		assert.deepEqual(second, first);
	} finally {
		await dev.close();
	}
});

test("resolves a Secrets Store value without logging it", async () => {
	const secret = "orange-secret-store-e2e-do-not-log";
	const dev = await startOrangeDev(configDirectory, "wrangler.toml", { environment: { TOML_SECRET: secret } });
	try {
		const response = await fetch(`${dev.origin}/secret-store`);
		assert.equal(response.status, 200);
		assert.equal(await response.text(), secret);
	} finally {
		await dev.close();
	}
	assert.doesNotMatch(dev.output(), new RegExp(secret));
});

function spawnDev(config: string): ChildProcess {
	return spawn(
		process.execPath,
		["--import", "tsx", cliEntrypoint, "dev", "--config", config, "--port", "0"],
		{ env: { ...process.env, CI: "1", NO_COLOR: "1" }, stdio: ["ignore", "pipe", "pipe"] },
	);
}

// Each test runs on a fresh copy, so build output and storage stay out of the repository.
function copyFixture(name = "cloudflare-project"): ReturnType<typeof copyProject> {
	return copyProject(join(repositoryRoot, "tests", "fixtures", name));
}

// Reads the actor names from the project's Rivet Engine, without the hash of the deployment.
async function engineActorNames(projectRoot: string): Promise<string[]> {
	for await (const path of glob(".open-orange/rivetkit/*/.rivetkit/var/engine/runtime.json", {
		cwd: projectRoot,
	})) {
		const stamp: unknown = JSON.parse(await readFile(join(projectRoot, path), "utf8"));
		assert.ok(isRecord(stamp) && typeof stamp.endpoint === "string");
		// RivetKit authenticates to a local Engine with the `default` token.
		const response = await fetch(`${stamp.endpoint}/actors/names?namespace=default`, {
			headers: { authorization: "Bearer default" },
		});
		assert.equal(response.status, 200);
		const body: unknown = await response.json();
		assert.ok(isRecord(body) && isRecord(body.names));
		return Object.keys(body.names).map((name) => name.replace(/-[0-9a-f]{8}$/, ""));
	}
	throw new Error("orange dev did not record its Rivet Engine");
}

// Reads a response without decoding its body, as an HTTP client sees it.
function getRaw(url: string): Promise<{ body: Buffer; headers: IncomingHttpHeaders }> {
	return new Promise((resolveResponse, rejectResponse) => {
		get(url, (response) => {
			const chunks: Buffer[] = [];
			response.on("data", (chunk: Buffer) => chunks.push(chunk));
			response.once("error", rejectResponse);
			response.once("end", () => {
				resolveResponse({ body: Buffer.concat(chunks), headers: response.headers });
			});
		}).once("error", rejectResponse);
	});
}

test("encodes response bodies named by Content-Encoding, as workerd does", async () => {
	const project = await copyFixture("content-encoding");
	try {
		const dev = await startOrangeDev(project.directory);
		const { origin } = dev;
		try {
			const gzip = await getRaw(`${origin}/gzip`);
			assert.equal(gzip.headers["content-encoding"], "gzip");
			// The Worker's Content-Length describes the unencoded body, so it is dropped.
			assert.equal(gzip.headers["content-length"], undefined);
			assert.equal(gunzipSync(gzip.body).toString(), "automatic gzip");
			const br = await getRaw(`${origin}/br`);
			assert.equal(brotliDecompressSync(br.body).toString(), "automatic br");

			// An `encodeBody: "manual"` body is already encoded and is sent as it is.
			const manual = await getRaw(`${origin}/manual`);
			assert.equal(gunzipSync(manual.body).toString(), "manual gzip");

			// Workerd encodes only gzip and br. Other codings are sent as they are.
			const deflate = await getRaw(`${origin}/deflate`);
			assert.equal(deflate.headers["content-encoding"], "deflate");
			assert.equal(deflate.body.toString(), "not encoded");

			// fetch() decodes a compressed response, and returning it encodes it once.
			const proxy = await getRaw(`${origin}/proxy`);
			assert.equal(gunzipSync(proxy.body).toString(), "automatic gzip");

			// Durable Object and service binding callers read decoded bodies.
			const object = await getRaw(`${origin}/object`);
			assert.equal(gunzipSync(object.body).toString(), "from object");
			assert.equal((await getRaw(`${origin}/object-text`)).body.toString(), "from object");
			assert.equal((await getRaw(`${origin}/service-text`)).body.toString(), "from service");
		} catch (error) {
			if (error instanceof Error) error.message += `\n--- orange dev output ---\n${dev.output()}`;
			throw error;
		} finally {
			await dev.close();
		}
	} finally {
		await project.dispose();
	}
});

test("keeps Durable Object data when the project moves", { timeout: 60_000 }, async () => {
	const project = await copyFixture("durable-storage");
	const moved = `${project.directory}-moved`;
	try {
		let dev = await startOrangeDev(project.directory);
		try {
			assert.equal(await (await fetch(dev.origin, { body: "kept", method: "PUT" })).text(), "kept");
		} finally {
			await dev.close();
		}

		await rename(project.directory, moved);
		dev = await startOrangeDev(moved);
		try {
			assert.equal(await (await fetch(dev.origin)).text(), "kept");
		} finally {
			await dev.close();
		}
	} finally {
		// dispose() deletes the moved copy too, but it stops only the engines it finds in the original place.
		await stopProjectEngines(moved);
		await project.dispose();
	}
});

test("an Engine log size set in the shell wins, so one larger than the free disk stops orange dev and names the setting", { timeout: 60_000 }, async () => {
	const project = await copyFixture("durable-storage");
	try {
		const { code, output } = await runOrange(project.directory, ["dev", "--port", "0"], "wrangler.jsonc", {
			// 1 PiB is more than any test machine has free.
			environment: { RIVET__STORAGE__LOG_SHARD__MAX_DISK_BYTES: String(1024 ** 5) },
		});
		assert.equal(code, 1, output);
		assert.match(output, /RIVET__STORAGE__LOG_SHARD__MAX_DISK_BYTES is 1073741824 MiB, but only \d+ MiB is free/);
	} finally {
		await project.dispose();
	}
});

test("runs a Cloudflare project that uses Wrangler build features", async () => {
	const project = await copyFixture();
	try {
		const dev = await startOrangeDev(project.directory);
		try {
			assert.deepEqual(await dev.json("/"), {
				aiService:
					"NotSupportedError: cloudflare:ai Ai is not implemented by OpenOrange because it needs Cloudflare's AI service. Call the model provider's HTTP API with fetch().",
				cached: null,
				cloudflareModules: ["InferenceUpstreamError", "function", "function", "cosine"],
				colo: "DFW",
				connectingIp: "127.0.0.1",
				data: [1, 2, 3],
				emailFrom: "from@example.com",
				env: { GREETING: "hello", SETTINGS: '{"mode":"dev"}' },
				generated: "built before bundling",
				legacy: "function",
				nonRetryable: "NonRetryableError",
				page: "<h1>page</h1>\n",
				runtime: "workerd",
				throughExports: 1,
				traced: "false!",
				tracedFailure: "TypeError: traced failure",
				objectTracing: "undefined",
				wasm: true,
			});
			// The Engine lists the Durable Object under its class name, next to the
			// actors that run the project's cron triggers, facets, and Cache API.
			assert.deepEqual((await engineActorNames(project.directory)).sort(), [
				"counter",
				"facet",
				"openorange-cache",
				"openorange:cron",
			]);
		} finally {
			await dev.close();
		}
	} finally {
		await project.dispose();
	}
});

test("runs @cloudflare/vite-plugin output, which sets no_bundle", async () => {
	const project = await copyFixture("vite-output");
	try {
		const dev = await startOrangeDev(project.directory, "wrangler.json");
		try {
			const response = await fetch(`${dev.origin}/`);
			assert.equal(response.status, 200, dev.output());
			assert.equal(await response.text(), "built by vite");
		} finally {
			await dev.close();
		}
	} finally {
		await project.dispose();
	}
});

test("stops orange dev when the custom build fails", async () => {
	const project = await copyFixture();
	try {
		const { code, output } = await runOrange(project.directory, ["dev", "--port", "0"], "wrangler-failing-build.jsonc");
		assert.equal(code, 1, output);
		assert.match(output, /Running custom build `exit 3` failed with exit code 3/);
	} finally {
		await project.dispose();
	}
});
