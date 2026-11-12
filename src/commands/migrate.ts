import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { createClient, MigratorError, type BackfillResult } from "@rivet-dev/durable-object-migrator/client";
import ignore from "ignore";

import type { Theme } from "../cli/theme.js";
import { ExpectedFailure, exitWithOutcome } from "../cli/issue-report.js";
import { createTheme } from "../cli/theme.js";
import { requireDatabase, withDatabase } from "./d1.js";
import { docsRootUrl } from "./dev-output.js";
import { asExpectedFailure, copyD1Export, moveD1 } from "./migrate-d1.js";
import { loadWranglerApi, loadWranglerConfiguration, type ResolvedWranglerConfiguration } from "../config/load-wrangler.js";

export interface MigrateCommandIo {
	error(message: string): void;
	log(message: string): void;
}

const generatedConfigName = "wrangler.migrate.jsonc";
export const migrateGuideUrl = `${docsRootUrl}docs/migrate.mdx`;
const generatedEntrypoint = join(".open-orange", "migrate", "worker.mjs");
const defaultConcurrency = 8;
const progressEvery = 100;
// The handlers a Worker's default export can have besides fetch.
const workerHandlers = ["connect", "email", "queue", "scheduled", "tail", "tailStream", "trace"];

type MigrateSubcommand = "backfill" | "d1" | "prepare";

const migrateSubcommands: readonly MigrateSubcommand[] = ["prepare", "d1", "backfill"];

// Rows of a help section, with the descriptions in one column that always clears the longest flag.
function renderOptions(theme: Theme, rows: readonly [string, string][]): string[] {
	const width = Math.max(24, ...rows.map(([flags]) => flags.length + 2));
	return rows.map(([flags, description]) => `  ${theme.fg("orange", flags.padEnd(width))}${description}`);
}

const migrateEnvironment = [
	"ORANGE_MIGRATE_WORKER_URL  The Worker on Cloudflare. Its workers.dev URL works after cutover.",
	"WORKER_MIGRATOR_TOKEN      The value set on the Cloudflare Worker",
];

const globalOptionRows: [string, string][] = [
	["-e, --env <name>", "Environment from the Wrangler configuration"],
	["--cwd <dir>", "Run as if started in <dir>"],
];

