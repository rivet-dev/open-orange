import { deserialize } from "node:v8";

import type { RivetSynchronousSqliteExecutor } from "../../internal/rivetkit.js";
import { serializeUnshared } from "../../internal/v8-serialize.js";

/**
 * A logical copy of one SQLite database: its schema, then every row in pages. Workerd clones a
 * facet by copying its SQLite files. Orange cannot reach another actor's files, so it copies rows.
 * https://github.com/cloudflare/workerd/blob/7236b3650b6c0951484a4d170f17fb6f800b5662/src/workerd/server/factory/worker-factory-actor.c%2B%2B#L76-L103
 *
 * The source encodes each page as soon as it reads it, so JavaScript holds one page of row values
 * at a time, and the copy travels as a stream of length-prefixed frames cut into transport chunks.
 * The destination applies each frame as it arrives.
 */
type SnapshotFrame =
	| { readonly kind: "schema"; readonly objects: readonly SqliteSchemaObject[] }
	| {
			readonly kind: "rows";
			readonly columns: readonly string[];
			/** True for the table's first page, which replaces rows that its DDL created. */
			readonly first: boolean;
			readonly rowid: boolean;
			/** Each row is its values, then one type letter per value. See `typeLetters`. */
			readonly rows: readonly (readonly unknown[])[];
			readonly table: string;
	  };

interface SqliteSchemaObject {
	readonly name: string;
	readonly sql: string;
	readonly type: "index" | "table" | "trigger" | "view";
	/** True for a virtual table, whose DDL creates its shadow tables. */
	readonly virtual: boolean;
}

// JavaScript numbers lose integers beyond 2^53 and the difference between 2 and 2.0, which SQL
// can observe (`typeof()`, integer division). Such values travel as text with a type letter.
// Blobs travel as hex text: RivetKit returns a blob as an array of numbers, about 8 bytes per byte,
// and binds an empty blob as NULL.
const safeInteger = 9_007_199_254_740_991;

// Leaves room for the action envelope under RivetKit's 1 MiB response limit (measured).
export const snapshotChunkBytes = 512 * 1024;
// A page holds about this many bytes of row values, so a page of large rows stays small.
const pageTargetBytes = 1024 * 1024;
// Sample one row before sizing pages: 64 hex-encoded 256 KiB blobs already
// exceed the remote SQLite result limit before the adaptive estimate can run.
const firstPageRows = 1;
const maximumPageRows = 4096;

function quoteIdentifier(name: string): string {
	return `"${name.replaceAll('"', '""')}"`;
}

function asString(value: unknown, what: string): string {
	if (typeof value !== "string") throw new TypeError(`SQLite returned an invalid ${what}`);
	return value;
}

/** Cuts length-prefixed frames into transport chunks without holding the frames themselves. */
class SnapshotChunkWriter {
	readonly chunks: Uint8Array[] = [];
	#current = Buffer.allocUnsafe(snapshotChunkBytes);
	#used = 0;

	push(frame: Uint8Array): void {
		const prefix = Buffer.allocUnsafe(4);
		prefix.writeUInt32BE(frame.byteLength);
		this.#write(prefix);
		this.#write(frame);
	}

