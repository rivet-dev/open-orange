import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, stat } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { basename } from "node:path";

import { dumpAction, DumpError, splitDump } from "../../packages/runtime-node/src/bindings/d1/dump.js";
import { ExpectedFailure } from "../cli/issue-report.js";

// `orange migrate d1 <database> --url <orange>`: moves a D1 database with Cloudflare's export API.
//
//   preflight  Cloudflare reports its schema and reaches Orange. Nothing changes.
//   freeze     Cloudflare: triggers refuse every write, with an error that names the move. Reads work.
//   export     Cloudflare's export API dumps the database exactly (`sqlite3_cli_only`). D1 answers
//              no query until the export ends.
//   import     Orange reads the dump from its signed URL and commits it about 1 MiB at a time. The
//              prepared Worker digests every row of the frozen database meanwhile.
//   verify     Row counts and a SHA-256 per page of rows, Orange against Cloudflare. Schema too.
//   switch     Orange finishes, and Cloudflare forwards every query to Orange.
//
// Writes fail from the freeze until the switch. A failure before the switch opens the freeze again.

export interface MoveD1Io {
	error(message: string): void;
	log(message: string): void;
}

export interface CloudflareApi {
	accountId: string;
	apiToken: string;
	apiUrl: string;
	databaseId: string;
}

export interface MoveD1Options {
	binding: string;
	cloudflare: CloudflareApi;
	cloudflareUrl: string;
	orangeUrl: string;
	replace: boolean;
	token: string;
}

export class StepError extends Error {
	constructor(
		readonly side: string,
		readonly step: string,
		readonly status: number,
		readonly code: string,
		message: string,
	) {
		super(message);
	}
}

// The freeze outlives the export, which can't extend it: D1 answers no query then.
const leaseBaseSeconds = 300;
// Measured on a 1.04 GB database in the `sqlite3_cli_only` format: 46.5 s.
const exportSecondsPerGb = 47;
const leaseSecondsPerGb = 180;
// RivetKit commits at most this much at a time, and Orange builds each index in one commit.
const maxCommitBytes = 128 * 1024 * 1024;
const heartbeatMs = 30_000;
const maxStepAttempts = 8;
const maxExports = 3;
// About this much digest text per page. A page is one D1 query and one round trip, and on a 1 GB
// database 8 MB pages took 77 seconds where 4 MB pages took 99.
const digestPageBytes = 8_000_000;
const digestPagesPerCheck = 20;

async function post(side: string, base: string, binding: string, step: string, token: string, body: unknown): Promise<any> {
	const url = new URL(`/__migrate-d1/${encodeURIComponent(binding)}/${step}`, base);
	let response: Response;
	try {
		response = await fetch(url, {
			body: JSON.stringify(body),
			headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
			method: "POST",
		});
	} catch (error: unknown) {
		throw new StepError(side, step, 0, "network", `Couldn't reach ${side} at ${base}: ${error instanceof Error ? error.message : String(error)}`);
	}
	const text = await response.text();
	let parsed: any;
	try {
		parsed = JSON.parse(text);
	} catch {
		const hint = response.status === 404 ? ` Is ${base} the ${side} Worker, with the migration turned on?` : "";
		const title = /<title>([^<]*)<\/title>/i.exec(text)?.[1]?.replace(/\s+/g, " ").trim();
		throw new StepError(side, step, response.status, "not_json", `${side} answered ${response.status} to ${step}.${hint} ${title === undefined ? text.slice(0, 200) : `It sent an error page: ${title}`}`);
	}
	if (!response.ok) {
		throw new StepError(side, step, response.status, parsed?.error?.code ?? "failed", parsed?.error?.message ?? text.slice(0, 300));
	}
	return parsed;
}

// Refusals that the move expects, such as data on Orange or a schema change during the move. They
// are not bugs, so the CLI offers no bug report for them.
const expectedCodes: ReadonlySet<string> = new Set([
	"export_failed",
	"migrate_d1.busy",
	"migrate_d1.export_unsupported",
	"migrate_d1.freeze_lost",
	"migrate_d1.moved",
	"migrate_d1.not_configured",
	"migrate_d1.not_empty",
	"migrate_d1.schema_changed",
	"migrate_d1.unauthorized",
	"migrate_d1.unknown_binding",
	"migrate_d1.unknown_op",
	"migrate_d1.virtual_tables",
	"network",
	"not_json",
]);

