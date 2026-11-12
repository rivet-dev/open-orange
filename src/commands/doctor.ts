import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

import packageJson from "../../package.json" with { type: "json" };
import { aiApiKeyVariable, aiBaseUrlVariable, openRouterApiKeyVariable } from "../../packages/runtime-node/src/bindings/ai/backend.js";
import { r2S3SettingsFromEnvironment } from "../../packages/runtime-node/src/bindings/r2/s3-backend.js";
import { parseDevVars } from "../../packages/runtime-node/src/bindings/secrets-store.js";
import { mergeRuntimeSettings, workerVarSettings } from "../../packages/runtime-node/src/internal/runtime-settings.js";
import {
	assertPinnedRivetKitBuild,
	discoverInstalledRivetKitBuild,
	PINNED_RIVETKIT_VERSION,
} from "../../packages/runtime-node/src/internal/rivetkit-build.js";
import { defaultUnsupportedBindingAlternative } from "../../packages/runtime-node/src/bindings/unsupported.js";
import { engineLogDiskBudget, engineLogDiskVariable } from "../../packages/runtime-node/src/internal/ports.js";
import { sandboxProviderFromEnvironment } from "../../packages/runtime-node/src/modules/cloudflare-sandbox/providers.js";
import { bundleWorker } from "../build/bundle-worker.js";
import { runtimeModuleRewrites } from "../build/rewrite-module-imports.js";
import { exitWithOutcome } from "../cli/issue-report.js";
import { type Color, padVisible, type Theme, createTheme } from "../cli/theme.js";
import { loadWranglerConfiguration, type ResolvedWranglerConfiguration } from "../config/load-wrangler.js";
import { localDeploymentStoragePath } from "../runtime/deployment.js";
import { type BindingDescription, type BindingSupport, describeBindings, docsRootUrl, moduleDocsUrl, renderBrand } from "./dev-output.js";
import { rivetMcpStatus, type RivetMcpStatus } from "./mcp.js";
import { type DurableObjectStorage, findPrepareBlockers, listNames, migrateGuideUrl, readDurableObjectStorage } from "./migrate.js";

// `ok` passes, `action` is something to set up before a feature works, and
// `fail` means `orange dev` cannot start.
type CheckStatus = "action" | "fail" | "ok";

interface Check {
	id: string;
	title: string;
	status: CheckStatus;
	detail: string;
	// The next step. Set for actions and failures.
	hint?: string;
	// The page that explains the setup. Set for some actions and failures.
	docs?: string;
}

interface DoctorArguments {
	configPath?: string;
	cwd?: string;
	environment?: string;
	host: string;
	json: boolean;
	port: number;
	strict: boolean;
}

interface DoctorIo {
	log(message: string): void;
	error(message: string): void;
}

class UsageError extends Error {}

function parseDoctorArguments(args: readonly string[]): DoctorArguments {
	const parsed: DoctorArguments = { host: "127.0.0.1", json: false, port: 8787, strict: false };
	for (let index = 0; index < args.length; index += 1) {
		const token = args[index] ?? "";
		const separator = token.indexOf("=");
		const name = token.startsWith("--") && separator !== -1 ? token.slice(0, separator) : token;
		const inline = token.startsWith("--") && separator !== -1 ? token.slice(separator + 1) : undefined;
		const value = (): string => {
			if (inline !== undefined) return inline;
			const next = args[index + 1];
			if (next === undefined || next.startsWith("-")) throw new UsageError(`${name} needs a value`);
			index += 1;
			return next;
		};
		if (name === "doctor") continue;
		if (name === "--json") parsed.json = true;
		else if (name === "--strict") parsed.strict = true;
		else if (name === "-c" || name === "--config") parsed.configPath = value();
		else if (name === "-e" || name === "--env") parsed.environment = value();
		else if (name === "--cwd") parsed.cwd = value();
		else if (name === "--ip" || name === "--host") parsed.host = value();
		else if (name === "--port") {
			const port = Number(value());
			if (!Number.isInteger(port) || port < 0 || port > 65_535) {
				throw new UsageError("--port must be an integer from 0 to 65535");
			}
			parsed.port = port;
		} else throw new UsageError(`open-orange doctor does not accept ${token}`);
	}
	return parsed;
}

function checkNode(): Check {
	const range = packageJson.engines.node;
	const major = Number(process.versions.node.split(".")[0]);
	const minimum = Number(/>=\s*(\d+)/.exec(range)?.[1] ?? 0);
	const below = Number(/<\s*(\d+)/.exec(range)?.[1] ?? Number.POSITIVE_INFINITY);
	return major >= minimum && major < below
		? { detail: process.versions.node, id: "node", status: "ok", title: "Node.js" }
		: {
				detail: `${process.versions.node} is outside ${range}`,
				hint: `Install Node.js ${minimum}.`,
				id: "node",
				status: "fail",
				title: "Node.js",
			};
}

function checkRivetKit(): Check {
	try {
		assertPinnedRivetKitBuild(discoverInstalledRivetKitBuild());
		return { detail: `${PINNED_RIVETKIT_VERSION} · engine binary ready`, id: "rivetkit", status: "ok", title: "RivetKit" };
	} catch (error: unknown) {
		// A failed require adds "Require stack:" and one path per line, so the check shows the first line.
		const message = error instanceof Error ? error.message : String(error);
		return {
			detail: message.split("\n", 1)[0]?.trim() ?? message,
			hint: "Reinstall open-orange so the pinned RivetKit packages are installed.",
			id: "rivetkit",
			status: "fail",
			title: "RivetKit",
		};
	}
}

