import { AsyncLocalStorage } from "node:async_hooks";
import { Buffer } from "node:buffer";

import {
	type RivetDatabaseProvider,
	type RivetDatabaseProviderContext,
	type RivetSqliteDatabase,
	type RivetSqliteExecuteResult,
	type RivetSynchronousSqliteExecutor,
	rivetSqliteDeferredCommits,
} from "../../internal/rivetkit.js";
import {
	type DurableObjectGetAlarmOptions,
	type DurableObjectGetOptions,
	type DurableObjectListOptions,
	type DurableObjectPutOptions,
	type DurableObjectSetAlarmOptions,
	type DurableObjectStorage,
	type DurableObjectTransaction,
	type SqlStorage,
	SqlStorageCursor,
	SqlStorageStatement,
	type SqlStorageValue,
	type SyncKvStorage,
} from "../../modules/cloudflare-workers/durable-object.js";
import {
	DurableObjectAlarmStore,
	type DurableObjectAlarmSynchronization,
	normalizeAlarmTime,
} from "./alarm-storage.js";
import type { DurableObjectInputGate, DurableObjectTurnDatabase } from "./gates.js";
import { findStatementlessSql, firstCompleteStatementLength } from "./sql-complete.js";
import { createSyncKvStorage, DurableObjectKvStore } from "./sync-kv.js";
import { sqlStatementError } from "./sqlite-errors.js";
import { errorMessage } from "../unknown-values.js";

// DurableObjectStorage members that workerd defines and Orange does not implement.
// https://github.com/cloudflare/workerd/blob/81d1f18e18fa5b454ec47dde90817497b8a0cd70/src/workerd/api/actor-state.h#L329-L348
const unimplementedStorageMembers = new Set([
	"disableReplicas",
	"ensureReplicas",
	"getBookmarkForTime",
	"onNextSessionRestore",
	"onNextSessionRestoreBookmark",
	"snapshot",
]);

function storageUnsupported(name: string): Error {
	const error = new Error(`DurableObjectStorage.${name} is not implemented`);
	error.name = "NotSupportedError";
	return error;
}

// workerd keeps its local development bookmark in the `_cf_METADATA` table under key 2.
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/util/sqlite-metadata.h#L51-L57
const createMetadataTableSql =
	"CREATE TABLE IF NOT EXISTS _cf_METADATA (key INTEGER PRIMARY KEY, value BLOB)";
const getBookmarkSql = "SELECT value FROM _cf_METADATA WHERE key = 2";
const setBookmarkSql =
	"INSERT INTO _cf_METADATA VALUES(2, ?) ON CONFLICT DO UPDATE SET value = excluded.value";

// Formats a bookmark like Cloudflare's production bookmarks, as workerd does in local development.
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/io/actor-sqlite.c%2B%2B#L1168-L1185
function formatBookmark(bookmark: number): string {
	const uint32Max = 0xffff_ffff;
	const hex = (value: number): string => value.toString(16).padStart(8, "0");
	return `${hex(Math.floor(bookmark / uint32Max))}-${hex(bookmark % uint32Max)}-${hex(0)}-${"0".repeat(32)}`;
}

function assertStorageOptions(options: unknown): void {
	if (options === undefined) return;
	if (
		typeof options !== "object" ||
		options === null ||
		Array.isArray(options)
	) {
		throw new TypeError("Durable Object storage options must be an object");
	}
	const noCache = Reflect.get(options, "noCache");
	if (noCache !== undefined && typeof noCache !== "boolean") {
		throw new TypeError(
			"Durable Object storage option noCache must be a boolean",
		);
	}
	// allowConcurrency has no effect on SQLite-backed storage because every operation completes
	// synchronously.
	// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/actor-state.c%2B%2B#L58-L66
}

function allowsUnconfirmed(options: unknown): boolean {
	return (
		typeof options === "object" &&
		options !== null &&
		Reflect.get(options, "allowUnconfirmed") === true
	);
}

// workerd's SQLite backend has no key-count limit; the 128-pair limit belongs to
// Cloudflare's KV backend.
// https://github.com/cloudflare/workerd/blob/80c80a712532b012cbeaef4d08ff6ab15407e960/src/workerd/api/actor-state.c%2B%2B#L594-L600
function storageKeys(keys: unknown[]): string[] {
	return keys.map(storageKey);
}

function storageKey(value: unknown): string {
	// workerd converts a key with JavaScript's ToString, as a string parameter
	// does: numbers and undefined become strings, and a symbol throws TypeError.
	// Cloudflare's alarm example passes a numeric counter as the key.
	// https://github.com/cloudflare/cloudflare-docs/blob/e65ba8b1fa64a5dc7c5c42a96c455398945cdf5e/src/content/docs/durable-objects/examples/alarms-api.mdx#L44-L60
	return `${value}`;
}

function isSingleStorageKey(value: unknown): value is string | number {
	return typeof value === "string" || typeof value === "number";
}

function singleStorageKey(value: string | number): string {
	return String(value);
}

function compareStorageKeys(left: string, right: string): number {
	return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function storageEntries<T>(value: Record<string, T>): [string, T][] {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new TypeError("put() entries must be an object");
	}
	const keys = Object.keys(value);
	const entries: [string, T][] = [];
	for (const key of keys) {
		const item = value[key];
		// Mirrors workerd's record overload: undefined fields are omitted, while
		// the single-key overload rejects undefined.
		// https://github.com/cloudflare/workerd/blob/23263780e6ba38c7f230497a6abc1a4ff72124fb/src/workerd/api/actor-state.c%2B%2B#L594-L647
		if (item !== undefined) entries.push([key, item]);
	}
	return entries;
}

function asFiniteCount(value: unknown, label: string): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		throw new Error(`RivetKit SQLite returned an invalid ${label}`);
	}
	return value;
}

function normalizeBinding(value: unknown): unknown {
	if (
		value === null ||
		value === undefined ||
		typeof value === "number" ||
		typeof value === "string"
	) {
		return value ?? null;
	}
	if (value instanceof ArrayBuffer) {
		return new Uint8Array(value);
	}
	if (ArrayBuffer.isView(value)) {
		return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
	}
	// workerd binds any other value as its string form, so true binds "true".
	// A BigInt fails its number conversion and a Symbol fails ToString.
	// https://github.com/cloudflare/workerd/blob/80c80a712532b012cbeaef4d08ff6ab15407e960/src/workerd/api/sql.h#L29
	if (typeof value === "bigint") {
		throw new TypeError("Cannot convert a BigInt value to a number");
	}
	return `${value}`;
}

