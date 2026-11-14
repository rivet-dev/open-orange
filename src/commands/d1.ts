import { existsSync, globSync, statSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, posix, resolve } from "node:path";

import {
	loadWranglerConfiguration,
	type D1DatabaseConfiguration,
	type ResolvedWranglerConfiguration,
} from "../config/load-wrangler.js";
import { ExpectedFailure, failureExitCode } from "../cli/issue-report.js";
import { resolveDeploymentStorage } from "../runtime/deployment.js";
import { spawnRuntime, type RuntimeProcess } from "../runtime/spawn.js";
import { rivetNamespaceOf } from "./serve.js";
import { booleanValue, optionValue, splitOption } from "./arguments.js";
import { splitSqlQuery } from "./d1-sql.js";
import { isRecord } from "../unknown-values.js";

interface D1CommandIo {
	error(message: string): void;
	isInteractive?: boolean;
	log(message: string): void;
}

export type D1CommandPath = "d1 execute" | "d1 migrations apply" | "d1 migrations list";

interface ParsedD1Arguments {
	command?: string;
	configPath?: string;
	cwd?: string;
	database: string;
	environment?: string;
	file?: string;
	json: boolean;
	// Targets the Rivet Engine in RIVET_ENDPOINT, which `orange serve` uses.
	remote: boolean;
}

interface QueryResult {
	meta: { duration?: number };
	results: Record<string, unknown>[];
	success: boolean;
}

const valueOptions = new Map([
	["-c", "config"],
	["--config", "config"],
	["--command", "command"],
	["--cwd", "cwd"],
	["-e", "env"],
	["--env", "env"],
	["--env-file", "ignored"],
	["--file", "file"],
	["--persist-to", "persist-to"],
	["--profile", "ignored"],
]);
const booleanOptions = new Set([
	"--install-skills",
	"--json",
	"--local",
	"--preview",
	"--remote",
	"-y",
	"--yes",
]);

export function parseD1Arguments(path: D1CommandPath, args: readonly string[]): ParsedD1Arguments {
	const commandWords = path.split(" ");
	const positionals: string[] = [];
	const values = new Map<string, string>();
	const flags = new Map<string, boolean>();
	for (let index = 0; index < args.length; index += 1) {
		const token = args[index];
		if (token === undefined) continue;
		if (!token.startsWith("-")) {
			positionals.push(token);
			continue;
		}
		const { name, value } = splitOption(token);
		const valueOption = valueOptions.get(name);
		if (valueOption !== undefined) {
			const option = optionValue(args, index, name, value);
			values.set(valueOption, option.value);
			index = option.index;
		} else if (booleanOptions.has(name)) {
			flags.set(name.replace(/^-y$/, "--yes"), booleanValue(name, value));
		} else if (name !== "--help" && name !== "-h") {
			throw new Error(`orange ${path} option ${name} is not implemented`);
		}
	}
	// The leading positionals name the command itself.
	for (const word of commandWords) {
		if (positionals[0] === word) positionals.shift();
	}
	if (flags.get("--preview") === true) {
		throw new Error(`orange ${path} --preview is not implemented`);
	}
	if (values.has("persist-to")) {
		throw new Error(
			`orange ${path} --persist-to is not implemented. Orange stores local D1 data under .open-orange in the project.`,
		);
	}
	if (flags.get("--install-skills") === true) {
		throw new Error(`orange ${path} --install-skills is not implemented`);
	}
	const database = positionals[0];
	if (database === undefined || positionals.length > 1) {
		throw new ExpectedFailure(`orange ${path} requires exactly one database name or binding`);
	}
	const command = values.get("command");
	const file = values.get("file");
	const configPath = values.get("config");
	const cwd = values.get("cwd");
	const environment = values.get("env");
	return {
		...(command === undefined ? {} : { command }),
		...(configPath === undefined ? {} : { configPath }),
		...(cwd === undefined ? {} : { cwd }),
		database,
		...(environment === undefined ? {} : { environment }),
		...(file === undefined ? {} : { file }),
		json: flags.get("--json") === true,
		remote: flags.get("--remote") === true,
	};
}