/** Help for `orange migrate`, or for one of its commands. */
export function renderMigrateHelp(theme: Theme, subcommand?: MigrateSubcommand): string {
	const migrateGuide = `Guide: ${theme.hyperlink("Migration guide ↗", migrateGuideUrl)}`;
	const environment = (names: readonly string[]): string[] => [
		`\n${theme.bold("Environment")}`,
		...names.map((line) => `  ${theme.dim(line)}`),
	];
	const exitCodes = (codes: string): string[] => [`\n${theme.bold("Exit codes")}`, `  ${theme.dim(codes)}`];
	if (subcommand === "prepare") {
		return [
			theme.bold("open-orange migrate prepare"),
			"",
			"Get the Cloudflare Worker ready to move. Writes wrangler.migrate.jsonc and",
			".open-orange/migrate/worker.mjs, which wrap each SQLite-backed Durable Object class and D1",
			"binding. Your code does not change, and nothing deploys.",
			`\n${theme.bold("Options")}`,
			...renderOptions(theme, [["-c, --config <path>", "Wrangler configuration file"], ...globalOptionRows]),
			...exitCodes("0 prepared · 1 the config cannot move · 2 invalid arguments"),
			"",
			migrateGuide,
		].join("\n");
	}
	if (subcommand === "d1") {
		return [
			theme.bold("open-orange migrate d1 <database>"),
			"",
			"Move a D1 database from Cloudflare to the Orange Worker at --url with Cloudflare's export API.",
			"Writes fail from the start of the move until the switch. Reads fail during the export.",
			`\n${theme.bold("Options")}`,
			...renderOptions(theme, [
				["--url <url>", "The Orange Worker that receives the database"],
				["--replace", "Replace what Orange already has for this database"],
				["--file <path>", "Copy from this export file instead, with writes stopped. Needs no --url."],
				["--remote", "With --file: copy into the Rivet Engine in RIVET_ENDPOINT instead"],
				["--allow-real-as-integer", "With --file: copy a default-format export that turns 2.0 into 2"],
				["-c, --config <path>", "Wrangler configuration file"],
				...globalOptionRows,
			]),
			...environment([
				...migrateEnvironment,
				"CLOUDFLARE_API_TOKEN       Exports the database. Needs D1 edit permission.",
				"CLOUDFLARE_ACCOUNT_ID      The account of the database",
				"RIVET_ENDPOINT             With --file --remote: the Rivet Engine to copy into",
			]),
			...exitCodes("0 moved · 1 failed · 2 invalid arguments · 130 stopped"),
			"",
			migrateGuide,
		].join("\n");
	}
	if (subcommand === "backfill") {
		return [
			theme.bold("open-orange migrate backfill --url <url>"),
			"",
			"Move every Durable Object that got no traffic to the Orange Worker at --url.",
			`\n${theme.bold("Options")}`,
			...renderOptions(theme, [
				["--url <url>", "Any URL that reaches the Orange Worker"],
				["--concurrency <n>", `Objects that move at a time. Default ${defaultConcurrency}.`],
				["--dry-run", "Count each class's objects, moved or not. Moves nothing. Needs no --url."],
				["-c, --config <path>", "Wrangler configuration file"],
				...globalOptionRows,
			]),
			...environment([
				...migrateEnvironment,
				"CLOUDFLARE_API_TOKEN       Lists the objects. Needs a Workers read permission.",
				"CLOUDFLARE_ACCOUNT_ID      The account of the Worker",
			]),
			...exitCodes("0 done · 1 some objects did not move: run it again · 2 invalid arguments · 130 stopped"),
			"",
			migrateGuide,
		].join("\n");
	}
	return [
		theme.bold("open-orange migrate"),
		"",
		"Move SQLite-backed Durable Objects from Cloudflare to Orange with no downtime, and D1",
		"databases with a write freeze.",
		`\n${theme.bold("Commands")}`,
		...renderOptions(theme, [
			["prepare", "Generate a Wrangler config that wraps the Worker for the move"],
			["d1 <database> --url <url>", "Move a D1 database to <url>, with writes frozen during the move"],
			["backfill --url <url>", "Move every object that got no traffic to the Orange Worker at <url>"],
		]),
		"",
		`Run ${theme.bold("open-orange migrate <command> --help")} for the options of one command.`,
		...exitCodes("0 done · 1 failed · 2 unknown command or invalid arguments · 130 stopped by Ctrl-C or SIGTERM"),
		"",
		migrateGuide,
	].join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function migrationNames(migration: Record<string, unknown>, key: string): string[] {
	const names = migration[key];
	return Array.isArray(names) ? names.filter((name): name is string => typeof name === "string") : [];
}

export type DurableObjectStorage = "key-value" | "sqlite";

/**
 * The classes that exist after the whole migration history, by storage backend. A rename keeps the
 * backend, and a deleted class is gone. `loadWranglerConfiguration` has already validated the history.
 */
function currentClassBackends(migrations: unknown): Map<string, DurableObjectStorage> {
	const backends = new Map<string, DurableObjectStorage>();
	for (const migration of Array.isArray(migrations) ? migrations : []) {
		if (!isRecord(migration)) continue;
		for (const name of migrationNames(migration, "new_sqlite_classes")) backends.set(name, "sqlite");
		for (const name of migrationNames(migration, "new_classes")) backends.set(name, "key-value");
		// A transferred class keeps the backend it had in `from_script`, which this config does not
		// show. Orange's runtime treats it as SQLite, so this does too.
		for (const transfer of Array.isArray(migration.transferred_classes) ? migration.transferred_classes : []) {
			if (isRecord(transfer) && typeof transfer.to === "string") backends.set(transfer.to, "sqlite");
		}
		for (const rename of Array.isArray(migration.renamed_classes) ? migration.renamed_classes : []) {
			if (!isRecord(rename) || typeof rename.from !== "string" || typeof rename.to !== "string") continue;
			const backend = backends.get(rename.from);
			if (backend === undefined) continue;
			backends.delete(rename.from);
			backends.set(rename.to, backend);
		}
		for (const name of migrationNames(migration, "deleted_classes")) backends.delete(name);
	}
	return backends;
}

/**
 * The Durable Object classes of a Wrangler config by storage backend. With `environment`, the
 * migrations of that environment, as `orange dev -e` runs them.
 */
export async function readDurableObjectStorage(
	configPath: string,
	environment?: string,
): Promise<Map<string, DurableObjectStorage>> {
	const wrangler = await loadWranglerApi();
	const config = wrangler.unstable_readConfig(
		{ config: configPath, ...(environment === undefined ? {} : { env: environment }) },
		{ hideWarnings: true },
	);
	return currentClassBackends(isRecord(config) ? config.migrations : undefined);
}

/** What makes `orange migrate prepare` refuse a Worker. The Worker is accepted when each list is empty. */
export interface PrepareBlockers {
	noBundle: boolean;
	keyValueBacked: string[];
	// SQLite-backed classes with no Durable Object binding.
	unbound: string[];
}

/** `Cart`, `Cart and Lobby`, or `Cart, Lobby, and Room`. */
export function listNames(names: readonly string[]): string {
	if (names.length <= 2) return names.join(" and ");
	return `${names.slice(0, -1).join(", ")}, and ${names.at(-1)}`;
}

export function findPrepareBlockers(
	config: ResolvedWranglerConfiguration,
	backends: ReadonlyMap<string, DurableObjectStorage>,
): PrepareBlockers {
	const bound = new Set(config.durableObjects?.bindings.map((binding) => binding.className));
	const named = (storage: DurableObjectStorage): string[] =>
		[...backends].filter(([, backend]) => backend === storage).map(([name]) => name);
	return {
		keyValueBacked: named("key-value"),
		noBundle: config.noBundle,
		unbound: named("sqlite").filter((name) => !bound.has(name)),
	};
}

// The D1 half of the prepared Worker. The build copies it next to the CLI, so this path holds in a
// source checkout and in the package.
const d1CloudflareWorker = fileURLToPath(new URL("./d1-cloudflare-worker.js", import.meta.url));

// Exports the app as it is, with its Durable Object classes in `migratable()` and `/__migrate/*` and
// `/__migrate-d1/*` in front of its fetch handler. Every handler and object sees its D1 bindings
// through `withFencedD1`, which sends their queries to Orange once the database has moved. A class
// that a local `export const` names wins over the same name in `export *`.
function renderPreparedWorker(
	appEntrypoint: string,
	migratorWorker: string,
	classes: readonly string[],
	d1Bindings: readonly string[],
): string {
	const app = JSON.stringify(appEntrypoint);
	const objectClass = (name: string): string =>
		d1Bindings.length === 0
			? `app.${name}`
			: `class extends app.${name} {\n\tconstructor(ctx, env) {\n\t\tsuper(ctx, fence(env));\n\t}\n}`;
	return `// Generated by \`orange migrate prepare\`. Do not edit. Run the command again instead.
import { migratable, migrationRoute } from ${JSON.stringify(migratorWorker)};
import { d1MigrationRoute, withFencedD1 } from ${JSON.stringify(d1CloudflareWorker)};
import * as app from ${app};

export * from ${app};
const d1Bindings = ${JSON.stringify(d1Bindings)};
const fence = (env) => withFencedD1(env, { bindings: d1Bindings, token: env?.WORKER_MIGRATOR_TOKEN });
${classes.map((name) => `export const ${name} = migratable(${objectClass(name)});`).join("\n")}

const handler = app.default;
const route = (request, env) =>
	d1MigrationRoute(request, env, { bindings: d1Bindings, token: env.WORKER_MIGRATOR_TOKEN }) ??
	migrationRoute(request, env, { token: env.WORKER_MIGRATOR_TOKEN });
const notFound = () => new Response("Not Found", { status: 404 });

export default typeof handler === "function"
	? class extends handler {
			#unfencedEnv;
			constructor(ctx, env) {
				super(ctx, fence(env));
				this.#unfencedEnv = env;
			}
			fetch(request) {
				return route(request, this.#unfencedEnv) ?? (super.fetch ? super.fetch(request) : notFound());
			}
		}
	: {
			fetch(request, env, ctx) {
				return route(request, env) ?? (handler?.fetch ? handler.fetch(request, fence(env), ctx) : notFound());
			},
			...Object.fromEntries(
				${JSON.stringify(workerHandlers)}
					.filter((name) => typeof handler?.[name] === "function")
					.map((name) => [name, (event, env, ctx) => handler[name](event, fence(env), ctx)]),
			),
		};
`;
}

// Binding types whose data lives on Cloudflare. orange migrate moves only SQLite-backed Durable
// Objects and D1 databases, so the data of these stays where it is.
const dataBindingTypes: ReadonlySet<string> = new Set([
	"ai_search",
	"ai_search_namespace",
	"analytics_engine",
	"kv_namespace",
	"pipeline",
	"queue",
	"r2_bucket",
	"secrets_store_secret",
	"vectorize",
	"workflow",
]);

// For example `CACHE (kv_namespace)`, once per binding.
function bindingsWithDataThatStays(config: ResolvedWranglerConfiguration): string[] {
	return config.bindings.flatMap((binding) => {
		const type = binding.type === "unsupported" ? binding.bindingType : binding.type;
		return dataBindingTypes.has(type) ? [`${binding.binding} (${type})`] : [];
	});
}

// On Cloudflare, static assets answer a request before the Worker unless its path matches
// `run_worker_first`. A single-page-application fallback then answers the migrator's GETs with
// index.html and its POSTs with 405, so its routes must reach the Worker first.
const migratorRoutes = ["/__migrate/*", "/__migrate-d1/*"];

function withMigratorRoutesFirst(section: Record<string, unknown>): Record<string, unknown> {
	if (!isRecord(section.assets) || section.assets.run_worker_first === true) return section;
	const runWorkerFirst = section.assets.run_worker_first;
	const appRoutes: unknown[] = Array.isArray(runWorkerFirst) ? runWorkerFirst : [];
	return { ...section, assets: { ...section.assets, run_worker_first: [...appRoutes, ...migratorRoutes.filter((route) => !appRoutes.includes(route))] } };
}

// The generated files that the project's .gitignore does not ignore yet.
async function filesMissingFromGitignore(projectRoot: string, paths: readonly string[]): Promise<string[]> {
	const rules = await readFile(join(projectRoot, ".gitignore"), "utf8").catch(() => "");
	const matcher = ignore().add(rules);
	return paths.filter((path) => !matcher.ignores(path));
}

async function runPrepare(args: readonly string[], io: MigrateCommandIo, environment: string | undefined): Promise<number> {
	const { values } = parseArgs({
		args: [...args],
		options: { config: { short: "c", type: "string" } },
		strict: true,
	});
	const config = await loadWranglerConfiguration(configurationOptions(values.config, environment));
	if (config.configPath === undefined || config.entrypoint === undefined) {
		throw new ExpectedFailure("orange migrate prepare needs a Wrangler config with a Worker entrypoint.");
	}
	const wrangler = await loadWranglerApi();
	const { rawConfig } = wrangler.experimental_readRawConfig(values.config === undefined ? {} : { config: values.config });
	// `orange doctor` reports the same blockers, so keep the two in step.
	const backends = currentClassBackends(rawConfig.migrations);
	const blockers = findPrepareBlockers(config, backends);
	const reasons = [
		...(blockers.noBundle ? ["no_bundle is set. orange migrate prepare needs Wrangler to bundle the Worker, so remove no_bundle from the config."] : []),
		...(blockers.keyValueBacked.length === 0
			? []
			: [
					`${listNames(blockers.keyValueBacked)} ${blockers.keyValueBacked.length === 1 ? "is" : "are"} KV-backed. orange migrate moves only SQLite-backed classes (new_sqlite_classes), because Cloudflare gives a KV-backed class no way to export its data.`,
				]),
		...(blockers.unbound.length === 0
			? []
			: [
					`${listNames(blockers.unbound)} ${blockers.unbound.length === 1 ? "has" : "have"} no binding. The migrator reaches an object through its binding, so add one to durable_objects.bindings.`,
				]),
	];
	if (reasons.length > 0) {
		throw new ExpectedFailure(`orange migrate prepare refuses this Worker, and wrote nothing:\n${reasons.map((reason) => `- ${reason}`).join("\n")}\nSee ${migrateGuideUrl}.`);
	}
	const classes = [...backends].filter(([, backend]) => backend === "sqlite").map(([name]) => name);
	const d1Bindings = config.d1Databases.map((database) => database.binding);
	if (classes.length === 0 && d1Bindings.length === 0) {
		throw new ExpectedFailure(
			"This Worker has no SQLite-backed Durable Object classes and no D1 databases to migrate. Add classes to new_sqlite_classes, or D1 databases to d1_databases.",
		);
	}

	const entrypointPath = join(config.projectRoot, generatedEntrypoint);
	const toAppEntrypoint = relative(dirname(entrypointPath), config.entrypoint);
	await mkdir(dirname(entrypointPath), { recursive: true });
	await writeFile(
		entrypointPath,
		renderPreparedWorker(
			toAppEntrypoint.startsWith(".") ? toAppEntrypoint : `./${toAppEntrypoint}`,
			// An absolute path, so the app does not need the package. The file stays on this machine.
			fileURLToPath(import.meta.resolve("@rivet-dev/durable-object-migrator/worker")),
			classes,
			d1Bindings,
		),
	);
	const generatedConfig = join(config.projectRoot, generatedConfigName);
	await writeFile(
		generatedConfig,
		`// Generated by \`orange migrate prepare\`. Do not edit. Run the command again instead.\n${JSON.stringify(
			{
				...withMigratorRoutesFirst(rawConfig),
				// An environment's `assets` replaces the top-level one, so it needs the routes too.
				...(isRecord(rawConfig.env)
					? { env: Object.fromEntries(Object.entries(rawConfig.env).map(([name, section]) => [name, isRecord(section) ? withMigratorRoutesFirst(section) : section])) }
					: {}),
				main: `./${generatedEntrypoint.replaceAll("\\", "/")}`,
				// `find_additional_modules` searches below `base_dir`, which defaults to the directory of
				// `main`. The generated `main` lives elsewhere, so the app's directory stays explicit.
				...(rawConfig.find_additional_modules === true && rawConfig.base_dir === undefined
					? { base_dir: relative(config.projectRoot, dirname(config.entrypoint)).replaceAll("\\", "/") || "." }
					: {}),
			},
			null,
			"\t",
		)}\n`,
	);

	const theme = createTheme(process.stdout);
	const shown = relative(process.cwd(), generatedConfig);
	io.log(`${theme.fg("green", "✓")} Prepared ${[...classes, ...d1Bindings].join(", ")}. Your code did not change.`);
	const notMoved = bindingsWithDataThatStays(config);
	if (notMoved.length > 0) {
		io.log(`${theme.fg("yellow", "!")} Not moved: ${notMoved.join(", ")}. Their data stays on Cloudflare. See "What does not move" in docs/migrate.mdx.`);
	}
	const unignored = await filesMissingFromGitignore(config.projectRoot, [generatedConfigName, ".open-orange/"]);
	if (unignored.length > 0) {
		io.log(`${theme.fg("yellow", "!")} Add ${unignored.join(" and ")} to .gitignore. Prepare writes them again, and the Worker names a path on this machine.`);
	}
	io.log("");
	io.log("Deploy the prepared Worker to Cloudflare. Your users see no change:");
	const environmentFlag = environment === undefined ? "" : ` -e ${environment}`;
	io.log(`  wrangler secret put WORKER_MIGRATOR_TOKEN --config ${shown}${environmentFlag}`);
	io.log(`  wrangler deploy --config ${shown}${environmentFlag}`);
	return 0;
}

function configurationOptions(configPath: string | undefined, environment: string | undefined): { configPath?: string; environment?: string } {
	return { ...(configPath === undefined ? {} : { configPath }), ...(environment === undefined ? {} : { environment }) };
}

// Backfill reads the same settings as the Worker, so a project's `.dev.vars` is enough. The shell wins.
function backfillSetting(config: ResolvedWranglerConfiguration, name: string): string | undefined {
	const fromShell = process.env[name];
	if (fromShell !== undefined && fromShell !== "") return fromShell;
	for (const binding of config.bindings) {
		if (binding.type === "plain_text" && binding.binding === name && binding.value !== "") return binding.value;
	}
	return undefined;
}

function requireBackfillSetting(config: ResolvedWranglerConfiguration, name: string): string {
	const value = backfillSetting(config, name);
	if (value === undefined) throw new Error(`orange migrate backfill needs ${name}. Run \`orange migrate --help\`.`);
	return value;
}

async function readPosition(path: string): Promise<string | null> {
	try {
		return await readFile(path, "utf8");
	} catch (error: unknown) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
		throw error;
	}
}

