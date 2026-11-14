import { readFile } from "node:fs/promises";
import { parseEnv } from "node:util";

import { ExpectedFailure } from "../cli/issue-report.js";
import { workerSecretsVariable, workerVarsVariable } from "../config/load-wrangler.js";
import type { RunnerEnvValue } from "./rivet-cloud-api.js";

// What `orange deploy --var`, `--secret`, and `--secrets-file` give a Worker on a Rivet cluster:
// variables in its runner pool's `env`, and cluster secrets that `env` names. The flags follow
// `wrangler deploy` (`--var`, `--secrets-file`) and `rivet deploy` (`--secret KEY[=SECRET_NAME]`).
// The checks are the Cloud API's, so nothing is written when one fails.
// https://cloud-api.rivet.dev/v2/openapi.json

// Rivet sets these on every runner, and `orange serve` reads the last two.
const reservedNames = new Set([
	"PORT",
	"RIVETKIT_ENGINE_SPAWN",
	"RIVETKIT_METRICS_PORT",
	"RIVET_ENDPOINT",
	"RIVET_ENVOY_VERSION",
	"RIVET_NAMESPACE",
	"RIVET_NODE_VERSION",
	"RIVET_POOL",
	"RIVET_POOL_NAME",
	"RIVET_TOKEN",
	workerSecretsVariable,
	workerVarsVariable,
]);
const isReserved = (name: string): boolean => reservedNames.has(name) || name.startsWith("RIVET_USER_DATA_");
const namePattern = /^[A-Za-z_][A-Za-z0-9_]*$/;
const secretNamePattern = /^[A-Za-z0-9_](?:[A-Za-z0-9_-]*[A-Za-z0-9_])?$/;
const maxNameBytes = 256;
const maxVariables = 256;
const maxEnvironmentBytes = 32 * 1024;
const maxSecretBytes = 1024;
const maxSecretNameLength = 64;
export const maxClusterSecrets = 64;
// Unicode Cc, as the Cloud API's `^\P{Cc}*$`.
const controlCharacter = /\p{Cc}/u;

/** The variables and secrets one deploy adds to its pool. */
export interface EnvironmentChange {
	// The secret each name refers to, from `--secret` and `--secrets-file`.
	secrets: ReadonlyMap<string, string>;
	// Values to roll out first, by secret name, from `--secrets-file`.
	uploads: ReadonlyMap<string, string>;
	vars: ReadonlyMap<string, string>;
}

export interface EnvironmentFlags {
	secrets: readonly string[];
	secretsFiles: readonly string[];
	vars: readonly string[];
}

/**
 * Reads and checks a deploy's `--var`, `--secret`, and `--secrets-file`. Undefined when it passes
 * none. Values come from files, never arguments.
 */