/** `error` as an ExpectedFailure when the move expects it, such as Cloudflare's API refusing a token. */
export function asExpectedFailure(error: unknown): unknown {
	if (!(error instanceof StepError)) return error;
	const refusedByApi = error.code === "cloudflare_api" && (error.status === 401 || error.status === 403 || error.status === 404);
	return expectedCodes.has(error.code) || refusedByApi ? new ExpectedFailure(error.message) : error;
}

// A network error, a gateway error, a busy Engine, or a database that restarts. A rerun of the step
// is safe: every step goes on from what the server holds.
function transient(error: unknown): boolean {
	if (!(error instanceof StepError)) return false;
	// Another step moved Orange's copy on meanwhile. The next step reads from where it ends.
	if (error.code === "network" || error.code === "migrate_d1.storage_busy" || error.code === "migrate_d1.offset_mismatch" || error.status === 0 || error.status >= 502) return true;
	return /deadline|unavailable|durab|overloaded|fetch failed|Network connection lost|long-running export|restart/i.test(error.message);
}

// D1 answers no query while an export runs, for about 47 s per GB.
function duringExport(error: unknown): boolean {
	return error instanceof StepError && /long-running export/i.test(error.message);
}

// How long a step waits for an export to end. Longer than an export of D1's largest database.
const exportWaitMs = 15 * 60_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function megabytes(bytes: number): string {
	return `${(bytes / 1e6).toFixed(1)} MB`;
}

function seconds(ms: number): string {
	return `${(ms / 1000).toFixed(1)} s`;
}

// --- Cloudflare's API ---------------------------------------------------------------------------------

async function cloudflareApi(api: CloudflareApi, path: string, init?: { body: unknown; method: string }): Promise<any> {
	const url = `${api.apiUrl}/accounts/${api.accountId}/d1/database/${api.databaseId}${path}`;
	let response: Response;
	try {
		response = await fetch(url, {
			...(init === undefined ? {} : { body: JSON.stringify(init.body), method: init.method }),
			headers: { authorization: `Bearer ${api.apiToken}`, "content-type": "application/json" },
		});
	} catch (error: unknown) {
		throw new StepError("Cloudflare's API", path, 0, "network", `Couldn't reach Cloudflare's API: ${error instanceof Error ? error.message : String(error)}`);
	}
	const body: any = await response.json().catch(() => undefined);
	if (!response.ok || body?.success === false) {
		const reason = body?.errors?.[0]?.message ?? `HTTP ${response.status}`;
		const hint = response.status === 401 || response.status === 403 ? " Check CLOUDFLARE_API_TOKEN: it needs D1 edit permission." : response.status === 404 ? " Check CLOUDFLARE_ACCOUNT_ID and the database_id in the Wrangler config." : "";
		throw new StepError("Cloudflare's API", path, response.status, "cloudflare_api", `Cloudflare's API refused ${init?.method ?? "GET"} ${path || "database"}: ${reason}.${hint}`);
	}
	return body.result;
}

interface Export {
	bookmark: string;
	ms: number;
	url: string;
}

// Starts an export and polls it every second until it ends. An export that nobody polls is cancelled.
async function exportDatabase(api: CloudflareApi, io: MoveD1Io): Promise<Export> {
	const started = Date.now();
	let bookmark: string | undefined;
	let lastNote = started;
	for (let failures = 0; ; ) {
		let result: any;
		try {
			result = await cloudflareApi(api, "/export", {
				body: {
					// The default format writes every number as a JS double. This one writes them exactly.
					dump_options: { compatibility: "sqlite3_cli_only" },
					output_format: "polling",
					...(bookmark === undefined ? {} : { current_bookmark: bookmark }),
				},
				method: "POST",
			});
		} catch (error: unknown) {
			// A poll that fails on the network or on Cloudflare's side asks again. The export goes on.
			const retry = error instanceof StepError && (error.status === 0 || error.status === 429 || error.status >= 500);
			failures += 1;
			if (!retry || failures === maxStepAttempts) throw error;
			io.error(`Polling the export failed (${error.message}). Trying again.`);
			await sleep(Math.min(10_000, 500 * 2 ** (failures - 1)));
			continue;
		}
		failures = 0;
		bookmark = result?.at_bookmark ?? bookmark;
		if (result?.status === "error" || result?.success === false) {
			throw new StepError("Cloudflare's API", "export", 0, "export_failed", `Cloudflare's export failed: ${result?.error ?? "no reason given"}`);
		}
		const url = result?.result?.signed_url;
		if (result?.status === "complete" && typeof url === "string" && bookmark !== undefined) return { bookmark, ms: Date.now() - started, url };
		if (Date.now() - lastNote > 15_000) {
			io.log(`  Still exporting after ${seconds(Date.now() - started)}.`);
			lastNote = Date.now();
		}
		await sleep(1_000);
	}
}