// A rename, so a crash leaves the old position instead of half of a new one.
async function writePosition(path: string, position: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(`${path}.tmp`, position);
	await rename(`${path}.tmp`, path);
}

// Returns false when Orange already had the object's copy. An older Orange does not say, so it counts as copied.
async function wakeObject(origin: string, token: string, binding: string, target: { id: string } | { name: string }): Promise<boolean> {
	const url = new URL(`/__migrate/${encodeURIComponent(binding)}/wake`, origin);
	if ("name" in target) url.searchParams.set("name", target.name);
	else url.searchParams.set("id", target.id);
	const response = await fetch(url, { headers: { authorization: `Bearer ${token}` }, method: "POST" });
	const text = await response.text();
	if (!response.ok) {
		const internal = /"code":"migrate\.internal"/.test(text);
		throw Object.assign(new Error(`Orange refused the object (HTTP ${response.status}): ${text.slice(0, 500)}`), { internal });
	}
	try {
		const body: unknown = JSON.parse(text);
		return !(isRecord(body) && body.copied === false);
	} catch {
		return true;
	}
}

// An export holds the object's schema, then an INSERT for each row, KV value, and AUTOINCREMENT
// counter, and last the migrator's metadata row with the alarm. An object whose export has only
// schema and no alarm has no data on Cloudflare. The schema alone can be there, because the export
// starts the object, and many constructors run `CREATE TABLE IF NOT EXISTS`.
// https://github.com/rivet-dev/durable-object-migrator/blob/816c28b376e47b511f7ea7a635ab19995d84169a/src/worker.ts#L389-L392
// https://github.com/rivet-dev/durable-object-migrator/blob/816c28b376e47b511f7ea7a635ab19995d84169a/src/worker.ts#L559-L563
function isDataStatement(statement: string): boolean {
	if (statement.startsWith(`INSERT INTO "__do_meta"`)) return !statement.endsWith("('alarm', NULL);");
	return /^(?:INSERT|DELETE)\b/i.test(statement);
}

