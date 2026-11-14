import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { gunzipSync } from "node:zlib";

import { copyProject, repositoryRoot, runOrange, startOrangeDev, type TemporaryProject, withDeadline } from "../harness/orange-dev.js";

const wranglerBin = join(repositoryRoot, "node_modules", "wrangler", "bin", "wrangler.js");

function run(command: readonly string[], cwd: string): Promise<{ code: number | null; output: string }> {
	const child = spawn(process.execPath, command, { cwd, env: { ...process.env, CI: "1", NO_COLOR: "1", WRANGLER_SEND_METRICS: "false" }, stdio: ["ignore", "pipe", "pipe"] });
	let output = "";
	child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
	child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
	return withDeadline(new Promise((done) => child.once("exit", (code) => done({ code, output }))), command.join(" "), 120_000);
}

// A real `wrangler d1 export`, from a database that real Wrangler holds locally.
async function exportedDatabase(project: TemporaryProject): Promise<string> {
	const seed = await run([wranglerBin, "d1", "execute", "migrate-d1", "--local", "--file", "seed.sql"], project.directory);
	assert.equal(seed.code, 0, seed.output);
	const dump = join(project.directory, "export.sql");
	const exported = await run([wranglerBin, "d1", "export", "migrate-d1", "--local", "--output", dump], project.directory);
	assert.equal(exported.code, 0, exported.output);
	return dump;
}

const seeded = {
	audit: ["pet 1", "pet 2", "pet 3"],
	index: true,
	owners: [
		{ id: 1, name: "ada" },
		{ id: 2, name: "grace" },
		{ id: 3, name: "o'brien" },
	],
	pets: [
		{ blob: "00FF10", id: 1, note: "semi;colon", owner: 1, price: 1.5 },
		{ blob: "", id: 2, note: "line\nbreak", owner: 2, price: 2 },
		{ blob: "AB", id: 3, note: "unicode ✓", owner: 3, price: 12345678.25 },
	],
	view: [
		{ id: 1, name: "ada" },
		{ id: 2, name: "grace" },
		{ id: 3, name: "o'brien" },
	],
};

test("a D1 export arrives whole, the Worker reads it through its binding, and its schema keeps working", { timeout: 300_000 }, async () => {
	const project = await copyProject(join(repositoryRoot, "tests", "fixtures", "migrate-d1"));
	try {
		const dump = await exportedDatabase(project);
		const copy = await runOrange(project.directory, ["migrate", "d1", "DB", "--file", dump]);
		assert.equal(copy.code, 0, copy.output);
		const dev = await startOrangeDev(project.directory);
		try {
			assert.deepEqual(await (await fetch(dev.origin)).json(), seeded);
			// AUTOINCREMENT continues past the deleted row, and the trigger still fires.
			const owner = (await (await fetch(`${dev.origin}/owner`, { body: "new", method: "POST" })).json()) as { id: number };
			assert.equal(owner.id, 5);
			assert.equal((await fetch(`${dev.origin}/pet`, { body: "rex", method: "POST" })).status, 200);
			assert.equal(((await (await fetch(dev.origin)).json()) as typeof seeded).audit.at(-1), "pet 4");
		} finally {
			await dev.close();
		}
	} finally {
		await project.dispose();
	}
});

test("a row of 2 MB holding SQL syntax copies whole, and in seconds", { timeout: 120_000 }, async () => {
	const project = await copyProject(join(repositoryRoot, "tests", "fixtures", "migrate-d1"));
	try {
		// `runOrange` allows 60 seconds. A splitter that is quadratic in the size of a statement took 5 minutes for 1 MB.
		const body = `; BEGIN END -- /* $$ ${"x".repeat(2_000_000)}`;
		const dump = join(project.directory, "large-row.sql");
		await writeFile(dump, `CREATE TABLE notes(id INTEGER PRIMARY KEY, body TEXT);\nINSERT INTO notes(body) VALUES ('${body}');\nINSERT INTO notes(body) VALUES ('after');\n`);
		const copy = await runOrange(project.directory, ["migrate", "d1", "DB", "--file", dump]);
		assert.equal(copy.code, 0, copy.output);
		assert.match(copy.output, /Copied DB: 3 statements/);
		const read = await runOrange(project.directory, ["d1", "execute", "DB", "--json", "--command", "SELECT length(body) AS size FROM notes ORDER BY id"]);
		assert.equal(read.code, 0, read.output);
		assert.ok(read.output.includes(`"size": ${body.length}`), read.output.slice(-400));
		assert.ok(read.output.includes(`"size": 5`), read.output.slice(-400));
	} finally {
		await project.dispose();
	}
});

