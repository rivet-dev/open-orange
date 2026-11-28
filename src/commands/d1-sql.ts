// Splits SQL into statements like Wrangler's `d1 execute`, which runs the
// statements as one D1 batch. Ported from Wrangler's splitter and trimmer.
// https://github.com/cloudflare/workers-sdk/blob/be87ff0382c53a294e948e49419d25d653c50e86/packages/wrangler/src/d1/splitter.ts#L18-L38
// https://github.com/cloudflare/workers-sdk/blob/be87ff0382c53a294e948e49419d25d653c50e86/packages/wrangler/src/d1/splitter.ts#L132-L262
// https://github.com/cloudflare/workers-sdk/blob/be87ff0382c53a294e948e49419d25d653c50e86/packages/wrangler/src/d1/trimmer.ts#L11-L37
export function splitSqlQuery(sql: string): string[] {
	const trimmedSql = trimSqlQuery(sql);
	if (!mayContainMultipleStatements(trimmedSql)) return [trimmedSql];
	const split = splitSqlIntoStatements(trimmedSql);
	return split.length === 0 ? [trimmedSql] : split;
}

function mayContainMultipleStatements(sql: string): boolean {
	const trimmed = sql.trimEnd();
	const semicolonIndex = trimmed.indexOf(";");
	return semicolonIndex !== -1 && semicolonIndex !== trimmed.length - 1;
}

// D1 runs the batch in a transaction, so the wrapping transaction of a
// `sqlite3 .dump` file is removed.
function trimSqlQuery(sql: string): string {
	if (!sql.includes("BEGIN TRANSACTION")) return sql;
	const trimmedSql = sql.replace("BEGIN TRANSACTION;", "").replace("COMMIT;", "");
	if (trimmedSql.includes("BEGIN TRANSACTION")) {
		throw new Error(
			"Orange could not process the provided SQL file, as it contains several transactions.\nD1 runs your SQL in a transaction for you.\nPlease export an SQL file from your SQLite database and try again.",
		);
	}
	return trimmedSql;
}

// A `;` only ends a statement outside a CREATE [TEMP|TEMPORARY] TRIGGER body - inside one
// it separates the trigger's own inner statements, up to the trigger's closing END. This
// mirrors sqlite3_complete()'s statement machine, which only enters that mode on CREATE
// TRIGGER itself, never on a bare BEGIN or a CASE expression. This file's previous BEGIN/CASE
// depth counter wrongly treated a parenthesized `CASE ... END`, or one followed by a comma, as
// a compound block too, which sqlite3_complete() itself never does.
// https://github.com/sqlite/sqlite/blob/version-3.46.0/src/complete.c#L104-L260
// Adapted from the same machine already ported in this repo for a different purpose:
// https://github.com/rivet-dev/open-orange/blob/3f14b96d687d852e36b271f5ab4219d7bee1dc5f/packages/runtime-node/src/bindings/durable-objects/storage.ts#L395-L440
function splitSqlIntoStatements(sql: string): string[] {
	const statements: string[] = [];
	let statement = "";
	const append = (text: string): void => {
		statement += text;
	};
	let inTriggerBody = false;
	// Saw CREATE, waiting for an optional TEMP/TEMPORARY and then TRIGGER.
	let afterCreate = false;
	// Inside a trigger body, the word just completed was END - only a `;` reached right
	// after that word (whitespace and comments aside) closes the trigger's own statement.
	let justSawEnd = false;
	let pendingWord = "";
	const endPendingWord = (): void => {
		if (pendingWord.length === 0) return;
		const word = pendingWord;
		pendingWord = "";
		if (inTriggerBody) {
			justSawEnd = word === "END";
			return;
		}
		if (word === "CREATE") {
			afterCreate = true;
			return;
		}
		if (afterCreate && (word === "TEMP" || word === "TEMPORARY")) return;
		if (afterCreate && word === "TRIGGER") {
			inTriggerBody = true;
			afterCreate = false;
			justSawEnd = false;
			return;
		}
		afterCreate = false;
	};
	let index = 0;
	while (index < sql.length) {
		const char = String.fromCodePoint(sql.codePointAt(index) ?? 0);
		index += char.length;
		const isIdentifierChar = /[A-Za-z0-9_]/.test(char);
		if (!isIdentifierChar) {
			endPendingWord();
			// Only whitespace and comments may sit between the trigger's own closing END
			// and its `;` - anything else (a CASE's END, say) means this was not that END.
			if (inTriggerBody && justSawEnd && char !== ";" && !/\s/.test(char)) {
				const startsLineComment = char === "-" && sql[index] === "-";
				const startsBlockComment = char === "/" && sql[index] === "*";
				if (!startsLineComment && !startsBlockComment) justSawEnd = false;
			}
		}
		switch (char) {
			case "'":
			case '"':
			case "`": {
				const end = endOfMarker(sql, index, char);
				append(char + sql.slice(index, end));
				index = end;
				break;
			}
			case "$": {
				let end = index;
				while (end < sql.length) {
					const next = sql[end] ?? "";
					end += 1;
					if (!isDollarQuoteIdentifier(next)) break;
				}
				const dollarQuote = `$${sql.slice(index, end)}`;
				index = end;
				append(dollarQuote);
				if (dollarQuote.endsWith("$")) {
					const close = endOfMarker(sql, index, dollarQuote);
					append(sql.slice(index, close));
					index = close;
				}
				break;
			}
			case "-":
				if (sql[index] === "-") {
					// A line comment ends at the newline, which the statement keeps.
					index = endOfMarker(sql, index + 1, "\n");
					append("\n");
					break;
				}
				append(char);
				continue;
			case "/":
				if (sql[index] === "*") {
					index = endOfMarker(sql, index + 1, "*/");
					break;
				}
				append(char);
				continue;
			case ";":
				if (inTriggerBody && !justSawEnd) {
					append(char);
				} else {
					statements.push(statement);
					statement = "";
					inTriggerBody = false;
					justSawEnd = false;
				}
				break;
			default:
				if (isIdentifierChar) pendingWord += char.toUpperCase();
				append(char);
				break;
		}
	}
	statements.push(statement);
	return statements.map((value) => value.trim()).filter((value) => value.length > 0);
}

// The index just past the next `marker`, or the end of the text.
function endOfMarker(sql: string, from: number, marker: string): number {
	const found = sql.indexOf(marker, from);
	return found === -1 ? sql.length : found + marker.length;
}

// A dollar-quote tag holds digits, underscores, and letters.
function isDollarQuoteIdentifier(char: string): boolean {
	return char !== "$" && (/[0-9_]/i.test(char) || char.toLowerCase() !== char.toUpperCase());
}
