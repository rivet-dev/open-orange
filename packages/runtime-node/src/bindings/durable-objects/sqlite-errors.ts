import { errorMessage } from "../unknown-values.js";

function sqliteStatementDetails(error: unknown): object | undefined {
	if (!isObject(error) || Reflect.get(error, "group") !== "sqlite") return undefined;
	const metadata = Reflect.get(error, "metadata");
	if (!isObject(metadata)) return undefined;
	if (Reflect.get(error, "code") === "statement_failed") return metadata;
	// Remote transports retain their public error and add typed SQLite details.
	const statement = Reflect.get(metadata, "statement");
	return isObject(statement) ? statement : undefined;
}

function sqliteResultCode(error: unknown): number | undefined {
	const details = sqliteStatementDetails(error);
	const code = details === undefined ? undefined : Reflect.get(details, "code");
	return typeof code === "number" ? code : undefined;
}

/**
 * Whether a failed write is critical. SQLite rolls the whole transaction back for these codes,
 * so workerd breaks the object with the error, every later storage call rethrows it, and the
 * next request gets a fresh instance from durable state.
 * https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/util/sqlite.c%2B%2B#L680-L701
 */
export function isCriticalSqliteError(error: unknown): boolean {
	const code = sqliteResultCode(error);
	if (code === undefined) return false;
	const primary = code & 0xff;
	return (
		primary === SQLITE_FULL ||
		primary === SQLITE_IOERR ||
		primary === SQLITE_NOMEM ||
		primary === SQLITE_INTERRUPT
	);
}

const SQLITE_NOMEM = 7;
const SQLITE_INTERRUPT = 9;
const SQLITE_IOERR = 10;
const SQLITE_FULL = 13;

// RivetKit reports a failed statement as `sqlite.statement_failed`, with SQLite's message behind
// a transport prefix, and puts SQLite's own message and offset in the error's metadata. Workerd
// throws a plain Error that carries SQLite's message, the offset of the token SQLite blamed when
// it names one, and the result code.
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/sql.c%2B%2B#L152-L154
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/util/sqlite.c%2B%2B#L173-L186
export function sqlStatementError(error: unknown): unknown {
	const metadata = sqliteStatementDetails(error);
	if (metadata === undefined) return error;
	const reportedMessage = isObject(metadata) ? Reflect.get(metadata, "message") : undefined;
	const offset = isObject(metadata) ? Reflect.get(metadata, "offset") : undefined;
	const message = typeof reportedMessage === "string" ? reportedMessage : errorMessage(error);
	const located =
		typeof offset === "number" && Number.isSafeInteger(offset) && offset >= 0
			? `${message} at offset ${offset}`
			: message;
	const code = sqliteResultCode(error);
	return new Error(
		typeof code === "number" ? `${located}: ${sqliteCodeSuffix(code)}` : located,
	);
}

function isObject(value: unknown): value is object {
	return typeof value === "object" && value !== null;
}

// Workerd appends SQLite's result code name, and the extended name when it differs, for
// example "UNIQUE constraint failed: t.x: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_UNIQUE)".
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/util/sqlite.c%2B%2B#L173-L186
function sqliteCodeSuffix(code: number): string {
	const primary = SQLITE_PRIMARY_CODES[code & 0xff] ?? `SQLITE_UNKNOWN(${code & 0xff})`;
	const extended = SQLITE_EXTENDED_CODES[code];
	return extended === undefined || code === (code & 0xff)
		? primary
		: `${primary} (extended: ${extended})`;
}

// Primary result codes from https://www.sqlite.org/rescode.html.
const SQLITE_PRIMARY_CODES: Record<number, string> = {
	1: "SQLITE_ERROR",
	2: "SQLITE_INTERNAL",
	3: "SQLITE_PERM",
	4: "SQLITE_ABORT",
	5: "SQLITE_BUSY",
	6: "SQLITE_LOCKED",
	7: "SQLITE_NOMEM",
	8: "SQLITE_READONLY",
	9: "SQLITE_INTERRUPT",
	10: "SQLITE_IOERR",
	11: "SQLITE_CORRUPT",
	12: "SQLITE_NOTFOUND",
	13: "SQLITE_FULL",
	14: "SQLITE_CANTOPEN",
	15: "SQLITE_PROTOCOL",
	16: "SQLITE_EMPTY",
	17: "SQLITE_SCHEMA",
	18: "SQLITE_TOOBIG",
	19: "SQLITE_CONSTRAINT",
	20: "SQLITE_MISMATCH",
	21: "SQLITE_MISUSE",
	22: "SQLITE_NOLFS",
	23: "SQLITE_AUTH",
	24: "SQLITE_FORMAT",
	25: "SQLITE_RANGE",
	26: "SQLITE_NOTADB",
	27: "SQLITE_NOTICE",
	28: "SQLITE_WARNING",
};

// Extended codes that statements commonly return.
const SQLITE_EXTENDED_CODES: Record<number, string> = {
	275: "SQLITE_CONSTRAINT_CHECK",
	531: "SQLITE_CONSTRAINT_COMMITHOOK",
	787: "SQLITE_CONSTRAINT_FOREIGNKEY",
	1043: "SQLITE_CONSTRAINT_FUNCTION",
	1299: "SQLITE_CONSTRAINT_NOTNULL",
	1555: "SQLITE_CONSTRAINT_PRIMARYKEY",
	1811: "SQLITE_CONSTRAINT_TRIGGER",
	2067: "SQLITE_CONSTRAINT_UNIQUE",
	2323: "SQLITE_CONSTRAINT_VTAB",
	2579: "SQLITE_CONSTRAINT_ROWID",
	3091: "SQLITE_CONSTRAINT_DATATYPE",
	516: "SQLITE_ABORT_ROLLBACK",
	264: "SQLITE_READONLY_RECOVERY",
	1032: "SQLITE_READONLY_DBMOVED",
};

