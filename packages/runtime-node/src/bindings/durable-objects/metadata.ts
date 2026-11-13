import type { RivetSynchronousSqliteExecutor } from "../../internal/rivetkit.js";

/** Values that Orange keeps for an object in the object's own SQLite, beside user data. */
// `clone` names the row copy that filled a facet, and `fork` the fork that made it.
export type DurableObjectMetadataKey =
	| "clone"
	| "cloudflareImport"
	| "facet"
	| "fork"
	| "hibernation"
	| "name";

export const durableObjectMetadataTable = "_rivet_openorange_metadata";

// User SQL cannot reach `_rivet_` objects, and deleteAll() keeps them. See storage.ts and sync-kv.ts.
const metadataTable = durableObjectMetadataTable;
const tableExistsSql = `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '${metadataTable}'`;
const createTableSql = `CREATE TABLE IF NOT EXISTS ${metadataTable} (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID`;
const selectSql = `SELECT value FROM ${metadataTable} WHERE key = ?`;
const upsertSql = `INSERT INTO ${metadataTable} (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`;

/** Returns undefined when the object has no value for `key`. */
export function readDurableObjectMetadata(
	database: RivetSynchronousSqliteExecutor,
	key: DurableObjectMetadataKey,
): unknown {
	// The table exists only once a value was written, so objects without metadata keep an empty schema.
	if (database.executeSync(tableExistsSql).rows.length === 0) return undefined;
	const value = database.executeSync(selectSql, [key]).rows[0]?.[0];
	if (value === undefined) return undefined;
	if (typeof value !== "string") {
		throw new TypeError(`Durable Object metadata ${key} is invalid`);
	}
	return JSON.parse(value);
}

export function writeDurableObjectMetadata(
	database: RivetSynchronousSqliteExecutor,
	key: DurableObjectMetadataKey,
	value: unknown,
): void {
	database.executeSync(createTableSql);
	database.executeSync(upsertSql, [key, JSON.stringify(value)]);
}
