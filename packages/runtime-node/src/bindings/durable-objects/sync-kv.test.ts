import assert from "node:assert/strict";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import test from "node:test";

import type {
	RivetSqliteBindings,
	RivetSqliteDatabase,
	RivetSqliteExecuteResult,
	RivetSynchronousSqliteTransaction,
} from "../../internal/rivetkit.js";
import type {
	DurableObjectStorage,
	DurableObjectTransaction,
	SyncKvStorage,
} from "../../modules/cloudflare-workers/durable-object.js";
import {
	DurableObjectAlarmStore,
	type DurableObjectAlarmSynchronization,
} from "./alarm-storage.js";
import { DurableObjectInputGate, DurableObjectTurnDatabase } from "./gates.js";
import { DurableObjectStateController } from "./state.js";
import { createDurableObjectStorage } from "./storage.js";
import { createSyncKvStorage, DurableObjectKvStore } from "./sync-kv.js";

function sqliteInput(value: unknown): SQLInputValue {
	if (
		value === null ||
		typeof value === "number" ||
		typeof value === "bigint" ||
		typeof value === "string" ||
		value instanceof Uint8Array
	) {
		return value;
	}
	throw new TypeError("Test SQLite adapter received an invalid binding");
}

function numberFromSqlite(value: number | bigint): number {
	const number = Number(value);
	if (!Number.isSafeInteger(number)) {
		throw new RangeError("Test SQLite adapter received an unsafe count");
	}
	return number;
}

class TestSqliteExecutor implements RivetSqliteDatabase {
	readonly database = new DatabaseSync(":memory:");
	commits = 0;
	whenDurable: (ticket: number) => Promise<void> = async () => {};

	commitTicket(): number {
		return this.commits;
	}

	close(): void {
		this.database.close();
	}

	beginTransactionSync(): RivetSynchronousSqliteTransaction {
		this.database.exec("BEGIN");
		return new TestSqliteTransaction(this);
	}

	execSync(
		sql: string,
		callback?: (row: unknown[], columns: string[]) => void,
	): void {
		if (callback !== undefined) {
			throw new Error("Test SQLite adapter does not stream script rows");
		}
		this.database.exec(sql);
	}

	executeSync(
		sql: string,
		params?: RivetSqliteBindings,
	): RivetSqliteExecuteResult {
		if (params !== undefined && !Array.isArray(params)) {
			throw new TypeError("Test SQLite adapter requires positional bindings");
		}
		const bindings = (params ?? []).map(sqliteInput);
		const statement = this.database.prepare(sql);
		const columns = statement.columns().map(({ name }) => name);
		if (columns.length > 0) {
			return {
				changes: 0,
				columns,
				rows: statement
					.all(...bindings)
					.map((row) => columns.map((column) => row[column])),
			};
		}
		const result = statement.run(...bindings);
		return {
			changes: numberFromSqlite(result.changes),
			columns: [],
			rows: [],
		};
	}
}

class TestSqliteTransaction implements RivetSynchronousSqliteTransaction {
	readonly #executor: TestSqliteExecutor;

	constructor(executor: TestSqliteExecutor) {
		this.#executor = executor;
	}

	commitSync(): void {
		this.#executor.database.exec("COMMIT");
		this.#executor.commits += 1;
	}

	rollbackSync(): void {
		this.#executor.database.exec("ROLLBACK");
	}

	execSync(
		sql: string,
		callback?: (row: unknown[], columns: string[]) => void,
	): void {
		this.#executor.execSync(sql, callback);
	}

	executeSync(
		sql: string,
		params?: RivetSqliteBindings,
	): RivetSqliteExecuteResult {
		return this.#executor.executeSync(sql, params);
	}
}

function testStorage(t: test.TestContext): SyncKvStorage {
	const executor = new TestSqliteExecutor();
	t.after(() => executor.close());
	return createSyncKvStorage(new DurableObjectKvStore(() => executor));
}