async function checkBundle(config: ResolvedWranglerConfiguration): Promise<Check> {
	const title = "Bundle";
	if (config.entrypoint === undefined) {
		return { detail: "assets-only Worker", id: "bundle", status: "ok", title };
	}
	// A custom build can have side effects, so doctor leaves it to orange dev.
	if (config.build !== undefined) {
		return { detail: `skipped: orange dev runs \`${config.build.command}\` first`, id: "bundle", status: "ok", title };
	}
	const directory = await mkdtemp(join(tmpdir(), "open-orange-doctor-"));
	try {
		const bundle = await bundleWorker({
			entrypoint: config.entrypoint,
			moduleRewrites: runtimeModuleRewrites(),
			moduleRules: config.moduleRules,
			outputPath: join(directory, "worker.mjs"),
		});
		return {
			detail: `${relative(process.cwd(), config.entrypoint)} · ${Math.ceil(bundle.bytes.byteLength / 1024)} KB`,
			id: "bundle",
			status: "ok",
			title,
		};
	} catch (error: unknown) {
		return {
			detail: error instanceof Error ? error.message : String(error),
			hint: "Fix the import or build error above.",
			id: "bundle",
			status: "fail",
			title,
		};
	} finally {
		await rm(directory, { force: true, recursive: true });
	}
}

// The settings that the runtime reads: the shell, with the Worker's vars over it. The vars include
// the entries of `.dev.vars`, or of `.env` when there is no `.dev.vars`, as `orange dev` loads them.
function runtimeEnvironment(config: ResolvedWranglerConfiguration): Record<string, string | undefined> {
	return { ...mergeRuntimeSettings(process.env, workerVarSettings(config.bindings)) };
}

// A Secrets Store secret reads `.dev.vars`, then the environment, by its binding name.
function localSecret(projectRoot: string, environment: Record<string, string | undefined>, name: string): string | undefined {
	const path = join(projectRoot, ".dev.vars");
	const fromFile = existsSync(path) ? parseDevVars(readFileSync(path, "utf8")).get(name) : undefined;
	return fromFile ?? environment[name];
}

// The settings that the runtime reads for Browser Rendering and Send Email.
const browserCdpVariable = "ORANGE_BROWSER_CDP_URL";
const smtpUrlVariable = "ORANGE_EMAIL_SMTP_URL";

// The check that tells whether a binding that needs a service has its setting.
function backendCheckId(type: string, binding: string): string | undefined {
	const prefixes: Record<string, string> = { ai: "ai", browser: "browser", send_email: "email" };
	return prefixes[type] === undefined ? undefined : `${prefixes[type]}:${binding}`;
}

// The scheme and host of a URL, without its credentials, path, or query.
function shownHost(url: string): string | undefined {
	try {
		const parsed = new URL(url);
		return `${parsed.protocol}//${parsed.host}`;
	} catch {
		return undefined;
	}
}

