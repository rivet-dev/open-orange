import assert from "node:assert/strict";
import test from "node:test";

import type {
	RivetSqliteBindings,
	RivetSqliteDatabase,
	RivetSqliteExecuteResult,
	RivetSynchronousSqliteTransaction,
} from "../../internal/rivetkit.js";
import { DurableObjectInputGate, DurableObjectTurnDatabase } from "./gates.js";
import {
	createDurableObjectStorage,
	durableObjectDatabaseProvider,
} from "./storage.js";

class FakeDatabase implements RivetSqliteDatabase {
	readonly calls: { params?: RivetSqliteBindings; sql: string }[] = [];
	readonly results = new Map<string, RivetSqliteExecuteResult>();
	readonly scripts = new Map<
		string,
		{ columns: string[]; rows: unknown[][] }
	>();

	commitTicket(): number {
		return 0;
	}

	async whenDurable(): Promise<void> {}

	beginTransactionSync(): RivetSynchronousSqliteTransaction {
		return new FakeTransaction(this);
	}

	execSync(
		sql: string,
		callback?: (row: unknown[], columns: string[]) => void,
	): void {
		const result = this.scripts.get(sql);
		if (result === undefined) throw new Error(`Unexpected SQL script: ${sql}`);
		for (const row of result.rows) callback?.(row, result.columns);
	}

	executeSync(
		sql: string,
		params?: RivetSqliteBindings,
	): RivetSqliteExecuteResult {
		this.calls.push({ sql, ...(params === undefined ? {} : { params }) });
		if (this.scripts.has(sql)) {
			throw new Error("sqlite execute only supports a single statement");
		}
		const result = this.results.get(sql);
		if (result === undefined) throw new Error(`Unexpected SQL query: ${sql}`);
		return result;
	}
}

class FakeTransaction implements RivetSynchronousSqliteTransaction {
	readonly #database: FakeDatabase;

	constructor(database: FakeDatabase) {
		this.#database = database;
	}

	commitSync(): void {}

	rollbackSync(): void {}

	execSync(
		sql: string,
		callback?: (row: unknown[], columns: string[]) => void,
	): void {
		this.#database.execSync(sql, callback);
	}

	executeSync(
		sql: string,
		params?: RivetSqliteBindings,
	): RivetSqliteExecuteResult {
		return this.#database.executeSync(sql, params);
	}
}

function storageFor(database: FakeDatabase) {
	return createDurableObjectStorage(
		new DurableObjectTurnDatabase(database, () => {}),
		new DurableObjectInputGate(),
	);
}

function result(
	columns: string[],
	rows: unknown[][],
	changes = 0,
): RivetSqliteExecuteResult {
	return { changes, columns, rows };
}

test("opens the actor's native synchronous SQLite database", async () => {
	const database = new FakeDatabase();
	const opened: string[] = [];
	const client = await durableObjectDatabaseProvider.createClient({
		actorId: "actor-id",
		nativeDatabaseProvider: {
			async open(actorId): Promise<RivetSqliteDatabase> {
				opened.push(actorId);
				return database;
			},
		},
	});

	assert.equal(client, database);
	assert.deepEqual(opened, ["actor-id"]);
	await durableObjectDatabaseProvider.onMigrate(client);
	await assert.rejects(
		durableObjectDatabaseProvider.createClient({ actorId: "missing" }),
		/native SQLite/,
	);
});

test("validates and forwards Cloudflare SQL binding values", () => {
	const database = new FakeDatabase();
	database.results.set(
		"SELECT ?, ?, ?, ?",
		result(
			["number", "text", "nothing", "bytes"],
			[[7, "orange", null, [255, 1]]],
		),
	);
	database.results.set("SELECT :same + :same", result(["value"], [[4]]));
	const sql = storageFor(database).sql;

	const bytes = new Uint8Array([255, 1]);
	const row = sql
		.exec("SELECT ?, ?, ?, ?", 7, "orange", undefined, bytes)
		.one();
	assert.equal(row.number, 7);
	assert.equal(row.text, "orange");
	assert.equal(row.nothing, null);
	assert.ok(row.bytes instanceof ArrayBuffer);
	assert.deepEqual(new Uint8Array(row.bytes), bytes);
	assert.deepEqual(database.calls[0]?.params, [7, "orange", null, bytes]);
	assert.deepEqual(sql.exec("SELECT :same + :same", 2).one(), { value: 4 });

	assert.throws(
		() => sql.exec("SELECT '?' AS literal, ? -- ?\n", 1, 2),
		/Wrong number of parameter bindings/,
	);
	assert.throws(
		() => sql.exec("SELECT ?"),
		/Wrong number of parameter bindings/,
	);
});

