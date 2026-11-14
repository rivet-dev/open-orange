import assert from "node:assert/strict";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { isRecord, type RunningOrangeDev, startOrangeDev, stopProjectEngines } from "../harness/orange-dev.js";

// Drives KV, D1, Rate Limiting, vars, secrets, and unsupported binding stubs
// through a real `orange dev` process, Wrangler configuration, and Rivet Engine.

const fixtureWorker = fileURLToPath(new URL("../fixtures/bindings/worker.js", import.meta.url));
const rateLimitWorker = fileURLToPath(
	new URL("../fixtures/ratelimit/worker.js", import.meta.url),
);

const wranglerConfiguration = {
	compatibility_date: "2026-09-03",
	d1_databases: [{ binding: "DB", database_id: "app-db", database_name: "app" }],
	images: { binding: "IMAGES" },
	kv_namespaces: [
		{ binding: "KV", id: "main-kv" },
		{ binding: "KV_ALIAS", id: "main-kv" },
		{ binding: "KV_OTHER", id: "other-kv" },
	],
	main: "./worker.js",
	name: "bindings-e2e",
	secrets_store_secrets: [
		{ binding: "STORE_SECRET", secret_name: "store", store_id: "local" },
	],
	services: [{ binding: "OTHER_WORKER", service: "another-worker" }],
	vars: { JSON_VAR: { nested: [1] }, OVERRIDDEN: "from-config", PLAIN: "plain" },
};

const devVars = [
	"DEV_SECRET=from-dev-vars",
	"OVERRIDDEN=from-dev-vars",
	"STORE_SECRET=store-value",
].join("\n");