// The runtime runs this Worker against the database, so `orange d1` writes
// the same Durable Object storage that `orange dev` reads.
const databaseWorkerSource = `export default {
	async fetch(request, env) {
		const statements = await request.json();
		try {
			const results = await env.DB.batch(statements.map((sql) => env.DB.prepare(sql)));
			return Response.json(
				results.map((result) => ({
					meta: { duration: result.meta?.duration },
					results: result.results ?? [],
					success: result.success,
				})),
			);
		} catch (error) {
			return Response.json({ error: (error.cause ?? error).message }, { status: 500 });
		}
	},
};
`;

function isQueryResult(value: unknown): value is QueryResult {
	return (
		isRecord(value) &&
		isRecord(value.meta) &&
		typeof value.success === "boolean" &&
		Array.isArray(value.results) &&
		value.results.every(isRecord)
	);
}

interface DatabaseConnection {
	// Runs the statements as one batch: all of them commit, or none do.
	batch(statements: readonly string[]): Promise<QueryResult[]>;
	close(): Promise<void>;
	// The runtime that serves the database, with the binding `DB`.
	origin: string;
}

// A remote database is the one that `orange serve` reads from the Engine in
// RIVET_ENDPOINT. The runtime then only calls the Engine, and the deployed
// runner hosts the database actor.
async function openDatabase(
	config: ResolvedWranglerConfiguration,
	database: D1DatabaseConfiguration,
	remote: boolean,
	vars: Readonly<Record<string, string>>,
): Promise<DatabaseConnection> {
	const endpoint = remote ? process.env.RIVET_ENDPOINT : undefined;
	if (remote && (endpoint === undefined || endpoint.length === 0)) {
		throw new ExpectedFailure(
			"--remote needs RIVET_ENDPOINT. Set it to the Rivet Engine of the deployed app, such as RIVET_ENDPOINT=https://<namespace>:<token>@api.rivet.dev.",
		);
	}
	const temporaryDirectory = await mkdtemp(join(tmpdir(), "open-orange-d1-"));
	let runtime: RuntimeProcess | undefined;
	try {
		const bundlePath = join(temporaryDirectory, "database-worker.mjs");
		await writeFile(bundlePath, databaseWorkerSource);
		const { deploymentIdentity, rivetStoragePath } = await resolveDeploymentStorage(config);
		runtime = await spawnRuntime({
			bindingConfigurations: [
				{ binding: "DB", databaseId: database.databaseId, type: "d1" },
				...Object.entries(vars).map(([binding, value]) => ({ binding, type: "plain_text" as const, value })),
			],
			builtAt: new Date(),
			bundlePath,
			deploymentIdentity,
			host: "127.0.0.1",
			normalizedConfiguration: "{}",
			port: 0,
			projectRoot: config.projectRoot,
			...(endpoint === undefined
				? { rivetNamespace: "default" }
				: {
						rivetClientOnly: true,
						rivetEndpoint: endpoint,
						rivetNamespace: rivetNamespaceOf(endpoint),
					}),
			rivetStoragePath,
			startupTimeoutMs: 60_000,
			stdout: "stderr",
		});
	} catch (error: unknown) {
		await rm(temporaryDirectory, { force: true, recursive: true });
		throw error;
	}
	const origin = `http://127.0.0.1:${runtime.port}`;
	const started = runtime;
	return {
		origin,
		async batch(statements): Promise<QueryResult[]> {
			const response = await fetch(origin, {
				body: JSON.stringify(statements),
				method: "POST",
			});
			const body: unknown = await response.json();
			if (!response.ok) {
				const message = isRecord(body) ? body.error : undefined;
				throw new Error(typeof message === "string" ? message : "D1 query failed");
			}
			if (!Array.isArray(body) || !body.every(isQueryResult)) {
				throw new Error("D1 returned an invalid result");
			}
			return body;
		},
		async close(): Promise<void> {
			try {
				await started.stop();
			} finally {
				await rm(temporaryDirectory, { force: true, recursive: true });
			}
		},
	};
}