// Asks for only the first page of an export, without the client's read-ahead of page 2, so an
// export of more than one page never finishes here. An export that fits in one page does finish:
// the object on Cloudflare then marks itself moved, removes its alarm, and closes its WebSockets.
// That is safe, because the migrator still serves the export of a moved object, so the wake that
// follows, or a later run after a failed wake, copies it.
// https://github.com/rivet-dev/durable-object-migrator/blob/816c28b376e47b511f7ea7a635ab19995d84169a/src/client.ts#L120-L128
// https://github.com/rivet-dev/durable-object-migrator/blob/816c28b376e47b511f7ea7a635ab19995d84169a/src/worker.ts#L428-L445
async function hasNoDataOnCloudflare(workerUrl: string, token: string, binding: string, id: string): Promise<boolean> {
	const url = new URL(`/__migrate/${encodeURIComponent(binding)}/export`, workerUrl);
	url.searchParams.set("id", id);
	const response = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
	const text = await response.text();
	if (!response.ok) throw Object.assign(new Error(`Cloudflare refused the export of ${id} (HTTP ${response.status}): ${text.slice(0, 500)}`), { internal: false });
	const page = JSON.parse(text) as { cursor: string | null; statements: string[] };
	// An empty object fits in one page, so a second page means data.
	return page.cursor === null && !page.statements.some(isDataStatement);
}