// --- The move -----------------------------------------------------------------------------------------

interface SchemaObject {
	name: string;
	sql: string;
	tableName: string;
	type: string;
}

interface SourceSchema {
	bytes: number;
	hash: string;
	objects: SchemaObject[];
	tables: { name: string; virtual: boolean }[];
}

interface DigestPage {
	count: number;
	digest: string;
}

export async function moveD1(options: MoveD1Options, io: MoveD1Io): Promise<number> {
	const { binding, cloudflareUrl, orangeUrl, token } = options;
	const started = Date.now();
	const cloudflare = (step: string, body: unknown = {}): Promise<any> => post("Cloudflare", cloudflareUrl, binding, step, token, body);
	const orange = (step: string, body: unknown = {}): Promise<any> => post("Orange", orangeUrl, binding, step, token, body);
	const retrying = async <Result>(label: string, run: () => Promise<Result>): Promise<Result> => {
		let exportSince: number | undefined;
		for (let attempt = 1; ; ) {
			try {
				return await run();
			} catch (error: unknown) {
				// A step that meets an export waits for it to end, such as a digest during a second export.
				if (duringExport(error) && Date.now() - (exportSince ??= Date.now()) < exportWaitMs) {
					await sleep(2_000);
					continue;
				}
				if (!transient(error) || attempt === maxStepAttempts) throw error;
				const pause = Math.min(10_000, 500 * 2 ** (attempt - 1));
				io.error(`${label} failed (${error instanceof Error ? error.message : String(error)}). Trying again in ${pause / 1000} s.`);
				await sleep(pause);
				attempt += 1;
			}
		}
	};
	const finishOrange = async (): Promise<void> => {
		try {
			await retrying("Finishing the copy on Orange", () => orange("finish"));
		} catch (error: unknown) {
			throw new Error(
				`Cloudflare sends every query for ${binding} to Orange, but Orange's copy did not finish (${error instanceof Error ? error.message : String(error)}). Queries fail until it does. Run this command again to finish it.`,
			);
		}
	};

	// 1. Preflight. Nothing changes, so its reads retry like every later step.
	const state = await retrying("Reading the move's state on Cloudflare", () => cloudflare("state"));
	if (state.state === "moved") {
		// A run that switched Cloudflare and stopped before Orange finished. The copy is checked and whole.
		const target = await retrying("Reading Orange's status", () => orange("status"));
		if (target.state === "importing") {
			await finishOrange();
			io.log(`✓ Finished the copy of ${binding} on Orange. Cloudflare sends every query for it to ${state.url}.`);
			return 0;
		}
		io.log(`${binding} has already moved to ${state.url}. Cloudflare sends every query for it there.`);
		return 0;
	}
	if (state.state === "frozen") {
		throw new ExpectedFailure(
			`Another \`orange migrate d1\` is moving ${binding}, and holds its write freeze until ${new Date(state.until * 1000).toISOString()}. Wait for it to end. If it was killed, its freeze opens by itself then. Nothing changed.`,
		);
	}
	const schema: SourceSchema = await retrying("Reading Cloudflare's schema", () => cloudflare("schema"));
	const virtual = schema.tables.filter((table) => table.virtual).map((table) => table.name);
	if (virtual.length > 0) {
		throw new ExpectedFailure(`D1's export can't include virtual tables: ${virtual.join(", ")}. Drop them on Cloudflare, move the database, and create them again on Orange. Nothing changed.`);
	}
	const target = await retrying("Reading Orange's status", () => orange("status"));
	if (target.state === "none" && target.objects > 0 && !options.replace) {
		throw new ExpectedFailure(`${binding} already has ${target.objects} tables, indexes, views, or triggers on Orange, so Orange won't overwrite them. Pass --replace to replace them. Nothing changed.`);
	}
	const reach = await cloudflare("probe", { url: orangeUrl });
	if (!reach.ok) {
		throw new ExpectedFailure(`Cloudflare can't reach Orange at ${orangeUrl} (${reach.error ?? `HTTP ${reach.status}`}), and after the move every query goes there. Check the URL. Nothing changed.`);
	}
	const database = await cloudflareApi(options.cloudflare, "");
	const size = Number(database?.file_size ?? schema.bytes);
	// No index of a smaller database can be larger than one commit.
	const risks: { indexes: { bytes: number; name: string; table: string }[]; rowids: { max: number; rows: number; table: string }[] } = await cloudflare("preflight", { indexes: size > maxCommitBytes });
	const large = risks.indexes.filter((index) => index.bytes > maxCommitBytes);
	if (large.length > 0) {
		throw new ExpectedFailure(
			`Orange builds each index in one commit of at most 128 MiB, and these indexes may be larger: ${large.map((index) => `${index.name} on ${index.table} (about ${megabytes(index.bytes)})`).join(", ")}. Drop them on Cloudflare before the move. Nothing changed.`,
		);
	}
	for (const table of risks.rowids) {
		io.error(
			`! ${table.table} has rowids up to ${table.max} in ${table.rows} rows. D1's export numbers them again from 1, so a rowid that your app stored points at another row on Orange. If it stores them, give the table an INTEGER PRIMARY KEY before the move.`,
		);
	}
	const leaseSeconds = leaseBaseSeconds + Math.ceil((size / 1e9) * leaseSecondsPerGb);
	io.log(`${binding} is ${megabytes(size)} on Cloudflare, in ${schema.tables.length} tables. Writes fail from now until the switch, and reads fail during the export (about ${exportSecondsPerGb} s per GB).`);

	// 2. Freeze.
	const frozen: { freeze: string; hash: string; tables: string[]; until: number } = await cloudflare("freeze", { leaseSeconds });
	const frozenAt = Date.now();
	io.log(`Froze writes on Cloudflare. If this command stops, they resume after ${Math.round(leaseSeconds / 60)} minutes at most.`);
	let leaseLost: Error | undefined;
	const extend = async (): Promise<void> => {
		try {
			await cloudflare("extend", { freeze: frozen.freeze, leaseSeconds });
		} catch (error: unknown) {
			if (error instanceof StepError && error.code === "migrate_d1.freeze_lost") leaseLost = error;
			// Any other failure is D1 during the export, or the network. The lease still runs.
		}
	};
	const heartbeat = setInterval(() => void extend(), heartbeatMs);
	// Set once Cloudflare forwards every query to Orange. From then on, the freeze must stay.
	let switched = false;
	let unfreezing: Promise<void> | undefined;
	// D1 refuses the unfreeze during an export too, so it tries until the export ends.
	const unfreeze = (): Promise<void> =>
		(unfreezing ??= (async () => {
			clearInterval(heartbeat);
			let told = false;
			try {
				const opened = await retrying("Opening the freeze on Cloudflare", async () => {
					try {
						return await cloudflare("unfreeze", { freeze: frozen.freeze });
					} catch (error: unknown) {
						if (duringExport(error) && !told) {
							told = true;
							io.error(`Waiting for Cloudflare's export to end, to open the freeze. Press Ctrl-C again to stop now: writes then resume when the lease runs out, in ${Math.round(leaseSeconds / 60)} minutes at most.`);
						}
						throw error;
					}
				});
				if (opened.unfrozen) io.error(`Writes to ${binding} on Cloudflare work again. Run this command again to move it.`);
				else if (opened.state === "moved") io.error(`Cloudflare sends every query for ${binding} to Orange. Run this command again to finish the move.`);
			} catch (error: unknown) {
				io.error(`Couldn't open the freeze on Cloudflare (${error instanceof Error ? error.message : String(error)}). Writes resume when its lease runs out, in ${Math.round(leaseSeconds / 60)} minutes at most.`);
			}
		})());
	const onSignal = (): void => {
		if (switched) process.exit(130);
		void unfreeze().finally(() => process.exit(130));
	};
	process.once("SIGINT", onSignal);
	process.once("SIGTERM", onSignal);
	try {
		// 3. Export.
		let exported = await exportDatabase(options.cloudflare, io);
		io.log(`Exported ${binding} in ${seconds(exported.ms)}.`);
		await extend();

		// 4. Import, and digest Cloudflare's rows meanwhile: every table that the freeze covers.
		await retrying("Starting the copy on Orange", () => orange("begin", { export: exported.bookmark, replace: options.replace }));
		const importStarted = Date.now();
		const digests = digestTables(frozen.tables, (body) => retrying("A digest of Cloudflare's rows", () => cloudflare("digest", body)));
		// A digest that fails waits for the import to end, so the freeze opens only once.
		digests.catch(() => undefined);
		let exports = 1;
		let last = Date.now();
		let stalled = 0;
		let reached = -1;
		for (;;) {
			let step: any;
			try {
				step = await retrying("An import step", () => orange("import", { export: exported.bookmark, url: exported.url }));
			} catch (error: unknown) {
				if (!(error instanceof StepError) || error.code !== "migrate_d1.export_expired" || exports === maxExports) throw error;
				// Each export has a new bookmark, because the lease's heartbeat writes, so Orange starts its copy again.
				io.log(`The export's URL stopped working (${error.message}). Exporting again, and copying from the start.`);
				exported = await exportDatabase(options.cloudflare, io);
				exports += 1;
				await retrying("Starting the copy on Orange", () => orange("begin", { export: exported.bookmark, replace: options.replace }));
				continue;
			}
			// A step that ends early, such as on a broken connection, still moves on. One that keeps
			// moving nothing can't finish.
			stalled = step.offset > reached ? 0 : stalled + 1;
			reached = step.offset;
			if (stalled === maxStepAttempts) throw new Error(`The import stopped at byte ${step.offset} of ${step.size}${step.interrupted === undefined ? "" : `: ${step.interrupted}`}.`);
			if (Date.now() - last > 5_000 || step.done) {
				io.log(`Imported ${megabytes(step.offset)} of ${megabytes(step.size)}, ${step.statements} statements.`);
				last = Date.now();
			}
			if (step.done) break;
		}
		const importMs = Date.now() - importStarted;
		const pages = await digests;

		// 5. Verify. A copy that fails a check is dropped, so the next run copies again.
		const verifyStarted = Date.now();
		const refuse = async (message: string): Promise<never> => {
			await orange("discard").catch(() => undefined);
			throw new ExpectedFailure(message);
		};
		const after: SourceSchema = await retrying("Reading Cloudflare's schema", () => cloudflare("schema"));
		if (after.hash !== frozen.hash) {
			await refuse(`${binding}'s schema changed on Cloudflare during the move, so Orange's copy is out of date. Stop schema changes, then run this command again.`);
		}
		const status = await orange("status");
		if (status.frozen !== true) await refuse("The export holds no sign of the write freeze, so it may be older than the freeze. Run this command again.");
		const orangeObjects: SchemaObject[] = (await retrying("Reading Orange's schema", () => orange("schema"))).objects;
		const describe = (object: SchemaObject): string => `${object.type} ${object.name} ON ${object.tableName}: ${object.sql}`;
		const expected = new Set(after.objects.map(describe));
		const found = new Set(orangeObjects.map(describe));
		const missing = [...expected].filter((object) => !found.has(object));
		const extra = [...found].filter((object) => !expected.has(object));
		if (missing.length > 0 || extra.length > 0) {
			await refuse(`Orange's schema for ${binding} differs from Cloudflare's. Missing on Orange: ${missing.join("; ") || "none"}. Only on Orange: ${extra.join("; ") || "none"}.`);
		}
		let rows = 0;
		for (const [table, tablePages] of pages) {
			let cursor: string | null = null;
			let checkedRows = 0;
			for (let start = 0; start === 0 || start < tablePages.length; start += digestPagesPerCheck) {
				const batch = tablePages.slice(start, start + digestPagesPerCheck);
				const isLast = start + digestPagesPerCheck >= tablePages.length;
				const result: any = await retrying("Checking Orange's rows", () => orange("digest", { after: cursor, last: isLast, pages: batch, table }));
				if (result.mismatch !== undefined) {
					const from = checkedRows + result.mismatch.rows;
					await refuse(
						`Orange's copy of ${table} differs from Cloudflare's in rows ${from + 1} to ${from + result.mismatch.expected} (in key order): ${result.mismatch.count === result.mismatch.expected ? "a value differs" : `Orange has ${result.mismatch.count} rows there`}. Nothing moved.`,
					);
				}
				if (result.extra === true) await refuse(`Orange's copy of ${table} has more rows than Cloudflare's. Nothing moved.`);
				checkedRows += result.rows;
				cursor = result.after ?? cursor;
			}
			rows += checkedRows;
		}
		io.log(`Checked ${rows} rows in ${pages.size} tables, value for value, in ${seconds(Date.now() - verifyStarted)}: Orange equals Cloudflare.`);

		// 6. Switch Cloudflare first, then finish Orange. Between the two, a forwarded query fails on
		// Orange's unfinished copy, and no side takes a write that the other misses. The switch holds
		// only while the lease runs and the schema is as the freeze left it.
		await extend();
		if (leaseLost !== undefined) throw leaseLost;
		await retrying("Switching Cloudflare to Orange", () => cloudflare("moved", { freeze: frozen.freeze, url: orangeUrl }));
		switched = true;
		clearInterval(heartbeat);
		await finishOrange();
		io.log(`✓ Moved ${binding} in ${seconds(Date.now() - started)}: export ${seconds(exported.ms)}, import ${seconds(importMs)}. Writes were frozen for ${seconds(Date.now() - frozenAt)}.`);
		io.log(`Cloudflare now sends every query for ${binding} to Orange. Move your traffic when ready.`);
		return 0;
	} catch (error: unknown) {
		if (!switched) await unfreeze();
		throw error;
	} finally {
		clearInterval(heartbeat);
		process.off("SIGINT", onSignal);
		process.off("SIGTERM", onSignal);
	}
}