function checkBackends(config: ResolvedWranglerConfiguration): Check[] {
	const environment = runtimeEnvironment(config);
	const checks: Check[] = [];
	for (const binding of config.bindings) {
		if (binding.type === "ai") {
			const keyed = Boolean(environment[aiApiKeyVariable] || environment[openRouterApiKeyVariable]);
			const custom = Boolean(environment[aiBaseUrlVariable]);
			checks.push(
				keyed || custom
					? { detail: custom ? `env.${binding.binding} · ${environment[aiBaseUrlVariable]}` : `env.${binding.binding} · OpenRouter`, id: `ai:${binding.binding}`, status: "ok", title: "Workers AI" }
					: {
							detail: `env.${binding.binding} needs an API key`,
							docs: `${docsRootUrl}docs/modules/workers-ai.mdx`,
							hint: `Set ${openRouterApiKeyVariable}, or ${aiApiKeyVariable} with ${aiBaseUrlVariable}, in .dev.vars.`,
							id: `ai:${binding.binding}`,
							status: "action",
							title: "Workers AI",
						},
			);
		} else if (binding.type === "browser") {
			const endpoint = environment[browserCdpVariable];
			checks.push(
				endpoint
					? { detail: `env.${binding.binding} · ${shownHost(endpoint) ?? browserCdpVariable}`, id: `browser:${binding.binding}`, status: "ok", title: "Browser" }
					: {
							detail: `env.${binding.binding} has no Chrome DevTools endpoint, so its calls throw`,
							docs: `${docsRootUrl}docs/modules/browser-rendering.mdx`,
							hint: `Set ${browserCdpVariable} in .dev.vars to a CDP endpoint, such as Browserbase or Browserless.`,
							id: `browser:${binding.binding}`,
							status: "action",
							title: "Browser",
						},
			);
		} else if (binding.type === "send_email") {
			const id = `email:${binding.binding}`;
			const docs = `${docsRootUrl}docs/modules/email.mdx`;
			const server = environment[smtpUrlVariable];
			const host = server ? shownHost(server) : undefined;
			if (!server) {
				checks.push({
					detail: `env.${binding.binding} has no SMTP server, so its calls throw`,
					docs,
					hint: `Set ${smtpUrlVariable} in .dev.vars to your SMTP server, such as Amazon SES or Resend.`,
					id,
					status: "action",
					title: "Send Email",
				});
			} else if (host === undefined || !/^smtps?:\/\//.test(host)) {
				// The runner refuses this value when it binds env.EMAIL.
				checks.push({
					detail: `${smtpUrlVariable} must be a URL that starts with smtp:// or smtps://`,
					docs,
					hint: `Set ${smtpUrlVariable} to a URL such as smtp://user:password@smtp.example.com:587.`,
					id,
					status: "fail",
					title: "Send Email",
				});
			} else {
				checks.push({ detail: `env.${binding.binding} · ${host}`, id, status: "ok", title: "Send Email" });
			}
		} else if (binding.type === "secrets_store_secret") {
			const id = `secret:${binding.binding}`;
			checks.push(
				localSecret(config.projectRoot, environment, binding.binding) !== undefined
					? { detail: `env.${binding.binding} · .dev.vars or environment`, id, status: "ok", title: "Secrets Store" }
					: {
							detail: `env.${binding.binding} has no local value, so get() throws`,
							docs: `${docsRootUrl}docs/modules/secrets-store.mdx`,
							hint: `Set ${binding.binding} in .dev.vars.`,
							id,
							status: "action",
							title: "Secrets Store",
						},
			);
		} else if (binding.type === "r2_bucket") {
			const id = `r2:${binding.binding}`;
			try {
				const settings = r2S3SettingsFromEnvironment(binding.bucketName, environment);
				checks.push({
					detail: `env.${binding.binding} · ${settings === undefined ? "Rivet Actor" : settings.endpoint}`,
					id,
					status: "ok",
					title: "R2 Bucket",
				});
			} catch (error: unknown) {
				checks.push({
					detail: error instanceof Error ? error.message : String(error),
					docs: `${docsRootUrl}docs/modules/r2.mdx`,
					hint: "Set the missing variables in .dev.vars, or remove the endpoint to store objects locally.",
					id,
					status: "fail",
					title: "R2 Bucket",
				});
			}
		}
	}
	const usesSandbox = (config.durableObjects?.classes ?? []).some((entry) => entry.container !== undefined);
	if (usesSandbox) {
		try {
			const provider = sandboxProviderFromEnvironment(environment);
			checks.push({ detail: `${provider.name} provider`, id: "sandbox", status: "ok", title: "Sandbox" });
		} catch (error: unknown) {
			checks.push({
				detail: error instanceof Error ? error.message : String(error),
				docs: `${docsRootUrl}docs/modules/sandbox.mdx`,
				hint: "Set the provider key in .dev.vars, or unset ORANGE_SANDBOX_PROVIDER to use the local provider.",
				id: "sandbox",
				status: "action",
				title: "Sandbox",
			});
		}
	}
	return checks;
}

// Listens on the port and closes at once. Port 0 gets a free port from the OS.
function tryListen(host: string, port: number): Promise<{ error: NodeJS.ErrnoException } | { port: number }> {
	return new Promise((resolveListen) => {
		const server = createServer();
		server.once("error", (error: NodeJS.ErrnoException) => resolveListen({ error }));
		server.listen(port, host, () => {
			const address = server.address();
			const bound = typeof address === "object" && address !== null ? address.port : port;
			server.close(() => resolveListen({ port: bound }));
		});
	});
}

// The next free port above `port`, so the hint names one that works. The OS picks one when the
// ports nearby are all taken.
async function freePortNear(host: string, port: number): Promise<number | undefined> {
	for (let candidate = port + 1; candidate <= Math.min(port + 20, 65_535); candidate += 1) {
		const result = await tryListen(host, candidate);
		if ("port" in result) return result.port;
	}
	const result = await tryListen(host, 0);
	return "port" in result ? result.port : undefined;
}

async function checkPort(host: string, port: number): Promise<Check> {
	const address = `${host}:${port}`;
	const result = await tryListen(host, port);
	if (!("error" in result)) return { detail: `${address} is free`, id: "port", status: "ok", title: "Port" };
	const { error } = result;
	const free = error.code === "EADDRINUSE" ? await freePortNear(host, port) : undefined;
	return {
		detail: error.code === "EADDRINUSE" ? `${address} is in use` : `${address}: ${error.message}`,
		hint: free === undefined ? "Stop the other server, or pass another --port." : `Stop the other server, or run orange dev --port ${free}. Port ${free} is free.`,
		id: "port",
		status: "fail",
		title: "Port",
	};
}