export async function withDatabase<Value>(
	config: ResolvedWranglerConfiguration,
	database: D1DatabaseConfiguration,
	remote: boolean,
	operation: (database: DatabaseConnection) => Promise<Value>,
	vars: Readonly<Record<string, string>> = {},
): Promise<Value> {
	const local = await openDatabase(config, database, remote, vars);
	try {
		return await operation(local);
	} finally {
		await local.close();
	}
}

function requireConfigPath(config: ResolvedWranglerConfiguration): string {
	if (config.configPath === undefined) {
		throw new Error(
			"No configuration file found. Create a wrangler.jsonc file to define your D1 database.",
		);
	}
	return config.configPath;
}

function findDatabase(
	config: ResolvedWranglerConfiguration,
	name: string,
): D1DatabaseConfiguration | undefined {
	return config.d1Databases.find(
		(database) => database.databaseName === name || database.binding === name,
	);
}

export function requireDatabase(
	config: ResolvedWranglerConfiguration,
	name: string,
): D1DatabaseConfiguration {
	const database = findDatabase(config, name);
	if (database === undefined) {
		throw new ExpectedFailure(
			`Couldn't find a D1 DB with the name or binding '${name}' in your ${basename(requireConfigPath(config))} file.`,
		);
	}
	return database;
}

// Emoji take two terminal columns, and a variation selector takes none.
function displayWidth(value: string): number {
	let width = 0;
	for (const char of value) {
		if (char !== "\uFE0F") width += /\p{Extended_Pictographic}/u.test(char) ? 2 : 1;
	}
	return width;
}

// Renders rows like Wrangler's logger.table.
function renderTable(rows: readonly Record<string, string>[]): string {
	const columns = Object.keys(rows[0] ?? {});
	const widths = columns.map((column) =>
		Math.max(displayWidth(column), ...rows.map((row) => displayWidth(row[column] ?? ""))),
	);
	const line = (left: string, middle: string, right: string): string =>
		left + widths.map((width) => "─".repeat(width + 2)).join(middle) + right;
	const cells = (values: string[]): string =>
		`│ ${values
			.map((value, index) => value + " ".repeat((widths[index] ?? 0) - displayWidth(value)))
			.join(" │ ")} │`;
	return [
		line("┌", "┬", "┐"),
		cells(columns),
		line("├", "┼", "┤"),
		...rows.map((row) => cells(columns.map((column) => row[column] ?? ""))),
		line("└", "┴", "┘"),
	].join("\n");
}

// https://github.com/cloudflare/workers-sdk/blob/be87ff0382c53a294e948e49419d25d653c50e86/packages/wrangler/src/d1/execute.ts#L105-L200
async function executeCommand(
	parsed: ParsedD1Arguments,
	config: ResolvedWranglerConfiguration,
	io: D1CommandIo,
): Promise<number> {
	if (parsed.file !== undefined && parsed.command !== undefined) {
		throw new ExpectedFailure("Error: can't provide both --command and --file.");
	}
	const sql =
		parsed.file !== undefined
			? await readFile(resolve(parsed.file), "utf8")
			: parsed.command;
	if (sql === undefined) {
		throw new Error(
			'Missing required option --command or --file. Provide a SQL command inline with --command="<SQL>", or a path to a SQL file with --file=<path>.',
		);
	}
	const database = requireDatabase(config, parsed.database);
	if (!parsed.json) {
		io.log(
			parsed.remote
				? `🌀 Executing on remote database ${parsed.database} (${database.databaseId}) in RIVET_ENDPOINT:`
				: `🌀 Executing on local database ${parsed.database} (${database.databaseId}) from .open-orange:`,
		);
	}
	const results = await withDatabase(config, database, parsed.remote, (local) =>
		local.batch(splitSqlQuery(sql)),
	);
	if (parsed.json || io.isInteractive !== true) {
		io.log(JSON.stringify(results, null, 2));
		return 0;
	}
	io.log(
		`🚣 ${results.length} command${results.length === 1 ? "" : "s"} executed successfully.`,
	);
	for (const result of results) {
		if (result.results.length > 0) {
			io.log(
				renderTable(
					result.results.map((row) =>
						Object.fromEntries(Object.entries(row).map(([key, value]) => [key, String(value)])),
					),
				),
			);
		}
	}
	return 0;
}