// Pages of each table's rows, as Cloudflare digests them, in key order. Pages grow or shrink so each
// holds about `digestPageBytes` of text.
async function digestTables(tables: readonly string[], digest: (body: unknown) => Promise<any>): Promise<Map<string, DigestPage[]>> {
	const out = new Map<string, DigestPage[]>();
	for (const table of tables) {
		const pages: DigestPage[] = [];
		let after: unknown = null;
		let limit = 1_000;
		for (;;) {
			const page = await digest({ after, limit, table });
			pages.push({ count: page.count, digest: page.digest });
			if (page.count < limit) break;
			after = page.last;
			limit = Math.max(100, Math.min(50_000, Math.round((limit * digestPageBytes) / Math.max(1, page.bytes))));
		}
		out.set(table, pages);
	}
	return out;
}

// --- An export file -------------------------------------------------------------------------------

// Serves one file over HTTP with byte ranges, so Orange reads it the way it reads a signed URL.
async function serveFile(path: string): Promise<{ close(): Promise<void>; url: string }> {
	const server = createServer((request, response) => {
		void (async () => {
			const { size } = await stat(path);
			const range = /^bytes=(\d+)-$/.exec(request.headers.range ?? "");
			const start = range === null ? 0 : Number(range[1]);
			response.writeHead(range === null ? 200 : 206, {
				"accept-ranges": "bytes",
				"content-length": String(size - start),
				...(range === null ? {} : { "content-range": `bytes ${start}-${size - 1}/${size}` }),
			});
			createReadStream(path, { start }).pipe(response);
		})().catch(() => response.destroy());
	});
	await new Promise<void>((listening) => server.listen(0, "127.0.0.1", listening));
	const { port } = server.address() as AddressInfo;
	return {
		close: () => new Promise((closed) => server.close(() => closed())),
		url: `http://127.0.0.1:${port}/${encodeURIComponent(basename(path))}`,
	};
}

