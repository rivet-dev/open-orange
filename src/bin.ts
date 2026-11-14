import { resolve } from "node:path";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
	commandRegistry,
	type CommandDefinition,
	pinnedWranglerVersion,
} from "./command-registry.js";
import { runTypesCommand } from "./commands/types.js";
import { runD1Command } from "./commands/d1.js";
import { runDevCommand } from "./commands/dev.js";
import { renderDoctorHelp, runDoctorCommand } from "./commands/doctor.js";
import { renderServeHelp, runServeCommand } from "./commands/serve.js";
import { renderDeployHelp, runDeployCommand } from "./commands/deploy.js";
import { accountCommands, defaultCloudApi, renderAccountHelp, runAccountCommand } from "./commands/rivet-account.js";
import { renderMcpHelp, runMcpCommand } from "./commands/mcp.js";
import { runMigrateCommand } from "./commands/migrate.js";
import { orangeVersion } from "./version.js";
import { renderBrand, renderDevHelp } from "./commands/dev-output.js";
import { createTheme } from "./cli/theme.js";
import { dropOutputAfterReaderCloses } from "./cli/closed-output.js";
import { exitWithOutcome, issueUrl, renderIssueLine, shouldOfferIssueReport } from "./cli/issue-report.js";
import { hasWranglerUpdateCheckStarted } from "./config/load-wrangler.js";

interface CliIo {
	log(message: string): void;
	error(message: string): void;
}

const defaultIo: CliIo = {
	log: (message) => console.log(message),
	error: (message) => console.error(message),
};

const orangeOnlyCommands: ReadonlySet<string> = new Set(["deploy", "doctor", "mcp", "migrate", "serve", ...accountCommands]);

const d1CommandPaths: ReadonlySet<string> = new Set(["d1 execute", "d1 migrations apply", "d1 migrations list"]);
const cloudApiHelpRow = `      --cloud-api   Rivet Cloud API for --remote. Default ${defaultCloudApi}  [string]\n`;

function renderHelp(command: CommandDefinition, executableName: string): string {
	return (
		command.help
			// Wrangler's `d1 migrations --remote` reaches Cloudflare. Orange's reaches the deployed Worker's Engine.
			.replace("a remote DB for use with wrangler dev --remote", "the deployed DB on the linked Rivet cluster or RIVET_ENDPOINT")
			.replace(/^ {6}--remote .*\n/m, (row) => (d1CommandPaths.has(command.path.join(" ")) ? row + cloudApiHelpRow : row))
			.replace(/\bwrangler\b/g, executableName)
			.trimEnd()
	);
}

function optionConsumesValue(command: CommandDefinition, token: string): boolean {
	const name = token.includes("=") ? token.slice(0, token.indexOf("=")) : token;
	const option = command.options.find((candidate) => candidate.names.includes(name));
	return (
		!token.includes("=") &&
		option !== undefined &&
		option.type !== "boolean" &&
		option.type !== "count"
	);
}

function resolveCommand(args: readonly string[]): {
	command: CommandDefinition;
	helpRequested: boolean;
	unknown?: string;
} {
	const root = commandRegistry.get("");
	if (root === undefined) {
		throw new Error("Orange command registry is missing its root command");
	}

	let command = root;
	let helpRequested = args.length === 0;
	for (let index = 0; index < args.length; index += 1) {
		const token = args[index];
		if (token === undefined) {
			continue;
		}
		if (token === "--help" || token === "-h") {
			helpRequested = true;
			continue;
		}
		if (token === "--") {
			break;
		}
		if (token.startsWith("-")) {
			if (optionConsumesValue(command, token)) {
				index += 1;
			}
			continue;
		}

		const childPath = [...command.path, token].join(" ");
		const child = commandRegistry.get(childPath);
		if (child !== undefined) {
			command = child;
			continue;
		}
		if (command.positionals.length === 0 && command.children.length > 0) {
			return { command, helpRequested, unknown: token };
		}
		break;
	}
	return { command, helpRequested };
}

// The commands that work today, for the landing screen and `open-orange --help`.
const orangeCommands: readonly [string, string][] = [
	["dev", "Run the Worker in this directory"],
	["doctor", "Check that this project is ready for dev"],
	["serve", "Serve the Worker against the Rivet Engine in RIVET_ENDPOINT"],
	["login", "Sign in to Rivet Cloud"],
	["link --cluster <name>", "Link this directory to a Rivet cluster"],
	["deploy", "Deploy the Worker to a Rivet cluster"],
	["whoami", "Show the signed-in account and linked cluster"],
	["migrate", "Move Durable Objects and D1 databases from Cloudflare"],
	["mcp", "Connect your coding agent to the Rivet MCP"],
	["types", "Generate worker-configuration.d.ts"],
	["d1 migrations apply <db>", "Apply D1 migrations locally"],
	["d1 execute <db>", "Run SQL against a local D1 database"],
	["<command> --help", "Help for one command"],
];