test("a trigger with comments in its header and `end` or `begin` as names copies whole", { timeout: 120_000 }, async () => {
	const project = await copyProject(join(repositoryRoot, "tests", "fixtures", "migrate-d1"));
	try {
		const dump = join(project.directory, "names.sql");
		await writeFile(
			dump,
			[
				"CREATE TABLE spans(id INTEGER PRIMARY KEY, end INTEGER, begin TEXT);",
				"CREATE TABLE span_log(end INTEGER, begin TEXT);",
				"CREATE /* logs each span */ TRIGGER -- after the insert",
				"spans_log AFTER INSERT ON spans BEGIN INSERT INTO span_log(end, begin) VALUES (NEW.end, NEW.begin); SELECT NEW.end; SELECT CASE WHEN NEW.begin IS NULL THEN 0 ELSE 1 END; END;",
				"INSERT INTO spans(end, begin) VALUES (7, 'a');",
				"",
			].join("\n"),
		);
		const copy = await runOrange(project.directory, ["migrate", "d1", "DB", "--file", dump]);
		assert.equal(copy.code, 0, copy.output);
		assert.match(copy.output, /Copied DB: 4 statements/);
		const read = await runOrange(project.directory, ["d1", "execute", "DB", "--json", "--command", "SELECT end, begin FROM span_log"]);
		assert.equal(read.code, 0, read.output);
		assert.match(read.output, /"end": 7,\s+"begin": "a"/);
	} finally {
		await project.dispose();
	}
});

test("each statement in a batch reports the changes it made, not those of the batch", { timeout: 120_000 }, async () => {
	const project = await copyProject(join(repositoryRoot, "tests", "fixtures", "migrate-d1"));
	try {
		const statements = [
			"CREATE TABLE notes(id INTEGER PRIMARY KEY, body TEXT)",
			"INSERT INTO notes(body) VALUES ('a'), ('b')",
			`INSERT INTO notes(body) VALUES ('${"x".repeat(100_000)}')`,
			"UPDATE notes SET body = 'c' WHERE id < 3",
			"SELECT id FROM notes",
		];
		const dev = await startOrangeDev(project.directory);
		try {
			const response = await fetch(`${dev.origin}/batch-meta`, { body: JSON.stringify(statements), method: "POST" });
			assert.equal(response.status, 200, await response.clone().text());
			const metas = (await response.json()) as { changed_db: boolean; changes: number; last_row_id: number; size_after: number }[];
			assert.deepEqual(
				metas.slice(1).map((meta) => [meta.changes, meta.last_row_id, meta.changed_db]),
				[
					[2, 2, true],
					[1, 3, true],
					[2, 3, true],
					[0, 3, false],
				],
			);
			const sizes = metas.map((meta) => meta.size_after);
			assert.ok(sizes[2]! > sizes[1]!, sizes.join());
			assert.equal(sizes[4], sizes[3]);
		} finally {
			await dev.close();
		}
	} finally {
		await project.dispose();
	}
});

