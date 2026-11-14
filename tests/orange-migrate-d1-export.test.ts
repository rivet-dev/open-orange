import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer, Socket } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { gunzipSync } from "node:zlib";

import { startFakeD1ExportApi, type FakeD1ExportApi, type FakeD1ExportApiOptions } from "./fake-d1-export-api.js";
import { describeSource, migratorToken, startCloudflareSource, type CloudflareSource } from "./migrate-source.js";
import { copyProject, repositoryRoot, runOrange, startOrangeDev, type RunningOrangeDev, type TemporaryProject, withDeadline } from "./orange-dev.js";

// `orange migrate d1 --url` end to end: the real CLI, real `orange dev`, and the prepared Worker on
// real workerd with a real local D1 that holds seed.sql. Cloudflare's export API is a local server
// that serves the export real D1 made of the same seed.sql (see the fixture's capture.ts).

const fixture = join(repositoryRoot, "tests", "fixtures", "migrate-d1-export");
const wranglerBin = join(repositoryRoot, "node_modules", "wrangler", "bin", "wrangler.js");
const realDump = gunzipSync(await readFile(join(fixture, "exports", "sqlite3_cli_only.sql.gz")));

function wrangler(directory: string, args: readonly string[]): Promise<void> {
	const child = spawn(process.execPath, [wranglerBin, ...args], {
		cwd: directory,
		env: { ...process.env, CI: "1", NO_COLOR: "1", WRANGLER_SEND_METRICS: "false" },
		stdio: ["ignore", "pipe", "pipe"],
	});
	let output = "";
	child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
	child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
	return withDeadline(
		new Promise((done, fail) => child.once("exit", (code) => (code === 0 ? done() : fail(new Error(output))))),
		args.join(" "),
		120_000,
	);
}

interface AppResult {
	status: number;
	text: string;
}

async function app(origin: string, statements: { params?: unknown[]; sql: string }[]): Promise<AppResult> {
	const response = await fetch(`${origin}/sql`, { body: JSON.stringify({ statements }), method: "POST" });
	return { status: response.status, text: await response.text() };
}

function rows(result: AppResult): any[] {
	assert.equal(result.status, 200, result.text);
	return JSON.parse(result.text)[0].rows;
}

// Every table, value for value. SQLite builds print a REAL's 17 digits differently, such as
// `0.1` and `0.10000000000000001` for one double, so a REAL compares as the double it parses to.
async function dump(origin: string): Promise<Record<string, unknown[][]>> {
	const response = await fetch(`${origin}/dump`);
	assert.equal(response.status, 200, await response.clone().text());
	const tables = (await response.json()) as Record<string, (string | null)[][]>;
	const real = (text: string): string => {
		const body = text.slice(1);
		return `r${body === "Inf" ? "Infinity" : body === "-Inf" ? "-Infinity" : String(Number(body))}`;
	};
	return Object.fromEntries(Object.entries(tables).map(([name, rows]) => [name, rows.map((row) => row.map((value) => (value?.startsWith("r") ? real(value) : value)))]));
}

async function sourceState(source: CloudflareSource): Promise<string> {
	const response = await fetch(`${source.origin}/__migrate-d1/DB/state`, { body: "{}", headers: { authorization: `Bearer ${migratorToken}` }, method: "POST" });
	return ((await response.json()) as { state: string }).state;
}

// A TCP proxy, so Orange keeps one URL across a restart.
async function startProxy(target: () => number): Promise<{ close(): Promise<void>; origin: string }> {
	const sockets = new Set<Socket>();
	const server = createServer((client) => {
		const upstream = new Socket();
		sockets.add(client).add(upstream);
		upstream.connect(target(), "127.0.0.1");
		client.pipe(upstream).pipe(client);
		const drop = (): void => {
			client.destroy();
			upstream.destroy();
		};
		client.on("error", drop).on("close", drop);
		upstream.on("error", drop).on("close", drop);
	});
	await new Promise<void>((listening) => server.listen(0, "127.0.0.1", listening));
	const address = server.address();
	assert.ok(address !== null && typeof address === "object");
	return {
		close: () =>
			new Promise((closed) => {
				for (const socket of sockets) socket.destroy();
				server.close(() => closed());
			}),
		origin: `http://127.0.0.1:${address.port}`,
	};
}

