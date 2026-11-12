import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { loadWranglerConfiguration } from "./load-wrangler.js";

const fixture = (name: string): string =>
	fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

test("resolves JSONC named environments with Wrangler inheritance rules", async () => {
	const config = await loadWranglerConfiguration({
		configPath: fixture("wrangler.jsonc"),
		environment: "staging",
	});

	assert.equal(config.environment, "staging");
	assert.equal(config.entrypoint, fixture("worker.ts"));
	assert.equal(config.compatibilityDate, "2026-09-03");
	assert.deepEqual(config.bindings, [
		{
			binding: "STAGING_SECRET",
			secretName: "staging-secret",
			storeId: "staging-store",
			type: "secrets_store_secret",
		},
		{ binding: "STAGING_VERSION", type: "version_metadata" },
	]);
	assert.doesNotMatch(config.normalizedConfiguration, /ROOT_SECRET/);
});

test("resolves TOML configuration and supported bindings", async () => {
	const config = await loadWranglerConfiguration({
		configPath: fixture("wrangler.toml"),
	});

	assert.equal(config.entrypoint, fixture("worker.ts"));
	assert.deepEqual(
		config.bindings.map((binding) => binding.binding),
		["TOML_SECRET", "TOML_VERSION"],
	);
});

test("accepts other compatibility profiles, warns about ignored flags, and keeps quiet about Node.js flags that Cloudflare needs", async () => {
	const config = await loadWranglerConfiguration({
		configPath: fixture("wrangler-other-profile.jsonc"),
	});

	assert.equal(config.compatibilityDate, "2024-01-01");
	assert.deepEqual(config.warnings, [
		'Orange ignores compatibility_flags ["streams_enable_constructors"]',
	]);
});

test("backs KV, D1, and R2 locally and stubs unsupported bindings with a warning", async () => {
	const config = await loadWranglerConfiguration({
		configPath: fixture("wrangler-unsupported.jsonc"),
	});

	assert.deepEqual(config.bindings, [
		{ binding: "AI", type: "ai" },
		{ binding: "BUCKET", bucketName: "uploads", type: "r2_bucket" },
		{ binding: "CACHE", namespaceId: "00000000000000000000000000000000", type: "kv_namespace" },
		// Wrangler dev prefers the preview ID and falls back to the binding name.
		{ binding: "DB", databaseId: "preview-database-id", type: "d1" },
		{ binding: "LOCAL_ONLY", namespaceId: "LOCAL_ONLY", type: "kv_namespace" },
	]);
	assert.deepEqual(config.warnings, [
	]);
});

test("binds service bindings to other Workers of the orange dev session", async () => {
	const config = await loadWranglerConfiguration({
		configPath: fixture("wrangler-services.jsonc"),
	});

	assert.deepEqual(config.bindings, [
		{ binding: "OTHER", service: "another-worker", type: "service" },
		{ binding: "SELF", type: "service" },
	]);
	assert.equal(config.warnings.length, 0);
});

test("resolves a deterministic same-script SQLite Durable Object manifest", async () => {
	const config = await loadWranglerConfiguration({
		configPath: fixture("wrangler-durable-objects.jsonc"),
	});

	assert.deepEqual(config.bindings, []);
	assert.deepEqual(config.durableObjects, {
		bindings: [
			{ binding: "COUNTER", className: "Counter" },
			{ binding: "COUNTER_ALIAS", className: "Counter" },
			{ binding: "ROOM", className: "Room" },
		],
		classes: [
			{
				className: "Counter",
				migrationTag: "v1",
				storageBackend: "sqlite",
			},
			{
				className: "Room",
				migrationTag: "v1",
				storageBackend: "sqlite",
			},
		],
		latestMigrationTag: "v1",
	});
	assert.match(config.normalizedConfiguration, /"durableObjects"/);
});