function countSqlBindings(sql: string): number {
	let index = 0;
	let nextAnonymousIndex = 1;
	let maximumIndex = 0;
	const named = new Map<string, number>();
	while (index < sql.length) {
		const character = sql[index];
		const following = sql[index + 1];
		if (character === "'" || character === '"' || character === "`") {
			const quote = character;
			index += 1;
			while (index < sql.length) {
				if (sql[index] !== quote) {
					index += 1;
					continue;
				}
				if (sql[index + 1] === quote) {
					index += 2;
					continue;
				}
				index += 1;
				break;
			}
			continue;
		}
		if (character === "[") {
			index = sql.indexOf("]", index + 1);
			if (index < 0) return maximumIndex;
			index += 1;
			continue;
		}
		if (character === "-" && following === "-") {
			index = sql.indexOf("\n", index + 2);
			if (index < 0) return maximumIndex;
			continue;
		}
		if (character === "/" && following === "*") {
			index = sql.indexOf("*/", index + 2);
			if (index < 0) return maximumIndex;
			index += 2;
			continue;
		}
		if (character === "?") {
			let end = index + 1;
			while (end < sql.length && /[0-9]/.test(sql[end])) end += 1;
			const explicit = sql.slice(index + 1, end);
			const bindingIndex =
				explicit.length === 0 ? nextAnonymousIndex : Number(explicit);
			maximumIndex = Math.max(maximumIndex, bindingIndex);
			nextAnonymousIndex = Math.max(nextAnonymousIndex, bindingIndex + 1);
			index = end;
			continue;
		}
		if (
			(character === ":" || character === "@" || character === "$") &&
			following !== undefined &&
			/[A-Za-z0-9_]/.test(following)
		) {
			let end = index + 2;
			while (end < sql.length && /[A-Za-z0-9_]/.test(sql[end])) end += 1;
			const name = sql.slice(index, end);
			let bindingIndex = named.get(name);
			if (bindingIndex === undefined) {
				bindingIndex = nextAnonymousIndex;
				named.set(name, bindingIndex);
				nextAnonymousIndex += 1;
			}
			maximumIndex = Math.max(maximumIndex, bindingIndex);
			index = end;
			continue;
		}
		index += 1;
	}
	return maximumIndex;
}

function normalizeSqlValue(value: unknown): SqlStorageValue {
	if (
		value === null ||
		typeof value === "number" ||
		typeof value === "string"
	) {
		return value;
	}
	// Workerd returns a 64-bit integer outside the safe range as a lossy double,
	// not a BigInt.
	// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/sql.c%2B%2B#L376-L381
	if (typeof value === "bigint") return Number(value);
	if (value instanceof ArrayBuffer) return value.slice(0);
	if (ArrayBuffer.isView(value)) {
		return Uint8Array.from(
			new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
		).buffer;
	}
	if (
		Array.isArray(value) &&
		value.every(
			(byte) =>
				typeof byte === "number" &&
				Number.isInteger(byte) &&
				byte >= 0 &&
				byte <= 255,
		)
	) {
		return Uint8Array.from(value).buffer;
	}
	throw new Error("RivetKit SQLite returned an unsupported column value");
}

function rowsWrittenForQuery(query: string, changes: unknown): number {
	const withoutLeadingComments = query
		.replace(/^(?:\s|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)+/, "")
		.toUpperCase();
	if (!/^(?:INSERT|UPDATE|DELETE|REPLACE)\b/.test(withoutLeadingComments)) {
		return 0;
	}
	return asFiniteCount(changes, "change count");
}

const transactionControlMessage =
	"To execute a transaction, please use the state.storage.transaction() or state.storage.transactionSync() APIs instead of the SQL BEGIN TRANSACTION or SAVEPOINT statements. The JavaScript API is safer because it will automatically roll back on exceptions, and because it interacts correctly with Durable Objects' automatic atomic write coalescing.";

// The SQL with its strings and comments masked, so only identifiers and keywords remain.
function sqlIdentifiers(query: string): string {
	return query.replace(/'(?:''|[^'])*'|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\//g, " ");
}

function assertNoReservedNames(query: string): void {
	// Keep Cloudflare's `_cf_` objects and the Rivet host's `_rivet_` objects
	// private from user SQL. The native regulator applies its `_cf_` check to
	// resolved SQLite object names; masking SQL strings and comments gives this
	// JavaScript bridge the same practical fence.
	// https://github.com/cloudflare/workerd/blob/23263780e6ba38c7f230497a6abc1a4ff72124fb/src/workerd/api/sql.c%2B%2B#L141-L146
	if (/(?:^|[^A-Za-z0-9_])_(?:cf|rivet)_[A-Za-z0-9_]*/i.test(sqlIdentifiers(query))) {
		throw new Error("not authorized");
	}
}

const schemaListing =
	/(?:^|[^A-Za-z0-9_])(?:sqlite_(?:temp_)?(?:master|schema)|table_list)(?![A-Za-z0-9_])/i;

// workerd's schema holds the user's objects and its own `_cf_` tables. RivetKit keeps its `_rivet_`
// tables in the same database, which a Worker on workerd never sees, and a tool that lists every
// table and then reads each one fails on them. So a schema listing drops their rows. A query that
// renames the `name` and `tbl_name` columns, or only counts rows, still sees them.
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/util/sqlite.c%2B%2B#L1207-L1210
function withoutRivetObjects(
	query: string,
	result: ReturnType<typeof normalizeResult>,
): ReturnType<typeof normalizeResult> {
	if (!schemaListing.test(sqlIdentifiers(query))) return result;
	const nameColumns = result.columns.flatMap((column, index) =>
		/^(?:name|tbl_name)$/i.test(column) ? [index] : [],
	);
	if (nameColumns.length === 0) return result;
	const rows = result.rows.filter(
		(row) =>
			!nameColumns.some((index) => {
				const value = row[index];
				return typeof value === "string" && /^_rivet_/i.test(value);
			}),
	);
	return { ...result, rows, rowsRead: rows.length };
}

const transactionControlKeywords = new Set([
	"BEGIN",
	"COMMIT",
	"END",
	"ROLLBACK",
	"SAVEPOINT",
	"RELEASE",
]);