describe("Worker bindings through orange dev", () => {
	let projectRoot: string;
	let server: RunningOrangeDev;

	before(async () => {
		projectRoot = await mkdtemp(join(tmpdir(), "open-orange-bindings-"));
		await cp(fixtureWorker, join(projectRoot, "worker.js"));
		await writeFile(join(projectRoot, "wrangler.json"), JSON.stringify(wranglerConfiguration));
		await writeFile(join(projectRoot, ".dev.vars"), devVars);
		server = await startOrangeDev(projectRoot, "wrangler.json");
	});

	after(async () => {
		try {
			await server?.close();
		} finally {
			await stopProjectEngines(projectRoot);
			await rm(projectRoot, { force: true, recursive: true });
		}
	});

	it("layers .dev.vars over configured vars like wrangler dev", async () => {
		assert.deepEqual(await server.json("/vars"), {
			devSecret: "from-dev-vars",
			json: { nested: [1] },
			overridden: "from-dev-vars",
			plain: "plain",
			// A .dev.vars entry named after a Secrets Store binding stays that
			// secret's local value instead of replacing the binding.
			storeSecret: "store-value",
		});
	});

	it("loads unsupported bindings as stubs that are listed once at startup and throw on use", async () => {
		assert.deepEqual(await server.json("/stubs"), {
			awaited: true,
			images: {
				message: 'Images binding "IMAGES" is not supported by OpenOrange. See the OpenOrange bindings documentation for supported bindings.',
				name: "Error",
			},
			imagesType: "object",
			methodType: "function",
			// A Worker that is not running fails like Wrangler's dev registry.
			otherWorker: {
				message: 'Worker "another-worker" not found. Make sure it is running locally.',
				name: "Error",
			},
		});
		const output = server.output();
		assert.match(output, /^! env\.IMAGES +Images +stub · calls throw$/m);
		assert.equal(
			output.split("See the OpenOrange bindings documentation for supported bindings.").length - 1,
			1,
			output,
		);
	});

	it("stores KV values of every body type and reads them back in every result type", async () => {
		assert.deepEqual(await server.json("/kv/roundtrip"), {
			absent: null,
			absentWithMetadata: { cacheStatus: null, metadata: null, value: null },
			bulkJson: {
				message:
					"KV GET_BULK failed: 400 At least one of the requested keys corresponds to a non-json value",
				name: "Error",
			},
			bulkText: { absent: null, text: "hello" },
			bytes: [0, 1, 255],
			json: { count: 2 },
			streamed: "streamed",
			text: "hello",
			withMetadata: { cacheStatus: null, metadata: { owner: "alice" }, value: "hello" },
		});
	});

	it("lists keys in order with prefix, limit, cursor, expiration, and metadata", async () => {
		const result = await server.json("/kv/list");
		assert.ok(isRecord(result));
		assert.deepEqual(result.names, [["list:a", "list:b"], ["list:c", "list:expiring"]]);
		assert.deepEqual(result.complete, [false, true]);
		assert.equal(result.cacheStatus, null);
		assert.ok(isRecord(result.expiring));
		assert.deepEqual(result.expiring.metadata, [1]);
		const expiration = Number(result.expiring.expiration);
		const putAt = Number(result.putAt);
		assert.ok(expiration >= putAt + 3600 && expiration <= putAt + 3601, String(expiration));
	});

	it("rejects invalid KV calls with workerd's error text", async () => {
		const error = (message: string, name = "Error") => ({ message, name });
		assert.deepEqual(await server.json("/kv/errors"), {
			bulkType: error('KV GET_BULK failed: 400 "arrayBuffer" is not a valid type. Use "json" or "text"'),
			emptyKey: error("Key name cannot be empty.", "TypeError"),
			objectValue: error(
				"KV put() accepts only strings, ArrayBuffers, ArrayBufferViews, and ReadableStreams as values.",
				"TypeError",
			),
			pastExpiration: error(
				"KV PUT failed: 400 Invalid expiration of 1. Please specify integer greater than the current number of seconds since the UNIX epoch.",
			),
			unknownType: error(
				'Unknown response type. Possible types are "text", "arrayBuffer", "json", and "stream".',
				"TypeError",
			),
		});
	});

	it("shares data between bindings to one namespace ID and isolates other IDs", async () => {
		assert.deepEqual(await server.json("/kv/alias"), { alias: "shared", other: null });
	});

	it("keeps every write from overlapping requests", async () => {
		await Promise.all(
			Array.from({ length: 20 }, (_, index) => server.json(`/kv/write?key=burst-${index}`)),
		);
		assert.deepEqual(await server.json("/kv/count?prefix=burst-"), { count: 20 });
	});

	it("runs D1 statements with D1 result shapes and metadata", async () => {
		assert.deepEqual(await server.json("/d1/setup"), { count: 2 });
		const result = await server.json("/d1/crud");
		assert.deepEqual(result, {
			all: [{ body: "first" }, { body: "second" }],
			batchChanges: 1,
			batchRows: [{ body: "first" }, { body: "second" }],
			// Like workerd, a 64-bit integer outside the safe range is a lossy number.
			bigInteger: 9007199254740992,
			first: { body: "first", data: [1, 2, 3], flag: 1, id: 1 },
			firstColumn: "second",
			firstMissing: null,
			insertedMeta: { changedDb: true, changes: 1, lastRowId: 1, success: true },
			raw: [
				["id", "body"],
				[1, "first"],
				[2, "second"],
			],
			session: { after: "string", before: null },
		});
	});

	it("reports D1 failures like wrangler dev and rolls back a failed batch", async () => {
		const error = (message: string) => ({ message, name: "Error" });
		assert.deepEqual(await server.json("/d1/errors"), {
			atomic: error(
				"D1_ERROR: UNIQUE constraint failed: notes.body: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_UNIQUE)",
			),
			badBinding: error("D1_TYPE_ERROR: Type 'undefined' not supported for value 'undefined'"),
			emptyExec: error("D1_EXEC_ERROR: Error in line 1: : No SQL statements detected."),
			missingColumn: error("D1_COLUMN_NOTFOUND: Column not found (two)"),
			missingTable: error("D1_ERROR: no such table: missing: SQLITE_ERROR"),
			rolledBack: 0,
		});
	});

	it("keeps every D1 insert from overlapping requests", async () => {
		await Promise.all(
			Array.from({ length: 20 }, (_, index) => server.json(`/d1/hit?name=hit-${index}`)),
		);
		assert.deepEqual(await server.json("/d1/count"), { hits: 20, notes: 2 });
	});

	it("persists KV and D1 data across orange dev restarts", async () => {
		await server.json("/kv/write?key=persisted");
		await server.close();
		server = await startOrangeDev(projectRoot, "wrangler.json");
		assert.deepEqual(await server.json("/kv/read?key=persisted"), { value: "persisted" });
		assert.deepEqual(await server.json("/d1/count"), { hits: 20, notes: 2 });
	});
});