function unquoteName(text: string): string {
	const first = text[0];
	if (first === '"' || first === "'" || first === "`") return text.slice(1, -1).replaceAll(`${first}${first}`, first);
	if (first === "[") return text.slice(1, -1);
	return text;
}

/**
 * The columns of a CREATE TABLE that keep each value's type as it arrives: no declared type, a BLOB
 * type, or ANY in a STRICT table. Other columns convert an integer to their own type. Generated
 * columns are left out, as a dump does not write them.
 * https://www.sqlite.org/datatype3.html#determination_of_column_affinity
 */
export function columnsThatKeepTypes(sql: string): string[] {
	const open = sql.indexOf("(");
	if (open === -1) return [];
	const parts: string[] = [];
	let depth = 0;
	let start = open + 1;
	let close = -1;
	for (let index = open; index < sql.length && close === -1; index += 1) {
		const char = sql[index]!;
		const quote = char === "[" ? "]" : char === '"' || char === "'" || char === "`" ? char : undefined;
		if (quote !== undefined) {
			const end = sql.indexOf(quote, index + 1);
			index = end === -1 ? sql.length : end;
		} else if (char === "(") depth += 1;
		else if (char === ")") {
			depth -= 1;
			if (depth === 0) close = index;
		} else if (char === "," && depth === 1) {
			parts.push(sql.slice(start, index));
			start = index + 1;
		}
	}
	if (close === -1) return [];
	parts.push(sql.slice(start, close));
	const strict = /\bSTRICT\b/i.test(sql.slice(close + 1));
	const columns: string[] = [];
	for (const part of parts) {
		const definition = part.trim();
		if (/^(?:CONSTRAINT|PRIMARY|UNIQUE|CHECK|FOREIGN)\b/i.test(definition)) continue;
		const match = /^("(?:[^"]|"")*"|`[^`]*`|\[[^\]]*\]|'(?:[^']|'')*'|\S+)\s*([^]*)$/.exec(definition);
		if (match === null) continue;
		const rest = match[2]!;
		if (/\bAS\s*\(/i.test(rest)) continue;
		const type = (rest.split(/\b(?:CONSTRAINT|PRIMARY|NOT|NULL|UNIQUE|CHECK|DEFAULT|COLLATE|REFERENCES|GENERATED)\b/i)[0] ?? "").trim().toUpperCase();
		const keeps = strict ? type === "ANY" : !/INT|CHAR|CLOB|TEXT/.test(type) && (type === "" || type.includes("BLOB"));
		if (keeps) columns.push(unquoteName(match[1]!));
	}
	return columns;
}

