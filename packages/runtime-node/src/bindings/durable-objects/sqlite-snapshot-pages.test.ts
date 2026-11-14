import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { RivetSynchronousSqliteExecutor } from "../../internal/rivetkit.js";
import { readSqliteSnapshotChunks, SqliteSnapshotFrameReader } from "./sqlite-snapshot.js";

test("snapshot sampling respects a remote result limit before sizing large-row pages", () => {
	const database = new DatabaseSync(":memory:");
	try {
		database.exec("CREATE TABLE blobs(id INTEGER PRIMARY KEY, data BLOB)");
		const insert = database.prepare("INSERT INTO blobs VALUES (?, ?)");
		const blob = new Uint8Array(256 * 1024);
		for (let id = 0; id < 65; id++) insert.run(id, blob);
		const executor: RivetSynchronousSqliteExecutor = {
			execSync(sql) { database.exec(sql); },
			executeSync(sql, params) {
				const statement = database.prepare(sql);
				const columns = statement.columns().map(column => column.name);
				assert.ok(params === undefined || Array.isArray(params));
				const values = statement.all(...(params ?? []) as never[]);
				const rows = values.map(row => columns.map(column => row[column]));
				const bytes = rows.reduce((total, row) => total + row.reduce<number>((size, value) => size + (typeof value === "string" ? Buffer.byteLength(value) : 8), 0), 0);
				assert.ok(bytes <= 24 * 1024 * 1024, "SQLite response exceeds the remote 24 MiB result limit");
				return { columns, rows, changes: 0 };
			},
		};
		const reader = new SqliteSnapshotFrameReader();
		const expected = Buffer.from(blob).toString("hex");
		let copied = 0;
		for (const chunk of readSqliteSnapshotChunks(executor, name => name === "blobs")) {
			for (const frame of reader.push(chunk)) {
				assert.ok(frame !== null && typeof frame === "object" && "kind" in frame);
				if (frame.kind !== "rows") continue;
				assert.ok("rows" in frame && Array.isArray(frame.rows));
				for (const row of frame.rows) {
					assert.equal(row[1], copied++);
					assert.equal(row[2], expected);
				}
			}
		}
		reader.finish();
		assert.equal(copied, 65);
	} finally { database.close(); }
});