test("keeps a migrated Durable Object class that has no binding", async () => {
	const config = await loadWranglerConfiguration({
		configPath: fixture("wrangler-durable-unbound-class.jsonc"),
	});

	assert.deepEqual(config.durableObjects, {
		bindings: [],
		classes: [
			{ className: "Facet", migrationTag: "v1", storageBackend: "sqlite" },
		],
		latestMigrationTag: "v1",
	});
});

test("binds cross-script Durable Object bindings and rejects unsupported migrations", async () => {
	const crossScript = await loadWranglerConfiguration({
		configPath: fixture("wrangler-durable-cross-script.jsonc"),
	});
	assert.equal(crossScript.durableObjects, undefined);
	assert.deepEqual(crossScript.bindings, [
		{
			binding: "REMOTE_COUNTER",
			className: "Counter",
			scriptName: "another-worker",
			type: "durable_object_namespace",
		},
	]);
	await assert.rejects(
		loadWranglerConfiguration({
			configPath: fixture("wrangler-durable-unsupported-migration.jsonc"),
		}),
		/Durable Object class Counter has more than one initial migration/,
	);
	await assert.rejects(
		loadWranglerConfiguration({
			configPath: fixture(
				"wrangler-durable-duplicate-sqlite-migration.jsonc",
			),
		}),
		/Durable Object class Counter has more than one initial migration/,
	);
});

test("rejects the assets settings that Wrangler rejects", async () => {
	const directory = await mkdtemp(join(tmpdir(), "open-orange-assets-config-"));
	const load = async (configuration: Record<string, unknown>): Promise<unknown> => {
		const configPath = join(directory, "wrangler.json");
		await writeFile(configPath, JSON.stringify({ compatibility_date: "2026-09-03", ...configuration }));
		return loadWranglerConfiguration({ configPath });
	};
	try {
		await assert.rejects(
			load({ assets: { binding: "ASSETS", directory: "./public" } }),
			/Cannot use assets with a binding in an assets-only Worker/,
		);
		await assert.rejects(
			load({ assets: { directory: "./public", run_worker_first: true } }),
			/Cannot set run_worker_first without a Worker script/,
		);
		await assert.rejects(
			load({ assets: { directory: "./public", run_worker_first: ["api/*"] }, main: "./worker.js" }),
			/'api\/\*': rules must start with '\/' or '!\/'/,
		);
		await assert.rejects(
			load({ assets: { directory: "./public", run_worker_first: ["!/static/*"] }, main: "./worker.js" }),
			/Only negative `run_worker_first` rules were provided/,
		);
	} finally {
		await rm(directory, { force: true, recursive: true });
	}
});

test("backs both Rate Limiting forms and rejects settings Cloudflare rejects, naming the binding", async () => {
	const directory = await mkdtemp(join(tmpdir(), "open-orange-ratelimit-config-"));
	const load = async (configuration: Record<string, unknown>) => {
		const configPath = join(directory, "wrangler.json");
		await writeFile(
			configPath,
			JSON.stringify({ compatibility_date: "2026-09-03", main: "./worker.js", ...configuration }),
		);
		return loadWranglerConfiguration({ configPath });
	};
	const unsafeLimiter = (simple: unknown) => ({
		unsafe: { bindings: [{ name: "UNSAFE", namespace_id: "2", simple, type: "ratelimit" }] },
	});
	try {
		const config = await load({
			ratelimits: [{ name: "LIMITER", namespace_id: "1", simple: { limit: 10, period: 60 } }],
			...unsafeLimiter({ limit: 5, period: 10 }),
		});
		assert.deepEqual(config.bindings, [
			{ binding: "LIMITER", namespaceId: "1", simple: { limit: 10, period: 60 }, type: "ratelimit" },
			{ binding: "UNSAFE", namespaceId: "2", simple: { limit: 5, period: 10 }, type: "ratelimit" },
		]);
		assert.deepEqual(config.warnings, []);
		await assert.rejects(
			load({ ratelimits: [{ name: "LIMITER", namespace_id: "1", simple: { limit: 10, period: 30 } }] }),
			/"simple.period" must be either 10 or 60 but got 30/,
		);
		await assert.rejects(
			load(unsafeLimiter({ limit: 5, period: 30 })),
			/Rate Limiting binding UNSAFE simple.period must be either 10 or 60 but got 30/,
		);
		await assert.rejects(
			load(unsafeLimiter({ limit: "5", period: 10 })),
			/Rate Limiting binding UNSAFE simple.limit must be a number but got "5"/,
		);
		// Like Wrangler, any numeric limit loads.
		assert.deepEqual((await load(unsafeLimiter({ limit: 0, period: 10 }))).bindings, [
			{ binding: "UNSAFE", namespaceId: "2", simple: { limit: 0, period: 10 }, type: "ratelimit" },
		]);
		await assert.rejects(
			load({ unsafe: { bindings: [{ name: "UNSAFE", simple: { limit: 5, period: 10 }, type: "ratelimit" }] } }),
			/UNSAFE.namespace_id must be a non-empty string/,
		);
	} finally {
		await rm(directory, { force: true, recursive: true });
	}
});