// The top-level, comma-separated items of each parenthesized list in `text`, such as a column list
// or a row of VALUES.
function parenthesizedLists(text: string): string[][] {
	const lists: string[][] = [];
	let items: string[] = [];
	let depth = 0;
	let start = 0;
	for (let index = 0; index < text.length; index += 1) {
		const char = text[index]!;
		const quote = char === "[" ? "]" : char === '"' || char === "'" || char === "`" ? char : undefined;
		if (quote !== undefined) {
			const end = text.indexOf(quote, index + 1);
			index = end === -1 ? text.length : end;
		} else if (char === "(") {
			depth += 1;
			if (depth === 1) {
				items = [];
				start = index + 1;
			}
		} else if (char === ")") {
			depth -= 1;
			if (depth === 0) {
				items.push(text.slice(start, index).trim());
				lists.push(items);
			}
		} else if (char === "," && depth === 1) {
			items.push(text.slice(start, index).trim());
			start = index + 1;
		}
	}
	return lists;
}

const insertInto = /^INSERT\s+INTO\s+("(?:[^"]|"")*"|`[^`]*`|\[[^\]]*\]|[^\s(]+)\s*\(([^)]*)\)\s*VALUES\s*([^]*)$/i;

const createTable = /^CREATE\s+(?:TEMP\s+|TEMPORARY\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?("(?:[^"]|"")*"|`[^`]*`|\[[^\]]*\]|'(?:[^']|'')*'|[^\s(]+)/i;

