import { assertFitsRivetCommit } from "../../internal/rivet-limits.js";
import { Buffer } from "node:buffer";
import { deserialize } from "node:v8";

import type { RivetSqliteStatement, RivetSynchronousSqliteExecutor } from "../../internal/rivetkit.js";
import type {
	SyncKvListOptions,
	SyncKvStorage,
} from "../../modules/cloudflare-workers/durable-object.js";
import { serializeUnshared } from "../../internal/v8-serialize.js";

const tableExistsSql =
	"SELECT name FROM sqlite_master WHERE type = 'table' AND name = '_cf_KV'";
const createTableSql =
	"CREATE TABLE IF NOT EXISTS _cf_KV (key TEXT PRIMARY KEY, value BLOB) WITHOUT ROWID";
const getSql = "SELECT value FROM _cf_KV WHERE key = ?";
const putSql =
	"INSERT INTO _cf_KV (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value";
const deleteSql = "DELETE FROM _cf_KV WHERE key = ?";
const listForwardSql = "SELECT key, value FROM _cf_KV ORDER BY key";
const listReverseSql = "SELECT key, value FROM _cf_KV ORDER BY key DESC";

const invalidatedIteratorMessage =
	"kv.list() iterator was invalidated because a new call to kv.list() was started. Only one kv.list() iterator can exist at a time.";

interface NormalizedListOptions {
	end?: string;
	limit?: number;
	prefix?: string;
	reverse: boolean;
	start?: string;
	startAfter?: string;
}

interface StoredEntry {
	bytes: Uint8Array;
	key: string;
}

function requireKey(value: unknown, label = "key"): string {
	if (typeof value !== "string") {
		throw new TypeError(`Storage ${label} must be a string`);
	}
	assertFitsRivetCommit(`Storage ${label}`, Buffer.byteLength(value, "utf8"));
	return value;
}

function optionalKey(value: unknown, label: string): string | undefined {
	return value === undefined ? undefined : requireKey(value, label);
}

function normalizeListOptions(
	options: SyncKvListOptions | undefined,
): NormalizedListOptions {
	if (options === undefined) return { reverse: false };
	if (
		typeof options !== "object" ||
		options === null ||
		Array.isArray(options)
	) {
		throw new TypeError("kv.list() options must be an object");
	}
	const start = optionalKey(options.start, "start");
	const startAfter = optionalKey(options.startAfter, "startAfter");
	if (start !== undefined && startAfter !== undefined) {
		throw new TypeError(
			"list() cannot be called with both start and startAfter values.",
		);
	}
	const end = optionalKey(options.end, "end");
	const prefix = optionalKey(options.prefix, "prefix");
	if (options.reverse !== undefined && typeof options.reverse !== "boolean") {
		throw new TypeError("list() reverse must be a boolean.");
	}
	// workerd reads the limit as an int, so it drops a fraction.
	const limit =
		typeof options.limit === "number" ? Math.trunc(options.limit) : options.limit;
	if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
		throw new TypeError("List limit must be positive.");
	}
	return {
		...(end === undefined ? {} : { end }),
		...(limit === undefined ? {} : { limit }),
		...(prefix === undefined ? {} : { prefix }),
		reverse: options.reverse ?? false,
		...(start === undefined ? {} : { start }),
		...(startAfter === undefined ? {} : { startAfter }),
	};
}

function asStoredBytes(value: unknown): Uint8Array {
	if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
	if (ArrayBuffer.isView(value)) {
		return Uint8Array.from(
			new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
		);
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
		return Uint8Array.from(value);
	}
	throw new Error("RivetKit SQLite returned an invalid stored KV value");
}

export function serializeStoredValue(key: string, value: unknown): Uint8Array {
	let bytes: Uint8Array;
	try {
		bytes = serializeUnshared(value);
	} catch (error: unknown) {
		throw new DOMException(
			error instanceof Error ? error.message : "Value could not be cloned.",
			"DataCloneError",
		);
	}
	// Cloudflare caps a key and value at 2 MiB together. Orange's bound is Rivet's commit size.
	assertFitsRivetCommit("A storage key and value together", Buffer.byteLength(key, "utf8") + bytes.byteLength);
	return bytes;
}

