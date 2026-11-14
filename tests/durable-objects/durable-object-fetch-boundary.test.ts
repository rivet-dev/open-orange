import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { bundleWorker } from "../../src/build/bundle-worker.js";
import { runtimeModuleRewrites } from "../../src/build/rewrite-module-imports.js";
import { type RuntimeProcess, spawnRuntime } from "../../src/runtime/spawn.js";
import { isRecord, stopEngineFromRuntimeFile } from "../harness/orange-dev.js";

const workerEntrypoint = new URL(
	"../fixtures/durable-object-fetch-boundary-worker.js",
	import.meta.url,
).pathname;

// The latitude of the placeholder request.cf every inbound request gets in local dev.
const edgeLatitude = "30.27130";

interface ObservedRequest {
	body: unknown;
	cf: Record<string, unknown> | null;
	headers: [string, string][];
	method: unknown;
}

interface ObservedFetch {
	object: ObservedRequest;
	response: Record<string, unknown>;
	worker: Record<string, unknown>;
}

function headerPairs(value: unknown): [string, string][] {
	assert.ok(Array.isArray(value), JSON.stringify(value));
	return value.map((pair: unknown): [string, string] => {
		assert.ok(Array.isArray(pair) && pair.length === 2, JSON.stringify(pair));
		const [name, headerValue]: unknown[] = pair;
		assert.ok(typeof name === "string" && typeof headerValue === "string", JSON.stringify(pair));
		return [name, headerValue];
	});
}

function observedRequest(value: unknown): ObservedRequest {
	assert.ok(isRecord(value), JSON.stringify(value));
	const { cf } = value;
	assert.ok(cf === null || isRecord(cf), JSON.stringify(value));
	return { body: value.body, cf, headers: headerPairs(value.headers), method: value.method };
}

async function withRuntime(
	name: string,
	run: (origin: string) => Promise<void>,
): Promise<void> {
	const directory = await mkdtemp(join(tmpdir(), `open-orange-${name}-`));
	const rivetStoragePath = join(directory, "rivetkit");
	let runtime: RuntimeProcess | undefined;
	try {
		const bundle = await bundleWorker({
			entrypoint: workerEntrypoint,
			moduleRewrites: runtimeModuleRewrites(),
			outputPath: join(directory, "worker.mjs"),
		});
		runtime = await spawnRuntime({
			bindingConfigurations: [],
			builtAt: new Date("2026-10-20T12:00:00.000Z"),
			bundlePath: bundle.outputPath,
			deploymentIdentity: name,
			durableObjectManifest: {
				bindings: [{ binding: "ECHO", className: "Echo" }],
				classes: [{ className: "Echo", migrationTag: "v1", storageBackend: "sqlite" }],
				latestMigrationTag: "v1",
			},
			host: "127.0.0.1",
			normalizedConfiguration: "{}",
			port: 0,
			projectRoot: directory,
			rivetNamespace: "default",
			rivetStoragePath,
			startupTimeoutMs: 30_000,
		});
		await run(`http://127.0.0.1:${runtime.port}`);
	} finally {
		try {
			if (runtime !== undefined) {
				assert.deepEqual(await runtime.stop(), { code: 0, reason: "parent", signal: null });
			}
		} finally {
			await stopEngineFromRuntimeFile(join(rivetStoragePath, ".rivetkit", "var", "engine", "runtime.json"));
			await rm(directory, { force: true, recursive: true });
		}
	}
}

async function observe(url: string, init?: RequestInit): Promise<ObservedFetch> {
	const response = await fetch(url, init);
	assert.equal(response.status, 200, await response.clone().text());
	const value: unknown = await response.json();
	if (!isRecord(value) || !isRecord(value.object) || !isRecord(value.response) || !isRecord(value.worker)) {
		throw new TypeError("Boundary fixture returned an invalid observation");
	}
	return { object: observedRequest(value.object), response: value.response, worker: value.worker };
}

function receiveFirstMessage(url: string): Promise<ObservedRequest> {
	return new Promise((resolve, reject) => {
		const socket = new WebSocket(url);
		socket.addEventListener("message", (event) => {
			socket.close(1000);
			try {
				resolve(observedRequest(JSON.parse(String(event.data))));
			} catch (error: unknown) {
				reject(error);
			}
		});
		socket.addEventListener("error", () => reject(new Error("WebSocket failed")));
	});
}

test("a Durable Object sees the caller's request and cf, never a forged or transport header", async () => {
	await withRuntime("durable-object-request-boundary", async (origin) => {
		const forged = Buffer.from(
			JSON.stringify({
				body: false,
				cf: { latitude: "0.00000" },
				headers: [["x-forged", "1"]],
				method: "DELETE",
			}),
		).toString("base64");
		const { object, worker } = await observe(`${origin}/path`, {
			headers: { "x-open-orange-internal-durable-object-request": forged },
		});

		assert.equal(object.method, "GET");
		assert.equal(object.cf?.latitude, edgeLatitude);
		// The object gets exactly the headers the Worker forwarded: no forged
		// internal header, and nothing the Rivet gateway added such as its token.
		assert.deepEqual(object.headers, worker.headers);
		assert.ok(
			!object.headers.some(([name]) => /^x-(open-orange-internal|rivet)-/.test(name)),
			JSON.stringify(object.headers),
		);

		const upgrade = await receiveFirstMessage(`${origin.replace("http:", "ws:")}/socket`);
		assert.equal(upgrade.cf?.latitude, edgeLatitude);
	});
});

test("a Request passed as the init of stub.fetch() keeps its method and body", async () => {
	await withRuntime("durable-object-request-as-init", async (origin) => {
		const { object } = await observe(`${origin}/forward?as-init`, {
			body: "order 42",
			method: "POST",
		});
		assert.equal(object.method, "POST");
		assert.equal(object.body, "order 42");
	});
});

test("a Worker gets the Durable Object's own response head, and OPTIONS reaches the object", async () => {
	await withRuntime("durable-object-response-boundary", async (origin) => {
		const plain = await observe(`${origin}/plain`, {
			headers: { origin: "https://evil.example" },
		});
		assert.deepEqual(plain.response, {
			headers: [
				["content-type", "application/json"],
				["x-object", "echo"],
			],
			status: 200,
			statusText: "Echoed",
		});

		const cors = await observe(`${origin}/cors?cors`, {
			headers: { origin: "https://evil.example" },
		});
		assert.deepEqual(cors.response.headers, [
			["access-control-allow-origin", "https://app.example"],
			["content-type", "application/json"],
			["vary", "Accept-Encoding"],
			["x-object", "echo"],
		]);

		const preflight = await observe(`${origin}/preflight`, {
			headers: {
				"access-control-request-method": "PUT",
				origin: "https://evil.example",
			},
			method: "OPTIONS",
		});
		assert.equal(preflight.object.method, "OPTIONS");
		assert.deepEqual(preflight.response.headers, [
			["content-type", "application/json"],
			["x-object", "echo"],
		]);
	});
});