function testDurableObject(
	t: test.TestContext,
	alarmScheduler?: DurableObjectAlarmSynchronization,
): {
	controller: DurableObjectStateController;
	executor: TestSqliteExecutor;
	resets: Error[];
	storage: DurableObjectStorage;
} {
	const executor = new TestSqliteExecutor();
	t.after(() => executor.close());
	const resets: Error[] = [];
	const database = new DurableObjectTurnDatabase(executor, (error) =>
		resets.push(error),
	);
	const inputGate = new DurableObjectInputGate();
	return {
		controller: new DurableObjectStateController({}, inputGate, database),
		executor,
		resets,
		storage: createDurableObjectStorage(database, inputGate, alarmScheduler),
	};
}

function testAsyncStorage(
	t: test.TestContext,
	alarmScheduler?: DurableObjectAlarmSynchronization,
): {
	executor: TestSqliteExecutor;
	storage: DurableObjectStorage;
} {
	const { executor, storage } = testDurableObject(t, alarmScheduler);
	return { executor, storage };
}

test("holds an event that arrives during storage.transaction() until it commits", async (t) => {
	const { controller, storage } = testDurableObject(t);
	storage.sql.exec("CREATE TABLE event_log (value TEXT)");
	const release = Promise.withResolvers<void>();
	const transactionEvent = controller.runEvent(() =>
		storage.transaction(async () => {
			storage.sql.exec("INSERT INTO event_log VALUES ('transaction')");
			await release.promise;
		}),
	);
	const laterEvent = controller.runEvent(() => {
		storage.sql.exec("INSERT INTO event_log VALUES ('later event')");
	});
	await new Promise((resolve) => setImmediate(resolve));
	release.resolve();
	await Promise.all([transactionEvent, laterEvent]);

	assert.deepEqual(
		storage.sql
			.exec<{ value: string }>("SELECT value FROM event_log ORDER BY rowid")
			.toArray()
			.map(({ value }) => value),
		["transaction", "later event"],
	);
});

test("never releases an event result whose writes fail to become durable", async (t) => {
	const { controller, executor, resets, storage } = testDurableObject(t);
	const durability = Promise.withResolvers<void>();
	executor.whenDurable = () => durability.promise;
	let released = false;
	const event = controller
		.runEvent(() => {
			storage.kv.put("acknowledged", true);
			return "response";
		})
		.then((value) => {
			released = true;
			return value;
		});
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(released, false);

	durability.reject(new Error("depot unavailable"));
	await assert.rejects(event, /resetting to its last durable state/);
	assert.equal(released, false);
	assert.equal(resets.length, 1);
	assert.throws(
		() => storage.kv.get("acknowledged"),
		/resetting to its last durable state/,
	);
	await assert.rejects(
		controller.runEvent(() => "next response"),
		/resetting to its last durable state/,
	);
});

test("stores fresh V8 clones and returns undefined for missing keys", (t) => {
	const kv = testStorage(t);
	interface StoredGraph {
		bytes: Uint8Array;
		map: Map<string, number>;
		nested: { value: number };
		self?: StoredGraph;
	}
	const original: StoredGraph = {
		bytes: new Uint8Array([1, 2, 3]),
		map: new Map([["answer", 42]]),
		nested: { value: 7 },
	};
	original.self = original;

	assert.equal(kv.get("missing"), undefined);
	kv.put("graph", original);
	original.bytes[0] = 9;
	original.map.set("later", 10);
	original.nested.value = 11;

	const first = kv.get<StoredGraph>("graph");
	assert.ok(first !== undefined);
	assert.equal(first.self, first);
	assert.deepEqual(first.bytes, new Uint8Array([1, 2, 3]));
	assert.deepEqual(first.map, new Map([["answer", 42]]));
	assert.deepEqual(first.nested, { value: 7 });
	first.nested.value = 99;
	assert.deepEqual(kv.get<StoredGraph>("graph")?.nested, { value: 7 });

	kv.put("undefined", undefined);
	assert.deepEqual(Array.from(kv.list()), [
		["graph", kv.get("graph")],
		["undefined", undefined],
	]);
});