// What a proxy does with one step of a move: send another body, answer itself, or forward the step
// and then drop the connection, so the step happens and its answer is lost.
type StepPlan = { answer?: { body: unknown; status: number }; body?: unknown; lose?: boolean } | undefined;

// An HTTP proxy in front of the prepared Worker or of Orange, as the CLI reaches them.
async function startStepProxy(target: () => string, plan: (step: string, body: any) => StepPlan | Promise<StepPlan>): Promise<{ close(): Promise<void>; origin: string }> {
	const server = createHttpServer((request, response) => {
		void (async () => {
			let text = "";
			for await (const chunk of request) text += String(chunk);
			const step = /^\/__migrate-d1\/[^/]+\/([^/]+)$/.exec(new URL(request.url ?? "/", "http://proxy").pathname)?.[1];
			const planned = step === undefined ? undefined : await plan(step, text === "" ? {} : JSON.parse(text));
			if (planned?.answer !== undefined) {
				response.writeHead(planned.answer.status, { "content-type": "application/json" });
				response.end(JSON.stringify(planned.answer.body));
				return;
			}
			const headers = Object.fromEntries(Object.entries(request.headers).filter(([name]) => !["connection", "content-length", "host"].includes(name))) as Record<string, string>;
			const forwarded = await fetch(new URL(request.url ?? "/", target()), {
				...(request.method === "GET" || request.method === "HEAD" ? {} : { body: planned?.body === undefined ? text : JSON.stringify(planned.body) }),
				headers,
				method: request.method,
			});
			const body = Buffer.from(await forwarded.arrayBuffer());
			if (planned?.lose === true) {
				response.destroy();
				return;
			}
			response.writeHead(forwarded.status, { "content-type": forwarded.headers.get("content-type") ?? "application/json" });
			response.end(body);
		})().catch(() => response.destroy());
	});
	await new Promise<void>((listening) => server.listen(0, "127.0.0.1", listening));
	const address = server.address();
	assert.ok(address !== null && typeof address === "object");
	return {
		close: () =>
			new Promise((closed) => {
				server.closeAllConnections();
				server.close(() => closed());
			}),
		origin: `http://127.0.0.1:${address.port}`,
	};
}

interface MoveUrls {
	cloudflareUrl?: string;
	orangeUrl?: string;
}

interface StartedMove {
	exited: Promise<{ code: number | null; output: string; signal: NodeJS.Signals | null }>;
	output(): string;
	signal(signal: NodeJS.Signals): void;
}

interface Move {
	api: FakeD1ExportApi;
	destination: TemporaryProject;
	dispose(): Promise<void>;
	move(urls?: MoveUrls): Promise<{ code: number | null; output: string }>;
	orange: RunningOrangeDev;
	source: CloudflareSource;
	// The move as its own process, for a test that stops it or runs another one beside it.
	start(urls?: MoveUrls): StartedMove;
}