test("rejects Queues settings outside Cloudflare's ranges and names the queue", async () => {
	const directory = await mkdtemp(join(tmpdir(), "open-orange-queues-config-"));
	const load = async (queues: Record<string, unknown>) => {
		const configPath = join(directory, "wrangler.json");
		await writeFile(
			configPath,
			JSON.stringify({ compatibility_date: "2026-09-03", main: "./worker.js", queues }),
		);
		return loadWranglerConfiguration({ configPath });
	};
	try {
		await assert.rejects(
			load({ consumers: [{ max_batch_size: 0, queue: "jobs" }] }),
			/Queue consumer jobs\.max_batch_size must be an integer of 1 or more/,
		);
		await assert.rejects(
			load({ consumers: [{ queue: "jobs" }, { queue: "jobs" }] }),
			/Queue jobs has more than one consumer/,
		);
		await assert.rejects(
			load({ producers: [{ binding: "JOBS", delivery_delay: -1, queue: "jobs" }] }),
			/Queue producer JOBS\.delivery_delay must be an integer of 0 or more/,
		);
		// Unset settings take Cloudflare's production defaults, not wrangler dev's.
		const config = await load({
			consumers: [{ queue: "jobs" }],
			producers: [{ binding: "JOBS", queue: "jobs" }],
		});
		assert.deepEqual(config.queueConsumers, [
			{ maxBatchSize: 10, maxBatchTimeout: 5, maxRetries: 3, queueName: "jobs", retryDelay: 0 },
		]);
		assert.deepEqual(config.bindings, [{ binding: "JOBS", queueName: "jobs", type: "queue" }]);
	} finally {
		await rm(directory, { force: true, recursive: true });
	}
});

test("rejects unknown Wrangler config fields and names each field with its path", async () => {
	const directory = await mkdtemp(join(tmpdir(), "orange-unknown-fields-"));
	try {
		const configPath = join(directory, "wrangler.jsonc");
		await writeFile(join(directory, "index.js"), "export default {};\n");
		await writeFile(
			configPath,
			JSON.stringify({
				compatibility_date: "2026-09-03",
				env: { staging: { kv_namespace: [{ binding: "KV", id: "kv" }] } },
				kv_namespaces: [{ binding: "KV", id: "kv", previw_id: "kv" }],
				main: "index.js",
				name: "typo",
				routez: ["example.com/*"],
			}),
		);
		await assert.rejects(
			loadWranglerConfiguration({ configPath }),
			/Unknown Wrangler configuration fields: kv_namespaces\[0\]\.previw_id, routez\./,
		);
		await assert.rejects(
			loadWranglerConfiguration({ configPath, environment: "staging" }),
			/env\.staging\.kv_namespace/,
		);
	} finally {
		await rm(directory, { force: true, recursive: true });
	}
});
