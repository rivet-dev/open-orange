import assert from "node:assert/strict";
import test from "node:test";
import { isCriticalSqliteError, sqlStatementError } from "./sqlite-errors.js";

test("remote SQLite statement details preserve the local binding error", () => {
	const statement = { code: 1, message: "no such table: missing", offset: null };
	const remote = { group: "sqlite", code: "remote_execution_failed", message: "Remote SQLite execution failed: prepare context", metadata: { statement } };
	const local = { group: "sqlite", code: "statement_failed", metadata: statement };
	assert.equal((sqlStatementError(remote) as Error).message, (sqlStatementError(local) as Error).message);
	assert.equal((sqlStatementError(remote) as Error).message, "no such table: missing: SQLITE_ERROR");
	assert.equal(isCriticalSqliteError(remote), false);
});

test("remote statement offsets and extended result codes stay structured", () => {
	const error = { group: "sqlite", code: "remote_execution_failed", metadata: { statement: { code: 2067, message: "UNIQUE constraint failed: t.x", offset: 7 } } };
	assert.equal((sqlStatementError(error) as Error).message, "UNIQUE constraint failed: t.x at offset 7: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_UNIQUE)");
});

test("critical remote statement errors still break the object", () => {
	for (const code of [7, 9, 10, 13, 266]) {
		assert.equal(isCriticalSqliteError({ group: "sqlite", code: "remote_execution_failed", metadata: { statement: { code, message: "statement failure" } } }), true);
	}
	const transport = { group: "sqlite", code: "remote_indeterminate_result", message: "commit result lost" };
	assert.equal(sqlStatementError(transport), transport);
	assert.equal(isCriticalSqliteError(transport), false);
	const storage = { group: "sqlite", code: "remote_execution_failed", message: "storage refused" };
	assert.equal(sqlStatementError(storage), storage);
});
