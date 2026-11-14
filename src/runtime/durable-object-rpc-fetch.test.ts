import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { bundleWorker } from "../build/bundle-worker.js";
import { runtimeModuleRewrites } from "../build/rewrite-module-imports.js";
import { type RuntimeProcess, spawnRuntime } from "./spawn.js";
import { isRecord, stopEngineFromRuntimeFile, waitFor } from "../../tests/orange-dev.js";

const workerEntrypoint = new URL(
	"./fixtures/durable-object-rpc-fetch-worker.ts",
	import.meta.url,
).pathname;

function createStreamingBody(
	chunks: readonly string[],
): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	return new ReadableStream<Uint8Array>({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
			controller.close();
		},
	});
}

function requestWithStream(
	url: string,
	body: ReadableStream<Uint8Array>,
): Promise<Response> {
	const init: RequestInit = {
		body,
		headers: { "content-type": "text/plain" },
		method: "POST",
	};
	Reflect.set(init, "duplex", "half");
	return fetch(url, init);
}

async function closeRuntime(
	runtime: RuntimeProcess | undefined,
): Promise<void> {
	if (runtime === undefined) return;
	const exit = await runtime.stop();
	assert.deepEqual(exit, { code: 0, reason: "parent", signal: null });
}

interface StorageLifecycleSnapshot {
	alarm: number | null;
	asyncValue: string | null;
	generation: number;
	id: string;
	sqlValue: string | null;
	syncValue: string | null;
	transactionValue: string | null;
}

function requireStorageLifecycleSnapshot(
	value: unknown,
): StorageLifecycleSnapshot {
	if (
		!isRecord(value) ||
		(value.alarm !== null && typeof value.alarm !== "number") ||
		(value.asyncValue !== null && typeof value.asyncValue !== "string") ||
		typeof value.generation !== "number" ||
		typeof value.id !== "string" ||
		(value.sqlValue !== null && typeof value.sqlValue !== "string") ||
		(value.syncValue !== null && typeof value.syncValue !== "string") ||
		(value.transactionValue !== null &&
			typeof value.transactionValue !== "string")
	) {
		throw new TypeError("Storage lifecycle fixture returned an invalid snapshot");
	}
	return {
		alarm: value.alarm,
		asyncValue: value.asyncValue,
		generation: value.generation,
		id: value.id,
		sqlValue: value.sqlValue,
		syncValue: value.syncValue,
		transactionValue: value.transactionValue,
	};
}

function assertStoredLifecycle(
	snapshot: StorageLifecycleSnapshot,
	marker: string,
	alarm: number,
): void {
	assert.equal(snapshot.alarm, alarm);
	assert.equal(snapshot.asyncValue, marker);
	assert.match(snapshot.id, /^[a-f0-9]{64}$/);
	assert.equal(snapshot.sqlValue, marker);
	assert.equal(snapshot.syncValue, marker);
	assert.equal(snapshot.transactionValue, marker);
}

function assertEmptyLifecycle(snapshot: StorageLifecycleSnapshot): void {
	assert.equal(snapshot.alarm, null);
	assert.equal(snapshot.asyncValue, null);
	assert.match(snapshot.id, /^[a-f0-9]{64}$/);
	assert.equal(snapshot.sqlValue, null);
	assert.equal(snapshot.syncValue, null);
	assert.equal(snapshot.transactionValue, null);
}