// Reads the whole export the way the import does, so a statement the import would refuse stops the
// copy before Orange changes. Returns the export's SHA-256, and the `table.column` names that keep
// any type and get an integer, which D1's default format may have written for a REAL.
async function checkExport(path: string, checkIntegers: boolean): Promise<{ keepTypes: string[]; sha256: string }> {
	const hash = createHash("sha256");
	const keepTypes = new Map<string, Set<string>>();
	const integers = new Set<string>();
	let buffer: Buffer = Buffer.alloc(0);
	const check = (final: boolean): void => {
		const split = splitDump(buffer, final);
		try {
			for (const statement of split.statements) {
				dumpAction(statement.sql, checkIntegers);
				const table = createTable.exec(statement.sql);
				if (table !== null) keepTypes.set(unquoteName(table[1]!), new Set(columnsThatKeepTypes(statement.sql)));
				const insert = insertInto.exec(statement.sql);
				const kept = insert === null ? undefined : keepTypes.get(unquoteName(insert[1]!));
				if (insert !== null && kept !== undefined && kept.size > 0) {
					const names = insert[2]!.split(",").map((name) => unquoteName(name.trim()));
					for (const row of parenthesizedLists(insert[3]!)) {
						for (const [index, value] of row.entries()) {
							const name = names[index];
							if (name !== undefined && kept.has(name) && /^-?\d+$/.test(value)) integers.add(`${unquoteName(insert[1]!)}.${name}`);
						}
					}
				}
			}
		} catch (error: unknown) {
			if (error instanceof DumpError) throw new ExpectedFailure(`${error.message} Orange was not changed.`);
			throw error;
		}
		buffer = buffer.subarray(split.rest);
	};
	for await (const chunk of createReadStream(path)) {
		hash.update(chunk as Buffer);
		buffer = buffer.length === 0 ? (chunk as Buffer) : Buffer.concat([buffer, chunk as Buffer]);
		check(false);
	}
	check(true);
	return { keepTypes: [...integers], sha256: hash.digest("hex") };
}