// A failure in Orange's own code, so a bug report can help: Orange's copy failed inside Orange, or
// this command threw something other than a refusal or a network error.
function isInternalFailure(error: unknown): boolean {
	if (error instanceof MigratorError) return false;
	if (error instanceof Error && "internal" in error) return error.internal === true;
	return !(error instanceof TypeError && error.message === "fetch failed");
}

// A request that does not reach the wrapped Worker gets the app's answer, often a static asset's:
// a single-page-application fallback answers 200 with index.html.
function backfillFailureMessage(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	if (!(error instanceof MigratorError) || error.code !== "migrator.not_a_migrator") return message;
	return `${message} If the Worker serves static assets, they may answer before it: \`assets.run_worker_first\` in ${generatedConfigName} must list \`/__migrate/*\`. Run \`orange migrate prepare\` again and deploy ${generatedConfigName}.`;
}

// A wake without a target answers 400 from a migrating Orange, and something else from anything else.
async function checkDestination(origin: string, token: string, binding: string): Promise<void> {
	let response: Response;
	try {
		response = await fetch(new URL(`/__migrate/${encodeURIComponent(binding)}/wake`, origin), {
			headers: { authorization: `Bearer ${token}` },
			method: "POST",
		});
	} catch (error: unknown) {
		throw new Error(`Couldn't reach Orange at ${origin}: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (response.status === 400) return;
	if (response.status === 401) {
		throw new Error(`Orange at ${origin} refused WORKER_MIGRATOR_TOKEN. Use the same value on Cloudflare, on Orange, and here.`);
	}
	throw new Error(
		`${origin} did not answer as an Orange Worker that is migrating (HTTP ${response.status}). Set ORANGE_MIGRATE_WORKER_URL and WORKER_MIGRATOR_TOKEN on it, and pass its URL with --url.`,
	);
}

// Cloudflare's list API, the same that the backfill reads, with no Worker and no Orange.
function cloudflareListSettings(config: ResolvedWranglerConfiguration, scriptName: string) {
	return {
		accountId: requireBackfillSetting(config, "CLOUDFLARE_ACCOUNT_ID"),
		apiToken: requireBackfillSetting(config, "CLOUDFLARE_API_TOKEN"),
		// The same variable that Wrangler reads.
		...(process.env.CLOUDFLARE_API_BASE_URL === undefined ? {} : { apiUrl: process.env.CLOUDFLARE_API_BASE_URL }),
		scriptName,
	};
}

// `--dry-run`: counts the objects that Cloudflare lists for each class. An object that moved keeps
// its data on Cloudflare, so the count includes it: telling them apart would wake each object. It
// wakes no object, and it reads and writes no saved place.
async function countBackfill(configPath: string | undefined, io: MigrateCommandIo, environment: string | undefined): Promise<number> {
	const config = await loadWranglerConfiguration(configurationOptions(configPath, environment));
	const bindings = config.durableObjects?.bindings ?? [];
	if (config.workerName === undefined || bindings.length === 0) {
		throw new Error("orange migrate backfill needs a Wrangler config with a Worker name and Durable Object bindings.");
	}
	const cloudflare = cloudflareListSettings(config, config.workerName);
	// The client only lists here: `migrate` counts each ID that Cloudflare lists with data.
	const lister = createClient({ token: "", workerUrl: "http://unused.invalid" });
	for (const className of new Set(bindings.map((binding) => binding.className))) {
		let objects = 0;
		await lister.backfill({
			cloudflare: { ...cloudflare, className },
			migrate: async () => {
				objects += 1;
			},
			startAt: null,
			updateStartAt: () => undefined,
		});
		io.log(`${className}: ${objects} ${objects === 1 ? "object" : "objects"} on Cloudflare, including any that already moved to Orange. Dry run: nothing moved.`);
	}
	return 0;
}

async function runBackfill(args: readonly string[], io: MigrateCommandIo, environment: string | undefined): Promise<number> {
	const { values } = parseArgs({
		args: [...args],
		options: {
			concurrency: { type: "string" },
			config: { short: "c", type: "string" },
			"dry-run": { type: "boolean" },
			url: { type: "string" },
		},
		strict: true,
	});
	if (values["dry-run"] === true) return countBackfill(values.config, io, environment);
	if (values.url === undefined) throw new Error("orange migrate backfill needs the URL of the Orange Worker. Pass --url <url>.");
	const concurrency = values.concurrency === undefined ? defaultConcurrency : Number(values.concurrency);
	if (!Number.isInteger(concurrency) || concurrency < 1) {
		throw new Error(`--concurrency must be a whole number of at least 1, not ${values.concurrency}`);
	}
	const config = await loadWranglerConfiguration(configurationOptions(values.config, environment));
	const scriptName = config.workerName;
	const bindings = config.durableObjects?.bindings ?? [];
	if (scriptName === undefined || bindings.length === 0) {
		throw new Error("orange migrate backfill needs a Wrangler config with a Worker name and Durable Object bindings.");
	}
	const token = requireBackfillSetting(config, "WORKER_MIGRATOR_TOKEN");
	const workerUrl = requireBackfillSetting(config, "ORANGE_MIGRATE_WORKER_URL");
	const migrator = createClient({ token, workerUrl });
	const cloudflare = cloudflareListSettings(config, scriptName);

	const stop = new AbortController();
	const onSignal = (): void => {
		io.error("Stopping after the objects in progress. Run the command again to continue.");
		stop.abort();
	};
	process.once("SIGINT", onSignal);
	process.once("SIGTERM", onSignal);
	let failures = 0;
	let totalMoved = 0;
	let internalFailure: unknown;
	try {
		// One binding per class, because every binding of a class reaches the same objects.
		for (const className of new Set(bindings.map((binding) => binding.className))) {
			const binding = bindings.find((candidate) => candidate.className === className)?.binding ?? "";
			await checkDestination(values.url, token, binding);
			const positionPath = join(config.projectRoot, ".open-orange", "migrate", `backfill-${className}.json`);
			let moved = 0;
			const unnamed = new Set<string>();
			const alreadyMoved = new Set<string>();
			const empty = new Set<string>();
			let result: BackfillResult;
			try {
				result = await migrator.backfill({
					cloudflare: { ...cloudflare, className },
					concurrency,
					migrate: async ({ id }) => {
						const { name } = await migrator.resolve(binding, { id });
						// Without a name, Orange keys the copy by ID. An object that Orange already copied by
						// name, such as one that the app created on Orange, has an empty copy on Cloudflare,
						// and a copy by ID would only add a second, empty object.
						if (name === null && (await hasNoDataOnCloudflare(workerUrl, token, binding, id))) {
							empty.add(id);
							return;
						}
						if (!(await wakeObject(values.url ?? "", token, binding, name === null ? { id } : { name }))) {
							alreadyMoved.add(id);
							return;
						}
						if (name === null) unnamed.add(id);
						moved += 1;
						if (moved % progressEvery === 0) io.log(`${className}: moved ${moved}…`);
					},
					signal: stop.signal,
					startAt: await readPosition(positionPath),
					updateStartAt: (position) => writePosition(positionPath, position),
				});
			} catch (error: unknown) {
				if (stop.signal.aborted) return 130;
				throw error;
			}
			const counts = [
				`${moved} moved`,
				`${result.failed.length} failed`,
				`already moved: ${alreadyMoved.size}`,
				...(empty.size === 0 ? [] : [`no data on Cloudflare: ${empty.size}`]),
			];
			io.log(`${className}: ${counts.join(", ")}.`);
			if (unnamed.size > 0) {
				io.log(`${className}: ${unnamed.size} had no saved name, so they moved by ID. See ${migrateGuideUrl}#names.`);
			}
			for (const { error, id } of result.failed) {
				io.error(`  ${id}: ${backfillFailureMessage(error)}`);
				if (internalFailure === undefined && isInternalFailure(error)) internalFailure = error;
			}
			failures += result.failed.length;
			totalMoved += moved;
			// A finished run starts over next time, which finds objects that Cloudflare listed late.
			if (result.failed.length === 0) await rm(positionPath, { force: true });
		}
	} finally {
		process.off("SIGINT", onSignal);
		process.off("SIGTERM", onSignal);
	}
	if (failures > 0) {
		io.error(`${failures} objects did not move. Run the command again to retry them.`);
		if (internalFailure === undefined) return exitWithOutcome(1);
		// Last, so a bug report quotes it.
		io.error(`Orange failed on its own side: ${internalFailure instanceof Error ? internalFailure.message : String(internalFailure)}`);
		return 1;
	}
	// A run that moved nothing already confirms the move, so it needs no second run.
	if (totalMoved > 0) io.log("Run this command once more in a few minutes. Cloudflare lists new objects late.");
	return 0;
}