export async function readEnvironmentChange(
	flags: EnvironmentFlags,
	// Configured bindings other than `vars`, such as a KV namespace. A variable cannot replace one.
	otherBindings: ReadonlySet<string>,
): Promise<EnvironmentChange | undefined> {
	if (flags.vars.length === 0 && flags.secrets.length === 0 && flags.secretsFiles.length === 0) return undefined;
	const sources = new Map<string, string>();
	const claim = (name: string, source: string): void => {
		const earlier = sources.get(name);
		if (earlier !== undefined) throw new ExpectedFailure(`${name} is set by both ${earlier} and ${source}. Set it once. Nothing was deployed.`);
		sources.set(name, source);
		checkName(name, source, otherBindings);
	};
	const vars = new Map<string, string>();
	for (const flag of flags.vars) {
		const colon = flag.indexOf(":");
		if (colon <= 0) throw new ExpectedFailure(`--var ${JSON.stringify(flag)} needs the form NAME:value, as in wrangler deploy --var.`);
		const name = flag.slice(0, colon);
		claim(name, `--var ${name}`);
		vars.set(name, checkValue(name, flag.slice(colon + 1), Infinity));
	}
	const secrets = new Map<string, string>();
	for (const flag of flags.secrets) {
		const [name = "", secret = name] = flag.split("=", 2);
		claim(name, `--secret ${name}`);
		if (!secretNamePattern.test(secret) || secret.length > maxSecretNameLength) {
			throw new ExpectedFailure(`--secret ${flag}: ${JSON.stringify(secret)} is not a secret name. Use letters, digits, _ and -, up to 64 characters. Nothing was deployed.`);
		}
		secrets.set(name, secret);
	}
	const uploads = new Map<string, string>();
	for (const path of flags.secretsFiles) {
		for (const [name, value] of Object.entries(await readSecretsFile(path))) {
			claim(name, path);
			// As `rivet cluster secret set` refuses one without --allow-empty: an empty value is a mistake far
			// more often than a wish.
			if (value === "") throw new ExpectedFailure(`${path}: ${name} is empty. Give it a value, or remove the line. Nothing was deployed.`);
			// The secret is named like its variable, as `rivet deploy --secret KEY` expects, so `rivet cluster
			// secret set KEY` changes what this Worker reads.
			if (name.length > maxSecretNameLength) {
				throw new ExpectedFailure(`${path}: ${name} is ${name.length} characters, and a Rivet cluster secret's name holds at most ${maxSecretNameLength}. Nothing was deployed.`);
			}
			secrets.set(name, name);
			uploads.set(name, checkValue(name, value, maxSecretBytes));
		}
	}
	return { secrets, uploads, vars };
}

/**
 * The pool's `env` after a deploy: the pool's own variables, with this deploy's on top, as `rivet
 * deploy` merges them. Its keys are the names the Worker sees, so it is also the map back from
 * secrets. A variable is removed with `rivet cluster env unset`.
 */
export function mergePoolEnvironment(
	current: Readonly<Record<string, RunnerEnvValue>> | undefined,
	change: EnvironmentChange | undefined,
	otherBindings: ReadonlySet<string>,
): { env: Record<string, RunnerEnvValue>; shadowed: string[]; unpinned: string[] } {
	const env: Record<string, RunnerEnvValue> = {};
	const unpinned: string[] = [];
	for (const [name, value] of Object.entries(current ?? {})) {
		if (name === workerVarsVariable || name === workerSecretsVariable) continue;
		// A sent `env` takes each secret's latest version, as `rivet deploy` does.
		if ("secret" in value) {
			if (value.secret.pinned_version != null) unpinned.push(name);
			env[name] = { secret: { name: value.secret.name } };
		} else {
			env[name] = value;
		}
	}
	for (const [name, value] of change?.vars ?? []) env[name] = { string: value };
	for (const [name, secret] of change?.secrets ?? []) env[name] = { secret: { name: secret } };
	// A variable that another tool set on the pool under a binding's name cannot replace the binding.
	const bound = Object.keys(env).filter((name) => !otherBindings.has(name)).sort();
	const shadowed = Object.keys(env).filter((name) => otherBindings.has(name)).sort();
	// The runner's process holds other variables too, so `orange serve` binds only these names.
	const varNames = bound.filter((name) => "string" in (env[name] as RunnerEnvValue));
	const secretNames = bound.filter((name) => "secret" in (env[name] as RunnerEnvValue));
	if (varNames.length > 0) env[workerVarsVariable] = { string: varNames.join(",") };
	if (secretNames.length > 0) env[workerSecretsVariable] = { string: secretNames.join(",") };
	checkPoolSize(env);
	return { env, shadowed, unpinned: unpinned.filter((name) => "secret" in (env[name] as RunnerEnvValue)).sort() };
}

/** Whether two pool `env` maps are equal, apart from rollback pins, so a deploy can leave the pins alone. */
export function samePoolEnvironment(
	a: Readonly<Record<string, RunnerEnvValue>> | undefined,
	b: Readonly<Record<string, RunnerEnvValue>>,
): boolean {
	const key = (env: Readonly<Record<string, RunnerEnvValue>>): string =>
		JSON.stringify(
			Object.entries(env)
				.map(([name, value]) => [name, "string" in value ? `s:${value.string}` : `r:${value.secret.name}`])
				.sort(),
		);
	return key(a ?? {}) === key(b);
}