/**
 * `--file`: copies an export into Orange's database with the same import as a move, so it resumes
 * where it stopped. Only an export in `sqlite3_cli_only` form holds integers past 2^53 exactly, so
 * the import refuses such an integer in any other export. D1's default format also writes a REAL
 * with no fraction, such as 2.0, as an integer, so it is refused while a column keeps any type,
 * unless `allowRealAsInteger`. Nothing on Cloudflare changes.
 */
export async function copyD1Export(
	binding: string,
	path: string,
	replace: boolean,
	allowRealAsInteger: boolean,
	withOrange: <Result>(operation: (origin: string) => Promise<Result>, vars: Record<string, string>) => Promise<Result>,
	io: MoveD1Io,
): Promise<number> {
	const { size } = await stat(path);
	const head = await readHead(path);
	// The `sqlite3` shell's dump, which `sqlite3_cli_only` matches, wraps itself in one transaction.
	const exact = /^(?:\/\*[^]*?\*\/\s*)?PRAGMA foreign_keys=OFF;\s*BEGIN TRANSACTION;/.test(head);
	// D1's default format, as `wrangler d1 export` writes it, starts so.
	const defaultFormat = /^(?:\/\*[^]*?\*\/\s*)?PRAGMA defer_foreign_keys=TRUE;/i.test(head);
	const checked = await checkExport(path, !exact);
	if (defaultFormat && checked.keepTypes.length > 0 && !allowRealAsInteger) {
		throw new ExpectedFailure(
			`The export is in D1's default format, which writes a REAL with no fraction, such as 2.0, as the integer 2. These columns get integers, and keep each as an INTEGER even where it was a REAL: ${checked.keepTypes.join(", ")}. Export in the sqlite3_cli_only format, or move with \`orange migrate d1 --url\`, which exports exactly. Or pass --allow-real-as-integer to copy it with that change. Orange was not changed.`,
		);
	}
	const exportId = `file:${size}:${checked.sha256}`;
	const token = randomUUID();
	const file = await serveFile(path);
	try {
		// The import route answers only while a migration is on, so the runtime gets both settings.
		return await withOrange(
			async (origin) => {
				const orange = (step: string, body: unknown = {}): Promise<any> => post("Orange", origin, "DB", step, token, body);
				await orange("begin", { export: exportId, replace });
				for (;;) {
					const step = await orange("import", { checkIntegers: !exact, export: exportId, url: file.url });
					if (step.done) {
						const finished = await orange("finish");
						io.log(`✓ Copied ${binding}: ${finished.statements} statements, ${megabytes(size)}.`);
						return 0;
					}
					io.log(`Imported ${megabytes(step.offset)} of ${megabytes(step.size)}.`);
				}
			},
			{ ORANGE_MIGRATE_WORKER_URL: "http://unused.invalid", WORKER_MIGRATOR_TOKEN: token },
		);
	} finally {
		await file.close();
	}
}

async function readHead(path: string): Promise<string> {
	const handle = await open(path);
	try {
		const buffer = Buffer.alloc(512);
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
		return buffer.subarray(0, bytesRead).toString("utf8");
	} finally {
		await handle.close();
	}
}