async function runD1(args: readonly string[], io: MigrateCommandIo, environment: string | undefined): Promise<number> {
	const { positionals, values } = parseArgs({
		allowPositionals: true,
		args: [...args],
		options: {
			config: { short: "c", type: "string" },
			file: { type: "string" },
			"allow-real-as-integer": { type: "boolean" },
			remote: { type: "boolean" },
			replace: { type: "boolean" },
			url: { type: "string" },
		},
		strict: true,
	});
	const [databaseName] = positionals;
	if (databaseName === undefined) throw new Error("orange migrate d1 needs a database. Pass its binding or name.");
	const configOption = configurationOptions(values.config, environment);
	if (values.file !== undefined) {
		// --remote copies into the database that `orange serve` uses.
		const config = await loadWranglerConfiguration({ deployed: values.remote === true, ...configOption });
		const database = requireDatabase(config, databaseName);
		return copyD1Export(
			database.binding,
			resolve(values.file),
			values.replace === true,
			values["allow-real-as-integer"] === true,
			(operation, vars) => withDatabase(config, database, values.remote === true, (connection) => operation(connection.origin), vars),
			io,
		);
	}
	if (values.url === undefined) {
		throw new Error("orange migrate d1 needs the URL of the Orange Worker. Pass --url <url>, or --file <export> to copy an export with writes stopped.");
	}
	// The deployed config names the database's ID on Cloudflare, not its local preview ID.
	const config = await loadWranglerConfiguration({ deployed: true, ...configOption });
	const database = requireDatabase(config, databaseName);
	const setting = (name: string): string => {
		const value = backfillSetting(config, name);
		if (value === undefined) throw new Error(`orange migrate d1 needs ${name}. Run \`orange migrate d1 --help\`.`);
		return value;
	};
	return moveD1(
		{
			binding: database.binding,
			cloudflare: {
				accountId: setting("CLOUDFLARE_ACCOUNT_ID"),
				apiToken: setting("CLOUDFLARE_API_TOKEN"),
				// The same variable that Wrangler reads.
				apiUrl: process.env.CLOUDFLARE_API_BASE_URL ?? "https://api.cloudflare.com/client/v4",
				databaseId: database.databaseId,
			},
			cloudflareUrl: setting("ORANGE_MIGRATE_WORKER_URL"),
			orangeUrl: values.url,
			replace: values.replace === true,
			token: setting("WORKER_MIGRATOR_TOKEN"),
		},
		io,
	);
}