async function setUp(api: Partial<FakeD1ExportApiOptions> = {}): Promise<Move> {
	const sourceProject = await copyProject(fixture);
	const prepared = await runOrange(sourceProject.directory, ["migrate", "prepare"]);
	assert.equal(prepared.code, 0, prepared.output);
	await wrangler(sourceProject.directory, ["d1", "execute", "migrate-d1-export", "--local", "--file", "seed.sql", "--config", "wrangler.migrate.jsonc"]);
	const source = await startCloudflareSource(sourceProject.directory);
	const destination = await copyProject(fixture);
	await writeFile(join(destination.directory, ".dev.vars"), `ORANGE_MIGRATE_WORKER_URL=${source.origin}\nWORKER_MIGRATOR_TOKEN=${migratorToken}\n`);
	const orange = await startOrangeDev(destination.directory);
	// The same object, so a test can change what the export serves between runs.
	const fake = await startFakeD1ExportApi(Object.assign(api, { dump: api.dump ?? realDump }));
	const environment = {
		CLOUDFLARE_ACCOUNT_ID: "test-account",
		CLOUDFLARE_API_BASE_URL: fake.url,
		CLOUDFLARE_API_TOKEN: "test-api-token",
		ORANGE_MIGRATE_WORKER_URL: source.origin,
		WORKER_MIGRATOR_TOKEN: migratorToken,
	};
	const result: Move = {
		api: fake,
		destination,
		// Every part closes, also after one fails to, so a hung Orange can't leave wrangler dev running.
		async dispose() {
			const closed = await Promise.allSettled([result.orange.close(), fake.close(), source.close()]);
			await sourceProject.dispose();
			await destination.dispose();
			for (const outcome of closed) if (outcome.status === "rejected") throw outcome.reason;
		},
		move: (urls = {}) =>
			runOrange(destination.directory, ["migrate", "d1", "DB", "--url", urls.orangeUrl ?? result.orange.origin], "wrangler.jsonc", {
				deadlineMs: 240_000,
				environment: { ...environment, ORANGE_MIGRATE_WORKER_URL: urls.cloudflareUrl ?? source.origin },
			}),
		orange,
		source,
		start(urls = {}) {
			const child = spawn(process.execPath, ["--import", "tsx", join(repositoryRoot, "src", "bin.ts"), "migrate", "d1", "DB", "--url", urls.orangeUrl ?? result.orange.origin, "--config", join(destination.directory, "wrangler.jsonc")], {
				cwd: repositoryRoot,
				env: { ...process.env, ...environment, CI: "1", NO_COLOR: "1", ORANGE_MIGRATE_WORKER_URL: urls.cloudflareUrl ?? source.origin },
				stdio: ["ignore", "pipe", "pipe"],
			});
			let output = "";
			child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
			child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
			const exited = withDeadline(
				new Promise<{ code: number | null; output: string; signal: NodeJS.Signals | null }>((done) => child.once("exit", (code, signal) => done({ code, output, signal }))),
				"orange migrate d1",
				240_000,
			);
			return { exited, output: () => output, signal: (signal) => child.kill(signal) };
		},
	};
	return result;
}

async function waitFor(what: string, done: () => Promise<boolean> | boolean, ms = 60_000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!(await done())) {
		if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}

// A move that failed before the switch: Cloudflare takes writes again, and Orange serves none of its copy.
async function assertRefused(setup: Move, moved: { code: number | null; output: string }, message: RegExp): Promise<void> {
	assert.equal(moved.code, 1, moved.output);
	assert.match(moved.output, message);
	assert.doesNotMatch(moved.output, /Looks like a bug/);
	assert.equal(await sourceState(setup.source), "none");
	// A write, and one that takes it back, so Cloudflare still equals the export that the next run reads.
	const write = await app(setup.source.origin, [
		{ sql: "INSERT INTO tags(owner, label) VALUES (99, 'after a refusal')" },
		{ sql: "DELETE FROM tags WHERE owner = 99" },
	]);
	assert.equal(JSON.parse(write.text)[0].servedBy, "miniflare.db", write.text);
	assert.match((await app(setup.orange.origin, [{ sql: "SELECT count(*) FROM owners" }])).text, /unfinished copy from Cloudflare/);
}

