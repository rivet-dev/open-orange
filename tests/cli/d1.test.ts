import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { isRecord, startOrangeDev, stopProjectEngines } from "../harness/orange-dev.js";

// Drives `orange d1` commands and `orange dev` as real processes against one
// project, so the database the commands write is the one the Worker reads.

const cliEntrypoint = fileURLToPath(new URL("../../src/bin.ts", import.meta.url));

const worker = `export default {
	async fetch(request, env) {
		const { results } = await env.DB.prepare("SELECT body FROM notes ORDER BY id").all();
		return Response.json(results.map((row) => row.body));
	},
};
`;

interface CommandResult {
	code: number | null;
	stderr: string;
	stdout: string;
}

describe("orange d1 against the local database", () => {
	let projectRoot = "";

	const orange = (...args: string[]): Promise<CommandResult> =>
		new Promise((resolveResult) => {
			const child = spawn(
				process.execPath,
				["--import", "tsx", cliEntrypoint, "--config", join(projectRoot, "wrangler.json"), ...args],
				{ env: { ...process.env, CI: "1", NO_COLOR: "1" }, stdio: ["ignore", "pipe", "pipe"] },
			);
			let stdout = "";
			let stderr = "";
			child.stdout.on("data", (chunk: unknown) => {
				stdout += String(chunk);
			});
			child.stderr.on("data", (chunk: unknown) => {
				stderr += String(chunk);
			});
			child.once("exit", (code) => resolveResult({ code, stderr, stdout }));
		});

	const query = async (sql: string): Promise<unknown[]> => {
		const result = await orange("d1", "execute", "app", "--local", "--json", "--command", sql);
		assert.equal(result.code, 0, result.stderr);
		const parsed: unknown = JSON.parse(result.stdout);
		assert.ok(Array.isArray(parsed));
		return parsed.map((entry: unknown) => (isRecord(entry) ? entry.results : undefined));
	};

	const writeMigration = (name: string, sql: string): Promise<void> =>
		writeFile(join(projectRoot, "db", "migrations", name), sql);

	before(async () => {
		projectRoot = await mkdtemp(join(tmpdir(), "open-orange-d1-"));
		await mkdir(join(projectRoot, "db", "migrations"), { recursive: true });
		await writeFile(
			join(projectRoot, "wrangler.json"),
			JSON.stringify({
				compatibility_date: "2026-09-03",
				d1_databases: [
					{
						binding: "DB",
						database_id: "app-db",
						database_name: "app",
						migrations_dir: "db/migrations",
						migrations_table: "schema_migrations",
					},
				],
				main: "./worker.js",
				name: "d1-e2e",
			}),
		);
		await writeFile(join(projectRoot, "worker.js"), worker);
		await writeMigration(
			"0001_init.sql",
			"-- Notes table\nCREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL);\n",
		);
		await writeMigration("0002_seed.sql", "INSERT INTO notes (body) VALUES ('first');\n");
		await writeMigration(
			"0003_broken.sql",
			"INSERT INTO notes (body) VALUES ('partial');\nINSERT INTO missing VALUES (1);\n",
		);
		await writeMigration("0004_last.sql", "INSERT INTO notes (body) VALUES ('last');\n");
	});

	after(async () => {
		await stopProjectEngines(projectRoot);
		await rm(projectRoot, { force: true, recursive: true });
	});

	it("rejects a database that the configuration does not define", async () => {
		const result = await orange("d1", "execute", "other", "--command", "SELECT 1");
		assert.equal(result.code, 1);
		assert.match(
			result.stderr,
			/Couldn't find a D1 DB with the name or binding 'other' in your wrangler.json file\./,
		);
	});

	it("applies migrations in order, rolls back a failed one, and orange dev reads the result", async () => {
		const pending = await orange("d1", "migrations", "list", "DB", "--local");
		assert.equal(pending.code, 0, pending.stderr);
		assert.deepEqual(pending.stdout.match(/\d{4}_\w+\.sql/g), [
			"0001_init.sql",
			"0002_seed.sql",
			"0003_broken.sql",
			"0004_last.sql",
		]);

		// The failed migration rolls back its own insert, and later ones do not run.
		const failed = await orange("d1", "migrations", "apply", "app", "--local");
		assert.equal(failed.code, 1);
		assert.match(
			failed.stderr,
			/Migration 0003_broken\.sql failed with the following errors:\nno such table: missing/,
		);
		assert.deepEqual(
			await query("SELECT body FROM notes ORDER BY id; SELECT name FROM schema_migrations ORDER BY id"),
			[[{ body: "first" }], [{ name: "0001_init.sql" }, { name: "0002_seed.sql" }]],
		);

		await writeMigration("0003_broken.sql", "INSERT INTO notes (body) VALUES ('fixed');\n");
		const applied = await orange("d1", "migrations", "apply", "DB", "--local");
		assert.equal(applied.code, 0, applied.stderr);
		const again = await orange("d1", "migrations", "apply", "DB", "--local");
		assert.equal(again.code, 0, again.stderr);
		assert.match(again.stdout, /No migrations to apply!/);

		const dev = await startOrangeDev(projectRoot, "wrangler.json");
		try {
			assert.deepEqual(await dev.json("/"), ["first", "fixed", "last"]);
		} finally {
			await dev.close();
		}
	});
});