// The disk of the storage directory where `orange dev` keeps this Worker's Engine data. The same
// rule as the Engine's start, so doctor passes only when `orange dev` starts.
function checkDisk(storagePath: string): Check {
	let budget: ReturnType<typeof engineLogDiskBudget>;
	try {
		budget = engineLogDiskBudget(storagePath);
	} catch (error: unknown) {
		return {
			detail: `Couldn't read the free disk space for the Rivet Engine: ${error instanceof Error ? error.message : String(error)}`,
			hint: "Check that you can read and write .open-orange/ in the project. orange dev fails the same way.",
			id: "disk",
			status: "fail",
			title: "Disk",
		};
	}
	const size = (bytes: number): string =>
		bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GiB` : `${Math.floor(bytes / 1024 ** 2)} MiB`;
	if (budget.problem !== undefined) {
		return {
			detail: budget.problem,
			hint: budget.configured
				? `Set ${engineLogDiskVariable} to fewer bytes, unset it to let Orange size the log, or free disk space.`
				: "Free disk space where the project is, then run orange doctor again.",
			id: "disk",
			status: "fail",
			title: "Disk",
		};
	}
	return {
		detail: `${size(budget.availableBytes)} free · Rivet Engine log up to ${size(budget.capBytes)}${budget.configured ? ` from ${engineLogDiskVariable}` : ""}`,
		id: "disk",
		status: "ok",
		title: "Disk",
	};
}

// Orange's SQLite, from RivetKit, is built without SQLITE_ENABLE_UPDATE_DELETE_LIMIT, so it rejects
// `DELETE ... LIMIT` and `UPDATE ... LIMIT`. chanfana before 3.1.0 deletes a row with
// `DELETE ... RETURNING * LIMIT 1`, so every D1 delete endpoint of such an app fails on Orange.
// The installed version is the one that runs, so doctor reads it and not the range in package.json.
function checkChanfana(config: ResolvedWranglerConfiguration): Check | undefined {
	if (config.d1Databases.length === 0) return undefined;
	let version: string;
	try {
		const manifest: unknown = JSON.parse(readFileSync(join(config.projectRoot, "node_modules", "chanfana", "package.json"), "utf8"));
		if (typeof manifest !== "object" || manifest === null || !("version" in manifest) || typeof manifest.version !== "string") return undefined;
		version = manifest.version;
	} catch {
		return undefined;
	}
	const [major = 0, minor = 0] = version.split(".").map(Number);
	if (major > 3 || (major === 3 && minor >= 1)) return undefined;
	return {
		detail: `chanfana ${version} deletes with DELETE ... RETURNING * LIMIT 1, which Orange's D1 rejects with near "LIMIT": syntax error`,
		docs: `${docsRootUrl}docs/modules/d1.mdx`,
		hint: "Upgrade chanfana to 3.1.0 or later, which deletes without LIMIT.",
		id: "chanfana",
		status: "action",
		title: "chanfana",
	};
}

const labelWidth = 14;

// The human output fits a terminal this wide. A value with no spaces can still run past it.
const outputWidth = 100;

// Splits `text` at spaces into lines of at most `width` characters.
function wrapWords(text: string, width: number): string[] {
	const lines: string[] = [];
	let current = "";
	for (const word of text.split(" ")) {
		if (current !== "" && current.length + 1 + word.length > width) {
			lines.push(current);
			current = word;
		} else {
			current = current === "" ? word : `${current} ${word}`;
		}
	}
	return [...lines, current];
}

// `text` wrapped to the output width, each line `indent` columns in and colored by `paint`.
function indented(text: string, indent: number, paint: (line: string) => string): string[] {
	return wrapWords(text, outputWidth - indent).map((line) => `${" ".repeat(indent)}${paint(line)}`);
}

// The label of a docs link at the end of a row, in a terminal that shows hyperlinks.
const docsLabel = "docs ↗";

// The full URL on its own line, for output that cannot show a hyperlink, such as a pipe. The
// indent shrinks so that the URL still fits.
function urlLines(theme: Theme, url: string, indent: number): string[] {
	if (theme.hyperlinks) return [];
	return [`${" ".repeat(Math.max(0, Math.min(indent, outputWidth - url.length)))}${theme.link(url)}`];
}

// A hint and its docs link together: the link ends the last hint line in a terminal, and is the
// next line everywhere else.
function hintLines(theme: Theme, hint: string, docs: string | undefined, indent: number, color: Color): string[] {
	const link = docs !== undefined && theme.hyperlinks ? ` ${theme.hyperlink(docsLabel, docs)}` : "";
	const lines = wrapWords(hint, outputWidth - indent - (link === "" ? 0 : docsLabel.length + 1)).map(
		(line) => `${" ".repeat(indent)}${theme.fg(color, line)}`,
	);
	if (link !== "") lines[lines.length - 1] += link;
	return [...lines, ...(docs === undefined ? [] : urlLines(theme, docs, indent))];
}

function renderCheck(theme: Theme, check: Check): string {
	const gutter =
		check.status === "ok" ? theme.fg("green", "✓") : check.status === "action" ? theme.fg("yellow", "!") : theme.fg("red", "×");
	const [first = "", ...rest] = wrapWords(check.detail, outputWidth - 2 - labelWidth);
	const lines = [
		`${padVisible(gutter, 2)}${padVisible(theme.fg("subtle", check.title), labelWidth)}${theme.fg("white", first)}`,
		...rest.map((line) => `${" ".repeat(2 + labelWidth)}${theme.fg("white", line)}`),
	];
	if (check.hint !== undefined) lines.push(...hintLines(theme, check.hint, check.docs, 2 + labelWidth, "muted"));
	return lines.join("\n");
}

function renderSummary(theme: Theme, checks: readonly Check[]): string {
	const failures = checks.filter((check) => check.status === "fail").length;
	const actions = checks.filter((check) => check.status === "action").length;
	if (failures > 0) {
		return `${theme.fg("red", "×")} ${theme.bold(theme.fg("white", `${failures} ${failures === 1 ? "check" : "checks"} to fix before orange dev can start`))}`;
	}
	if (actions > 0) {
		return `${theme.fg("orange", "●")} ${theme.bold(theme.fg("white", `Ready for orange dev`))} ${theme.fg("subtle", `· ${actions} ${actions === 1 ? "thing" : "things"} to set up`)}`;
	}
	return `${theme.fg("orange", "●")} ${theme.bold(theme.fg("white", "Ready for orange dev"))}`;
}