function checkPoolSize(env: Readonly<Record<string, RunnerEnvValue>>): void {
	const entries = Object.entries(env);
	if (entries.length > maxVariables) {
		throw new ExpectedFailure(`The pool would have ${entries.length} variables, and a Rivet runner pool takes at most ${maxVariables}. Nothing was deployed.`);
	}
	const bytes = entries.reduce(
		(total, [name, value]) => total + byteLength(name) + byteLength("string" in value ? value.string : value.secret.name),
		0,
	);
	if (bytes > maxEnvironmentBytes) {
		throw new ExpectedFailure(
			`The pool's variable names and values would take ${bytes} bytes, and a Rivet runner pool takes at most ${maxEnvironmentBytes}. Move large values to R2 or KV. Nothing was deployed.`,
		);
	}
}

function checkName(name: string, source: string, otherBindings: ReadonlySet<string>): void {
	if (!namePattern.test(name) || byteLength(name) > maxNameBytes) {
		throw new ExpectedFailure(`${source}: ${JSON.stringify(name)} is not a valid variable name. Use letters, digits and _, not starting with a digit. Nothing was deployed.`);
	}
	if (isReserved(name)) {
		throw new ExpectedFailure(`${source}: Rivet or Orange sets ${name} on every runner, so a Worker cannot set it. Nothing was deployed.`);
	}
	if (otherBindings.has(name)) {
		throw new ExpectedFailure(`${source}: ${name} is already a binding in the Wrangler configuration. Rename the variable. Nothing was deployed.`);
	}
}

function checkValue(name: string, value: string, maxBytes: number): string {
	if (controlCharacter.test(value)) {
		throw new ExpectedFailure(
			`${name} has a line break or another control character, and Rivet runner variables and secrets are one line. Encode it, for example with \`base64 -w0 key.pem\`, and decode it in the Worker with atob(env.${name}). Nothing was deployed.`,
		);
	}
	const bytes = byteLength(value);
	if (bytes > maxBytes) {
		throw new ExpectedFailure(
			`${name} is ${bytes} bytes, and a Rivet cluster secret holds at most ${maxBytes}. Keep large material in R2 or KV and put the key to it in the secret. Nothing was deployed.`,
		);
	}
	return value;
}

// `wrangler secret bulk`'s formats: a JSON object of strings, or `.env` lines.
async function readSecretsFile(path: string): Promise<Record<string, string>> {
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (error: unknown) {
		const code = (error as NodeJS.ErrnoException).code;
		const problem =
			code === "ENOENT" ? "does not exist" : code === "EISDIR" ? "is a directory" : code === "EACCES" ? "is not readable" : undefined;
		// An unknown read failure is not a user fault, so it keeps the bug report.
		if (problem === undefined) throw error;
		throw new ExpectedFailure(`--secrets-file ${path} ${problem}. Pass the path to a .env or JSON file. Nothing was deployed.`);
	}
	let json: unknown;
	try {
		json = JSON.parse(text);
	} catch {
		return Object.fromEntries(Object.entries(parseEnv(text)).filter((entry): entry is [string, string] => entry[1] !== undefined));
	}
	if (typeof json !== "object" || json === null || Array.isArray(json)) {
		throw new ExpectedFailure(`--secrets-file ${path} holds JSON that is not an object of names to text values.`);
	}
	for (const [name, value] of Object.entries(json)) {
		if (typeof value !== "string") throw new ExpectedFailure(`--secrets-file ${path}: ${name} is not text. Secret values are strings.`);
	}
	return json as Record<string, string>;
}

function byteLength(text: string): number {
	return Buffer.byteLength(text, "utf8");
}