describe("Rate Limiting through orange dev", () => {
	let projectRoot: string;
	let server: RunningOrangeDev;

	const rateLimitConfiguration = {
		compatibility_date: "2026-09-03",
		main: "./worker.js",
		name: "ratelimit-e2e",
		ratelimits: [
			{ name: "LIMITER", namespace_id: "1001", simple: { limit: 3, period: 10 } },
			{ name: "LIMITER_ALIAS", namespace_id: "1001", simple: { limit: 3, period: 10 } },
			{ name: "MINUTE", namespace_id: "2002", simple: { limit: 2, period: 60 } },
			{ name: "BURST", namespace_id: "4004", simple: { limit: 10, period: 60 } },
		],
		unsafe: {
			bindings: [
				{
					name: "UNSAFE_LIMITER",
					namespace_id: "3003",
					simple: { limit: 3, period: 10 },
					type: "ratelimit",
				},
			],
		},
	};

	async function limit(binding: string, key: string): Promise<boolean> {
		const path = `/limit?binding=${binding}&key=${encodeURIComponent(key)}`;
		const outcome = await server.json(path);
		assert.ok(isRecord(outcome) && typeof outcome.success === "boolean", JSON.stringify(outcome));
		return outcome.success;
	}

	// Windows align to the wall clock like Cloudflare's. A test that needs
	// `neededMs` inside one window starts in the next window when the current
	// one is too short.
	async function windowWithAtLeast(periodSeconds: number, neededMs: number): Promise<void> {
		const periodMs = periodSeconds * 1000;
		const remaining = periodMs - (Date.now() % periodMs);
		if (remaining < neededMs) await delay(remaining + 100);
	}

	async function nextWindow(periodSeconds: number): Promise<void> {
		const periodMs = periodSeconds * 1000;
		await delay(periodMs - (Date.now() % periodMs) + 100);
	}

	before(async () => {
		projectRoot = await mkdtemp(join(tmpdir(), "open-orange-ratelimit-"));
		await cp(rateLimitWorker, join(projectRoot, "worker.js"));
		await writeFile(join(projectRoot, "wrangler.json"), JSON.stringify(rateLimitConfiguration));
		server = await startOrangeDev(projectRoot, "wrangler.json");
	});

	after(async () => {
		try {
			await server?.close();
		} finally {
			await stopProjectEngines(projectRoot);
			await rm(projectRoot, { force: true, recursive: true });
		}
	});

	it("rejects the call after the limit, per key, shared by bindings with one namespace_id", async () => {
		await windowWithAtLeast(10, 5_000);
		const calls = [];
		for (let index = 0; index < 4; index += 1) calls.push(await limit("LIMITER", "a"));
		assert.deepEqual(calls, [true, true, true, false]);
		assert.equal(await limit("LIMITER_ALIAS", "a"), false);
		assert.equal(await limit("LIMITER", "b"), true);
		assert.equal(await limit("UNSAFE_LIMITER", "a"), true);
		assert.equal(await limit("MINUTE", "a"), true);
	});

	it("allows a limited key again in the next window", async () => {
		await windowWithAtLeast(10, 5_000);
		for (let index = 0; index < 3; index += 1) await limit("UNSAFE_LIMITER", "window");
		assert.equal(await limit("UNSAFE_LIMITER", "window"), false);
		await nextWindow(10);
		assert.equal(await limit("UNSAFE_LIMITER", "window"), true);
	});

	it("never allows more than the limit when calls on one key overlap", async () => {
		await windowWithAtLeast(60, 30_000);
		const outcomes = await Promise.all(
			Array.from({ length: 60 }, (_, index) => limit("BURST", index % 2 === 0 ? "x" : "y")),
		);
		const successes = (parity: number): number =>
			outcomes.filter((success, index) => success && index % 2 === parity).length;
		assert.deepEqual([successes(0), successes(1)], [10, 10]);
	});

	it("rejects invalid limit() options with Miniflare's error text", async () => {
		const response = await fetch(`${server.origin}/errors`);
		assert.deepEqual(await response.json(), {
			extraOption: { message: "bad rate limit options: [window]", name: "Error" },
			missingOptions: { message: "invalid rate limit options", name: "Error" },
			numberKey: { message: "invalid key: 1", name: "Error" },
			unsupportedPeriod: { message: "unsupported period: 30", name: "Error" },
		});
	});

	it("keeps counts across an orange dev restart in the same window", async () => {
		await windowWithAtLeast(60, 40_000);
		assert.deepEqual([await limit("MINUTE", "restart"), await limit("MINUTE", "restart")], [true, true]);
		await server.close();
		server = await startOrangeDev(projectRoot, "wrangler.json");
		assert.equal(await limit("MINUTE", "restart"), false);
		assert.equal(await limit("MINUTE", "other"), true);
	});
});
