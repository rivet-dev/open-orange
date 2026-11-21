import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

import type { DurableObjectTurnDatabase } from "../durable-objects/gates.js";
import { type RivetSynchronousSqliteExecutor, SqliteBusyTimeoutError } from "../../internal/rivetkit.js";

// The D1 actor's side of `orange migrate d1`: it takes a D1 export statement by statement, in small
// commits that each record how far into the export they reach, so a copy resumes at that byte after a
// restart. Until `finish`, the app's queries fail, so the app never sees a partial copy. The route
// in `migration-route.ts` reads the export and sends the statements here.

const importTable = "_rivet_d1_import";
const longStatementTimeoutMs = 3_600_000;

/**
 * The Engine refused or could not finish this database's writes in time. RivetKit then restarts the
 * D1 actor from its last durable state, so a step can resume from what is durable.
 */
export const isStorageBusy = (error: unknown): boolean =>
	error instanceof SqliteBusyTimeoutError ||
	/durability_failed|resetting to its last durable state|storage is overloaded|write_refused|flush retry deadline/i.test(errorMessageOf(error));

const errorMessageOf = (error: unknown): string => (error instanceof Error ? `${error.message} ${String(error.cause ?? "")}` : String(error));

export class D1ImportError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		message: string,
	) {
		super(message);
	}
}

interface ImportState {
	// Which export this copy comes from: Cloudflare's bookmark, or a file's size and hash.
	export: string;
	// Bytes of the export applied, and its size once a read has seen it.
	offset: number;
	size: number | null;
	statements: number;
	// The export holds the freeze's state row, so it was made while writes were frozen.
	frozen: boolean;
}

export interface ImportStatement {
	kind: "index" | "run" | "sequence";
	sql: string;
}

const userObjectFilter = `name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' AND name NOT LIKE '\\_rivet\\_%' ESCAPE '\\' AND name NOT LIKE '\\_orange\\_d1\\_%' ESCAPE '\\'`;

function quote(name: string): string {
	return `"${name.replaceAll('"', '""')}"`;
}

// --- The digest, as the prepared Worker computes it (`digestRow` in d1-cloudflare-worker.js) ---------

interface DigestTable {
	columns: { name: string; pk: number }[];
	name: string;
	withoutRowid: boolean;
}

function rowidName(table: DigestTable): string {
	const names = new Set(table.columns.map((column) => column.name.toLowerCase()));
	const free = ["rowid", "_rowid_", "oid"].find((name) => !names.has(name));
	if (free === undefined) throw new D1ImportError(422, "migrate_d1.no_rowid", `table ${table.name} names columns rowid, _rowid_, and oid`);
	return free;
}

function keyColumns(table: DigestTable): string[] {
	if (!table.withoutRowid) return [rowidName(table)];
	return table.columns
		.filter((column) => column.pk > 0)
		.sort((left, right) => left.pk - right.pk)
		.map((column) => quote(column.name));
}

// A REAL comes back as the double itself: SQLite 3.46 prints some doubles with digits that read back
// as another double. The prepared Worker's newer SQLite prints them exactly. An infinity comes back
// as text, as the Worker's printf writes it.
function exact(column: string): string {
	return `CASE typeof(${column}) WHEN 'integer' THEN CAST(${column} AS TEXT) WHEN 'real' THEN CASE ${column} WHEN 9e999 THEN 'Inf' WHEN -9e999 THEN '-Inf' ELSE ${column} END WHEN 'text' THEN hex(${column}) WHEN 'blob' THEN hex(${column}) END`;
}

// A key value as a tagged text, and back, so a key past 2^53 survives the round trip to the CLI. A
// REAL key goes as its 8 bytes and comes back as a bound double: SQLite 3.46 reads some 17-digit
// texts one bit off, so `printf` and `CAST` could move a page's start past a row, or before one.
function tag(column: string): string {
	return `CASE typeof(${column}) WHEN 'integer' THEN 'i' || ${column} WHEN 'real' THEN 'r' || printf('%!.17g', ${column}) WHEN 'text' THEN 't' || hex(${column}) WHEN 'blob' THEN 'b' || hex(${column}) END`;
}

function untag(expression: string): string {
	const body = `substr(${expression}, 2)`;
	return `CASE substr(${expression}, 1, 1) WHEN 'i' THEN CAST(${body} AS INTEGER) WHEN 't' THEN CAST(unhex(${body}) AS TEXT) WHEN 'b' THEN unhex(${body}) END`;
}