// Token and state numbers of sqlite3_complete()'s statement machine, which
// tells a statement-ending `;` from one inside a CREATE TRIGGER body.
// https://github.com/sqlite/sqlite/blob/version-3.46.0/src/complete.c#L104-L260
const tokenSemi = 0;
const tokenWhitespace = 1;
const tokenOther = 2;
const tokenExplain = 3;
const tokenCreate = 4;
const tokenTemp = 5;
const tokenTrigger = 6;
const tokenEnd = 7;
const sqlStatementTransitions: readonly (readonly number[])[] = [
	[1, 0, 2, 3, 4, 2, 2, 2],
	[1, 1, 2, 3, 4, 2, 2, 2],
	[1, 2, 2, 2, 2, 2, 2, 2],
	[1, 3, 3, 2, 4, 2, 2, 2],
	[1, 4, 2, 2, 2, 4, 5, 2],
	[6, 5, 5, 5, 5, 5, 5, 5],
	[6, 6, 5, 5, 5, 5, 5, 7],
	[1, 7, 5, 5, 5, 5, 5, 5],
];

function isSqlIdentifierCharacter(character: string | undefined): boolean {
	return character !== undefined && /[A-Za-z0-9_$\u0080-\uffff]/.test(character);
}

function sqlKeywordToken(word: string): number {
	switch (word) {
		case "CREATE":
			return tokenCreate;
		case "TEMP":
		case "TEMPORARY":
			return tokenTemp;
		case "TRIGGER":
			return tokenTrigger;
		case "END":
			return tokenEnd;
		case "EXPLAIN":
			return tokenExplain;
		default:
			return tokenOther;
	}
}

/**
 * Finds the first statement that controls a transaction. Workerd's
 * regulator rejects BEGIN, COMMIT, and SAVEPOINT statements at prepare time, after the
 * earlier statements of a multi-statement exec() ran, so transactions stay owned by the
 * storage API.
 * https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/util/sqlite.c%2B%2B#L834-L900
 * https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/util/sqlite.c%2B%2B#L1153-L1201
 */
