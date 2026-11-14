import { homedir, userInfo } from "node:os";

import { orangeVersion } from "../version.js";
import { osc8, supportsHyperlinks } from "./theme.js";

const issuesUrl = "https://github.com/rivet-dev/open-orange/issues";
const maxTitleLength = 120;
const maxBodyErrorLength = 1_000;

const sensitiveEnvName = /TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|CREDENTIAL|AUTH|^RIVET_ENDPOINT$/i;
const sensitiveFlag = /^--(?:[\w-]*(?:token|secret|password|key))(?:=(.*))?$/i;
const sensitiveAssignment =
	/\b([\w-]*(?:token|secret|password|passwd|api[_-]?key|authorization)[\w-]*["']?\s*[:=]\s*["']?)(?!bearer\b|basic\b)[^\s"',;&]+/gi;

export interface IssueReportContext {
	readonly args: readonly string[];
	readonly cwd: string;
	readonly env: NodeJS.ProcessEnv;
}

function replaceAll(text: string, value: string, replacement: string): string {
	return value.length === 0 ? text : text.replaceAll(value, replacement);
}

// Values the process knows are secret, so they go even when they look like ordinary words.
function knownSecrets({ args, env }: IssueReportContext): string[] {
	const secrets: string[] = [];
	for (const [name, value] of Object.entries(env)) {
		if (value !== undefined && value.length >= 4 && sensitiveEnvName.test(name)) secrets.push(value);
	}
	for (const [index, arg] of args.entries()) {
		const match = sensitiveFlag.exec(arg);
		if (match === null) continue;
		const value = match[1] ?? args[index + 1];
		if (value !== undefined && value.length > 0) secrets.push(value);
	}
	// The longest first, so a secret that contains another one goes as a whole.
	return secrets.sort((left, right) => right.length - left.length);
}

/** Removes secrets and local paths from text that leaves this machine in a URL. */
export function redactForIssue(text: string, context: IssueReportContext): string {
	let redacted = text.replace(/\u001B\[[0-9;]*m/g, "");
	for (const secret of knownSecrets(context)) redacted = replaceAll(redacted, secret, "<redacted>");
	redacted = redacted
		.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s'"<>)\]]+/gi, (value) => {
			if (value.toLowerCase().startsWith("file:")) return "<path>";
			try {
				const url = new URL(value);
				return `${url.protocol}//${url.host}`;
			} catch {
				return "<url>";
			}
		})
		.replace(/\b(bearer|basic)\s+\S+/gi, "$1 <redacted>")
		.replace(sensitiveAssignment, "$1<redacted>");
	redacted = replaceAll(redacted, context.cwd, ".");
	const home = homedir();
	if (home.length > 1) redacted = replaceAll(redacted, home, "~");
	redacted = redacted
		.replace(/(?<![\w:/.~-])~?(?:[\\/][^\s'"`:;,()[\]<>\\/]+)+[\\/]?/g, (value) => `<path>/${value.split(/[\\/]/).filter(Boolean).at(-1) ?? ""}`)
		.replace(/\b[A-Za-z]:\\[^\s'"`]+/g, "<path>")
		.replace(/\b(?:sk|pk|rk|ghp|gho|ghs|xox[a-z])[-_][A-Za-z0-9_-]{8,}/g, "<redacted>")
		.replace(/[A-Za-z0-9+_=-]{32,}/g, "<redacted>");
	const { username } = userInfo();
	if (username.length >= 3) redacted = redacted.replace(new RegExp(`\\b${username.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g"), "<user>");
	return redacted;
}

/** A prefilled new-issue URL. Everything in it passed through `redactForIssue`. */
export function issueUrl(command: string, errorText: string, context: IssueReportContext): string {
	const error = redactForIssue(errorText, context).trim();
	const firstLine = error.split("\n", 1)[0]?.trim() ?? "";
	const title = `orange ${command}: ${firstLine === "" ? "failed" : firstLine}`.slice(0, maxTitleLength);
	const body = [
		`**Version:** orange ${orangeVersion}, Node.js ${process.version}, ${process.platform} ${process.arch}`,
		...(error === "" ? [] : ["", "```", error.slice(0, maxBodyErrorLength), "```"]),
		"",
		"**What I did:**",
	].join("\n");
	return `${issuesUrl}/new?${new URLSearchParams({ body, title }).toString()}`;
}

/** The one line a failed command prints. A terminal shows a short link to the same prefilled URL. */
export function renderIssueLine(url: string, stream: NodeJS.WriteStream): string {
	const target = supportsHyperlinks(stream) ? osc8(`${issuesUrl}/new`, url) : url;
	return `Looks like a bug? Report it: ${target}`;
}

/**
 * A refusal that the command expects, such as a config it can't migrate. The command exits 1 and
 * prints the message, but offers no bug report.
 */
export class ExpectedFailure extends Error {}

/**
 * The exit code for a command that failed with `error`: 1 for an ExpectedFailure, 2 for an unknown
 * or malformed option, which node:util parseArgs refuses, and 1 with a bug report for the rest.
 */
export function failureExitCode(error: unknown): number {
	if (error instanceof ExpectedFailure) return exitWithOutcome(1);
	const code = error instanceof Error && "code" in error ? String(error.code) : "";
	return code.startsWith("ERR_PARSE_ARGS_") ? 2 : 1;
}

let outcomeExitCode: number | undefined;

/**
 * Returns `code` and marks it as the command's result, such as a doctor check that failed or
 * objects that a backfill must retry. The CLI offers a bug report only for other failures.
 */
export function exitWithOutcome(code: number): number {
	outcomeExitCode = code;
	return code;
}

/**
 * True when a failed command should offer a bug report: not for a usage error (2), a stop by the
 * user (130), or a result that the command reported with `exitWithOutcome`.
 */
export function shouldOfferIssueReport(exitCode: number): boolean {
	return exitCode !== 0 && exitCode !== 2 && exitCode !== 130 && exitCode !== outcomeExitCode;
}