test("runs Durable Object RPC and fetch through the Worker binding and Rivet actor", async () => {
	const directory = await mkdtemp(join(tmpdir(), "open-orange-durable-e2e-"));
	const rivetStoragePath = join(directory, "rivetkit");
	let runtime: RuntimeProcess | undefined;
	const diagnostics: string[] = [];
	try {
		const bundle = await bundleWorker({
			entrypoint: workerEntrypoint,
			moduleRewrites: runtimeModuleRewrites(),
			outputPath: join(directory, "worker.mjs"),
		});
		const startFixtureRuntime = (): Promise<RuntimeProcess> =>
			spawnRuntime({
				bindingConfigurations: [],
				builtAt: new Date("2026-09-04T12:00:00.000Z"),
				bundlePath: bundle.outputPath,
				deploymentIdentity: "durable-rpc-fetch-e2e",
				durableObjectManifest: {
					bindings: [
						{ binding: "COUNTERS", className: "Counter" },
						{ binding: "MIRRORS", className: "Mirror" },
					],
					classes: [
						{
							className: "Counter",
							migrationTag: "v1",
							storageBackend: "sqlite",
						},
						{
							className: "Mirror",
							migrationTag: "v1",
							storageBackend: "sqlite",
						},
					],
					latestMigrationTag: "v1",
				},
				host: "0.0.0.0",
				normalizedConfiguration: "{}",
				onDiagnostic(diagnostic): void {
					diagnostics.push(diagnostic.stack ?? diagnostic.message);
				},
				port: 0,
				projectRoot: directory,
				rivetNamespace: "default",
				rivetStoragePath,
				startupTimeoutMs: 30_000,
			});
		runtime = await startFixtureRuntime();
		let origin = `http://127.0.0.1:${runtime.port}`;

		const first = await fetch(`${origin}/rpc?name=alice&amount=2`);
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.equal(first.status, 200, diagnostics.join("\n"));
		assert.deepEqual(await first.json(), { value: 2 });
		const second = await fetch(`${origin}/rpc?name=alice&amount=3`);
		assert.deepEqual(await second.json(), { value: 5 });

		const legacy = await requestWithStream(
			`${origin}/legacy-fetch?name=legacy`,
			createStreamingBody(["legacy ", "body"]),
		);
		assert.equal(legacy.status, 201, diagnostics.join("\n"));
		assert.equal(legacy.statusText, "Legacy Fetch");
		assert.equal(legacy.headers.get("x-durable-route"), "legacy-fetch");
		assert.equal(
			legacy.headers.get("x-original-url"),
			"https://durable.example/legacy?source=worker",
		);
		assert.equal(await legacy.text(), "legacy body");

		const stream = await requestWithStream(
			`${origin}/rpc-stream?name=stream`,
			createStreamingBody(["rpc ", "stream ", "body"]),
		);
		assert.equal(stream.status, 206, diagnostics.join("\n"));
		assert.equal(stream.statusText, "RPC Stream");
		assert.equal(stream.headers.get("x-durable-route"), "rpc-stream");
		assert.equal(await stream.text(), "rpc stream body");

		const failure = await fetch(`${origin}/error?name=failure`);
		assert.equal(failure.status, 200, diagnostics.join("\n"));
		assert.deepEqual(await failure.json(), {
			message: "durable method failed",
			name: "RangeError",
		});

		const isolated = await fetch(`${origin}/isolation`);
		assert.equal(isolated.status, 200, diagnostics.join("\n"));
		assert.deepEqual(await isolated.json(), {
			counter: { value: 2 },
			otherClass: { value: 5 },
			otherObject: { value: 3 },
		});

		const firstSql = await fetch(`${origin}/sql?name=sqlite&amount=2`);
		assert.equal(firstSql.status, 200, diagnostics.join("\n"));
		const firstSqlResult: unknown = await firstSql.json();
		assert.ok(isRecord(firstSqlResult));
		assert.deepEqual(firstSqlResult.columnNames, ["id", "value"]);
		assert.equal(firstSqlResult.inserted, 1);
		assert.deepEqual(firstSqlResult.rows, [{ id: 2, value: "value-2" }]);
		assert.deepEqual(firstSqlResult.raw, [[2, "value-2"]]);
		assert.equal(firstSqlResult.rowsRead, 1);
		assert.equal(firstSqlResult.total, 1);
		if (typeof firstSqlResult.databaseSize !== "number") {
			throw new TypeError("SQL fixture returned an invalid database size");
		}
		assert.ok(firstSqlResult.databaseSize > 0);
		if (typeof firstSqlResult.bindingError !== "string") {
			throw new TypeError("SQL fixture returned an invalid binding error");
		}
		assert.match(
			firstSqlResult.bindingError,
			/Wrong number of parameter bindings/,
		);

		const secondSql = await fetch(`${origin}/sql?name=sqlite&amount=5`);
		assert.equal(secondSql.status, 200, diagnostics.join("\n"));
		const secondSqlResult: unknown = await secondSql.json();
		assert.ok(isRecord(secondSqlResult));
		assert.deepEqual(secondSqlResult.rows, [
			{ id: 2, value: "value-2" },
			{ id: 5, value: "value-5" },
		]);

		const transactions = await fetch(
			`${origin}/transactions?name=transactions`,
		);
		assert.equal(transactions.status, 200, diagnostics.join("\n"));
		const transactionResult: unknown = await transactions.json();
		assert.ok(isRecord(transactionResult));
		assert.deepEqual(transactionResult.ids, [8, 9]);
		assert.equal(transactionResult.returned, "outer:nested");
		if (typeof transactionResult.transactionControlError !== "string") {
			throw new TypeError(
				"Transaction fixture returned an invalid transaction-control error",
			);
		}
		assert.match(
			transactionResult.transactionControlError,
			/please use the state\.storage\.transaction/,
		);

		const syncKv = await fetch(`${origin}/sync-kv?name=sync-kv`);
		assert.equal(syncKv.status, 200, diagnostics.join("\n"));
		const syncKvResult: unknown = await syncKv.json();
		assert.ok(isRecord(syncKvResult));
		assert.equal(syncKvResult.cloneValue, 7);
		assert.equal(syncKvResult.committed, "yes");
		assert.deepEqual(syncKvResult.deleteResults, [true, false]);
		assert.deepEqual(syncKvResult.prefix, [
			["bar", 2],
			["baz", 3],
		]);
		assert.deepEqual(syncKvResult.reverse, [
			["baz", 3],
			["bar", 2],
		]);
		assert.equal(syncKvResult.rolledBack, true);
		if (typeof syncKvResult.invalidatedIteratorError !== "string") {
			throw new TypeError("KV fixture returned an invalid iterator error");
		}
		assert.match(
			syncKvResult.invalidatedIteratorError,
			/Only one kv\.list\(\) iterator can exist/,
		);

		const asyncKv = await fetch(`${origin}/async-kv?name=async-kv`);
		assert.equal(asyncKv.status, 200, diagnostics.join("\n"));
		assert.deepEqual(await asyncKv.json(), {
			afterReset: 9,
			deleted: 1,
			list: [["a", 1]],
			multi: [
				["a", 1],
				["b", 2],
			],
			resetSql: true,
			resetValue: true,
		});

		const asyncTransactions = await fetch(
			`${origin}/async-transactions?name=async-transactions`,
		);
		assert.equal(asyncTransactions.status, 200, diagnostics.join("\n"));
		const asyncTransactionResult: unknown = await asyncTransactions.json();
		assert.ok(isRecord(asyncTransactionResult));
		assert.equal(asyncTransactionResult.alarmRoundTrip, true);
		assert.deepEqual(asyncTransactionResult.committed, [
			["committed", 1],
			["nested-committed", 4],
			["storage-context", 2],
			["sync-savepoint", 3],
		]);
		assert.equal(asyncTransactionResult.explicitRolledBack, true);
		assert.equal(asyncTransactionResult.nestedRolledBack, true);
		assert.equal(asyncTransactionResult.returned, "committed");
		assert.equal(asyncTransactionResult.thrownRolledBack, true);
		if (typeof asyncTransactionResult.gateDiagnostic !== "string") {
			throw new TypeError(
				"Async transaction fixture returned an invalid gate diagnostic",
			);
		}
		// Storage accepts allowConcurrency now that it has input and output gates.
		assert.equal(asyncTransactionResult.gateDiagnostic, "");

		const stateResponse = await fetch(`${origin}/state?name=state`);
		assert.equal(stateResponse.status, 200, diagnostics.join("\n"));
		const state: unknown = await stateResponse.json();
		assert.ok(isRecord(state));
		assert.equal(state.startupReady, true);
		assert.match(String(state.id), /^[a-f0-9]{64}$/);
		assert.deepEqual(state.diagnostics, ["DurableObjectState.container is not implemented"]);
		assert.equal(state.exportsCounterNamespace, true);
		const initialGeneration = state.generation;
		assert.equal(typeof initialGeneration, "number");

		const waitUntilStart = await fetch(
			`${origin}/wait-until-start?name=state`,
		);
		assert.equal(await waitUntilStart.json(), initialGeneration);
		await waitFor("waitUntil to finish", async () => {
			const response = await fetch(
				`${origin}/wait-until-status?name=state`,
			);
			return (await response.json()) === initialGeneration;
		});

		const aborted = await fetch(`${origin}/abort?name=state`);
		assert.equal(aborted.status, 200, diagnostics.join("\n"));
		assert.deepEqual(await aborted.json(), { message: "state fixture reset" });
		let resetState: unknown;
		await waitFor(`the reset actor generation\n${diagnostics.join("\n")}`, async () => {
			try {
				const response = await fetch(`${origin}/state?name=state`);
				if (!response.ok) return false;
				const value: unknown = await response.json();
				if (
					isRecord(value) &&
					typeof value.generation === "number" &&
					value.generation !== initialGeneration
				) {
					resetState = value;
					return true;
				}
			} catch {}
			return false;
		});
		assert.ok(isRecord(resetState), diagnostics.join("\n"));
		assert.equal(resetState.id, state.id);
		assert.equal(resetState.startupReady, true);

		const lifecycleMarker = "persisted-across-generation-and-process";
		const lifecycleAlarmTime = Date.now() + 7_200_000;
		const lifecycleWrite = await fetch(
			`${origin}/storage-lifecycle-write?name=lifecycle&marker=${encodeURIComponent(lifecycleMarker)}&alarm=${lifecycleAlarmTime}`,
		);
		assert.equal(lifecycleWrite.status, 200, diagnostics.join("\n"));
		const writtenLifecycle = requireStorageLifecycleSnapshot(
			await lifecycleWrite.json(),
		);
		assertStoredLifecycle(
			writtenLifecycle,
			lifecycleMarker,
			lifecycleAlarmTime,
		);

		const isolatedObject = requireStorageLifecycleSnapshot(
			await (
				await fetch(`${origin}/storage-lifecycle-read?name=lifecycle-other`)
			).json(),
		);
		const isolatedClass = requireStorageLifecycleSnapshot(
			await (
				await fetch(`${origin}/storage-lifecycle-read-class?name=lifecycle`)
			).json(),
		);
		assertEmptyLifecycle(isolatedObject);
		assertEmptyLifecycle(isolatedClass);
		assert.notEqual(isolatedObject.id, writtenLifecycle.id);
		assert.notEqual(isolatedClass.id, writtenLifecycle.id);

		const lifecycleAbort = await fetch(`${origin}/abort?name=lifecycle`);
		assert.equal(lifecycleAbort.status, 200, diagnostics.join("\n"));
		assert.deepEqual(await lifecycleAbort.json(), {
			message: "state fixture reset",
		});
		let recreatedLifecycle: StorageLifecycleSnapshot | undefined;
		await waitFor(`the recreated lifecycle actor\n${diagnostics.join("\n")}`, async () => {
			try {
				const response = await fetch(
					`${origin}/storage-lifecycle-read?name=lifecycle`,
				);
				if (!response.ok) return false;
				const snapshot = requireStorageLifecycleSnapshot(
					await response.json(),
				);
				if (snapshot.generation === writtenLifecycle.generation) return false;
				recreatedLifecycle = snapshot;
				return true;
			} catch {
				return false;
			}
		});
		assert.ok(recreatedLifecycle, diagnostics.join("\n"));
		assert.equal(recreatedLifecycle.id, writtenLifecycle.id);
		assertStoredLifecycle(
			recreatedLifecycle,
			lifecycleMarker,
			lifecycleAlarmTime,
		);

		await fetch(`${origin}/storage-lifecycle-read?name=blocking`);
		const blocking = fetch(
			`${origin}/block-sql?name=blocking&milliseconds=500`,
		);
		// No signal marks the start of the synchronous SQL loop; give it a head start.
		await new Promise<void>((resolve) => setTimeout(resolve, 100));
		const quickStarted = performance.now();
		const delayed = await fetch(`${origin}/rpc?name=blocking-peer&amount=0`);
		const quickElapsed = performance.now() - quickStarted;
		assert.equal(delayed.status, 200, diagnostics.join("\n"));
		const blockingResponse = await blocking;
		assert.equal(blockingResponse.status, 200, diagnostics.join("\n"));
		const blockingResult: unknown = await blockingResponse.json();
		assert.ok(isRecord(blockingResult));
		assert.ok(Number(blockingResult.elapsedMilliseconds) >= 500);
		assert.ok(Number(blockingResult.passes) > 0);
		assert.ok(
			quickElapsed >= 200,
			`Expected synchronous SQL to delay another actor; observed ${quickElapsed}ms`,
		);

		const firstAlarmTime = Date.now() + 3_600_000;
		const secondAlarmTime = firstAlarmTime + 1_000;
		const firstAlarm = await fetch(
			`${origin}/alarm-set?name=persisted-alarm&time=${firstAlarmTime}`,
		);
		assert.equal(firstAlarm.status, 200, diagnostics.join("\n"));
		assert.equal(await firstAlarm.json(), firstAlarmTime);
		const replacedAlarm = await fetch(
			`${origin}/alarm-set?name=persisted-alarm&time=${secondAlarmTime}`,
		);
		assert.equal(replacedAlarm.status, 200, diagnostics.join("\n"));
		assert.equal(await replacedAlarm.json(), secondAlarmTime);

		await closeRuntime(runtime);
		runtime = undefined;
		runtime = await startFixtureRuntime();
		origin = `http://127.0.0.1:${runtime.port}`;
		const restoredAlarm = await fetch(
			`${origin}/alarm-get?name=persisted-alarm`,
		);
		assert.equal(restoredAlarm.status, 200, diagnostics.join("\n"));
		assert.equal(await restoredAlarm.json(), secondAlarmTime);
		const restartedLifecycle = requireStorageLifecycleSnapshot(
			await (
				await fetch(`${origin}/storage-lifecycle-read?name=lifecycle`)
			).json(),
		);
		assert.equal(restartedLifecycle.id, writtenLifecycle.id);
		assertStoredLifecycle(
			restartedLifecycle,
			lifecycleMarker,
			lifecycleAlarmTime,
		);
		const lifecycleAlarmDelete = await fetch(
			`${origin}/alarm-delete?name=lifecycle`,
		);
		assert.equal(await lifecycleAlarmDelete.json(), null);
		const deletedAlarm = await fetch(
			`${origin}/alarm-delete?name=persisted-alarm`,
		);
		assert.equal(deletedAlarm.status, 200, diagnostics.join("\n"));
		assert.equal(await deletedAlarm.json(), null);

		await closeRuntime(runtime);
		runtime = undefined;
	} finally {
		try {
			await closeRuntime(runtime);
		} finally {
			await stopEngineFromRuntimeFile(join(rivetStoragePath, ".rivetkit", "var", "engine", "runtime.json"));
			await rm(directory, { force: true, recursive: true });
		}
	}
});