function findTransactionControl(
	query: string,
): { offset: number; afterStatements: boolean } | undefined {
	let afterStatements = false;
	let state = 0;
	let index = 0;
	while (index < query.length) {
		const start = index;
		const character = query[index];
		let token: number = tokenOther;
		let word: string | undefined;
		if (character === ";") {
			token = tokenSemi;
			index += 1;
		} else if (/[ \t\n\f\r]/.test(character)) {
			token = tokenWhitespace;
			index += 1;
		} else if (character === "/" && query[index + 1] === "*") {
			const end = query.indexOf("*/", index + 2);
			if (end < 0) return undefined;
			token = tokenWhitespace;
			index = end + 2;
		} else if (character === "-" && query[index + 1] === "-") {
			const end = query.indexOf("\n", index + 2);
			if (end < 0) return undefined;
			token = tokenWhitespace;
			index = end + 1;
		} else if (/[[`"']/.test(character)) {
			const end = query.indexOf(
				character === "[" ? "]" : character,
				index + 1,
			);
			if (end < 0) return undefined;
			index = end + 1;
		} else if (isSqlIdentifierCharacter(character)) {
			while (isSqlIdentifierCharacter(query[index])) index += 1;
			word = query.slice(start, index).toUpperCase();
			token = sqlKeywordToken(word);
		} else {
			index += 1;
		}
		if (
			(state === 0 || state === 1) &&
			word !== undefined &&
			transactionControlKeywords.has(word)
		) {
			return { offset: start, afterStatements };
		}
		if (token !== tokenWhitespace && token !== tokenSemi) {
			afterStatements = true;
		}
		state = sqlStatementTransitions[state][token];
	}
	return undefined;
}

function normalizeResult(
	query: string,
	result: RivetSqliteExecuteResult,
): {
	columns: string[];
	rows: SqlStorageValue[][];
	rowsRead: number;
	rowsWritten: number;
} {
	if (
		!Array.isArray(result.columns) ||
		!result.columns.every((column) => typeof column === "string") ||
		!Array.isArray(result.rows)
	) {
		throw new Error("RivetKit SQLite returned an invalid query result");
	}
	return {
		columns: [...result.columns],
		rows: result.rows.map((row) => {
			if (!Array.isArray(row) || row.length !== result.columns.length) {
				throw new Error("RivetKit SQLite returned an invalid result row");
			}
			return row.map(normalizeSqlValue);
		}),
		// Rivet currently exposes materialized rows and sqlite3_changes(), but not
		// workerd's LIBSQL_STMTSTATUS_ROWS_READ/WRITTEN counters. Keep these
		// counters explicit and deterministic until that primitive is available.
		// Workerd's live counter behavior is implemented here:
		// https://github.com/cloudflare/workerd/blob/23263780e6ba38c7f230497a6abc1a4ff72124fb/src/workerd/api/sql.c%2B%2B#L234-L248
		rowsRead: result.rows.length,
		rowsWritten: rowsWrittenForQuery(query, result.changes),
	};
}

function isMultipleStatementError(error: unknown): boolean {
	return /only supports a single statement/i.test(errorMessage(error));
}

function executeMultipleStatements(
	database: RivetSynchronousSqliteExecutor,
	query: string,
): ReturnType<typeof normalizeResult> {
	const rows: SqlStorageValue[][] = [];
	let columns: string[] = [];
	database.execSync(query, (rawRow, rawColumns) => {
		if (columns.length === 0) columns = [...rawColumns];
		rows.push(rawRow.map(normalizeSqlValue));
	});
	return { columns, rows, rowsRead: rows.length, rowsWritten: 0 };
}

function newSqlRow<Row extends SqlStorageValue[]>(): Row;
function newSqlRow(): SqlStorageValue[] {
	return [];
}

class SqlStorageCursorImplementation<
	T extends Record<string, SqlStorageValue>,
> extends SqlStorageCursor<T> {
	// The concrete cursor eagerly materializes Rivet's result while preserving
	// workerd's single shared position across object and raw iteration.
	// https://github.com/cloudflare/workerd/blob/23263780e6ba38c7f230497a6abc1a4ff72124fb/src/workerd/api/sql.c%2B%2B#L250-L341
	readonly columnNames: string[];
	readonly #rows: SqlStorageValue[][];
	readonly #rowsRead: number;
	readonly #rowsWritten: number;
	readonly #canceled: () => boolean;
	#index = 0;

	constructor(
		columns: readonly string[],
		rows: readonly SqlStorageValue[][],
		rowsRead: number,
		rowsWritten: number,
		canceled: () => boolean,
	) {
		super();
		this.columnNames = [...columns];
		this.#rows = rows.map((row) => [...row]);
		this.#rowsRead = rowsRead;
		this.#rowsWritten = rowsWritten;
		this.#canceled = canceled;
	}

	get rowsRead(): number {
		return this.#rowsRead;
	}

	get rowsWritten(): number {
		return this.#rowsWritten;
	}

	#takeRaw(): SqlStorageValue[] | undefined {
		const row = this.#rows[this.#index];
		if (row === undefined) return undefined;
		// deleteAll() resets the database, which cancels every query with rows left. A
		// fully read cursor already ended its query.
		// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/util/sqlite.c%2B%2B#L1780-L1785
		if (this.#canceled()) {
			throw new Error(
				"SQLite query was canceled because the database was deleted.",
			);
		}
		this.#index += 1;
		return [...row];
	}

	#toObject(values: readonly SqlStorageValue[]): T {
		const row: T = Object.create(Object.prototype);
		for (const [index, name] of this.columnNames.entries()) {
			Object.defineProperty(row, name, {
				configurable: true,
				enumerable: true,
				value: values[index],
				writable: true,
			});
		}
		return row;
	}

	next(): { done?: false; value: T } | { done: true; value?: never } {
		const row = this.#takeRaw();
		return row === undefined
			? { done: true }
			: { done: false, value: this.#toObject(row) };
	}

	toArray(): T[] {
		return Array.from(this);
	}

	one(): T {
		const first = this.next();
		if (first.done) {
			throw new Error(
				"Expected exactly one result from SQL query, but got no results.",
			);
		}
		if (this.#index < this.#rows.length) {
			this.#index = this.#rows.length;
			throw new Error(
				"Expected exactly one result from SQL query, but got multiple results.",
			);
		}
		return first.value;
	}

	*raw<U extends SqlStorageValue[]>(): IterableIterator<U> {
		for (;;) {
			const row = this.#takeRaw();
			if (row === undefined) return;
			const typedRow = newSqlRow<U>();
			typedRow.push(...row);
			yield typedRow;
		}
	}

	[Symbol.iterator](): IterableIterator<T> {
		const cursor = this;
		return {
			next(): IteratorResult<T, undefined> {
				const result = cursor.next();
				return result.done ? { done: true, value: undefined } : result;
			},
			[Symbol.iterator](): IterableIterator<T> {
				return this;
			},
		};
	}
}

export interface SqlStorageIngestResult {
	remainder: string;
	rowsRead: number;
	rowsWritten: number;
	statementCount: number;
}

class SqlStorageImplementation implements SqlStorage {
	readonly Cursor = SqlStorageCursor;
	readonly Statement = SqlStorageStatement;
	readonly #database: () => RivetSynchronousSqliteExecutor;
	#pageSize: number | undefined;
	#resets = 0;

	constructor(database: () => RivetSynchronousSqliteExecutor) {
		this.#database = database;
	}

	cancelCursors(): void {
		this.#resets += 1;
	}

	exec<T extends Record<string, SqlStorageValue>>(
		query: string,
		...bindings: unknown[]
	): SqlStorageCursor<T> {
		if (typeof query !== "string") {
			throw new TypeError("SQL query must be a string");
		}
		const statementless = findStatementlessSql(query);
		if (statementless !== undefined) {
			if (statementless > 0) this.exec(query.slice(0, statementless), ...bindings);
			throw new Error("SQL code did not contain a statement.");
		}
		assertNoReservedNames(query);
		const transactionControl = findTransactionControl(query);
		if (transactionControl?.afterStatements === false) {
			throw new Error(transactionControlMessage);
		}
		const bindingCount = countSqlBindings(query);
		if (bindingCount !== bindings.length) {
			throw new Error("Wrong number of parameter bindings for SQL query.");
		}
		const normalizedBindings = bindings.map(normalizeBinding);
		if (transactionControl !== undefined) {
			if (normalizedBindings.length > 0) {
				throw new Error(
					"OpenOrange does not yet support bindings on multi-statement SQL",
				);
			}
			// The statements before the rejected one run, as they do in workerd.
			try {
				this.#database().execSync(query.slice(0, transactionControl.offset));
			} catch (error: unknown) {
				throw sqlStatementError(error);
			}
			throw new Error(transactionControlMessage);
		}
		let result: ReturnType<typeof normalizeResult>;
		try {
			result = normalizeResult(
				query,
				this.#database().executeSync(query, normalizedBindings),
			);
		} catch (error: unknown) {
			if (!isMultipleStatementError(error)) throw sqlStatementError(error);
			if (normalizedBindings.length > 0) {
				throw new Error(
					"OpenOrange does not yet support bindings on multi-statement SQL",
				);
			}
			try {
				result = executeMultipleStatements(this.#database(), query);
			} catch (multiError: unknown) {
				throw sqlStatementError(multiError);
			}
		}
		result = withoutRivetObjects(query, result);
		const resets = this.#resets;
		return new SqlStorageCursorImplementation<T>(
			result.columns,
			result.rows,
			result.rowsRead,
			result.rowsWritten,
			() => this.#resets !== resets,
		);
	}

	// Runs every complete statement at the start of `query` and returns the incomplete rest, so a
	// caller can stream a large SQL dump in pieces. A failing statement throws, and the ones
	// before it stay applied.
	// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/util/sqlite.c%2B%2B#L954-L982
	ingest(query: string): SqlStorageIngestResult {
		if (typeof query !== "string") {
			throw new TypeError("SQL query must be a string");
		}
		const result: SqlStorageIngestResult = {
			remainder: query,
			rowsRead: 0,
			rowsWritten: 0,
			statementCount: 0,
		};
		for (
			let length = firstCompleteStatementLength(result.remainder);
			length > 0;
			length = firstCompleteStatementLength(result.remainder)
		) {
			const cursor = this.exec(result.remainder.slice(0, length));
			result.rowsRead += cursor.rowsRead;
			result.rowsWritten += cursor.rowsWritten;
			result.statementCount += 1;
			result.remainder = result.remainder.slice(length);
		}
		return result;
	}

	// Workerd's test hook caps the database size so tests can trigger SQLITE_FULL.
	// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/sql.c%2B%2B#L117-L120
	setMaxPageCountForTest(count: number): void {
		this.#database().executeSync(`PRAGMA max_page_count = ${Math.trunc(Number(count))}`);
	}

	get databaseSize(): number {
		// Workerd reports allocated pages excluding freelist pages, multiplied by
		// SQLite's page size. Mirror that formula instead of Rivet's cache metric.
		// https://github.com/cloudflare/workerd/blob/23263780e6ba38c7f230497a6abc1a4ff72124fb/src/workerd/api/sql.c%2B%2B#L126-L139
		const pageCount = this.#database().executeSync(
			"select (select * from pragma_page_count) - (select * from pragma_freelist_count);",
		).rows[0]?.[0];
		this.#pageSize ??= asFiniteCount(
			this.#database().executeSync("PRAGMA page_size;").rows[0]?.[0],
			"page size",
		);
		return asFiniteCount(pageCount, "used page count") * this.#pageSize;
	}
}

type TransactionStatus = "active" | "committed" | "rolled-back";

interface TransactionAlarmState {
	dirty: boolean;
}

interface TransactionFrame {
	readonly alarmState: TransactionAlarmState;
	commit(): void;
	readonly database: RivetSynchronousSqliteExecutor;
	readonly kind: "async" | "sync";
	rollback(): void;
	readonly rootId: symbol;
	status: TransactionStatus;
}

interface ActiveTransactionRoot {
	readonly completion: Promise<void>;
	readonly rootId: symbol;
}

interface TransactionOperations {
	deleteMany(
		keys: string[],
		options?: DurableObjectPutOptions,
	): Promise<number>;
	deleteOne(key: string, options?: DurableObjectPutOptions): Promise<boolean>;
	deleteAlarm(options?: DurableObjectSetAlarmOptions): Promise<void>;
	getAlarm(options?: DurableObjectGetAlarmOptions): Promise<number | null>;
	getMany<T>(
		keys: string[],
		options?: DurableObjectGetOptions,
	): Promise<Map<string, T>>;
	getOne<T>(
		key: string,
		options?: DurableObjectGetOptions,
	): Promise<T | undefined>;
	list<T>(options?: DurableObjectListOptions): Promise<Map<string, T>>;
	putMany(entries: Record<string, unknown>, options: unknown): Promise<void>;
	putOne(
		key: string,
		value: unknown,
		options?: DurableObjectPutOptions,
	): Promise<void>;
	setAlarm(
		scheduledTime: number | Date,
		options?: DurableObjectSetAlarmOptions,
	): Promise<void>;
}

class DurableObjectTransactionImplementation
	implements DurableObjectTransaction
{
	readonly #frame: TransactionFrame;
	readonly #operations: TransactionOperations;

	constructor(frame: TransactionFrame, operations: TransactionOperations) {
		this.#frame = frame;
		this.#operations = operations;
	}

	#assertActive(operation: string): void {
		if (this.#frame.status === "rolled-back") {
			throw new Error(`Cannot ${operation}() on rolled back transaction`);
		}
		if (this.#frame.status === "committed") {
			throw new Error(
				`Cannot call ${operation}() on transaction that has already committed: did you move \`txn\` outside of the closure?`,
			);
		}
	}

	get<T = unknown>(
		key: string,
		options?: DurableObjectGetOptions,
	): Promise<T | undefined>;
	get<T = unknown>(
		keys: string[],
		options?: DurableObjectGetOptions,
	): Promise<Map<string, T>>;
	get<T = unknown>(
		keyOrKeys: string | number | string[],
		options?: DurableObjectGetOptions,
	): Promise<T | undefined | Map<string, T>> {
		this.#assertActive("get");
		return Array.isArray(keyOrKeys)
			? this.#operations.getMany<T>(keyOrKeys, options)
			: this.#operations.getOne<T>(storageKey(keyOrKeys), options);
	}

	list<T = unknown>(
		options?: DurableObjectListOptions,
	): Promise<Map<string, T>> {
		this.#assertActive("list");
		return this.#operations.list<T>(options);
	}

	put<T>(
		key: string,
		value: T,
		options?: DurableObjectPutOptions,
	): Promise<void>;
	put<T>(
		entries: Record<string, T>,
		options?: DurableObjectPutOptions,
	): Promise<void>;
	put<T>(
		keyOrEntries: string | number | Record<string, T>,
		valueOrOptions?: T | DurableObjectPutOptions,
		options?: DurableObjectPutOptions,
	): Promise<void> {
		this.#assertActive("put");
		if (isSingleStorageKey(keyOrEntries)) {
			return this.#operations.putOne(
				singleStorageKey(keyOrEntries),
				valueOrOptions,
				options,
			);
		}
		return this.#operations.putMany(keyOrEntries, valueOrOptions);
	}

	delete(key: string, options?: DurableObjectPutOptions): Promise<boolean>;
	delete(keys: string[], options?: DurableObjectPutOptions): Promise<number>;
	delete(
		keyOrKeys: string | number | string[],
		options?: DurableObjectPutOptions,
	): Promise<boolean | number> {
		this.#assertActive("delete");
		return Array.isArray(keyOrKeys)
			? this.#operations.deleteMany(keyOrKeys, options)
			: this.#operations.deleteOne(storageKey(keyOrKeys), options);
	}

	// workerd's transaction has deleteAll() only to reject it.
	// https://github.com/cloudflare/workerd/blob/80c80a712532b012cbeaef4d08ff6ab15407e960/src/workerd/api/actor-state.c%2B%2B#L573-L576
	deleteAll(): Promise<void> {
		return Promise.reject(new Error("Cannot call deleteAll() within a transaction"));
	}

	getAlarm(options?: DurableObjectGetAlarmOptions): Promise<number | null> {
		this.#assertActive("getAlarm");
		return this.#operations.getAlarm(options);
	}

	setAlarm(
		scheduledTime: number | Date,
		options?: DurableObjectSetAlarmOptions,
	): Promise<void> {
		this.#assertActive("setAlarm");
		return this.#operations.setAlarm(scheduledTime, options);
	}

	deleteAlarm(options?: DurableObjectSetAlarmOptions): Promise<void> {
		this.#assertActive("deleteAlarm");
		return this.#operations.deleteAlarm(options);
	}

	rollback(): void {
		// Match workerd's idempotent rollback and expired-transaction diagnostics.
		// https://github.com/cloudflare/workerd/blob/23263780e6ba38c7f230497a6abc1a4ff72124fb/src/workerd/api/actor-state.c%2B%2B#L928-L954
		if (this.#frame.status === "rolled-back") return;
		this.#assertActive("rollback");
		this.#frame.rollback();
		this.#frame.status = "rolled-back";
	}
}

class DurableObjectStorageImplementation implements DurableObjectStorage {
	readonly kv: SyncKvStorage;
	readonly sql: SqlStorage;
	declare readonly getBookmarkForTime: DurableObjectStorage["getBookmarkForTime"];
	declare readonly onNextSessionRestoreBookmark: DurableObjectStorage["onNextSessionRestoreBookmark"];
	readonly #alarmScheduler: DurableObjectAlarmSynchronization | undefined;
	readonly #alarmStore: DurableObjectAlarmStore;
	readonly #committedAlarmStore: DurableObjectAlarmStore;
	readonly #database: DurableObjectTurnDatabase;
	readonly #inputGate: DurableObjectInputGate;
	readonly #kvStore: DurableObjectKvStore;
	readonly #sql: SqlStorageImplementation;
	readonly #transactionContext = new AsyncLocalStorage<TransactionFrame>();
	#activeTransaction: ActiveTransactionRoot | undefined;
	#asyncSavepointSequence = 0;
	#syncTransactionDepth = 0;

	constructor(
		database: DurableObjectTurnDatabase,
		inputGate: DurableObjectInputGate,
		alarmScheduler?: DurableObjectAlarmSynchronization,
	) {
		this.#database = database;
		this.#inputGate = inputGate;
		this.#alarmScheduler = alarmScheduler;
		this.#alarmStore = new DurableObjectAlarmStore(() =>
			this.#currentDatabase(),
		);
		this.#committedAlarmStore = new DurableObjectAlarmStore(() => database);
		this.#kvStore = new DurableObjectKvStore(() => this.#currentDatabase());
		this.kv = createSyncKvStorage(this.#kvStore);
		this.#sql = new SqlStorageImplementation(() => this.#currentDatabase());
		this.sql = this.#sql;
	}

	#activeFrame(): TransactionFrame | undefined {
		// A promise continuation that outlives its transaction runs as ordinary turn work, as it
		// does in workerd.
		const frame = this.#transactionContext.getStore();
		return frame?.status === "active" ? frame : undefined;
	}

	#currentDatabase(): RivetSynchronousSqliteExecutor {
		const frame = this.#activeFrame();
		if (frame !== undefined) return frame.database;
		if (this.#activeTransaction !== undefined) {
			// The input gate holds new events during storage.transaction(), but it cannot hold a
			// synchronous call from an event that was already running when the transaction began.
			throw new Error(
				"Synchronous storage cannot run while another event's storage.transaction() is open",
			);
		}
		return this.#database;
	}

	#transactionWait(): Promise<void> | undefined {
		const active = this.#activeTransaction;
		if (active === undefined) return undefined;
		if (this.#activeFrame()?.rootId === active.rootId) return undefined;
		return active.completion.then(() => this.#transactionWait());
	}

	// A write with `allowUnconfirmed` does not hold the output gate. Workerd supports it for put,
	// delete, setAlarm, and deleteAlarm, but not deleteAll.
	// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/io/actor-sqlite.c%2B%2B#L768-L866
	#write<Result>(options: unknown, write: () => Result): Result {
		return allowsUnconfirmed(options)
			? this.#database.runUnconfirmed(write)
			: write();
	}

	// SQLite-backed workerd runs storage operations synchronously and returns resolved promises,
	// so an un-awaited write keeps program order with later synchronous calls.
	// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/actor-state.c%2B%2B#L58-L66
	#run<Result>(operation: () => Result): Promise<Result> {
		try {
			const wait = this.#transactionWait();
			if (wait !== undefined) return wait.then(operation);
			return Promise.resolve(operation());
		} catch (error: unknown) {
			return Promise.reject(error);
		}
	}

	get<T = unknown>(
		key: string,
		options?: DurableObjectGetOptions,
	): Promise<T | undefined>;
	get<T = unknown>(
		keys: string[],
		options?: DurableObjectGetOptions,
	): Promise<Map<string, T>>;
	get<T = unknown>(
		keyOrKeys: string | number | string[],
		options?: DurableObjectGetOptions,
	): Promise<T | undefined | Map<string, T>> {
		return this.#run((): T | undefined | Map<string, T> => {
			assertStorageOptions(options);
			if (!Array.isArray(keyOrKeys)) {
				return this.#kvStore.get<T>(storageKey(keyOrKeys));
			}
			const entries: [string, T][] = [];
			for (const key of new Set(storageKeys(keyOrKeys))) {
				const value = this.#kvStore.get<T>(key);
				if (value !== undefined) entries.push([key, value]);
			}
			entries.sort(([left], [right]) => compareStorageKeys(left, right));
			return new Map(entries);
		});
	}

	list<T = unknown>(
		options?: DurableObjectListOptions,
	): Promise<Map<string, T>> {
		return this.#run(() => {
			assertStorageOptions(options);
			return new Map(this.#kvStore.list<T>(options));
		});
	}

	put<T>(
		key: string,
		value: T,
		options?: DurableObjectPutOptions,
	): Promise<void>;
	put<T>(
		entries: Record<string, T>,
		options?: DurableObjectPutOptions,
	): Promise<void>;
	put<T>(
		keyOrEntries: string | number | Record<string, T>,
		valueOrOptions?: T | DurableObjectPutOptions,
		options?: DurableObjectPutOptions,
	): Promise<void> {
		if (!isSingleStorageKey(keyOrEntries)) {
			return this.#putMultiple(keyOrEntries, valueOrOptions);
		}
		return this.#run(() => {
			assertStorageOptions(options);
			if (valueOrOptions === undefined) {
				throw new TypeError("put() called with undefined value.");
			}
			this.#write(options, () =>
				this.#kvStore.put(singleStorageKey(keyOrEntries), valueOrOptions),
			);
		});
	}

	#putMultiple(
		values: Record<string, unknown>,
		options: unknown,
	): Promise<void> {
		return this.#run(() => {
			assertStorageOptions(options);
			const entries = storageEntries(values);
			this.#write(options, () =>
				this.transactionSync(() => {
					for (const [key, value] of entries) this.#kvStore.put(key, value);
				}),
			);
		});
	}

	delete(key: string, options?: DurableObjectPutOptions): Promise<boolean>;
	delete(keys: string[], options?: DurableObjectPutOptions): Promise<number>;
	delete(
		keyOrKeys: string | number | string[],
		options?: DurableObjectPutOptions,
	): Promise<boolean | number> {
		return this.#run((): boolean | number => {
			assertStorageOptions(options);
			if (!Array.isArray(keyOrKeys)) {
				return this.#write(options, () =>
					this.#kvStore.delete(storageKey(keyOrKeys)),
				);
			}
			const keys = new Set(storageKeys(keyOrKeys));
			let count = 0;
			this.#write(options, () =>
				this.transactionSync(() => {
					for (const key of keys) {
						if (this.#kvStore.delete(key)) count += 1;
					}
				}),
			);
			return count;
		});
	}

	deleteAll(options?: DurableObjectPutOptions): Promise<void> {
		return this.#run(() => {
			assertStorageOptions(options);
			if (this.#activeFrame() !== undefined) {
				throw new Error("Cannot call deleteAll() within a transaction");
			}
			this.transactionSync(() => this.#kvStore.deleteAll());
			this.#sql.cancelCursors();
		}).then(() => this.#synchronizeAlarm());
	}

	// workerd's local development bookmarks advance on every call and persist with the database,
	// so later bookmarks sort after earlier ones, including across restarts.
	// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/io/actor-sqlite.c%2B%2B#L1150-L1192
	getCurrentBookmark(): Promise<string> {
		return this.#run(() => {
			const database = this.#currentDatabase();
			database.executeSync(createMetadataTableSql);
			const previous = database.executeSync(getBookmarkSql).rows[0]?.[0];
			const bookmark =
				typeof previous === "number" || typeof previous === "bigint"
					? Number(previous) + 1
					: 0;
			database.executeSync(setBookmarkSql, [bookmark]);
			return formatBookmark(bookmark);
		});
	}

	// One local database has nothing to catch up on, so every bookmark is already reached.
	// Workerd exposes this only under the experimental flag, so it stays out of the public
	// DurableObjectStorage type.
	// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/actor-state.h#L315-L318
	waitForBookmark(_bookmark: string): Promise<void> {
		return this.#run(() => undefined);
	}

	getAlarm(options?: DurableObjectGetAlarmOptions): Promise<number | null> {
		return this.#run(() => {
			assertStorageOptions(options);
			const record = this.#alarmStore.getRecord();
			return this.#alarmScheduler?.visibleAlarm === undefined
				? (record?.scheduledTime ?? null)
				: this.#alarmScheduler.visibleAlarm(record);
		});
	}

	setAlarm(
		scheduledTime: number | Date,
		options?: DurableObjectSetAlarmOptions,
	): Promise<void> {
		return this.#run(() => {
			assertStorageOptions(options);
			this.#alarmScheduler?.assertSupported();
			const time = normalizeAlarmTime(scheduledTime);
			this.#write(options, () => this.#alarmStore.set(time));
			return this.#markAlarmChanged();
		}).then((synchronize) => (synchronize ? this.#synchronizeAlarm() : undefined));
	}

	deleteAlarm(options?: DurableObjectSetAlarmOptions): Promise<void> {
		return this.#run(() => {
			assertStorageOptions(options);
			this.#write(options, () => this.#alarmStore.delete());
			return this.#markAlarmChanged();
		}).then((synchronize) => (synchronize ? this.#synchronizeAlarm() : undefined));
	}

	// Returns true when the alarm must be scheduled now. An asynchronous transaction schedules
	// it after its commit instead.
	#markAlarmChanged(): boolean {
		const frame = this.#activeFrame();
		if (frame?.kind !== "async") return true;
		frame.alarmState.dirty = true;
		return false;
	}

	async #synchronizeAlarm(): Promise<void> {
		if (this.#alarmScheduler === undefined) return;
		// The scheduler must see the alarm only after the write that set it committed.
		this.#database.commitTurn();
		await this.#alarmScheduler.synchronize(this.#committedAlarmStore.get());
	}

	sync(): Promise<void> {
		// Workerd's sync() resolves once every earlier write is durable.
		// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/actor-state.c%2B%2B#L780-L793
		return this.#run(() => undefined).then(() =>
			this.#database.waitForDurability(),
		);
	}

	transaction<T>(
		closure: (transaction: DurableObjectTransaction) => Promise<T>,
	): Promise<T> {
		if (typeof closure !== "function") {
			return Promise.reject(
				new TypeError("transaction closure must be a function"),
			);
		}
		const parent = this.#activeFrame();
		if (parent !== undefined) {
			if (parent.kind === "sync") {
				return Promise.reject(
					new Error(
						"Cannot start an asynchronous transaction inside transactionSync()",
					),
				);
			}
			return this.#runNestedAsyncTransaction(parent, closure);
		}
		// Workerd runs the callback in a critical section, so no other event starts until the
		// transaction ends. The gate also serializes transactions from events already running.
		// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/actor-state.c%2B%2B#L655-L666
		return this.#inputGate.runCriticalSection(() =>
			this.#runOuterAsyncTransaction(closure),
		);
	}

	async #runOuterAsyncTransaction<T>(
		closure: (transaction: DurableObjectTransaction) => Promise<T>,
	): Promise<T> {
		const database = this.#database.beginTransactionSync(
			undefined,
			"open-orange.durable-object.transaction",
		);
		const completion = Promise.withResolvers<void>();
		const rootId = Symbol("durable-object-transaction");
		const alarmState: TransactionAlarmState = { dirty: false };
		const frame: TransactionFrame = {
			alarmState,
			commit: () => {
				try {
					database.commitSync();
				} catch (error: unknown) {
					// Workerd resets the object when a transaction cannot commit.
					throw this.#database.breakObject(error);
				}
			},
			database,
			kind: "async",
			rollback: () => database.rollbackSync(),
			rootId,
			status: "active",
		};
		this.#activeTransaction = { completion: completion.promise, rootId };
		try {
			const result = await this.#transactionContext.run(frame, () =>
				this.#runTransactionClosure(frame, closure),
			);
			// A critical error inside the transaction broke the object, so the transaction fails
			// with it even when the closure caught the error and rolled back.
			const broken = this.#database.broken;
			if (broken !== undefined) throw broken;
			if (frame.status === "committed" && alarmState.dirty) {
				await this.#synchronizeAlarm();
			}
			return result;
		} finally {
			this.#activeTransaction = undefined;
			completion.resolve();
		}
	}

	async #runNestedAsyncTransaction<T>(
		parent: TransactionFrame,
		closure: (transaction: DurableObjectTransaction) => Promise<T>,
	): Promise<T> {
		const name = `_cf_async_savepoint_${this.#asyncSavepointSequence}`;
		this.#asyncSavepointSequence += 1;
		parent.database.executeSync(`SAVEPOINT ${name}`);
		const frame: TransactionFrame = {
			alarmState: parent.alarmState,
			commit: () => parent.database.executeSync(`RELEASE ${name}`),
			database: parent.database,
			kind: "async",
			rollback: () => {
				parent.database.executeSync(`ROLLBACK TO ${name}`);
				parent.database.executeSync(`RELEASE ${name}`);
			},
			rootId: parent.rootId,
			status: "active",
		};
		return await this.#transactionContext.run(frame, () =>
			this.#runTransactionClosure(frame, closure),
		);
	}

	async #runTransactionClosure<T>(
		frame: TransactionFrame,
		closure: (transaction: DurableObjectTransaction) => Promise<T>,
	): Promise<T> {
		const transaction = new DurableObjectTransactionImplementation(
			frame,
			this.#transactionOperations(),
		);
		try {
			const result = await closure(transaction);
			if (frame.status === "active") {
				frame.commit();
				frame.status = "committed";
			}
			return result;
		} catch (error: unknown) {
			if (frame.status === "active") {
				this.#rollbackWithoutMasking(frame.rollback);
				frame.status = "rolled-back";
			}
			throw error;
		}
	}

	#transactionOperations(): TransactionOperations {
		return {
			deleteAlarm: (options) => this.deleteAlarm(options),
			deleteMany: (keys, options) => this.delete(keys, options),
			deleteOne: (key, options) => this.delete(key, options),
			getAlarm: (options) => this.getAlarm(options),
			getMany: <T>(keys: string[], options?: DurableObjectGetOptions) =>
				this.get<T>(keys, options),
			getOne: <T>(key: string, options?: DurableObjectGetOptions) =>
				this.get<T>(key, options),
			list: <T>(options?: DurableObjectListOptions) => this.list<T>(options),
			putMany: (entries, options) => this.#putMultiple(entries, options),
			putOne: (key, value, options) => this.put(key, value, options),
			setAlarm: (scheduledTime, options) =>
				this.setAlarm(scheduledTime, options),
		};
	}

	transactionSync<T>(closure: () => T): T {
		if (typeof closure !== "function") {
			throw new TypeError("transactionSync closure must be a function");
		}
		const parent = this.#activeFrame();
		if (parent !== undefined) {
			return this.#nestedSynchronousTransaction(parent.database, closure);
		}
		const database = this.#currentDatabase();
		// Workerd runs transactionSync() as a savepoint inside the turn's implicit transaction, so
		// it becomes durable with the rest of the turn.
		// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/actor-state.c%2B%2B#L730-L776
		const frame: TransactionFrame = {
			alarmState: { dirty: false },
			commit: () => {},
			database,
			kind: "sync",
			rollback: () => {},
			rootId: Symbol("durable-object-sync-transaction"),
			status: "active",
		};
		try {
			const result = this.#transactionContext.run(frame, () =>
				this.#nestedSynchronousTransaction(database, closure),
			);
			frame.status = "committed";
			return result;
		} catch (error: unknown) {
			frame.status = "rolled-back";
			throw error;
		}
	}

	#nestedSynchronousTransaction<T>(
		database: RivetSynchronousSqliteExecutor,
		closure: () => T,
	): T {
		// Mirror workerd's nested synchronous-transaction savepoints, including
		// rolling back and releasing the savepoint before rethrowing.
		// https://github.com/cloudflare/workerd/blob/23263780e6ba38c7f230497a6abc1a4ff72124fb/src/workerd/api/actor-state.c%2B%2B#L730-L778
		const name = `_cf_sync_savepoint_${this.#syncTransactionDepth}`;
		this.#syncTransactionDepth += 1;
		database.executeSync(`SAVEPOINT ${name}`);
		try {
			const result = closure();
			database.executeSync(`RELEASE ${name}`);
			return result;
		} catch (error: unknown) {
			this.#rollbackWithoutMasking(() =>
				database.executeSync(`ROLLBACK TO ${name}`),
			);
			this.#rollbackWithoutMasking(() =>
				database.executeSync(`RELEASE ${name}`),
			);
			throw error;
		} finally {
			this.#syncTransactionDepth -= 1;
		}
	}

	#rollbackWithoutMasking(rollback: () => void): void {
		try {
			rollback();
		} catch {
			// The original closure or commit error is the transaction's observable
			// failure, matching workerd's rollbackNoThrow cleanup.
		}
	}
}