// A command to run after doctor, and what it does.
interface NextStep {
	command: string;
	does: string;
}

function nextSteps(failures: number, config: ResolvedWranglerConfiguration | undefined, classes: ClassMoves): NextStep[] {
	if (failures > 0) return [{ command: "orange doctor", does: "Check again after you fix each check marked ×" }];
	const hasDataToMove = classes.moves.length > 0 || (config?.d1Databases.length ?? 0) > 0;
	return [
		{ command: "orange dev", does: "Run the Worker on Rivet Actors on this machine" },
		...(hasDataToMove && classes.refusal === undefined
			? [{ command: "orange migrate --help", does: "Move Durable Object and D1 data from Cloudflare" }]
			: []),
	];
}

// Shown until an agent configuration names the Rivet MCP. JSON gets the `mcp` field instead.
const mcpStep: NextStep = { command: "orange mcp", does: "Connect your coding agent to the Rivet MCP" };

function renderNextSteps(theme: Theme, steps: readonly NextStep[]): string[] {
	const width = Math.max(...steps.map((step) => step.command.length)) + 3;
	return [
		"",
		`  ${theme.fg("subtle", "Next")}`,
		...steps.map((step) => `  ${theme.bold(theme.fg("white", step.command.padEnd(width)))}${theme.fg("muted", step.does)}`),
	];
}

const supportLabels: Record<BindingSupport, string> = {
	needs_service: "needs a service",
	not_supported: "not supported",
	runs_as_is: "runs as is",
};

// Problems first, so a reader sees what blocks a migration before what works.
const supportOrder: readonly BindingSupport[] = ["not_supported", "needs_service", "runs_as_is"];

function countSupport(bindings: readonly BindingDescription[]): Record<BindingSupport, number> {
	const count = (support: BindingSupport): number => bindings.filter((entry) => entry.support === support).length;
	return { needs_service: count("needs_service"), not_supported: count("not_supported"), runs_as_is: count("runs_as_is") };
}

// A binding as doctor reports it, with its one next step.
type DoctorBinding = BindingDescription & { hint?: string };

// Doctor gives each binding its docs page, so it leaves out the alternative that only points at
// the docs. A binding whose setting is present needs no hint.
function bindingHint(entry: BindingDescription, ready: ReadonlySet<string>, configName: string): string | undefined {
	if (entry.worker !== undefined) {
		return `Works only when the same orange dev session runs Worker "${entry.worker}": orange dev -c ${configName} -c <config of ${entry.worker}>.`;
	}
	if (entry.type === "dispatch_namespace") {
		return "Reaches only the Workers that the same orange dev session runs. Pass the config of each Worker with -c.";
	}
	const check = backendCheckId(entry.type, entry.binding);
	if (entry.support === "needs_service" && check !== undefined && ready.has(check)) return undefined;
	const hint = entry.setup ?? entry.alternative;
	return hint === defaultUnsupportedBindingAlternative ? noBackendHint : hint;
}

// For a stub with no specific alternative.
const noBackendHint = "Orange has no backend for this binding. Call the service's HTTP API with fetch(), or keep this code off Orange.";

// What starts the Worker's handlers without an `env` binding. Orange runs each of them.
interface Trigger {
	kind: "cron" | "queue_consumer" | "tail_consumer";
	// The cron expression, the queue name, or the consumer Worker.
	name: string;
	docs: string;
	// Set for a Tail Worker that is not this Worker.
	hint?: string;
}

function describeTriggers(config: ResolvedWranglerConfiguration): Trigger[] {
	const docs = (page: string): string => `${docsRootUrl}docs/modules/${page}`;
	return [
		...config.crons.map((name): Trigger => ({ docs: docs("cron-triggers.mdx"), kind: "cron", name })),
		...config.queueConsumers.map(
			(consumer): Trigger => ({ docs: docs("queues.mdx"), kind: "queue_consumer", name: consumer.queueName }),
		),
		...config.tailConsumers.map(
			(name): Trigger => ({
				docs: docs("tail-workers.mdx"),
				...(name === config.workerName
					? {}
					: { hint: `Tail Worker "${name}" gets the events only when an orange dev session runs it. They wait in a stream until then.` }),
				kind: "tail_consumer",
				name,
			}),
		),
	];
}