interface MigrationsConfiguration {
	directory: string;
	directoryConfigured: boolean;
	pattern: string;
	table: string;
}

function normalizeRelativePath(path: string): string {
	const normalized = posix.normalize(path.replace(/\\/g, "/"));
	return normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
}

// https://github.com/cloudflare/workers-sdk/blob/be87ff0382c53a294e948e49419d25d653c50e86/packages/wrangler/src/d1/migrations/helpers.ts#L53-L113
function resolveMigrationsConfiguration(
	configPath: string,
	database: D1DatabaseConfiguration | undefined,
): MigrationsConfiguration {
	const configFile = basename(configPath);
	if (database?.migrationsPattern !== undefined && database.migrationsDir === undefined) {
		throw new Error(
			`You have set \`migrations_pattern: "${database.migrationsPattern}"\` in your ${configFile} file but have not set \`migrations_dir\` for this D1 binding.`,
		);
	}
	const directory = normalizeRelativePath(database?.migrationsDir ?? "./migrations");
	let pattern = "*.sql";
	if (database?.migrationsPattern !== undefined) {
		const configured = normalizeRelativePath(database.migrationsPattern);
		if (directory !== "." && !configured.startsWith(`${directory}/`)) {
			throw new Error(
				`The configured \`migrations_pattern: "${database.migrationsPattern}"\` in your ${configFile} file must start with \`${directory}/\` to match \`"migrations_dir": "${directory}"\`.`,
			);
		}
		pattern = directory === "." ? configured : configured.slice(directory.length + 1);
	}
	return {
		directory: resolve(dirname(configPath), directory),
		directoryConfigured: database?.migrationsDir !== undefined,
		pattern,
		table: database?.migrationsTable ?? "d1_migrations",
	};
}

// Migrations run in the order of the leading number of their first path
// segment, then by name.
// https://github.com/cloudflare/workers-sdk/blob/be87ff0382c53a294e948e49419d25d653c50e86/packages/wrangler/src/d1/migrations/helpers.ts#L351-L404
function compareMigrationPaths(left: string, right: string): number {
	const leftSegments = left.split("/");
	const rightSegments = right.split("/");
	for (let index = 0; index < Math.min(leftSegments.length, rightSegments.length); index += 1) {
		const leftSegment = leftSegments[index] ?? "";
		const rightSegment = rightSegments[index] ?? "";
		const leftNumber = Number.parseInt(leftSegment.split("_")[0] ?? "", 10);
		const rightNumber = Number.parseInt(rightSegment.split("_")[0] ?? "", 10);
		if (leftNumber !== rightNumber) {
			if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) {
				return leftNumber - rightNumber;
			}
			if (Number.isFinite(leftNumber)) return -1;
			if (Number.isFinite(rightNumber)) return 1;
		}
		if (leftSegment !== rightSegment) return leftSegment < rightSegment ? -1 : 1;
	}
	return leftSegments.length - rightSegments.length;
}

function migrationNames(migrations: MigrationsConfiguration): string[] {
	return globSync(migrations.pattern, { cwd: migrations.directory })
		.map((path) => path.split("\\").join("/"))
		.filter((path) => statSync(join(migrations.directory, path)).isFile())
		.sort(compareMigrationPaths);
}

function escapeIdentifier(identifier: string): string {
	return `"${identifier.replace(/"/g, '""')}"`;
}