	finish(): Uint8Array[] {
		if (this.#used > 0) this.chunks.push(this.#current.subarray(0, this.#used));
		this.#used = 0;
		return this.chunks;
	}

	#write(bytes: Uint8Array): void {
		let offset = 0;
		while (offset < bytes.byteLength) {
			const length = Math.min(bytes.byteLength - offset, snapshotChunkBytes - this.#used);
			this.#current.set(bytes.subarray(offset, offset + length), this.#used);
			this.#used += length;
			offset += length;
			if (this.#used === snapshotChunkBytes) {
				this.chunks.push(this.#current);
				this.#current = Buffer.allocUnsafe(snapshotChunkBytes);
				this.#used = 0;
			}
		}
	}
}

/**
 * Reads the whole database in one synchronous call, so no other JavaScript turn can write in
 * between, and returns it as transport chunks. Only objects whose table `copied` accepts are read.
 */
export function readSqliteSnapshotChunks(
	database: RivetSynchronousSqliteExecutor,
	copied: (table: string) => boolean,
): Uint8Array[] {
	const kinds = new Map<string, string>();
	for (const row of database.executeSync("PRAGMA main.table_list").rows) {
		kinds.set(asString(row[1], "table name"), asString(row[2], "table kind"));
	}
	const objects: SqliteSchemaObject[] = [];
	const tables: string[] = [];
	const master = database.executeSync(
		"SELECT type, name, tbl_name, sql FROM main.sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY rowid",
	).rows;
	for (const [typeValue, nameValue, tableValue, sqlValue] of master) {
		const type = asString(typeValue, "object type");
		const name = asString(nameValue, "object name");
		if (!copied(asString(tableValue, "table name"))) continue;
		if (type !== "index" && type !== "table" && type !== "trigger" && type !== "view") {
			throw new TypeError(`SQLite returned an unknown object type ${type}`);
		}
		const kind = kinds.get(name);
		// A shadow table comes back with its virtual table's DDL, so only its rows are copied.
		if (kind !== "shadow") {
			objects.push({ name, sql: asString(sqlValue, "object SQL"), type, virtual: kind === "virtual" });
		}
		if (type === "table" && kind !== "virtual") tables.push(name);
	}
	if (kinds.has("sqlite_sequence")) tables.push("sqlite_sequence");
	const writer = new SnapshotChunkWriter();
	writer.push(serializeUnshared({ kind: "schema", objects } satisfies SnapshotFrame));
	for (const table of tables) readTablePages(database, table, writer);
	return writer.finish();
}

interface TablePlan {
	readonly columns: readonly string[];
	/** Columns that order the pages: `rowid`, or the primary key of a WITHOUT ROWID table. */
	readonly order: readonly string[];
	readonly rowid: boolean;
}

function planTable(database: RivetSynchronousSqliteExecutor, name: string): TablePlan {
	const columns: string[] = [];
	const primaryKey: [position: number, column: string][] = [];
	// Generated columns (hidden 2 and 3) cannot be inserted. SQLite computes them again.
	for (const row of database.executeSync(`PRAGMA main.table_xinfo(${quoteIdentifier(name)})`).rows) {
		const column = asString(row[1], "column name");
		if (row[6] === 0 || row[6] === 0n) columns.push(column);
		const position = Number(row[5]);
		if (position > 0) primaryKey.push([position, column]);
	}
	const withoutRowid = database.executeSync(
		"SELECT wr FROM pragma_table_list WHERE schema = 'main' AND name = ?",
		[name],
	).rows[0]?.[0];
	const rowid = name !== "sqlite_sequence" && (withoutRowid === 0 || withoutRowid === 0n);
	const order = rowid
		? ["rowid"]
		: primaryKey.sort(([left], [right]) => left - right).map(([, column]) => quoteIdentifier(column));
	return { columns, order, rowid };
}

function isKeysetValue(value: unknown): boolean {
	return typeof value === "string" || typeof value === "number" || typeof value === "bigint";
}

function approximateBytes(rows: readonly (readonly unknown[])[]): number {
	let bytes = 0;
	for (const row of rows) {
		for (const value of row) bytes += typeof value === "string" ? value.length : 8;
	}
	return bytes;
}

/**
 * Encodes a table page by page. Pages follow `rowid` or the primary key, so each page is an index
 * seek, not a rescan. All pages are read in the caller's one synchronous call.
 */
function readTablePages(
	database: RivetSynchronousSqliteExecutor,
	name: string,
	writer: SnapshotChunkWriter,
): void {
	const table = quoteIdentifier(name);
	const plan = planTable(database, name);
	const values = [...(plan.rowid ? ["rowid"] : []), ...plan.columns.map(quoteIdentifier)];
	if (values.length === 0) {
		writer.push(serializeUnshared({ columns: plan.columns, first: true, kind: "rows", rowid: plan.rowid, rows: [], table: name } satisfies SnapshotFrame));
		return;
	}
	const selected = values.map(
		(value) =>
			`CASE typeof(${value}) WHEN 'blob' THEN hex(${value}) WHEN 'integer' THEN CASE WHEN ${value} > ${safeInteger} OR ${value} < -${safeInteger} THEN CAST(${value} AS TEXT) ELSE ${value} END ELSE ${value} END`,
	);
	const typeLetters = values
		.map(
			(value) =>
				`CASE typeof(${value}) WHEN 'real' THEN 'r' WHEN 'integer' THEN CASE WHEN ${value} > ${safeInteger} OR ${value} < -${safeInteger} THEN 'I' ELSE 'i' END WHEN 'blob' THEN 'b' ELSE '.' END`,
		)
		.join(" || ");
	const keyed = plan.order.length > 0;
	// The raw key values come last, so the next page can start after them.
	const projection = `${selected.join(", ")}, ${typeLetters}${keyed ? `, ${plan.order.join(", ")}` : ""}`;
	const orderBy = keyed ? ` ORDER BY ${plan.order.join(", ")}` : "";
	const after = keyed ? ` WHERE (${plan.order.join(", ")}) > (${plan.order.map(() => "?").join(", ")})` : "";
	const rowLength = values.length + 1;
	let first = true;
	let limit = firstPageRows;
	let read = 0;
	let lastKey: unknown[] | undefined;
	for (;;) {
		let sql = `SELECT ${projection} FROM main.${table}`;
		let params: unknown[] | undefined;
		if (keyed && lastKey === undefined) {
			sql += `${orderBy} LIMIT ${limit}`;
		} else if (keyed && lastKey !== undefined && lastKey.every(isKeysetValue)) {
			sql += `${after}${orderBy} LIMIT ${limit}`;
			params = lastKey;
		} else if (keyed) {
			// A key value such as a blob cannot be bound back, so this page skips the rows read so far.
			sql += `${orderBy} LIMIT ${limit} OFFSET ${read}`;
		}
		const result = database.executeSync(sql, params).rows;
		const rows = result.map((row) => row.slice(0, rowLength));
		writer.push(serializeUnshared({ columns: plan.columns, first, kind: "rows", rowid: plan.rowid, rows, table: name } satisfies SnapshotFrame));
		first = false;
		read += result.length;
		if (!keyed || result.length < limit) return;
		lastKey = result[result.length - 1]?.slice(rowLength);
		const bytes = approximateBytes(rows);
		limit = Math.max(1, Math.min(maximumPageRows, Math.floor((limit * pageTargetBytes) / Math.max(bytes, 1))));
	}
}

/** Rebuilds frames from transport chunks that arrive in order. */
export class SqliteSnapshotFrameReader {
	#pending: Buffer[] = [];
	#pendingBytes = 0;

	/** Returns the frames that `chunk` completes. */
	push(chunk: Uint8Array): unknown[] {
		this.#pending.push(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
		this.#pendingBytes += chunk.byteLength;
		const frames: unknown[] = [];
		for (;;) {
			if (this.#pendingBytes < 4) return frames;
			const head = this.#take(4, false);
			const length = head.readUInt32BE(0);
			if (this.#pendingBytes < 4 + length) return frames;
			this.#take(4, true);
			frames.push(deserialize(this.#take(length, true)));
		}
	}

	finish(): void {
		if (this.#pendingBytes !== 0) {
			throw new TypeError("Durable Object facet snapshot ends inside a frame");
		}
	}

	#take(length: number, consume: boolean): Buffer {
		const out = Buffer.allocUnsafe(length);
		let copied = 0;
		let index = 0;
		let offset = 0;
		while (copied < length) {
			const part = this.#pending[index];
			if (part === undefined) throw new TypeError("Durable Object facet snapshot is truncated");
			const available = part.byteLength - offset;
			const count = Math.min(available, length - copied);
			part.copy(out, copied, offset, offset + count);
			copied += count;
			if (count === available) {
				index += 1;
				offset = 0;
			} else {
				offset += count;
			}
		}
		if (consume) {
			this.#pending = this.#pending.slice(index);
			if (offset > 0) {
				const head = this.#pending[0];
				if (head !== undefined) this.#pending[0] = head.subarray(offset);
			}
			this.#pendingBytes -= length;
		}
		return out;
	}
}

/** Removes every object whose table `cleared` accepts. */
function clearSqliteDatabase(
	database: RivetSynchronousSqliteExecutor,
	cleared: (table: string) => boolean,
): void {
	const master = database.executeSync(
		"SELECT type, name, tbl_name FROM main.sqlite_master WHERE name NOT LIKE 'sqlite\\_%' ESCAPE '\\'",
	).rows;
	const kinds = new Map<string, string>();
	for (const row of database.executeSync("PRAGMA main.table_list").rows) {
		kinds.set(asString(row[1], "table name"), asString(row[2], "table kind"));
	}
	const drops: string[] = [];
	// Views and triggers first, then virtual tables, which drop their shadow tables, then tables.
	for (const order of ["view", "trigger", "virtual", "table"] as const) {
		for (const [typeValue, nameValue, tableValue] of master) {
			const type = asString(typeValue, "object type");
			const name = asString(nameValue, "object name");
			if (!cleared(asString(tableValue, "table name")) || kinds.get(name) === "shadow") continue;
			const kind = type === "table" && kinds.get(name) === "virtual" ? "virtual" : type;
			if (kind !== order) continue;
			drops.push(`DROP ${type === "view" ? "VIEW" : type === "trigger" ? "TRIGGER" : "TABLE"} IF EXISTS main.${quoteIdentifier(name)}`);
		}
	}
	for (const statement of drops) database.executeSync(statement);
	if (kinds.has("sqlite_sequence")) database.executeSync("DELETE FROM main.sqlite_sequence");
}

function frameField(value: unknown, key: string): unknown {
	return typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
}

function requireFrame(value: unknown): SnapshotFrame {
	const kind = frameField(value, "kind");
	const isSchema = kind === "schema" && Array.isArray(frameField(value, "objects"));
	const isRows =
		kind === "rows" &&
		typeof frameField(value, "table") === "string" &&
		Array.isArray(frameField(value, "columns")) &&
		Array.isArray(frameField(value, "rows"));
	if (!isSchema && !isRows) throw new TypeError("Durable Object facet snapshot frame is invalid");
	// SAFETY: a frame is Orange's own serializeUnshared() output, and its kind and arrays are checked above.
	return value as SnapshotFrame;
}

/**
 * Replaces the objects whose table `cleared` accepts with a snapshot, one frame at a time. Run it
 * in one transaction with foreign keys off, so the copy commits whole or not at all.
 */
export class SqliteSnapshotWriter {
	readonly #database: RivetSynchronousSqliteExecutor;
	readonly #later: SqliteSchemaObject[] = [];
	#sawSchema = false;

	constructor(database: RivetSynchronousSqliteExecutor, cleared: (table: string) => boolean) {
		this.#database = database;
		clearSqliteDatabase(database, cleared);
	}

	apply(value: unknown): void {
		const frame = requireFrame(value);
		if (frame.kind === "schema") {
			for (const object of frame.objects) {
				if (object.type === "table") this.#database.executeSync(object.sql);
				else this.#later.push(object);
			}
			this.#sawSchema = true;
			return;
		}
		if (!this.#sawSchema) throw new TypeError("Durable Object facet snapshot rows came before its schema");
		const values = [...(frame.rowid ? ["rowid"] : []), ...frame.columns.map(quoteIdentifier)];
		if (values.length === 0) return;
		const target = `main.${quoteIdentifier(frame.table)}`;
		// A virtual table's DDL fills its shadow tables, for example FTS5's `_config`.
		if (frame.first) this.#database.executeSync(`DELETE FROM ${target}`);
		const typeParameter = values.length + 1;
		const placeholders = values.map(
			(_value, index) =>
				`CASE substr(?${typeParameter}, ${index + 1}, 1) WHEN 'r' THEN CAST(?${index + 1} AS REAL) WHEN 'I' THEN CAST(?${index + 1} AS INTEGER) WHEN 'b' THEN unhex(?${index + 1}) ELSE ?${index + 1} END`,
		);
		const insert = `INSERT INTO ${target} (${values.join(", ")}) VALUES (${placeholders.join(", ")})`;
		for (const row of frame.rows) this.#database.executeSync(insert, [...row]);
	}

	/** Creates indexes after the rows, and triggers after them, so copying rows fires no trigger. */
	finish(): void {
		for (const object of this.#later) this.#database.executeSync(object.sql);
	}
}