test("lists UTF-8 ordered ranges, prefixes, directions, and limits", (t) => {
	const kv = testStorage(t);
	for (const [key, value] of [
		["foo", 1],
		["bar", 2],
		["baz", 3],
		["car", 4],
	] as const) {
		kv.put(key, value);
	}

	assert.deepEqual(Array.from(kv.list()), [
		["bar", 2],
		["baz", 3],
		["car", 4],
		["foo", 1],
	]);
	assert.deepEqual(Array.from(kv.list({ prefix: "ba" })), [
		["bar", 2],
		["baz", 3],
	]);
	assert.deepEqual(Array.from(kv.list({ end: "car", start: "baz" })), [
		["baz", 3],
	]);
	assert.deepEqual(Array.from(kv.list({ end: "car", startAfter: "bar" })), [
		["baz", 3],
	]);
	assert.deepEqual(Array.from(kv.list({ limit: 2, reverse: true })), [
		["foo", 1],
		["car", 4],
	]);
	assert.deepEqual(
		Array.from(kv.list({ end: "bar" })),
		[],
		"end remains exclusive",
	);
	assert.throws(
		() => kv.list({ start: "a", startAfter: "b" }),
		/both start and startAfter/,
	);
	assert.throws(() => kv.list({ limit: 0 }), /List limit must be positive/);
});

test("allows only one live list iterator", (t) => {
	const kv = testStorage(t);
	kv.put("a", 1);
	kv.put("b", 2);
	const first = kv.list();
	const second = kv.list();

	assert.throws(() => Array.from(first), /Only one kv\.list\(\) iterator/);
	assert.deepEqual(Array.from(second), [
		["a", 1],
		["b", 2],
	]);
	assert.deepEqual(Array.from(second), []);
	const completed = kv.list();
	assert.deepEqual(Array.from(completed), [
		["a", 1],
		["b", 2],
	]);
	kv.list();
	assert.deepEqual(Array.from(completed), []);
});

test("deletes values and enforces cloning and pair-size limits", (t) => {
	const kv = testStorage(t);
	assert.equal(kv.delete("missing"), false);
	kv.put("present", { value: 1 });
	assert.equal(kv.delete("present"), true);
	assert.equal(kv.delete("present"), false);

	assert.throws(
		() => kv.put("function", () => undefined),
		(error: unknown) =>
			error instanceof Error && error.name === "DataCloneError",
	);
	assert.throws(
		() => Reflect.apply(kv.get, kv, [12]),
		/Storage key must be a string/,
	);
});

test("implements asynchronous single and list operations over the KV table", async (t) => {
	const { storage } = testAsyncStorage(t);

	assert.equal(await storage.get("missing"), undefined);
	await storage.put("b", { value: 2 });
	await storage.put("a", { value: 1 });
	assert.deepEqual(await storage.get("a"), { value: 1 });
	assert.deepEqual(
		await storage.list({ prefix: "a" }),
		new Map([["a", { value: 1 }]]),
	);
	assert.equal(await storage.delete("a"), true);
	assert.equal(await storage.delete("a"), false);
	assert.deepEqual(await storage.list(), new Map([["b", { value: 2 }]]));
});

test("coerces numeric asynchronous keys used by Cloudflare examples", async (t) => {
	const { storage } = testAsyncStorage(t);

	await Reflect.apply(storage.put, storage, [1, "first"]);
	assert.equal(await storage.get("1"), "first");
	assert.equal(await Reflect.apply(storage.get, storage, [1]), "first");
	assert.equal(await Reflect.apply(storage.delete, storage, [1]), true);
});

test("implements sorted and atomic asynchronous multi-key operations", async (t) => {
	const { storage } = testAsyncStorage(t);

	await storage.put({
		b: 2,
		a: 1,
		ignored: undefined,
		c: 3,
	});
	assert.deepEqual(
		await storage.get<number>(["c", "missing", "a", "c", "b"]),
		new Map([
			["a", 1],
			["b", 2],
			["c", 3],
		]),
	);
	assert.equal(await storage.delete(["b", "missing", "b", "c"]), 2);
	assert.deepEqual(await storage.list(), new Map([["a", 1]]));

	await assert.rejects(
		storage.put({ first: 1, invalid: () => undefined }),
		(error: unknown) =>
			error instanceof Error && error.name === "DataCloneError",
	);
	assert.equal(await storage.get("first"), undefined);
});