// The options of every migrate command, and Wrangler's global options, that take a value.
const optionsWithValues: ReadonlySet<string> = new Set(["-c", "--config", "--concurrency", "--cwd", "-e", "--env", "--file", "--url"]);

function isMigrateSubcommand(value: string | undefined): value is MigrateSubcommand {
	return migrateSubcommands.some((name) => name === value);
}

// Wrangler's global options. `orange --cwd app -e staging migrate prepare` passes them before the
// command, and every migrate command takes them.
function takeGlobalOptions(args: readonly string[]): { cwd?: string; environment?: string; rest: string[] } {
	const result: { cwd?: string; environment?: string; rest: string[] } = { rest: [] };
	for (let index = 0; index < args.length; index += 1) {
		const token = args[index] ?? "";
		const [name, inline] = token.startsWith("--") && token.includes("=") ? [token.slice(0, token.indexOf("=")), token.slice(token.indexOf("=") + 1)] : [token, undefined];
		if (name !== "--cwd" && name !== "-e" && name !== "--env") {
			result.rest.push(token);
			continue;
		}
		const value = inline ?? args[index + 1];
		if (value === undefined || value === "") throw usageError(`${name} needs a value.`);
		if (inline === undefined) index += 1;
		if (name === "--cwd") result.cwd = value;
		else result.environment = value;
	}
	return result;
}