function deserializeStoredValue<T>(key: string, bytes: Uint8Array): T;
function deserializeStoredValue(key: string, bytes: Uint8Array): unknown {
	if (bytes.byteLength === 0) {
		throw new Error(`Stored value for key ${JSON.stringify(key)} is empty`);
	}
	try {
		return deserialize(bytes);
	} catch {
		throw new Error(`Stored value for key ${JSON.stringify(key)} is corrupt`);
	}
}

function compareKeys(left: string, right: string): number {
	return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function hasBytePrefix(key: string, prefix: string): boolean {
	const keyBytes = Buffer.from(key, "utf8");
	const prefixBytes = Buffer.from(prefix, "utf8");
	return (
		keyBytes.byteLength >= prefixBytes.byteLength &&
		keyBytes.subarray(0, prefixBytes.byteLength).equals(prefixBytes)
	);
}

function matchesOptions(key: string, options: NormalizedListOptions): boolean {
	if (options.start !== undefined && compareKeys(key, options.start) < 0) {
		return false;
	}
	if (
		options.startAfter !== undefined &&
		compareKeys(key, options.startAfter) <= 0
	) {
		return false;
	}
	if (options.end !== undefined && compareKeys(key, options.end) >= 0) {
		return false;
	}
	return options.prefix === undefined || hasBytePrefix(key, options.prefix);
}

class SyncKvListIterator<T> implements IterableIterator<[string, T]> {
	readonly #entries: StoredEntry[];
	readonly #generation: number;
	readonly #isCurrent: (generation: number) => boolean;
	#index = 0;
	#done: boolean;

	constructor(
		entries: StoredEntry[],
		generation: number,
		isCurrent: (generation: number) => boolean,
	) {
		this.#entries = entries;
		this.#generation = generation;
		this.#isCurrent = isCurrent;
		this.#done = entries.length === 0;
	}

	next(): IteratorResult<[string, T], undefined> {
		if (this.#done) return { done: true, value: undefined };
		if (!this.#isCurrent(this.#generation)) {
			throw new Error(invalidatedIteratorMessage);
		}
		const entry = this.#entries[this.#index];
		if (entry === undefined) {
			this.#done = true;
			return { done: true, value: undefined };
		}
		this.#index += 1;
		return {
			done: false,
			value: [entry.key, deserializeStoredValue<T>(entry.key, entry.bytes)],
		};
	}

	[Symbol.iterator](): IterableIterator<[string, T]> {
		return this;
	}
}

/** Prepare void KV intents using the same validation and serialization as ordinary puts. */
export function prepareDurableObjectPuts(entries: readonly (readonly [string, unknown])[]): RivetSqliteStatement[] {
	const writes = entries.map(([key, value]) => {
		const normalizedKey = requireKey(key);
		return { sql: putSql, params: [normalizedKey, serializeStoredValue(normalizedKey, value)] };
	});
	return writes.length === 0 ? [] : [{ sql: createTableSql }, ...writes];
}

export class DurableObjectKvStore {
	readonly #database: () => RivetSynchronousSqliteExecutor;
	#listGeneration = 0;

	constructor(database: () => RivetSynchronousSqliteExecutor) {
		this.#database = database;
	}

	#tableExists(): boolean {
		return this.#database().executeSync(tableExistsSql).rows.length > 0;
	}

	#ensureTable(): void {
		this.#database().executeSync(createTableSql);
	}

	get<T = unknown>(key: string): T | undefined {
		const normalizedKey = requireKey(key);
		if (!this.#tableExists()) return undefined;
		const rows = this.#database().executeSync(getSql, [normalizedKey]).rows;
		if (rows.length === 0) return undefined;
		if (rows.length !== 1 || rows[0]?.length !== 1) {
			throw new Error("RivetKit SQLite returned an invalid KV get result");
		}
		return deserializeStoredValue<T>(normalizedKey, asStoredBytes(rows[0][0]));
	}

	list<T = unknown>(options?: SyncKvListOptions): Iterable<[string, T]> {
		const normalized = normalizeListOptions(options);
		this.#listGeneration += 1;
		const generation = this.#listGeneration;
		if (!this.#tableExists()) return [];
		const rows = this.#database().executeSync(
			normalized.reverse ? listReverseSql : listForwardSql,
		).rows;
		const entries: StoredEntry[] = [];
		for (const row of rows) {
			if (row.length !== 2 || typeof row[0] !== "string") {
				throw new Error("RivetKit SQLite returned an invalid KV list result");
			}
			if (!matchesOptions(row[0], normalized)) continue;
			entries.push({ bytes: asStoredBytes(row[1]), key: row[0] });
			if (entries.length === normalized.limit) break;
		}
		return new SyncKvListIterator<T>(
			entries,
			generation,
			(candidate) => candidate === this.#listGeneration,
		);
	}

	put<T>(key: string, value: T): void {
		const normalizedKey = requireKey(key);
		const bytes = serializeStoredValue(normalizedKey, value);
		this.#ensureTable();
		this.#database().executeSync(putSql, [normalizedKey, bytes]);
	}

	delete(key: string): boolean {
		const normalizedKey = requireKey(key);
		this.#ensureTable();
		return this.#database().executeSync(deleteSql, [normalizedKey]).changes > 0;
	}

	deleteAll(): void {
		// Workerd resets the complete user storage namespace and, on the pinned
		// compatibility date, its alarm. RivetKit has no equivalent user-database
		// reset primitive, so Orange drops only non-Rivet schema objects here; the
		// storage layer reconciles the removed alarm with Rivet after commit.
		// https://github.com/cloudflare/workerd/blob/23263780e6ba38c7f230497a6abc1a4ff72124fb/src/workerd/api/actor-state.c%2B%2B#L556-L575
		this.#listGeneration += 1;
		const database = this.#database();
		database.executeSync("PRAGMA defer_foreign_keys = ON");
		const triggers = database.executeSync(
			"SELECT name, tbl_name FROM sqlite_master WHERE type = 'trigger' ORDER BY name",
		).rows;
		for (const row of triggers) {
			const name = userSchemaName(row[0]);
			const tableName = userSchemaName(row[1]);
			if (name !== undefined && tableName !== undefined) {
				database.executeSync(`DROP TRIGGER ${quoteIdentifier(name)}`);
			}
		}
		const schema = database.executeSync("PRAGMA table_list").rows;
		for (const type of ["view", "virtual", "table"] as const) {
			for (const row of schema) {
				if (row[0] !== "main" || row[2] !== type) continue;
				const name = userSchemaName(row[1]);
				if (name === undefined) continue;
				const objectType = type === "view" ? "VIEW" : "TABLE";
				database.executeSync(
					`DROP ${objectType} ${quoteIdentifier(name)}`,
				);
			}
		}
	}
}

function userSchemaName(value: unknown): string | undefined {
	if (typeof value !== "string") {
		throw new Error("RivetKit SQLite returned an invalid schema name");
	}
	return /^(?:sqlite_|_rivet_)/i.test(value) ? undefined : value;
}

function quoteIdentifier(name: string): string {
	return `"${name.replaceAll('"', '""')}"`;
}

class SyncKvStorageImplementation implements SyncKvStorage {
	readonly #store: DurableObjectKvStore;

	constructor(store: DurableObjectKvStore) {
		this.#store = store;
	}

	get<T = unknown>(key: string): T | undefined {
		return this.#store.get<T>(key);
	}

	list<T = unknown>(options?: SyncKvListOptions): Iterable<[string, T]> {
		return this.#store.list<T>(options);
	}

	put<T>(key: string, value: T): void {
		this.#store.put(key, value);
	}

	delete(key: string): boolean {
		return this.#store.delete(key);
	}
}

// Mirrors workerd's V8-backed `_cf_KV` store and one-live-list-iterator rule:
// https://github.com/cloudflare/workerd/blob/23263780e6ba38c7f230497a6abc1a4ff72124fb/src/workerd/api/sync-kv.c%2B%2B#L11-L111
export function createSyncKvStorage(
	store: DurableObjectKvStore,
): SyncKvStorage {
	return new SyncKvStorageImplementation(store);
}