// The screen for `open-orange` with no arguments.
function renderLanding(): string {
	const theme = createTheme(process.stdout);
	const commands = orangeCommands;
	const width = Math.max(...commands.map(([command]) => command.length)) + 3;
	const link = (label: string, url: string): string =>
		`  ${theme.fg("subtle", label.padEnd(8))}${theme.link(url)}`;
	return [
		renderBrand(theme),
		"",
		`  ${theme.fg("white", "Run Cloudflare Workers on Rivet Actors, locally and anywhere Node.js runs.")}`,
		"",
		...commands.map(
			([command, description]) =>
				`  ${theme.fg("subtle", "open-orange")} ${theme.bold(theme.fg("white", command.padEnd(width)))}${theme.fg("muted", description)}`,
		),
		"",
		link("Docs", "https://github.com/rivet-dev/open-orange"),
		link("Rivet", "https://rivet.dev"),
	].join("\n");
}

// Every command that runs in Orange, for `open-orange --help`. No other Wrangler command runs: it
// prints "is not implemented", and none reaches Cloudflare.
const helpCommands: readonly [string, string][] = [
	["dev", "Run the Worker in this directory"],
	["doctor", "Check that this project is ready for dev"],
	["serve", "Serve the Worker against the Rivet Engine in RIVET_ENDPOINT"],
	["deploy", "Deploy the Worker to a Rivet cluster"],
	["login", "Sign in to Rivet Cloud"],
	["logout", "Sign out of Rivet Cloud"],
	["whoami", "Show the signed-in Rivet Cloud account and linked cluster"],
	["link --cluster <name>", "Link this directory to a Rivet cluster"],
	["unlink", "Remove this directory's link to a Rivet cluster"],
	["migrate", "Move Durable Objects and D1 databases from Cloudflare"],
	["mcp", "Connect your coding agent to the Rivet MCP"],
	["types", "Generate worker-configuration.d.ts"],
	["d1 execute <db>", "Run SQL against a D1 database on Orange"],
	["d1 migrations apply <db>", "Apply D1 migrations to a database on Orange"],
	["d1 migrations list <db>", "List the D1 migrations that a database on Orange has not applied"],
];

// The Wrangler global flags that Orange's commands take.
const helpGlobalFlags: readonly [string, string][] = [
	["-c, --config <path>", "Wrangler configuration file"],
	["-e, --env <name>", "Environment from the Wrangler configuration"],
	["--cwd <dir>", "Run as if started in <dir>"],
	["-h, --help", "Show help"],
	["-v, --version", "Show the version"],
];

// `open-orange --help`: only what runs in Orange. `open-orange <command> --help` still answers for
// every Wrangler command, for help parity.
function renderRootHelp(executableName: string): string {
	const rows = (entries: readonly [string, string][]): string[] => {
		const width = Math.max(...entries.map(([name]) => name.length)) + 3;
		return entries.map(([name, description]) => `  ${name.padEnd(width)}${description}`);
	};
	return [
		executableName,
		"",
		"COMMANDS",
		...rows(helpCommands),
		"",
		"GLOBAL FLAGS",
		...rows(helpGlobalFlags),
		"",
		`Run ${executableName} <command> --help for the flags of one command.`,
		`Other Wrangler commands, such as delete or secret, do not run in Orange: they print`,
		`"is not implemented". Run them with wrangler.`,
		"",
		"Docs: https://github.com/rivet-dev/open-orange",
	].join("\n");
}

// Wrangler takes its global options before the command, as in `orange --cwd app migrate`. Orange's
// own commands are not in the Wrangler registry, so they are found here, after those options.
function moveOrangeCommandFirst(args: readonly string[]): readonly string[] {
	const root = commandRegistry.get("");
	if (root === undefined) return args;
	for (let index = 0; index < args.length; index += 1) {
		const token = args[index] ?? "";
		if (token === "--") return args;
		if (token.startsWith("-")) {
			if (optionConsumesValue(root, token)) index += 1;
			continue;
		}
		if (index === 0 || !orangeOnlyCommands.has(token)) return args;
		return [token, ...args.slice(0, index), ...args.slice(index + 1)];
	}
	return args;
}