function usageError(message: string): Error {
	return Object.assign(new Error(message), { code: "ERR_PARSE_ARGS_INVALID_OPTION_VALUE" });
}

export async function runMigrateCommand(args: readonly string[], io: MigrateCommandIo): Promise<number> {
	const theme = createTheme(process.stdout);
	// The command is the first word that is not an option or an option's value.
	const index = args.findIndex((token, at) => !token.startsWith("-") && !optionsWithValues.has(args[at - 1] ?? ""));
	const subcommand = index === -1 ? undefined : args[index];
	const rest = index === -1 ? args : [...args.slice(0, index), ...args.slice(index + 1)];
	if (args.includes("--help") || args.includes("-h")) {
		if (subcommand !== undefined && !isMigrateSubcommand(subcommand)) {
			io.error(`Unknown orange migrate command: ${subcommand}. Run \`orange migrate --help\`.`);
			return 2;
		}
		io.log(renderMigrateHelp(theme, subcommand));
		return 0;
	}
	const originalWorkingDirectory = process.cwd();
	try {
		const globals = takeGlobalOptions(rest);
		if (globals.cwd !== undefined) process.chdir(resolve(globals.cwd));
		if (subcommand === "prepare") return await runPrepare(globals.rest, io, globals.environment);
		if (subcommand === "backfill") return await runBackfill(globals.rest, io, globals.environment);
		if (subcommand === "d1") return await runD1(globals.rest, io, globals.environment).catch((error: unknown) => Promise.reject(asExpectedFailure(error)));
		io.error(`Unknown orange migrate command: ${subcommand ?? "<none>"}. Run \`orange migrate --help\`.`);
		return 2;
	} catch (error: unknown) {
		io.error(error instanceof Error ? error.message : String(error));
		if (error instanceof ExpectedFailure) return exitWithOutcome(1);
		// node:util parseArgs refuses an unknown or malformed option. That is a usage error.
		const code = error instanceof Error && "code" in error ? String(error.code) : "";
		return code.startsWith("ERR_PARSE_ARGS_") ? 2 : 1;
	} finally {
		process.chdir(originalWorkingDirectory);
	}
}