test("shares one cursor position across object and raw iteration", () => {
	const database = new FakeDatabase();
	database.results.set(
		"SELECT duplicate columns",
		result(
			["id", "value", "value"],
			[
				[1, "first", "overwritten"],
				[2, "second", "last"],
			],
			3,
		),
	);
	database.results.set("INSERT rows", result([], [], 3));
	const cursor = storageFor(database).sql.exec<{
		id: number;
		value: string;
	}>("SELECT duplicate columns");

	assert.deepEqual(cursor.columnNames, ["id", "value", "value"]);
	assert.equal(cursor.rowsRead, 2);
	assert.equal(cursor.rowsWritten, 0);
	assert.deepEqual(cursor.next(), {
		done: false,
		value: { id: 1, value: "overwritten" },
	});
	assert.deepEqual(Array.from(cursor.raw()), [[2, "second", "last"]]);
	assert.deepEqual(cursor.next(), { done: true });
	assert.deepEqual(cursor.toArray(), []);
	assert.equal(
		storageFor(database).sql.exec("INSERT rows").rowsWritten,
		3,
	);
});

test("implements one() cardinality checks and consumes failed cursors", () => {
	const database = new FakeDatabase();
	database.results.set("SELECT empty", result(["value"], []));
	database.results.set("SELECT two", result(["value"], [[1], [2]]));
	const sql = storageFor(database).sql;

	assert.throws(() => sql.exec("SELECT empty").one(), /got no results/);
	const multiple = sql.exec("SELECT two");
	assert.throws(() => multiple.one(), /got multiple results/);
	assert.deepEqual(multiple.next(), { done: true });
});

test("executes unbound SQL scripts and exposes only their final rows", () => {
	const database = new FakeDatabase();
	const script = "CREATE TABLE values_table(value); SELECT 42 AS value;";
	database.scripts.set(script, { columns: ["value"], rows: [[42]] });
	database.scripts.set(
		"CREATE TABLE values_table(value); INSERT INTO values_table VALUES (?);",
		{ columns: [], rows: [] },
	);
	const sql = storageFor(database).sql;

	assert.deepEqual(sql.exec(script).toArray(), [{ value: 42 }]);
	assert.throws(
		() =>
			sql.exec(
				"CREATE TABLE values_table(value); INSERT INTO values_table VALUES (?);",
				42,
			),
		/bindings on multi-statement SQL/,
	);
});

test("calculates databaseSize from used pages and the cached page size", () => {
	const database = new FakeDatabase();
	const usedPages =
		"select (select * from pragma_page_count) - (select * from pragma_freelist_count);";
	database.results.set(usedPages, result(["pages"], [[10]]));
	database.results.set("PRAGMA page_size;", result(["page_size"], [[4096]]));
	const sql = storageFor(database).sql;

	assert.equal(sql.databaseSize, 40_960);
	assert.equal(sql.databaseSize, 40_960);
	assert.equal(
		database.calls.filter((call) => call.sql === "PRAGMA page_size;").length,
		1,
	);
});

test("rejects direct SQL transaction control", () => {
	const database = new FakeDatabase();
	const sql = storageFor(database).sql;
	for (const query of [
		"BEGIN TRANSACTION",
		"COMMIT",
		"END",
		"ROLLBACK",
		"SAVEPOINT manual",
		"RELEASE manual",
		"-- comment\nBEGIN IMMEDIATE",
	]) {
		assert.throws(
			() => sql.exec(query),
			/please use the state\.storage\.transaction/,
		);
	}
	assert.deepEqual(database.calls, []);
});

test("keeps Cloudflare and Rivet-reserved SQLite names private", () => {
	const database = new FakeDatabase();
	database.results.set(
		"SELECT '_cf_visible' AS value",
		result(["value"], [["_cf_visible"]]),
	);
	const sql = storageFor(database).sql;

	assert.throws(() => sql.exec("SELECT * FROM _cf_KV"), /not authorized/);
	assert.throws(
		() => sql.exec("CREATE TABLE _CF_private (value)"),
		/not authorized/,
	);
	assert.throws(
		() => sql.exec("CREATE TABLE _rivet_private (value)"),
		/not authorized/,
	);
	assert.deepEqual(sql.exec("SELECT '_cf_visible' AS value").one(), {
		value: "_cf_visible",
	});
});

test("keeps unimplemented storage members explicit", () => {
	const storage = storageFor(new FakeDatabase());
	for (const member of [
		"getBookmarkForTime",
		"onNextSessionRestoreBookmark",
	]) {
		assert.throws(
			() => Reflect.get(storage, member),
			new RegExp(`DurableObjectStorage\\.${member} is not implemented`),
		);
	}
});

test("reads a member Cloudflare does not define as undefined", () => {
	const storage = storageFor(new FakeDatabase());
	for (const member of ["prepare", "batch", "then", Symbol.iterator]) {
		assert.equal(Reflect.get(storage, member), undefined);
	}
});
