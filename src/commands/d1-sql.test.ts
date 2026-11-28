import assert from "node:assert/strict";
import test from "node:test";

import { splitSqlQuery } from "./d1-sql.js";

test("splits plain multi-statement SQL on each top-level ;", () => {
	assert.deepEqual(splitSqlQuery("INSERT INTO t VALUES (1); INSERT INTO t VALUES (2);"), [
		"INSERT INTO t VALUES (1)",
		"INSERT INTO t VALUES (2)",
	]);
});

test("keeps a CREATE TRIGGER body's own ; internal, splits at the trigger's closing END;", () => {
	const sql = [
		"CREATE TRIGGER t AFTER INSERT ON x",
		"BEGIN",
		"  INSERT INTO y VALUES (1);",
		"  INSERT INTO y VALUES (2);",
		"END;",
		"SELECT 1;",
	].join("\n");
	const statements = splitSqlQuery(sql);
	assert.equal(statements.length, 2);
	assert.match(statements[0] ?? "", /CREATE TRIGGER t[\s\S]*INSERT INTO y VALUES \(2\);\s*END/);
	assert.ok(!(statements[0] ?? "").trim().endsWith(";"), "the outer split drops the closing ;");
	assert.equal(statements[1], "SELECT 1");
});

// https://github.com/rivet-dev/open-orange/issues/82 repro 1: a CASE expression inside a
// trigger body used to be counted as its own compound block, and its END closed the block
// one level early, so the trigger's `;` right after the CASE's END) ended the whole
// CREATE TRIGGER statement in the middle of its body.
test("a CASE ... END inside a trigger body does not close the trigger early", () => {
	const sql = [
		"CREATE TABLE audit (id INTEGER PRIMARY KEY, val TEXT);",
		"CREATE TABLE items (id INTEGER PRIMARY KEY, status TEXT);",
		"CREATE TRIGGER items_audit AFTER INSERT ON items",
		"BEGIN",
		"  INSERT INTO audit (val) VALUES ((CASE WHEN NEW.status = 'ok' THEN 'good' ELSE 'bad' END ));",
		"END;",
	].join("\n");
	const statements = splitSqlQuery(sql);
	assert.equal(statements.length, 3);
	assert.match(statements[0] ?? "", /^CREATE TABLE audit/);
	assert.match(statements[1] ?? "", /^CREATE TABLE items/);
	assert.match(statements[2] ?? "", /^CREATE TRIGGER items_audit/);
	assert.match(statements[2] ?? "", /CASE WHEN NEW\.status = 'ok' THEN 'good' ELSE 'bad' END/);
	assert.match(statements[2] ?? "", /END\s*$/);
});

// https://github.com/rivet-dev/open-orange/issues/82 repro 2: a CASE ... END followed by a
// comma (outside any trigger) used to leave a compound block open, fusing every later
// statement into one and dropping their earlier result sets.
test("a CASE ... END followed by a comma does not fuse later statements together", () => {
	const statements = splitSqlQuery(
		"SELECT CASE 1 WHEN 1 THEN 'a' END, 2 AS b; SELECT 99 AS second_stmt;",
	);
	assert.deepEqual(statements, [
		"SELECT CASE 1 WHEN 1 THEN 'a' END, 2 AS b",
		"SELECT 99 AS second_stmt",
	]);
});

test("an ORDER BY CASE ... END, id clause splits normally", () => {
	const statements = splitSqlQuery(
		"SELECT * FROM t ORDER BY CASE WHEN x THEN 0 ELSE 1 END, id; SELECT 2;",
	);
	assert.deepEqual(statements, ["SELECT * FROM t ORDER BY CASE WHEN x THEN 0 ELSE 1 END, id", "SELECT 2"]);
});

test("CREATE TEMP TRIGGER is recognized the same as CREATE TRIGGER", () => {
	const sql = "CREATE TEMP TRIGGER t AFTER INSERT ON x BEGIN INSERT INTO y VALUES (1); END; SELECT 1;";
	const statements = splitSqlQuery(sql);
	assert.equal(statements.length, 2);
	assert.match(statements[0] ?? "", /^CREATE TEMP TRIGGER t/);
	assert.equal(statements[1], "SELECT 1");
});

test("a string literal containing the word END does not open or close a trigger body", () => {
	const statements = splitSqlQuery("INSERT INTO t VALUES ('the END'); SELECT 1;");
	assert.deepEqual(statements, ["INSERT INTO t VALUES ('the END')", "SELECT 1"]);
});