function realFromBits(hex: string): number {
	return Buffer.from(hex, "hex").readDoubleBE(0);
}

function realBits(real: unknown): string {
	const value = real === "Inf" ? Number.POSITIVE_INFINITY : real === "-Inf" ? Number.NEGATIVE_INFINITY : Number(real);
	const bytes = Buffer.alloc(8);
	bytes.writeDoubleBE(value);
	return bytes.toString("hex");
}

function digestRow(types: string, values: unknown[]): string {
	let row = "";
	for (let index = 0; index < types.length; index += 1) {
		const type = types[index]!;
		if (index > 0) row += ",";
		row += type === "r" ? `r${realBits(values[index])}` : type === "n" ? "n" : `${type}${String(values[index])}`;
	}
	return row;
}

export interface DigestPage {
	count: number;
	digest: string;
}

export class D1Import {
	readonly #database: () => DurableObjectTurnDatabase;
	// Loaded on first use. `null` means no copy is in progress.
	#state: ImportState | null | undefined;
	// The write in progress. A write reads the state that the one before it left, also while that one
	// waits to be durable.
	#writing: Promise<unknown> = Promise.resolve();

	constructor(database: () => DurableObjectTurnDatabase) {
		this.#database = database;
	}

	#serial(write: () => Promise<unknown>): Promise<unknown> {
		const next = this.#writing.catch(() => undefined).then(write);
		this.#writing = next;
		return next;
	}

	/** True while a copy has started and not finished. App queries must not run then. */
	unfinished(): boolean {
		return this.#load() !== null;
	}

	#load(): ImportState | null {
		if (this.#state !== undefined) return this.#state;
		const database = this.#database();
		const exists = database.executeSync(`SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = '${importTable}'`).rows.length > 0;
		if (!exists) {
			this.#state = null;
			return null;
		}
		const row = database.executeSync(`SELECT state FROM ${importTable} WHERE id = 1`).rows[0];
		this.#state = row === undefined ? null : (JSON.parse(String(row[0])) as ImportState);
		return this.#state;
	}

	#require(): ImportState {
		const state = this.#load();
		if (state === null) throw new D1ImportError(409, "migrate_d1.not_started", "No copy from Cloudflare has started for this database. Run begin first.");
		return state;
	}

	#userObjects(): { name: string; sql: string; tableName: string; type: string }[] {
		return this.#database()
			.executeSync(`SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE ${userObjectFilter} AND sql IS NOT NULL ORDER BY type, name`)
			.rows.map(([type, name, tableName, sql]) => ({ name: String(name), sql: String(sql), tableName: String(tableName), type: String(type) }));
	}

	// Runs `write` in its own transaction and waits until it is durable, so a failed step loses at
	// most the transaction it was in. Foreign keys are off: rows arrive in the export's order.
	async #commit(write: (transaction: RivetSynchronousSqliteExecutor) => void, timeoutMs?: number): Promise<void> {
		const database = this.#database();
		database.commitTurn();
		// A batch that the client retries after a busy or overloaded writer starts once every
		// earlier commit is durable.
		await database.whenDurable(database.commitTicket());
		const foreignKeys = Number(database.executeSync("PRAGMA foreign_keys").rows[0]?.[0] ?? 0);
		database.executeSync("PRAGMA foreign_keys = OFF");
		try {
			const transaction = database.beginTransactionSync(timeoutMs, "d1_import");
			try {
				write(transaction);
				transaction.commitSync();
			} catch (error: unknown) {
				transaction.rollbackSync();
				// The cached state may describe the rolled-back write.
				this.#state = undefined;
				throw error;
			}
		} finally {
			database.commitTurn();
			database.executeSync(`PRAGMA foreign_keys = ${foreignKeys === 0 ? "OFF" : "ON"}`);
		}
		await database.whenDurable(database.commitTicket());
	}

	status(): unknown {
		const state = this.#load();
		const objects = this.#userObjects().length;
		if (state === null) return { objects, state: "none" };
		return { ...state, objects, state: "importing" };
	}

	/** The user objects, for the CLI to compare with Cloudflare's. */
	schema(): unknown {
		return { objects: this.#userObjects() };
	}

	/**
	 * Starts a copy of the export `exportId`. A copy of the same export goes on where it stopped. A
	 * copy of another export starts again: it replaces only Orange's own partial copy. Data that a
	 * finished copy or the app wrote needs `replace`.
	 */
	async begin(binding: string, exportId: string, replace: boolean): Promise<unknown> {
		return this.#serial(() => this.#begin(binding, exportId, replace));
	}

	async #begin(binding: string, exportId: string, replace: boolean): Promise<unknown> {
		if (exportId === "") throw new D1ImportError(400, "migrate_d1.bad_request", "begin needs the export's id");
		const current = this.#load();
		if (current !== null && current.export === exportId) return this.status();
		return this.#restart(binding, exportId, replace);
	}

	/**
	 * Drops a copy that failed its check, so the next `begin` starts again even for the same export.
	 * App queries still fail until a copy finishes.
	 */
	async discard(binding: string): Promise<unknown> {
		return this.#serial(() => this.#discard(binding));
	}

	async #discard(binding: string): Promise<unknown> {
		this.#require();
		return this.#restart(binding, "", true);
	}

	async #restart(binding: string, exportId: string, replace: boolean): Promise<unknown> {
		const current = this.#load();
		const existing = this.#userObjects();
		if (current === null && existing.length > 0 && !replace) {
			throw new D1ImportError(
				409,
				"migrate_d1.not_empty",
				`${binding} already has ${existing.length} tables, indexes, views, or triggers on Orange, so Orange won't overwrite them. Pass --replace to replace them.`,
			);
		}
		const state: ImportState = { export: exportId, frozen: false, offset: 0, size: null, statements: 0 };
		await this.#commit((transaction) => {
			// Views and triggers first: dropping a table drops its indexes and triggers with it.
			const order = ["trigger", "view", "index", "table"];
			for (const { name, type } of [...existing].sort((left, right) => order.indexOf(left.type) - order.indexOf(right.type))) {
				transaction.executeSync(`DROP ${type.toUpperCase()} IF EXISTS ${quote(name)}`);
			}
			if (transaction.executeSync("SELECT 1 FROM sqlite_schema WHERE name = 'sqlite_sequence'").rows.length > 0) transaction.executeSync("DELETE FROM sqlite_sequence");
			transaction.executeSync(`CREATE TABLE IF NOT EXISTS ${importTable} (id INTEGER PRIMARY KEY CHECK (id = 1), state TEXT NOT NULL)`);
			transaction.executeSync(`INSERT OR REPLACE INTO ${importTable} (id, state) VALUES (1, ?)`, [JSON.stringify(state)]);
		});
		this.#state = state;
		return this.status();
	}

	/**
	 * Applies the statements between byte `from` and byte `to` of the export in one commit. A repeat of
	 * a range already applied is a no-op, so a step that failed after its commit can run again.
	 */
	async apply(body: { frozen?: boolean; from: number; size?: number | null; statements: ImportStatement[]; to: number }): Promise<unknown> {
		return this.#serial(() => this.#apply(body));
	}

	async #apply(body: { frozen?: boolean; from: number; size?: number | null; statements: ImportStatement[]; to: number }): Promise<unknown> {
		const state = this.#require();
		if (body.to <= state.offset) return { offset: state.offset, skipped: true };
		if (body.from !== state.offset) {
			throw new D1ImportError(409, "migrate_d1.offset_mismatch", `Orange holds the export up to byte ${state.offset}, not ${body.from}. Read from ${state.offset}.`);
		}
		const next: ImportState = {
			...state,
			frozen: state.frozen || body.frozen === true,
			offset: body.to,
			size: body.size ?? state.size,
			statements: state.statements + body.statements.length,
		};
		const long = body.statements.some((statement) => statement.kind === "index");
		await this.#commit((transaction) => {
			for (const statement of body.statements) {
				if (statement.kind === "sequence" && transaction.executeSync("SELECT 1 FROM sqlite_schema WHERE name = 'sqlite_sequence'").rows.length === 0) continue;
				try {
					transaction.executeSync(statement.sql);
				} catch (error: unknown) {
					throw new D1ImportError(422, "migrate_d1.statement_failed", `Orange could not run a statement of the export near byte ${state.offset}: ${errorMessageOf(error).trim()}. Statement: ${statement.sql.slice(0, 200)}`);
				}
			}
			transaction.executeSync(`UPDATE ${importTable} SET state = ? WHERE id = 1`, [JSON.stringify(next)]);
		}, long ? longStatementTimeoutMs : undefined);
		this.#state = next;
		return { offset: next.offset, statements: next.statements };
	}

	/**
	 * Checks pages of a table against Cloudflare's digests, in key order from `after`, an Orange key
	 * that an earlier call returned. With `last`, also checks that no row follows the last page.
	 */
	digest(body: { after?: string | null; last?: boolean; pages: DigestPage[]; table: string }): unknown {
		const database = this.#database();
		const table = this.#digestTable(body.table);
		const keys = keyColumns(table);
		const t = quote(table.name);
		const columns = table.columns.map((column) => `${t}.${quote(column.name)}`);
		const types = columns.map((column) => `substr(typeof(${column}), 1, 1)`).join(" || ");
		const order = keys.map((key) => `${t}.${key}`).join(", ");
		let after = typeof body.after === "string" ? body.after : null;
		// Row: the tagged key, each key's own value, the types, then the values.
		const read = (limit: number): unknown[][] => {
			const cursor = after === null ? [] : (JSON.parse(after) as (string | null)[]);
			const params = cursor.map((tagged) => (tagged?.startsWith("r") === true ? realFromBits(tagged.slice(1)) : tagged));
			const bound = cursor.map((tagged, index) => (tagged?.startsWith("r") === true ? `?${index + 1}` : untag(`?${index + 1}`)));
			const where = after === null ? "1" : `(${order}) > (${bound.join(", ")})`;
			return database.executeSync(
				`SELECT json_array(${keys.map((key) => tag(`${t}.${key}`)).join(", ")}) AS k${keys.map((key, index) => `, ${t}.${key} AS key${index}`).join("")}, ${types} AS ty${columns.map((column, index) => `, ${exact(column)} AS v${index}`).join("")} FROM ${t} WHERE ${where} ORDER BY ${order} LIMIT ${limit}`,
				params,
			).rows;
		};
		const cursorOf = (row: unknown[]): string =>
			JSON.stringify((JSON.parse(String(row[0])) as (string | null)[]).map((tagged, index) => (tagged?.startsWith("r") === true ? `r${realBits(row[1 + index])}` : tagged)));
		let checked = 0;
		let rows = 0;
		for (const [index, page] of body.pages.entries()) {
			const found = read(page.count);
			const text = found.map((row) => digestRow(String(row[1 + keys.length] ?? ""), row.slice(2 + keys.length))).join("\n");
			const digest = createHash("sha256").update(text, "utf8").digest("hex");
			if (found.length !== page.count || digest !== page.digest) {
				return { checked, mismatch: { count: found.length, expected: page.count, page: index, rows } };
			}
			rows += found.length;
			checked += 1;
			if (found.length > 0) after = cursorOf(found.at(-1)!);
		}
		if (body.last === true && read(1).length > 0) return { checked, extra: true, rows };
		return { after, checked, rows };
	}

	#digestTable(name: string): DigestTable {
		const database = this.#database();
		const listed = database.executeSync("SELECT wr FROM pragma_table_list WHERE schema = 'main' AND name = ?", [name]).rows[0];
		if (listed === undefined) throw new D1ImportError(404, "migrate_d1.unknown_table", `Orange has no table named ${name}`);
		const columns = database
			.executeSync("SELECT name, pk, hidden FROM pragma_table_xinfo(?) ORDER BY cid", [name])
			.rows.filter((row) => Number(row[2]) === 0)
			.map(([column, pk]) => ({ name: String(column), pk: Number(pk) }));
		return { columns, name, withoutRowid: Number(listed[0]) === 1 };
	}

	/** Ends the copy once the whole export is in. Then app queries run here. */
	async finish(): Promise<unknown> {
		return this.#serial(() => this.#finish());
	}

	async #finish(): Promise<unknown> {
		const state = this.#require();
		if (state.size === null || state.offset < state.size) {
			throw new D1ImportError(409, "migrate_d1.not_imported", `Orange holds ${state.offset} of ${state.size ?? "?"} bytes of the export. Import the rest first.`);
		}
		await this.#commit((transaction) => transaction.executeSync(`DROP TABLE ${importTable}`));
		this.#state = null;
		return { finished: true, statements: state.statements };
	}
}
