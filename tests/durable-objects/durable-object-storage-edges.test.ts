import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import { copyProject, repositoryRoot, startOrangeDev } from "../harness/orange-dev.js";

// Expected values are workerd 1.20260903.1's output for the same fixture.
test("Durable Object storage accepts what workerd's SQLite backend accepts, and fails like it", { timeout: 120_000 }, async (t) => {
	const project = await copyProject(join(repositoryRoot, "tests", "fixtures", "storage-edges"));
	try {
		const dev = await startOrangeDev(project.directory);
		try {
			await t.test("a Proxy around a stub can replace the stub's id and name", async () => {
				assert.deepEqual(await dev.json("/stub-proxy"), {
					value: { id: "from-the-proxy", name: "from-the-proxy" },
				});
			});

			await t.test("key-value calls take any key count, coerce keys, and reject uncloneable values with DataCloneError", async () => {
				assert.deepEqual(await dev.json("/key-value"), {
					put129: { value: null },
					get129: { value: 129 },
					delete129: { value: 129 },
					getUndefinedKey: { value: "stored under the string undefined" },
					listFractionalLimit: { value: ["a"] },
					putFunction: {
						error: { code: 25, isDOMException: true, isTypeError: false, message: "() => 1 could not be cloned.", name: "DataCloneError" },
					},
				});
			});

			await t.test("sql.exec() binds other values as their string form and rejects a BigInt", async () => {
				assert.deepEqual(await dev.json("/sql-bindings"), {
					boolean: { value: { v: "true", t: "text" } },
					object: { value: { v: "[object Object]", t: "text" } },
					bigint: {
						error: { isDOMException: false, isTypeError: true, message: "Cannot convert a BigInt value to a number", name: "TypeError" },
					},
					numericNamed: { value: { dollar: 1, colon: 2, at: 3, again: 1 } },
					numericNamedTooFew: {
						error: { isDOMException: false, isTypeError: false, message: "Wrong number of parameter bindings for SQL query.", name: "Error" },
					},
				});
			});

			await t.test("a transaction rejects deleteAll() and writes after rollback() with workerd's errors", async () => {
				const error = (message: string) => ({ error: { isDOMException: false, isTypeError: false, message, name: "Error" } });
				assert.deepEqual(await dev.json("/transaction"), {
					deleteAll: error("Cannot call deleteAll() within a transaction"),
					putAfterRollback: error("Cannot put() on rolled back transaction"),
				});
			});

			await t.test("sql.ingest() runs each complete statement and keeps a failed batch's earlier statements", async () => {
				const ingested = (await dev.json("/sql-ingest")) as { counts: Record<string, unknown> };
				// workerd reports rowsRead 2 here. Orange's row counters come from returned rows.
				delete ingested.counts.rowsRead;
				assert.deepEqual(ingested, {
					counts: { remainder: " INSERT INTO", rowsWritten: 2, statementCount: 2 },
					failure: {
						isDOMException: false,
						isTypeError: false,
						message: "UNIQUE constraint failed: ingested.id: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_PRIMARYKEY)",
						name: "Error",
					},
					remainders: [
						"    ",
						" SELECT 45",
						" SELECT 1 -- ;",
						"",
						"CREATE TRIGGER IF NOT EXISTS t AFTER INSERT ON ingested BEGIN SELECT 1; END",
					],
					rows: [1, 2, 3],
				});
			});

			await t.test("sql.exec() rejects SQL without a statement after running the statements before it", async () => {
				const noStatement = {
					error: { isDOMException: false, isTypeError: false, message: "SQL code did not contain a statement.", name: "Error" },
				};
				assert.deepEqual(await dev.json("/sql-without-statement"), {
					empty: noStatement,
					whitespace: noStatement,
					semicolon: noStatement,
					trailingWhitespace: { value: [{ one: 1 }] },
					trailingComment: noStatement,
					insertThenComment: noStatement,
					rows: [{ id: 1 }],
				});
			});
		} finally {
			await dev.close();
		}
	} finally {
		await project.dispose();
	}
});