test("a copy never overwrites Orange's data unless asked, and a copy that fails serves nothing until a rerun finishes it", { timeout: 300_000 }, async () => {
	const project = await copyProject(join(repositoryRoot, "tests", "fixtures", "migrate-d1"));
	try {
		const dump = await exportedDatabase(project);
		const first = await runOrange(project.directory, ["migrate", "d1", "DB", "--file", dump]);
		assert.equal(first.code, 0, first.output);
		const add = await runOrange(project.directory, ["d1", "execute", "DB", "--command", "INSERT INTO owners(name) VALUES ('only on Orange')"]);
		assert.equal(add.code, 0, add.output);

		const refused = await runOrange(project.directory, ["migrate", "d1", "DB", "--file", dump]);
		assert.equal(refused.code, 1, refused.output);
		assert.match(refused.output, /won't overwrite them\. Pass --replace/);
		const kept = await runOrange(project.directory, ["d1", "execute", "DB", "--json", "--command", "SELECT name FROM owners WHERE name = 'only on Orange'"]);
		assert.equal(kept.code, 0, kept.output);
		assert.match(kept.output, /only on Orange/);

		// The copy commits as it goes, so a statement that fails leaves part of a copy, which Orange
		// does not serve.
		const broken = join(project.directory, "broken.sql");
		await writeFile(broken, `${await readFile(dump, "utf8")}\nINSERT INTO no_such_table VALUES (1);\n`);
		const failed = await runOrange(project.directory, ["migrate", "d1", "DB", "--file", broken, "--replace"]);
		assert.equal(failed.code, 1, failed.output);
		assert.match(failed.output, /no such table: no_such_table/);
		const partial = await runOrange(project.directory, ["d1", "execute", "DB", "--json", "--command", "SELECT count(*) FROM owners"]);
		assert.notEqual(partial.code, 0, partial.output);
		assert.match(partial.output, /unfinished copy from Cloudflare/);

		// A rerun replaces Orange's own partial copy without --replace.
		const rerun = await runOrange(project.directory, ["migrate", "d1", "DB", "--file", dump]);
		assert.equal(rerun.code, 0, rerun.output);
		const dev = await startOrangeDev(project.directory);
		try {
			assert.deepEqual(await (await fetch(dev.origin)).json(), seeded);
		} finally {
			await dev.close();
		}
	} finally {
		await project.dispose();
	}
});

test("an export in D1's default format with an integer past 2^53 is refused before Orange changes, and the exact format copies it exactly", { timeout: 300_000 }, async () => {
	const project = await copyProject(join(repositoryRoot, "tests", "fixtures", "migrate-d1-export"));
	try {
		// Both exports are real D1's, of the same database: see tests/fixtures/migrate-d1-export/capture.ts.
		const exports = join(repositoryRoot, "tests", "fixtures", "migrate-d1-export", "exports");
		const rounded = join(project.directory, "d1.sql");
		await writeFile(rounded, gunzipSync(await readFile(join(exports, "d1.sql.gz"))));
		const refused = await runOrange(project.directory, ["migrate", "d1", "DB", "--file", rounded]);
		assert.equal(refused.code, 1, refused.output);
		assert.match(refused.output, /The export holds the integer 9223372036854776000, at or past 2\^53\..*Orange was not changed/);
		const untouched = await runOrange(project.directory, ["d1", "execute", "DB", "--json", "--command", "SELECT count(*) AS n FROM sqlite_schema WHERE name = 'events'"]);
		assert.match(untouched.output, /"n": 0/);

		const exact = join(project.directory, "sqlite3.sql");
		await writeFile(exact, gunzipSync(await readFile(join(exports, "sqlite3_cli_only.sql.gz"))));
		const copied = await runOrange(project.directory, ["migrate", "d1", "DB", "--file", exact]);
		assert.equal(copied.code, 0, copied.output);
		const read = await runOrange(project.directory, ["d1", "execute", "DB", "--json", "--command", "SELECT CAST(id AS TEXT) AS id, CAST(at AS TEXT) AS at FROM events ORDER BY id"]);
		assert.equal(read.code, 0, read.output);
		for (const value of ["1152921504606846977", "1152921504606846978", "1152921504606846979", "9007199254740993", "9007199254740995"]) assert.match(read.output, new RegExp(`"${value}"`));
	} finally {
		await project.dispose();
	}
});

test("an export in D1's default format with a column that keeps any type is refused, unless the type change is accepted", { timeout: 300_000 }, async () => {
	const project = await copyProject(join(repositoryRoot, "tests", "fixtures", "migrate-d1"));
	try {
		// A real `wrangler d1 export` writes the REAL 2.0 as 2, which an untyped column keeps as an INTEGER.
		const created = await run(
			[wranglerBin, "d1", "execute", "migrate-d1", "--local", "--command", "CREATE TABLE readings (id INTEGER PRIMARY KEY, raw, typed REAL); INSERT INTO readings VALUES (1, 2.0, 2.0);"],
			project.directory,
		);
		assert.equal(created.code, 0, created.output);
		const dump = join(project.directory, "export.sql");
		const exported = await run([wranglerBin, "d1", "export", "migrate-d1", "--local", "--output", dump], project.directory);
		assert.equal(exported.code, 0, exported.output);

		const refused = await runOrange(project.directory, ["migrate", "d1", "DB", "--file", dump]);
		assert.equal(refused.code, 1, refused.output);
		assert.match(refused.output, /readings\.raw/);
		assert.match(refused.output, /--allow-real-as-integer/);
		assert.doesNotMatch(refused.output, /readings\.typed|Looks like a bug/);
		const untouched = await runOrange(project.directory, ["d1", "execute", "DB", "--json", "--command", "SELECT count(*) AS n FROM sqlite_schema WHERE name = 'readings'"]);
		assert.match(untouched.output, /"n": 0/);

		const accepted = await runOrange(project.directory, ["migrate", "d1", "DB", "--file", dump, "--allow-real-as-integer"]);
		assert.equal(accepted.code, 0, accepted.output);
		const read = await runOrange(project.directory, ["d1", "execute", "DB", "--json", "--command", "SELECT typeof(raw) AS raw, typeof(typed) AS typed FROM readings"]);
		assert.match(read.output, /"raw": "integer",\s+"typed": "real"/);
	} finally {
		await project.dispose();
	}
});