test("defers gate-related options", async (t) => {
	const { storage } = testAsyncStorage(t);
	await storage.put("allowed", 1, { noCache: true });
	assert.equal(await storage.get("allowed", { noCache: true }), 1);
	assert.deepEqual(
		await storage.list({ noCache: true, prefix: "allow" }),
		new Map([["allowed", 1]]),
	);
	assert.equal(await storage.delete("allowed", { noCache: true }), true);
	assert.equal(await storage.get("missing", { allowConcurrency: true }), undefined);
	await assert.rejects(storage.put("missing", undefined), /undefined value/);
});

test("deleteAll resets user SQL and KV state while preserving Rivet metadata", async (t) => {
	const { executor, storage } = testAsyncStorage(t);
	executor.database.exec("CREATE TABLE _rivet_state (value TEXT)");
	executor.database.exec("INSERT INTO _rivet_state VALUES ('kept')");
	executor.database.exec("PRAGMA foreign_keys = ON");
	storage.sql.exec("CREATE TABLE parent_values (id INTEGER PRIMARY KEY)");
	storage.sql.exec(
		"CREATE TABLE child_values (parent_id INTEGER REFERENCES parent_values(id))",
	);
	storage.sql.exec("INSERT INTO parent_values VALUES (1)");
	storage.sql.exec("INSERT INTO child_values VALUES (1)");
	storage.sql.exec("CREATE TABLE user_values (value INTEGER)");
	storage.sql.exec("CREATE VIEW user_view AS SELECT value FROM user_values");
	storage.sql.exec(
		"CREATE TRIGGER user_trigger AFTER INSERT ON user_values BEGIN SELECT 1; END",
	);
	await storage.put("key", "value");

	await storage.deleteAll();
	assert.equal(await storage.get("key"), undefined);
	assert.throws(
		() => storage.sql.exec("SELECT * FROM user_values"),
		/no such table/,
	);
	const rivetRows = executor.database
		.prepare("SELECT value FROM _rivet_state")
		.all();
	assert.equal(rivetRows.length, 1);
	assert.equal(rivetRows[0]?.value, "kept");
	await storage.put("after", 1);
	assert.equal(await storage.get("after"), 1);

	await assert.rejects(
		storage.transactionSync(() => storage.deleteAll()),
		/Cannot call deleteAll\(\) within a transaction/,
	);
});

test("commits asynchronous transactions across awaits and expires the handle", async (t) => {
	const { storage } = testAsyncStorage(t);
	let escaped: DurableObjectTransaction | undefined;
	const returned = await storage.transaction(async (transaction) => {
		escaped = transaction;
		await transaction.put("first", 1);
		await Promise.resolve();
		await storage.put("second", 2);
		storage.sql.exec("CREATE TABLE async_transaction_sql (value INTEGER)");
		storage.sql.exec("INSERT INTO async_transaction_sql VALUES (3)");
		return "committed";
	});

	assert.equal(returned, "committed");
	assert.deepEqual(
		await storage.get<number>(["first", "second"]),
		new Map([
			["first", 1],
			["second", 2],
		]),
	);
	assert.equal(
		storage.sql
			.exec<{ value: number }>("SELECT value FROM async_transaction_sql")
			.one().value,
		3,
	);
	const completedTransaction = escaped;
	if (completedTransaction === undefined) {
		throw new Error("transaction handle was not captured");
	}
	assert.throws(
		() => completedTransaction.get("first"),
		/transaction that has already committed/,
	);
});