export function createDurableObjectStorage(
	database: DurableObjectTurnDatabase,
	inputGate: DurableObjectInputGate,
	alarmScheduler?: DurableObjectAlarmSynchronization,
): DurableObjectStorage {
	const target = new DurableObjectStorageImplementation(
		database,
		inputGate,
		alarmScheduler,
	);
	const storage = new Proxy(target, {
		get(storage, property): unknown {
			if (
				typeof property === "string" &&
				unimplementedStorageMembers.has(property)
			) {
				throw storageUnsupported(property);
			}
			// A member Cloudflare does not define reads as undefined, as on workerd, so a library can
			// probe the object to tell which SQLite client it was given.
			const value: unknown = Reflect.get(storage, property, storage);
			return typeof value === "function" ? value.bind(storage) : value;
		},
	});
	turnDatabases.set(storage, database);
	return storage;
}

const turnDatabases = new WeakMap<object, DurableObjectTurnDatabase>();

/**
 * The database under an object's storage, for Orange's own internal objects only. A D1 import commits
 * in its own explicit transactions, waits for each to be durable, and gives one long statement more
 * time than the turn's default timeout. User code never gets this.
 */
export function internalTurnDatabase(storage: object): DurableObjectTurnDatabase {
	const database = turnDatabases.get(storage);
	if (database === undefined) throw new Error("This storage has no Orange turn database");
	return database;
}

export const durableObjectDatabaseProvider: RivetDatabaseProvider = {
	[rivetSqliteDeferredCommits]: true,
	async createClient(
		context: RivetDatabaseProviderContext,
	): Promise<RivetSqliteDatabase> {
		const database = await context.nativeDatabaseProvider?.open(
			context.actorId,
		);
		if (database === undefined) {
			throw new Error(
				"The pinned RivetKit runtime did not provide native SQLite",
			);
		}
		if (
			typeof database.beginTransactionSync !== "function" ||
			typeof database.commitTicket !== "function" ||
			typeof database.execSync !== "function" ||
			typeof database.executeSync !== "function" ||
			typeof database.whenDurable !== "function"
		) {
			throw new Error(
				"The pinned RivetKit runtime does not support synchronous SQLite",
			);
		}
		return database;
	},
	onMigrate(): void {},
};