test("a D1 database moves through the export API: Orange equals Cloudflare value for value, writes fail clearly while frozen, and none is lost", { timeout: 400_000 }, async () => {
	const setup = await setUp();
	const { orange, source } = setup;
	try {
		const before = await dump(source.origin);

		// The app writes and reads through Cloudflare from the moment the freeze starts until after
		// the move. The export holds the database as seed.sql left it, so the writer waits for the freeze.
		const writes: { name: string; result: AppResult }[] = [];
		const reads: AppResult[] = [];
		let running = true;
		const appTraffic = (async () => {
			while (running && (await sourceState(source)) !== "frozen") await new Promise((resolve) => setTimeout(resolve, 20));
			for (let i = 0; running; i += 1) {
				const name = `w${i}`;
				writes.push({ name, result: await app(source.origin, [{ params: [name], sql: "INSERT INTO owners(name) VALUES (?)" }]) });
				reads.push(await app(source.origin, [{ sql: "SELECT count(*) AS n FROM pets" }]));
				await new Promise((resolve) => setTimeout(resolve, 20));
			}
		})();
		const moved = await setup.move();
		// The app writes until one write lands on Orange. A fixed pause is too short on a loaded host.
		const until = Date.now() + 30_000;
		while (moved.code === 0 && Date.now() < until && !writes.some(({ result }) => result.status === 200)) {
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		running = false;
		await appTraffic;
		assert.equal(moved.code, 0, moved.output);
		assert.match(moved.output, /Checked \d+ rows in 13 tables, value for value/);
		// `notes` lost its second row, so its rowids 1, 3, 4 become 1, 2, 3 on Orange.
		assert.match(moved.output, /! notes has rowids up to 4 in 3 rows\. D1's export numbers them again from 1/);
		assert.doesNotMatch(moved.output, /! (?!notes)\w+ has rowids/);

		// While frozen, a write fails with an error that names the move, and a read works. Between the
		// switch and the end of Orange's copy, one commit, a query fails on Orange's unfinished copy.
		const switching = /unfinished copy from Cloudflare/;
		const refused = writes.filter(({ result }) => result.status !== 200);
		assert.ok(refused.some(({ result }) => /orange-d1-frozen: DB is moving to Orange/.test(result.text)), "some writes ran while frozen");
		const firstSwitching = refused.findIndex(({ result }) => switching.test(result.text));
		for (const [index, { result }] of refused.entries()) {
			assert.match(result.text, firstSwitching === -1 || index < firstSwitching ? /orange-d1-frozen: DB is moving to Orange/ : switching);
		}
		for (const read of reads.filter(({ status }) => status !== 200)) assert.match(read.text, switching);
		// After the switch, writes reach Orange through Cloudflare, and every acknowledged one is there.
		const acknowledged = writes.filter(({ result }) => result.status === 200);
		assert.ok(acknowledged.length > 0, "some writes ran after the switch");
		for (const { result } of acknowledged) assert.equal(JSON.parse(result.text)[0].servedBy, "open-orange.db");
		const after = await dump(orange.origin);
		const added = after.owners!.slice(before.owners!.length);
		assert.deepEqual(after.owners!.slice(0, before.owners!.length), before.owners);
		assert.deepEqual(
			added.map((row) => row[1]),
			acknowledged.map(({ name }) => `t${Buffer.from(name).toString("hex").toUpperCase()}`),
		);
		// AUTOINCREMENT goes on past the deleted owner 4, and the app's trigger fires on Orange.
		assert.equal(added[0]![0], "i5");
		assert.equal(after.audit!.length, before.audit!.length + acknowledged.length);
		for (const table of Object.keys(before).filter((name) => name !== "owners" && name !== "audit")) {
			assert.deepEqual(after[table], before[table], table);
		}

		// Integers past 2^53 are exact, and so is the UNIQUE index over them.
		assert.equal(rows(await app(orange.origin, [{ sql: "SELECT CAST(at AS TEXT) AS at FROM events ORDER BY id LIMIT 1" }]))[0].at, "9007199254740993");
		assert.equal((await app(orange.origin, [{ sql: "INSERT INTO events(id, at) VALUES (1, 9007199254740993)" }])).status, 500);
		assert.equal((await app(orange.origin, [{ sql: "INSERT INTO events(id, at) VALUES (2, 9007199254740992)" }])).status, 200);
		assert.deepEqual(rows(await app(orange.origin, [{ sql: "SELECT name FROM owner_names WHERE id = 3" }])), [{ name: "o'brien" }]);
		assert.deepEqual(rows(await app(orange.origin, [{ sql: "SELECT twice, thrice FROM generated WHERE id = 2" }])), [{ thrice: 60, twice: 40 }]);
		// A trigger whose body names columns `end` and `begin` arrives whole, and fires on Orange.
		assert.equal((await app(source.origin, [{ sql: "INSERT INTO spans(start, end, begin) VALUES (3, 4, 'c')" }])).status, 200);
		assert.deepEqual(rows(await app(orange.origin, [{ sql: "SELECT end, begin, kind FROM span_log ORDER BY id DESC LIMIT 1" }])), [{ begin: "c", end: 4, kind: "forward" }]);

		// A second run sees the move and changes nothing.
		const again = await setup.move();
		assert.equal(again.code, 0, again.output);
		assert.match(again.output, /already moved/);
	} finally {
		await setup.dispose();
	}
});

// `.raw()` and `.exec()` through the prepared Worker's binding, as Drizzle's `.returning()` and
// `.get()` use them.
async function rawAndExecWrites(origin: string, name: string): Promise<void> {
	const raw = await fetch(`${origin}/raw`, { body: JSON.stringify({ params: [`${name} raw`], sql: "INSERT INTO owners(name) VALUES (?) RETURNING name" }), method: "POST" });
	assert.equal(raw.status, 200, await raw.clone().text());
	assert.deepEqual(((await raw.json()) as { rows: unknown[][] }).rows, [["name"], [`${name} raw`]]);
	const exec = await fetch(`${origin}/exec`, { body: JSON.stringify({ sql: `INSERT INTO owners(name) VALUES ('${name} exec')` }), method: "POST" });
	assert.equal(exec.status, 200, await exec.clone().text());
}

test("an export that fails opens the freeze again, and Orange is not changed", { timeout: 300_000 }, async () => {
	const setup = await setUp({ exportError: "D1 Export error: cannot export databases with virtual tables (like FTS5)" });
	try {
		// Before any move, the database has no state table. After a failed move, it has none again.
		await rawAndExecWrites(setup.source.origin, "before");
		const moved = await setup.move();
		assert.equal(moved.code, 1, moved.output);
		assert.match(moved.output, /Cloudflare's export failed: D1 Export error/);
		assert.doesNotMatch(moved.output, /Looks like a bug/);
		assert.match(moved.output, /Writes to DB on Cloudflare work again/);
		const write = await app(setup.source.origin, [{ params: ["after"], sql: "INSERT INTO owners(name) VALUES (?)" }]);
		assert.equal(JSON.parse(write.text)[0].servedBy, "miniflare.db");
		await rawAndExecWrites(setup.source.origin, "after");
		// Each write ran once.
		assert.deepEqual(rows(await app(setup.source.origin, [{ sql: "SELECT name, count(*) AS n FROM owners WHERE name LIKE 'before %' OR name LIKE 'after %' GROUP BY name ORDER BY name" }])), [
			{ n: 1, name: "after exec" },
			{ n: 1, name: "after raw" },
			{ n: 1, name: "before exec" },
			{ n: 1, name: "before raw" },
		]);
		assert.deepEqual(rows(await app(setup.orange.origin, [{ sql: "SELECT count(*) AS n FROM sqlite_schema WHERE name = 'owners'" }])), [{ n: 0 }]);
	} finally {
		await setup.dispose();
	}
});

test("polls that fail are asked again, and a signed URL that breaks is exported again and copied from the start", { timeout: 300_000 }, async () => {
	const setup = await setUp({ failingPolls: 2, firstUrlBreaksAfter: 1_200_000 });
	try {
		const before = await dump(setup.source.origin);
		const moved = await setup.move();
		assert.equal(moved.code, 0, moved.output);
		assert.match(moved.output, /Polling the export failed \(Cloudflare's API refused POST \/export: Internal Server Error\.\)\. Trying again\./);
		// Each export has its own bookmark, as on real D1, so the copy starts again.
		assert.match(moved.output, /The export's URL stopped working .*HTTP 403.* Exporting again, and copying from the start/);
		assert.equal(setup.api.exports(), 2);
		assert.deepEqual(await dump(setup.orange.origin), before);
	} finally {
		await setup.dispose();
	}
});

test("Orange restarts during the import, and the move goes on from what Orange made durable", { timeout: 400_000 }, async () => {
	let restart: (() => void) | undefined;
	const restarted = new Promise<void>((resolve) => (restart = resolve));
	const setup = await setUp({
		bytesPerSecond: 400_000,
		// Past the first commit of about 1 MiB.
		onServed: (bytes) => {
			if (bytes >= 1_500_000) restart?.();
		},
	});
	let port = new URL(setup.orange.origin).port;
	const proxy = await startProxy(() => Number(port));
	try {
		const before = await dump(setup.source.origin);
		const moving = setup.move({ orangeUrl: proxy.origin });
		await restarted;
		await setup.orange.close();
		setup.orange = await startOrangeDev(setup.destination.directory);
		port = new URL(setup.orange.origin).port;
		const moved = await moving;
		assert.equal(moved.code, 0, `${moved.output}\n${describeSource(setup.source.origin)}`);
		assert.match(moved.output, /An import step failed/);
		assert.deepEqual(await dump(setup.orange.origin), before);
	} finally {
		await proxy.close();
		await setup.dispose();
	}
});

test("the check before the switch catches a wrong value in the export, nothing moves, and a rerun with a good export moves", { timeout: 400_000 }, async () => {
	// One byte of one row differs: `pet 1500` becomes `pet 1501`.
	const corrupted = Buffer.from(realDump.toString("utf8").replace("'pet 1500'", "'pet 1501'"));
	assert.notDeepEqual(corrupted, realDump);
	// An export without the freeze's state row could be older than the freeze.
	const unfrozen = Buffer.from(
		realDump
			.toString("utf8")
			.split("\n")
			.filter((line) => !line.startsWith("INSERT INTO _orange_d1_state"))
			.join("\n"),
	);
	assert.notDeepEqual(unfrozen, realDump);
	const options: FakeD1ExportApiOptions = { dump: unfrozen };
	const setup = await setUp(options);
	try {
		const before = await dump(setup.source.origin);
		await assertRefused(setup, await setup.move(), /The export holds no sign of the write freeze/);

		options.dump = corrupted;
		const refused = await setup.move();
		assert.equal(refused.code, 1, refused.output);
		assert.match(refused.output, /Orange's copy of pets differs from Cloudflare's in rows \d+ to \d+ \(in key order\): a value differs/);
		assert.match(refused.output, /Writes to DB on Cloudflare work again/);
		assert.equal(JSON.parse((await app(setup.source.origin, [{ sql: "SELECT 1" }])).text)[0].servedBy, "miniflare.db");
		// Orange serves none of the copy that failed.
		assert.match((await app(setup.orange.origin, [{ sql: "SELECT count(*) FROM pets" }])).text, /unfinished copy from Cloudflare/);

		options.dump = realDump;
		const moved = await setup.move();
		assert.equal(moved.code, 0, moved.output);
		assert.deepEqual(await dump(setup.orange.origin), before);
	} finally {
		await setup.dispose();
	}
});

test("the switch refuses when a write could have missed the copy, Orange serves none of it, and the next run moves", { timeout: 900_000 }, async () => {
	const options: FakeD1ExportApiOptions = { dump: realDump };
	const setup = await setUp(options);
	let cloudflarePlan: (step: string, body: any) => StepPlan | Promise<StepPlan> = () => undefined;
	let orangePlan: (step: string, body: any) => StepPlan | Promise<StepPlan> = () => undefined;
	const cloudflare = await startStepProxy(() => setup.source.origin, (step, body) => cloudflarePlan(step, body));
	const orange = await startStepProxy(() => setup.orange.origin, (step, body) => orangePlan(step, body));
	const move = (): Promise<{ code: number | null; output: string }> => setup.move({ cloudflareUrl: cloudflare.origin, orangeUrl: orange.origin });
	const sql = async (...statements: string[]): Promise<any[]> => {
		const result = await app(setup.source.origin, statements.map((statement) => ({ sql: statement })));
		assert.equal(result.status, 200, result.text);
		return JSON.parse(result.text);
	};
	try {
		const before = await dump(setup.source.origin);

		// 1. The lease runs out: 2 seconds, and every renewal fails. A write then reaches Cloudflare.
		let frozenAt = 0;
		cloudflarePlan = async (step, body) => {
			if (step === "freeze") {
				frozenAt = Date.now();
				return { body: { ...body, leaseSeconds: 2 } };
			}
			if (step === "extend") return { answer: { body: { error: { code: "gateway", message: "bad gateway" } }, status: 502 } };
			if (step === "moved") {
				await waitFor("the lease to run out", () => Date.now() - frozenAt > 3_000);
				await sql("INSERT INTO tags(owner, label) VALUES (98, 'after the lease')");
			}
			return undefined;
		};
		await assertRefused(setup, await move(), /the write freeze ran out or was replaced/);
		assert.deepEqual((await sql("SELECT label FROM tags WHERE owner = 98"))[0].rows, [{ label: "after the lease" }]);
		await sql("DELETE FROM tags WHERE owner = 98");

		// 2. A schema change during the import: the check before the switch sees it.
		let changed = false;
		cloudflarePlan = async (step) => {
			if (step === "digest" && !changed) {
				changed = true;
				await sql("CREATE INDEX pets_note ON pets(note)");
			}
			return undefined;
		};
		await assertRefused(setup, await move(), /DB's schema changed on Cloudflare during the move, so Orange's copy is out of date/);
		await sql("DROP INDEX pets_note");

		// 3. A table created after the check has no freeze triggers, so it takes writes.
		cloudflarePlan = async (step) => {
			if (step === "moved") await sql("CREATE TABLE late (x)", "INSERT INTO late VALUES ('kept on Cloudflare')");
			return undefined;
		};
		await assertRefused(setup, await move(), /schema changed on Cloudflare after the freeze/);
		assert.deepEqual((await sql("SELECT x FROM late"))[0].rows, [{ x: "kept on Cloudflare" }]);
		await sql("DROP TABLE late");

		// 4. A table dropped and created again reads the same in the schema, but has lost its triggers.
		cloudflarePlan = async (step) => {
			if (step === "moved") {
				await sql(
					`DROP TABLE "odd ""name"""`,
					`CREATE TABLE "odd ""name""" ("select" TEXT, "col;umn" INTEGER)`,
					`INSERT INTO "odd ""name"""("select", "col;umn") VALUES ('a ''quoted'' value', 1), ('kept on Cloudflare', 2)`,
				);
			}
			return undefined;
		};
		await assertRefused(setup, await move(), /schema changed on Cloudflare after the freeze/);
		assert.deepEqual((await sql(`SELECT count(*) AS n FROM "odd ""name"""`))[0].rows, [{ n: 2 }]);
		await sql(`DELETE FROM "odd ""name""" WHERE "col;umn" = 2`);

		// 5. A table created after the preflight, and before the freeze, is frozen and checked too.
		options.dump = Buffer.concat([realDump, Buffer.from("\nCREATE TABLE late2 (x);\nINSERT INTO late2 VALUES('stale');\n")]);
		cloudflarePlan = async (step) => {
			if (step === "freeze") await sql("CREATE TABLE late2 (x)", "INSERT INTO late2 VALUES ('on Cloudflare')");
			return undefined;
		};
		await assertRefused(setup, await move(), /Orange's copy of late2 differs from Cloudflare's/);
		await sql("DROP TABLE late2");
		options.dump = realDump;

		// 6. The switch's first answer is lost, and Orange can't finish. Cloudflare switches first, so
		// the app's queries fail on Orange's unfinished copy, and neither side takes a write.
		let switches = 0;
		cloudflarePlan = (step) => (step === "moved" && (switches += 1) === 1 ? { lose: true } : undefined);
		orangePlan = (step) => (step === "finish" ? { answer: { body: { error: { code: "migrate_d1.unavailable", message: "The D1 database did not answer" } }, status: 503 } } : undefined);
		const stopped = await move();
		assert.equal(stopped.code, 1, stopped.output);
		assert.match(stopped.output, /Switching Cloudflare to Orange failed/, describeSource(setup.source.origin));
		assert.match(stopped.output, /Cloudflare sends every query for DB to Orange, but Orange's copy did not finish .* Run this command again to finish it\./);
		assert.doesNotMatch(stopped.output, /Writes to DB on Cloudflare work again/);
		assert.equal(await sourceState(setup.source), "moved");
		const refused = await app(setup.source.origin, [{ params: ["while unfinished"], sql: "INSERT INTO owners(name) VALUES (?)" }]);
		assert.equal(refused.status, 500, refused.text);
		assert.match(refused.text, /unfinished copy from Cloudflare/);

		// 7. The next run finishes Orange's copy.
		orangePlan = () => undefined;
		const finished = await move();
		assert.equal(finished.code, 0, finished.output);
		assert.match(finished.output, /Finished the copy of DB on Orange/);
		assert.deepEqual(await dump(setup.orange.origin), before);
		const write = await app(setup.source.origin, [{ params: ["after the move"], sql: "INSERT INTO owners(name) VALUES (?)" }]);
		assert.equal(JSON.parse(write.text)[0].servedBy, "open-orange.db", write.text);
	} finally {
		await cloudflare.close();
		await orange.close();
		await setup.dispose();
	}
});

test("a second run during a move is refused, Ctrl-C opens the freeze, and the next run moves", { timeout: 600_000 }, async () => {
	const options: FakeD1ExportApiOptions = { bytesPerSecond: 200_000, dump: realDump };
	const setup = await setUp(options);
	try {
		const before = await dump(setup.source.origin);
		const first = setup.start();
		await waitFor("the freeze", async () => (await sourceState(setup.source)) === "frozen");
		await waitFor("the import", () => first.output().includes("Exported DB"));

		const second = await setup.move();
		assert.equal(second.code, 1, second.output);
		assert.match(second.output, /Another `orange migrate d1` is moving DB, and holds its write freeze until /);
		assert.doesNotMatch(second.output, /Looks like a bug/);
		assert.equal(await sourceState(setup.source), "frozen");

		first.signal("SIGINT");
		const stopped = await first.exited;
		assert.equal(stopped.code, 130, stopped.output);
		assert.match(stopped.output, /Writes to DB on Cloudflare work again/);
		await assertRefused(setup, { code: 1, output: "Writes to DB on Cloudflare work again" }, /work again/);

		options.bytesPerSecond = undefined;
		const moved = await setup.move();
		assert.equal(moved.code, 0, moved.output);
		assert.deepEqual(await dump(setup.orange.origin), before);
	} finally {
		await setup.dispose();
	}
});

test("import steps that overlap, such as a retry while the first still runs, apply the export once", { timeout: 300_000 }, async () => {
	const setup = await setUp();
	try {
		const before = await dump(setup.source.origin);
		// The steps of `orange migrate d1`, sent to Orange's route as the CLI sends them.
		const step = async (name: string, body: unknown): Promise<any> => {
			const response = await fetch(`${setup.orange.origin}/__migrate-d1/DB/${name}`, { body: JSON.stringify(body), headers: { authorization: `Bearer ${migratorToken}` }, method: "POST" });
			const text = await response.text();
			return { status: response.status, ...JSON.parse(text) };
		};
		const exportApi = `${setup.api.url}/accounts/test-account/d1/database/db/export`;
		const poll = async (body: unknown): Promise<any> => ((await (await fetch(exportApi, { body: JSON.stringify(body), method: "POST" })).json()) as { result: unknown }).result;
		const started = await poll({ output_format: "polling" });
		const exported = await poll({ current_bookmark: started.at_bookmark, output_format: "polling" });
		assert.equal((await step("begin", { export: exported.at_bookmark })).status, 200);
		const importAll = async (): Promise<void> => {
			for (;;) {
				const result = await step("import", { export: exported.at_bookmark, url: exported.result.signed_url });
				assert.equal(result.status, 200, JSON.stringify(result));
				if (result.done === true) return;
			}
		};
		await withDeadline(Promise.all([importAll(), importAll()]), "two overlapping imports", 120_000);

		// A URL of another export does not reach this copy.
		const other = await step("import", { export: "another-export", url: exported.result.signed_url });
		assert.equal(other.status, 409);
		assert.equal(other.error.code, "migrate_d1.export_changed");

		assert.equal((await step("finish", {})).status, 200);
		assert.deepEqual(await dump(setup.orange.origin), before);
	} finally {
		await setup.dispose();
	}
});