test("rolls back thrown, explicit, nested, and synchronous transaction work", async (t) => {
	const { storage } = testAsyncStorage(t);
	const marker = new Error("async transaction rollback");
	await assert.rejects(
		storage.transaction(async (transaction) => {
			await transaction.put("thrown", true);
			throw marker;
		}),
		(error: unknown) => error === marker,
	);
	assert.equal(await storage.get("thrown"), undefined);

	const rolledBack = await storage.transaction(async (transaction) => {
		await transaction.put("explicit", true);
		transaction.rollback();
		transaction.rollback();
		assert.throws(() => transaction.get("explicit"), /rolled back transaction/);
		return "rolled-back";
	});
	assert.equal(rolledBack, "rolled-back");
	assert.equal(await storage.get("explicit"), undefined);

	await storage.transaction(async (outer) => {
		await outer.put("outer", 1);
		await assert.rejects(
			storage.transaction(async (inner) => {
				await inner.put("nested-rolled-back", 2);
				throw new Error("nested marker");
			}),
			/nested marker/,
		);
		storage.transactionSync(() => storage.kv.put("sync-nested", 3));
	});
	assert.deepEqual(
		await storage.get<number>(["outer", "nested-rolled-back", "sync-nested"]),
		new Map([
			["outer", 1],
			["sync-nested", 3],
		]),
	);
	const asyncFromSync = storage.transactionSync(() =>
		storage.transaction(async () => undefined),
	);
	await assert.rejects(
		asyncFromSync,
		/asynchronous transaction inside transactionSync/,
	);
});

test("persists transaction alarm operations and deletes them with all state", async (t) => {
	const synchronizedAlarms: Array<number | null> = [];
	const { storage } = testAsyncStorage(t, {
		assertSupported(): void {},
		async synchronize(scheduledTime): Promise<void> {
			synchronizedAlarms.push(scheduledTime);
		},
	});
	const firstTime = Date.now() + 60_000;
	const secondTime = firstTime + 1_000;

	assert.equal(await storage.getAlarm(), null);
	await storage.transaction(async (transaction) => {
		await transaction.setAlarm(new Date(firstTime));
		assert.equal(await transaction.getAlarm(), firstTime);
	});
	assert.equal(await storage.getAlarm(), firstTime);

	await assert.rejects(
		storage.transaction(async (transaction) => {
			await transaction.setAlarm(secondTime);
			throw new Error("keep first alarm");
		}),
		/keep first alarm/,
	);
	assert.equal(await storage.getAlarm(), firstTime);

	await storage.transaction(async (transaction) => {
		await transaction.deleteAlarm();
	});
	assert.equal(await storage.getAlarm(), null);
	await storage.setAlarm(secondTime);
	await storage.deleteAll();
	assert.equal(await storage.getAlarm(), null);
	assert.deepEqual(synchronizedAlarms, [firstTime, null, secondTime, null]);
	await assert.rejects(storage.setAlarm(0), /alarm time <= 0/);
});

test("upgrades persisted alarm rows with a replacement token", (t) => {
	const executor = new TestSqliteExecutor();
	t.after(() => executor.close());
	executor.executeSync(
		"CREATE TABLE _cf_ALARM (id INTEGER PRIMARY KEY CHECK (id = 1), scheduled_time INTEGER NOT NULL)",
	);
	executor.executeSync(
		"INSERT INTO _cf_ALARM (id, scheduled_time) VALUES (1, ?)",
		[12_345],
	);
	const record = new DurableObjectAlarmStore(() => executor).getRecord();
	assert.equal(record?.scheduledTime, 12_345);
	assert.match(record?.token ?? "", /^[0-9a-f-]{36}$/);
});

test("sync and async storage wait for an active transaction", async (t) => {
	const { storage } = testAsyncStorage(t);
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const transaction = storage.transaction(async (transactionStorage) => {
		await transactionStorage.put("pending", 1);
		entered.resolve();
		await release.promise;
		await transactionStorage.put("pending", 2);
	});
	await entered.promise;

	let synchronized = false;
	const sync = storage.sync().then(() => {
		synchronized = true;
	});
	const read = storage.get<number>("pending");
	await Promise.resolve();
	assert.equal(synchronized, false);
	assert.throws(
		() => storage.kv.get("pending"),
		/another event's storage\.transaction\(\) is open/,
	);

	release.resolve();
	await transaction;
	await sync;
	assert.equal(synchronized, true);
	assert.equal(await read, 2);
});