export async function runOrange(
	cliArgs: readonly string[],
	io: CliIo = defaultIo,
	executableName = "open-orange",
): Promise<number> {
	let args = cliArgs;
	if (args.length === 1 && (args[0] === "--version" || args[0] === "-v")) {
		io.log(orangeVersion);
		return 0;
	}
	if (args.length === 0) {
		io.log(renderLanding());
		return 0;
	}
	args = moveOrangeCommandFirst(args);
	// Orange-only commands are not in the Wrangler command registry.
	if (args[0] === "doctor") {
		if (args.includes("--help") || args.includes("-h")) {
			io.log(renderDoctorHelp(createTheme(process.stdout)));
			return 0;
		}
		return runDoctorCommand(args.slice(1), io);
	}
	// `serve`, `deploy`, and the account commands target Rivet, not Cloudflare, so they replace
	// Wrangler's commands of the same name.
	if (args[0] !== undefined && accountCommands.has(args[0])) {
		if (args.includes("--help") || args.includes("-h")) {
			io.log(renderAccountHelp(args[0]));
			return 0;
		}
		return runAccountCommand(args, io);
	}
	if (args[0] === "mcp") {
		if (args.includes("--help") || args.includes("-h")) {
			io.log(renderMcpHelp(createTheme(process.stdout)));
			return 0;
		}
		return runMcpCommand(args.slice(1), io);
	}
	if (args[0] === "migrate") return runMigrateCommand(args.slice(1), io);
	if (args[0] === "serve") {
		if (args.includes("--help") || args.includes("-h")) {
			io.log(renderServeHelp(createTheme(process.stdout)));
			return 0;
		}
		return runServeCommand(args, io);
	}
	if (args[0] === "deploy") {
		if (args.includes("--help") || args.includes("-h")) {
			io.log(renderDeployHelp(createTheme(process.stdout)));
			return 0;
		}
		return runDeployCommand(args, io);
	}
	const resolution = resolveCommand(args);
	if (resolution.unknown !== undefined) {
		io.error(
			`Unknown open-orange command after ${
				resolution.command.path.join(" ") || "<root>"
			}: ${resolution.unknown}`,
		);
		return 2;
	}
	if (resolution.helpRequested && resolution.command.path.length === 0) {
		io.log(renderRootHelp(executableName));
		return 0;
	}
	if (resolution.helpRequested && resolution.command.path.join(" ") === "dev") {
		io.log(renderDevHelp(createTheme(process.stdout)));
		return 0;
	}
	if (resolution.helpRequested) {
		io.log(renderHelp(resolution.command, executableName));
		return 0;
	}
	const path = resolution.command.path.join(" ");
	if (path === "types") {
		return runTypesCommand(args, io);
	}
	if (path === "dev") {
		return runDevCommand(args, io);
	}
	if (path === "d1 execute" || path === "d1 migrations apply" || path === "d1 migrations list") {
		return runD1Command(path, args, { ...io, isInteractive: process.stdout.isTTY });
	}

	io.error(
		`open-orange command "${
			resolution.command.path.join(" ") || "<root>"
		}" is not implemented (pinned Wrangler ${pinnedWranglerVersion}).`,
	);
	// A known gap, not a bug.
	return exitWithOutcome(1);
}

// A write callback runs after every earlier write on the stream is flushed, so
// process.exit() cannot cut off piped output.
function flushStandardStreams(): Promise<void> {
	const flush = (stream: NodeJS.WriteStream): Promise<void> =>
		new Promise((resolveFlush) => stream.write("", () => resolveFlush()));
	return Promise.all([flush(process.stdout), flush(process.stderr)]).then(() => undefined);
}

const invokedPath = process.argv[1];
if (
	invokedPath !== undefined &&
	realpathSync(resolve(invokedPath)) === realpathSync(fileURLToPath(import.meta.url))
) {
	dropOutputAfterReaderCloses(process.stdout);
	dropOutputAfterReaderCloses(process.stderr);
	const args = process.argv.slice(2);
	const context = { args, cwd: process.cwd(), env: process.env };
	// Only a name Orange knows goes in the report. Any other argument can hold anything.
	const firstArgument = moveOrangeCommandFirst(args)[0] ?? "";
	const command = commandRegistry.has(firstArgument) || orangeOnlyCommands.has(firstArgument) ? firstArgument : "command";
	const printIssueLine = (errorText: string): void => {
		console.error(renderIssueLine(issueUrl(command, errorText, context), process.stderr));
	};
	process.on("uncaughtExceptionMonitor", (error) => printIssueLine(error.stack ?? error.message));
	let lastError = "";
	const exitCode = await runOrange(args, {
		...defaultIo,
		error(message) {
			lastError = message;
			defaultIo.error(message);
		},
	});
	process.exitCode = exitCode;
	if (shouldOfferIssueReport(exitCode)) printIssueLine(lastError);
	if (hasWranglerUpdateCheckStarted()) {
		await flushStandardStreams();
		process.exit(exitCode);
	}
}