test("serves the first Durable Object request after a killed runtime restarts", async () => {
	const directory = await mkdtemp(join(tmpdir(), "open-orange-durable-kill-"));
	const rivetStoragePath = join(directory, "rivetkit");
	let runtime: RuntimeProcess | undefined;
	const diagnostics: string[] = [];
	try {
		const bundle = await bundleWorker({
			entrypoint: workerEntrypoint,
			moduleRewrites: runtimeModuleRewrites(),
			outputPath: join(directory, "worker.mjs"),
		});
		const startFixtureRuntime = (): Promise<RuntimeProcess> =>
			spawnRuntime({
				bindingConfigurations: [],
				builtAt: new Date("2026-09-04T12:00:00.000Z"),
				bundlePath: bundle.outputPath,
				deploymentIdentity: "durable-kill-restart-e2e",
				durableObjectManifest: {
					bindings: [
						{ binding: "COUNTERS", className: "Counter" },
						{ binding: "MIRRORS", className: "Mirror" },
					],
					classes: [
						{
							className: "Counter",
							migrationTag: "v1",
							storageBackend: "sqlite",
						},
						{
							className: "Mirror",
							migrationTag: "v1",
							storageBackend: "sqlite",
						},
					],
					latestMigrationTag: "v1",
				},
				host: "0.0.0.0",
				normalizedConfiguration: "{}",
				onDiagnostic(diagnostic): void {
					diagnostics.push(diagnostic.stack ?? diagnostic.message);
				},
				port: 0,
				projectRoot: directory,
				rivetNamespace: "default",
				rivetStoragePath,
				startupTimeoutMs: 30_000,
			});
		const killed = await startFixtureRuntime();
		runtime = killed;
		const before = await fetch(
			`http://127.0.0.1:${killed.port}/rpc?name=killed&amount=1`,
		);
		assert.equal(before.status, 200, diagnostics.join("\n"));
		assert.deepEqual(await before.json(), { value: 1 });

		// The local Engine outlives the runtime, so it still has the actor running on the
		// killed runtime's envoy.
		killed.signal("SIGKILL");
		await killed.waitForExit();
		runtime = undefined;
		runtime = await startFixtureRuntime();

		const started = performance.now();
		const after = await fetch(
			`http://127.0.0.1:${runtime.port}/rpc?name=killed&amount=1`,
		);
		const elapsed = performance.now() - started;
		assert.equal(after.status, 200, diagnostics.join("\n"));
		// The counter lives in memory, so a fresh instance on the new runtime served the request.
		assert.deepEqual(await after.json(), { value: 1 });
		// A request routed to the dead envoy fails after the gateway's retry budget of about 19 seconds.
		assert.ok(
			elapsed < 15_000,
			`Expected the restarted runtime to serve the actor promptly; observed ${elapsed}ms`,
		);

		await closeRuntime(runtime);
		runtime = undefined;
	} finally {
		try {
			await closeRuntime(runtime);
		} finally {
			await stopEngineFromRuntimeFile(join(rivetStoragePath, ".rivetkit", "var", "engine", "runtime.json"));
			await rm(directory, { force: true, recursive: true });
		}
	}
});