// Prepares the migrations table and returns the migrations it has not
// recorded, in order.
// https://github.com/cloudflare/workers-sdk/blob/be87ff0382c53a294e948e49419d25d653c50e86/packages/wrangler/src/d1/migrations/helpers.ts#L156-L170
async function unappliedMigrations(
	local: DatabaseConnection,
	migrations: MigrationsConfiguration,
): Promise<string[]> {
	const table = escapeIdentifier(migrations.table);
	await local.batch([
		`CREATE TABLE IF NOT EXISTS ${table}(
		id         INTEGER PRIMARY KEY AUTOINCREMENT,
		name       TEXT UNIQUE,
		applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
);`,
	]);
	const [applied] = await local.batch([`SELECT * FROM ${table} ORDER BY id`]);
	const appliedNames = new Set(applied?.results.map((row) => String(row.name)));
	return migrationNames(migrations).filter((name) => !appliedNames.has(name));
}

// https://github.com/cloudflare/workers-sdk/blob/be87ff0382c53a294e948e49419d25d653c50e86/packages/wrangler/src/d1/migrations/apply.ts#L70-L227
async function migrationsCommand(
	path: "d1 migrations apply" | "d1 migrations list",
	parsed: ParsedD1Arguments,
	config: ResolvedWranglerConfiguration,
	io: D1CommandIo,
): Promise<number> {
	const configPath = requireConfigPath(config);
	const found = findDatabase(config, parsed.database);
	const migrations = resolveMigrationsConfiguration(configPath, found);
	if (!existsSync(migrations.directory)) {
		io.error(
			`No migrations folder found.${
				migrations.directoryConfigured
					? ""
					: ` Set \`migrations_dir\` in your ${basename(configPath)} file to choose a different path.`
			}`,
		);
		throw new ExpectedFailure(`No migrations present at ${migrations.directory}.`);
	}
	const database = requireDatabase(config, parsed.database);
	return withDatabase(config, database, parsed.remote, async (local) => {
		const pending = await unappliedMigrations(local, migrations);
		if (pending.length === 0) {
			io.log("✅ No migrations to apply!");
			return 0;
		}
		io.log("Migrations to be applied:");
		if (path === "d1 migrations list") {
			io.log(renderTable(pending.map((name) => ({ Name: name }))));
			return 0;
		}
		io.log(renderTable(pending.map((name) => ({ name }))));
		const statuses = new Map(pending.map((name) => [name, "🕒️"]));
		for (const name of pending) {
			// Each migration and its record run as one batch, so a failure rolls
			// back the whole migration and stops before the next one.
			const sql = `${await readFile(join(migrations.directory, name), "utf8")}
INSERT INTO ${escapeIdentifier(migrations.table)} (name)
values ('${name.replace(/'/g, "''")}');`;
			let failure: string | undefined;
			try {
				await local.batch(splitSqlQuery(sql));
			} catch (error: unknown) {
				failure = error instanceof Error ? error.message : String(error);
			}
			statuses.set(name, failure === undefined ? "✅" : "❌");
			io.log(
				renderTable(
					pending.map((entry) => ({ name: entry, status: statuses.get(entry) ?? "" })),
				),
			);
			if (failure !== undefined) {
				io.error(`Migration ${name} failed with the following errors:`);
				io.error(failure);
				return 1;
			}
		}
		return 0;
	});
}

export async function runD1Command(
	path: D1CommandPath,
	args: readonly string[],
	io: D1CommandIo,
): Promise<number> {
	let json = false;
	try {
		const parsed = parseD1Arguments(path, args);
		json = parsed.json;
		const originalWorkingDirectory = process.cwd();
		process.chdir(resolve(parsed.cwd ?? originalWorkingDirectory));
		try {
			// --remote reaches the database that `orange serve` uses.
			const config = await loadWranglerConfiguration({
				deployed: parsed.remote,
				...(parsed.configPath === undefined ? {} : { configPath: parsed.configPath }),
				...(parsed.environment === undefined ? {} : { environment: parsed.environment }),
			});
			return path === "d1 execute"
				? await executeCommand(parsed, config, io)
				: await migrationsCommand(path, parsed, config, io);
		} finally {
			process.chdir(originalWorkingDirectory);
		}
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		if (json) {
			io.log(JSON.stringify({ error: { text: message } }, null, 2));
		} else {
			io.error(message);
		}
		return failureExitCode(error);
	}
}