// For example: `2 Cron Triggers and 1 Tail Worker run as is`.
function renderTriggers(triggers: readonly Trigger[]): string | undefined {
	const nouns: Record<Trigger["kind"], [string, string]> = {
		cron: ["Cron Trigger", "Cron Triggers"],
		queue_consumer: ["queue consumer", "queue consumers"],
		tail_consumer: ["Tail Worker", "Tail Workers"],
	};
	const parts = (Object.keys(nouns) as Trigger["kind"][]).flatMap((kind) => {
		const count = triggers.filter((trigger) => trigger.kind === kind).length;
		return count === 0 ? [] : [`${count} ${nouns[kind][count === 1 ? 0 : 1]}`];
	});
	if (parts.length === 0) return undefined;
	const list = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(", ")}${parts.length > 2 ? "," : ""} and ${parts.at(-1)}`;
	return `${list} ${triggers.length === 1 ? "runs" : "run"} as is`;
}

// Whether `orange migrate` can move the data of a Durable Object class from Cloudflare.
interface ClassMove {
	name: string;
	storage: DurableObjectStorage;
	migratable: boolean;
	// Why the data cannot move, and what to do. Set when `migratable` is false.
	hint?: string;
}

interface ClassMoves {
	moves: ClassMove[];
	// Why `orange migrate prepare` refuses the whole Worker. Then no class can move.
	refusal?: string;
}


// The same rules as `orange migrate prepare`, which refuses the whole Worker while it has a
// KV-backed class, a SQLite class without a binding, or no_bundle.
async function describeClassMoves(config: ResolvedWranglerConfiguration): Promise<ClassMoves> {
	if (config.configPath === undefined) return { moves: [] };
	const backends = await readDurableObjectStorage(config.configPath, config.environment);
	const blockers = findPrepareBlockers(config, backends);
	const reasons = [
		...(blockers.noBundle ? ["no_bundle is set"] : []),
		...(blockers.keyValueBacked.length === 0
			? []
			: [`${listNames(blockers.keyValueBacked)} ${blockers.keyValueBacked.length === 1 ? "is" : "are"} KV-backed`]),
		...(blockers.unbound.length === 0
			? []
			: [`${listNames(blockers.unbound)} ${blockers.unbound.length === 1 ? "has" : "have"} no binding`]),
	];
	const hasData = backends.size > 0 || config.d1Databases.length > 0;
	const refusal =
		reasons.length === 0 || !hasData ? undefined : `orange migrate prepare refuses this Worker while ${listNames(reasons)}.`;
	const moves = [...backends].map(([name, storage]): ClassMove => {
		if (storage === "key-value") {
			return { hint: "Cloudflare gives a KV-backed class no way to export its data.", migratable: false, name, storage };
		}
		if (blockers.unbound.includes(name)) {
			return {
				hint: `Add a binding for ${name} to durable_objects.bindings. orange migrate reaches each object through a binding.`,
				migratable: false,
				name,
				storage,
			};
		}
		return refusal === undefined ? { migratable: true, name, storage } : { hint: refusal, migratable: false, name, storage };
	});
	// What to fix first: KV-backed classes, then classes without a binding, then the rest.
	const rank = (move: ClassMove): number =>
		move.storage === "key-value" ? 0 : blockers.unbound.includes(move.name) ? 1 : move.migratable ? 3 : 2;
	return {
		moves: moves.toSorted((a, b) => rank(a) - rank(b)),
		...(refusal === undefined ? {} : { refusal }),
	};
}

function renderClassMoves(theme: Theme, { moves, refusal }: ClassMoves): string[] {
	if (moves.length === 0 && refusal === undefined) return [];
	const storageLabels: Record<DurableObjectStorage, string> = { "key-value": "KV-backed", sqlite: "SQLite" };
	const blocked = (move: ClassMove): boolean => move.storage === "sqlite" && move.hint === refusal;
	const verdict = (move: ClassMove): string => {
		if (move.migratable) return "moves its data";
		if (move.storage === "key-value") return "cannot move its data";
		return blocked(move) ? "blocked" : "needs a binding";
	};
	const nameWidth = Math.max("Durable Object".length, ...moves.map((move) => move.name.length)) + 3;
	const storageWidth = Math.max("Storage".length, ...Object.values(storageLabels).map((label) => label.length)) + 3;
	const line = (gutter: string, name: string, storage: string, move: string): string =>
		`${padVisible(gutter, 2)}${padVisible(name, nameWidth)}${padVisible(storage, storageWidth)}${move}`.trimEnd();
	return [
		"",
		...(moves.length === 0 ? [] : [theme.fg("subtle", line("", "Durable Object", "Storage", "orange migrate"))]),
		...moves.flatMap((move) => [
			line(
				move.migratable ? "" : theme.fg("yellow", "!"),
				theme.fg("white", move.name),
				theme.fg("muted", storageLabels[move.storage]),
				theme.fg(move.migratable ? "muted" : "yellow", verdict(move)),
			),
			// The refusal line below explains a blocked class.
			...(move.hint === undefined || blocked(move) ? [] : indented(move.hint, 2 + nameWidth, (text) => theme.fg("subtle", text))),
		]),
		...(refusal === undefined
			? []
			: wrapWords(refusal, outputWidth - 2).map(
					(text, index) => `${index === 0 ? theme.fg("yellow", "!") : " "} ${theme.fg("white", text)}`,
				)),
		`  ${theme.fg("subtle", "Docs")}  ${theme.hyperlink("Migration guide ↗", migrateGuideUrl)}`,
	];
}

// One row for each binding: how it moves to Rivet, what backs it, and its documentation page.
function renderCompatibility(theme: Theme, bindings: readonly DoctorBinding[], triggers: readonly Trigger[]): string[] {
	const triggerLine = renderTriggers(triggers);
	if (bindings.length === 0) {
		return [
			"",
			theme.fg("subtle", "  No bindings in this configuration"),
			...(triggerLine === undefined ? [] : [`  ${theme.fg("white", triggerLine)}`]),
			...triggers.flatMap((trigger) => (trigger.hint === undefined ? [] : indented(trigger.hint, 4, (text) => theme.fg("subtle", text)))),
		];
	}
	const rows = supportOrder.flatMap((support) =>
		bindings
			.filter((entry) => entry.support === support)
			.map((entry) => ({ ...entry, name: `env.${entry.binding}` })),
	);
	const width = (header: string, values: readonly string[]): number =>
		Math.max(header.length, ...values.map((value) => value.length)) + 3;
	const nameWidth = width("Binding", rows.map((entry) => entry.name));
	const resourceWidth = width("Resource", rows.map((entry) => entry.resource));
	const supportWidth = width("On Rivet", Object.values(supportLabels));
	const runsOnWidth = width("Runs on", rows.map((entry) => entry.runsOn));
	const line = (gutter: string, name: string, resource: string, support: string, runsOn: string, docs: string): string =>
		`${padVisible(gutter, 2)}${padVisible(name, nameWidth)}${padVisible(resource, resourceWidth)}${padVisible(support, supportWidth)}${padVisible(runsOn, runsOnWidth)}${docs}`.trimEnd();
	const counts = countSupport(bindings);
	const parts = [
		`${counts.runs_as_is} of ${bindings.length} ${bindings.length === 1 ? "binding runs" : "bindings run"} as is`,
		...(counts.needs_service === 0 ? [] : [`${counts.needs_service} ${counts.needs_service === 1 ? "needs" : "need"} a service`]),
		...(counts.not_supported === 0 ? [] : [`${counts.not_supported} ${counts.not_supported === 1 ? "is" : "are"} not supported`]),
	];
	return [
		"",
		theme.fg("subtle", line("", "Binding", "Resource", "On Rivet", "Runs on", "")),
		...rows.flatMap((entry) => {
			const color = entry.support === "runs_as_is" ? "muted" : "yellow";
			return [
				line(
					entry.support === "not_supported" ? theme.fg("yellow", "!") : "",
					theme.fg("white", entry.name),
					theme.fg("muted", entry.resource),
					theme.fg(color, supportLabels[entry.support]),
					theme.fg("muted", entry.runsOn),
					theme.hyperlinks ? theme.hyperlink(docsLabel, entry.docs) : "",
				),
				...(entry.hint === undefined ? [] : indented(entry.hint, 2 + nameWidth, (text) => theme.fg("subtle", text))),
				...urlLines(theme, entry.docs, 2 + nameWidth),
			];
		}),
		"",
		`  ${theme.fg("white", parts.join(", "))}`,
		...(triggerLine === undefined ? [] : [`  ${theme.fg("white", triggerLine)}`]),
		...triggers.flatMap((trigger) => (trigger.hint === undefined ? [] : indented(trigger.hint, 4, (text) => theme.fg("subtle", text)))),
		`  ${theme.fg("subtle", "Docs")}  ${theme.hyperlink("All bindings ↗", `${moduleDocsUrl}bindings.mdx`)}`,
	];
}

export function renderDoctorHelp(theme: Theme): string {
	const option = (flags: string, description: string): string =>
		`  ${theme.fg("orange", flags.padEnd(24))}${description}`;
	const event = (json: string): string => `  ${theme.dim(json)}`;
	return [
		theme.bold("open-orange doctor"),
		"",
		"Check that this project is ready for orange dev. Show how each binding, trigger, and",
		"Durable Object class moves to Rivet.",
		`\n${theme.bold("Options")}`,
		option("-c, --config <path>", "Wrangler configuration file. Doctor checks one Worker."),
		option("-e, --env <name>", "Environment from the configuration"),
		option("--cwd <dir>", "Check as if started in <dir>"),
		option("--port <port>", "Port to check. Default 8787."),
		option("--ip <host>", "Host to check. Default 127.0.0.1."),
		option("--json", "Print JSON Lines events"),
		option("--strict", "Also exit 1 when something needs setup"),
		`\n${theme.bold("JSON events")}`,
		theme.dim("  One event per line: the checks, the bindings, the triggers, the classes, then the summary."),
		event('{"type":"check","id":"ai:AI","title":"Workers AI","status":"action","detail":"...",'),
		event(' "hint":"...","docs":"..."}'),
		theme.dim("  status is ok, action (set up before the feature works), or fail (orange dev cannot start)."),
		theme.dim("  hint (what to do) and docs (a URL) are set for actions and some failures."),
		event('{"type":"binding","name":"AI","bindingType":"ai","resource":"Workers AI","status":"pluggable",'),
		event(' "support":"needs_service","runsOn":"OpenAI-compatible API","hint":"Set ...","docs":"..."}'),
		theme.dim("  support is runs_as_is, needs_service, or not_supported. status is local, pluggable, or stub."),
		theme.dim("  hint is the next step. It is not set when there is nothing to do. Variables are not listed."),
		event('{"type":"trigger","kind":"tail_consumer","name":"logger","support":"runs_as_is",'),
		event(' "hint":"...","docs":"..."}'),
		theme.dim("  kind is cron, queue_consumer, or tail_consumer. Only a Tail Worker of another Worker has a hint."),
		event('{"type":"durable_object_class","name":"Cart","storage":"key-value","migratable":false,'),
		event(' "hint":"...","docs":"..."}'),
		theme.dim("  storage is sqlite or key-value. migratable is whether orange migrate can move the class's data"),
		theme.dim("  from Cloudflare. hint, set when migratable is false, says why."),
		event('{"type":"summary","ok":5,"actions":1,"failures":0,"exitCode":0,'),
		event(' "bindings":{"runs_as_is":1,"needs_service":1,"not_supported":0},'),
		event(' "mcp":{"configured":false,"url":"https://mcp.rivet.dev/mcp"},"next":["orange dev"]}'),
		theme.dim("  next lists the commands to run next. mcp.configured is whether an agent configuration names"),
		theme.dim("  the Rivet MCP. The human output then adds orange mcp to Next."),
		`  ${theme.dim('{"type":"failure","message":"...","hint":"..."}')}  ${theme.dim("for invalid arguments only")}`,
		`\n${theme.bold("Exit codes")}`,
		`  ${theme.dim("0 ready · 1 a check failed, or needs setup with --strict · 2 invalid arguments")}`,
		`  ${theme.dim("A binding that is not supported, or a class that orange migrate cannot move, does not")}`,
		`  ${theme.dim("change the exit code.")}`,
	].join("\n");
}

export async function runDoctorCommand(args: readonly string[], io: DoctorIo): Promise<number> {
	const theme = createTheme(process.stdout);
	const json = args.includes("--json");
	const emit = (event: Record<string, unknown>): void => io.log(JSON.stringify(event));
	let parsed: DoctorArguments;
	try {
		parsed = parseDoctorArguments(args);
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		if (json) emit({ hint: "Run orange doctor --help.", message, type: "failure" });
		else io.error(`${theme.fg("red", "×")} ${theme.bold(theme.fg("white", message))}\n  ${theme.fg("muted", "Run orange doctor --help.")}`);
		return 2;
	}

	const originalWorkingDirectory = process.cwd();
	process.chdir(resolve(parsed.cwd ?? originalWorkingDirectory));
	try {
		const checks: Check[] = [checkNode(), checkRivetKit()];
		let config: ResolvedWranglerConfiguration | undefined;
		try {
			config = await loadWranglerConfiguration({
				...(parsed.configPath === undefined ? {} : { configPath: parsed.configPath }),
				...(parsed.environment === undefined ? {} : { environment: parsed.environment }),
			});
			const name = config.configPath === undefined ? "no config file" : relative(process.cwd(), config.configPath) || config.configPath;
			checks.push({
				detail: config.workerName === undefined ? name : `${name} · ${config.workerName}`,
				id: "config",
				status: "ok",
				title: "Config",
			});
		} catch (error: unknown) {
			checks.push({
				detail: error instanceof Error ? error.message : String(error),
				hint: "Fix the Wrangler configuration, then run orange doctor again.",
				id: "config",
				status: "fail",
				title: "Config",
			});
		}
		if (config !== undefined) checks.push(await checkBundle(config));
		checks.push(await checkPort(parsed.host, parsed.port));
		checks.push(checkDisk(config === undefined ? join(process.cwd(), ".open-orange", "rivetkit") : localDeploymentStoragePath(config)));
		const chanfana = config === undefined ? undefined : checkChanfana(config);
		const backends = [...(config === undefined ? [] : checkBackends(config)), ...(chanfana === undefined ? [] : [chanfana])];
		checks.push(...backends);

		const failures = checks.filter((check) => check.status === "fail").length;
		const actions = checks.filter((check) => check.status === "action").length;
		// A failed check is doctor's result, not a bug in Orange.
		const exitCode = exitWithOutcome(failures > 0 || (parsed.strict && actions > 0) ? 1 : 0);

		// Variables and `.dev.vars` entries are values, not services to move, so they
		// would only inflate the count of bindings that run as is.
		const configName = config?.configPath === undefined ? "wrangler.jsonc" : relative(process.cwd(), config.configPath) || config.configPath;
		const ready = new Set(backends.filter((check) => check.status === "ok").map((check) => check.id));
		const bindings = (config === undefined ? [] : describeBindings(config))
			.filter((entry) => entry.type !== "plain_text" && entry.type !== "json")
			.map((entry): DoctorBinding => {
				const hint = bindingHint(entry, ready, configName);
				return hint === undefined ? entry : { ...entry, hint };
			});
		const triggers = config === undefined ? [] : describeTriggers(config);
		const classMoves: ClassMoves = config === undefined ? { moves: [] } : await describeClassMoves(config);
		const next = nextSteps(failures, config, classMoves);
		const mcp: RivetMcpStatus = rivetMcpStatus(config?.projectRoot ?? process.cwd());
		if (json) {
			for (const check of checks) emit({ ...check, type: "check" });
			for (const binding of bindings) {
				const { hint } = binding;
				emit({
					bindingType: binding.type,
					docs: binding.docs,
					...(hint === undefined ? {} : { hint }),
					name: binding.binding,
					resource: binding.resource,
					runsOn: binding.runsOn,
					status: binding.status,
					support: binding.support,
					type: "binding",
				});
			}
			for (const trigger of triggers) emit({ ...trigger, support: "runs_as_is", type: "trigger" });
			for (const move of classMoves.moves) emit({ ...move, docs: migrateGuideUrl, type: "durable_object_class" });
			emit({
				actions,
				bindings: countSupport(bindings),
				exitCode,
				failures,
				mcp: { configured: mcp.configured, url: mcp.url },
				next: next.map((step) => step.command),
				ok: checks.length - failures - actions,
				type: "summary",
			});
			return exitCode;
		}

		const lines = [renderBrand(theme), ""];
		lines.push(...checks.filter((check) => !backends.includes(check)).map((check) => renderCheck(theme, check)));
		if (config !== undefined) lines.push(...renderCompatibility(theme, bindings, triggers), ...renderClassMoves(theme, classMoves));
		if (backends.length > 0) lines.push("", ...backends.map((check) => renderCheck(theme, check)));
		lines.push("", renderSummary(theme, checks), ...renderNextSteps(theme, mcp.configured ? next : [...next, mcpStep]));
		io.log(lines.join("\n"));
		return exitCode;
	} finally {
		process.chdir(originalWorkingDirectory);
	}
}
