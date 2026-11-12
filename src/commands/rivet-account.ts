import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, readFile, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, parse } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { z } from "zod";

import { ExpectedFailure, exitWithOutcome } from "../cli/issue-report.js";
import { isRivetMcpConfigured } from "./mcp.js";
import { createRivetCloudClient } from "./rivet-cloud-api.js";

// Sign-in and the cluster link. These read and write the files of the Rivet CLI, so `rivet login`
// and `orange login` share one session.
// https://github.com/rivet-dev/actors/blob/587132c26994d9358b1ed1633641f023cb8f3942/engine/packages/cli/src/auth.rs#L1-L328
// https://github.com/rivet-dev/actors/blob/587132c26994d9358b1ed1633641f023cb8f3942/engine/packages/cli/src/credentials.rs#L1-L97
// https://github.com/rivet-dev/actors/blob/587132c26994d9358b1ed1633641f023cb8f3942/engine/packages/cli/src/target.rs#L1-L336

export const defaultCloudApi = "https://cloud-api.rivet.dev";

const clientId = "rivet-cli";
const scope = "rivet:cloud:read rivet:cloud:write";
const refreshSkewMs = 60_000;
const refreshRaceMs = 1_000;
const sessionExpiredMessage = "Your Rivet Cloud session expired. Run `orange login` again.";
const requestTimeoutMs = 60_000;

const sessionUserSchema = z.looseObject({
	email: z.string(),
	id: z.string(),
	name: z.string().default(""),
});

const sessionSchema = z.looseObject({
	access_token: z.string(),
	expires_at: z.number(),
	refresh_token: z.string(),
	user: sessionUserSchema,
});

type Session = z.infer<typeof sessionSchema>;

// Older Rivet CLIs need `rivet_cloud_token` in the file, so it stays even when empty. Fields that
// Orange does not read survive a rewrite.
const credentialsSchema = z.looseObject({
	rivet_cloud_token: z.string().default(""),
	sessions: z.record(z.string(), sessionSchema).default({}),
});

type Credentials = z.infer<typeof credentialsSchema>;

const tokenResponseSchema = z.object({
	access_token: z.string(),
	expires_in: z.number(),
	refresh_token: z.string(),
	user: sessionUserSchema,
});

const deviceCodeSchema = z.object({
	device_code: z.string(),
	expires_in: z.number(),
	interval: z.number(),
	user_code: z.string(),
	verification_uri: z.string(),
	verification_uri_complete: z.string().nullish(),
});

const oauthErrorSchema = z.object({
	error: z.string(),
	error_description: z.string().nullish(),
});

const linkSchema = z.object({
	cluster: z.string().optional(),
	org: z.string().optional(),
	project: z.string().optional(),
});

function credentialsPath(): string {
	return join(homedir(), ".rivet", "credentials");
}

// The name of a broken file is the fix. A bare SyntaxError names nothing.
function parseJsonFile(path: string, text: string): unknown {
	try {
		return JSON.parse(text);
	} catch (error: unknown) {
		throw new Error(`Couldn't read ${path}: it is not valid JSON (${error instanceof Error ? error.message : String(error)})`);
	}
}

async function readCredentials(): Promise<Credentials> {
	const path = credentialsPath();
	if (!existsSync(path)) return credentialsSchema.parse({});
	const parsed = credentialsSchema.safeParse(parseJsonFile(path, await readFile(path, "utf8")));
	if (!parsed.success) throw new Error(`Couldn't read ${path}: ${z.prettifyError(parsed.error)}`);
	return parsed.data;
}

async function writeCredentials(credentials: Credentials): Promise<void> {
	const path = credentialsPath();
	await mkdir(dirname(path), { recursive: true });
	// A rename, so another process never reads half of the file. The temporary name keeps the mode.
	const temporary = `${path}.${process.pid}.tmp`;
	await writeFile(temporary, JSON.stringify(credentials, null, 2), { mode: 0o600 });
	// `mode` applies only when the file is created.
	await chmod(temporary, 0o600);
	await rename(temporary, path);
}

function sessionKey(apiUrl: string): string {
	return apiUrl.replace(/\/+$/, "");
}

async function saveSession(apiUrl: string, session: Session | undefined): Promise<void> {
	const credentials = await readCredentials();
	if (session === undefined) delete credentials.sessions[sessionKey(apiUrl)];
	else credentials.sessions[sessionKey(apiUrl)] = session;
	await writeCredentials(credentials);
}

function sessionFrom(token: z.infer<typeof tokenResponseSchema>): Session {
	return {
		access_token: token.access_token,
		expires_at: Date.now() + token.expires_in * 1000,
		refresh_token: token.refresh_token,
		user: token.user,
	};
}

async function postAuth(apiUrl: string, path: string, body: unknown): Promise<{ status: number; ok: boolean; text: string }> {
	const url = new URL(`api/auth/device/${path}`, `${sessionKey(apiUrl)}/`);
	let response: Response;
	try {
		response = await fetch(url, {
			body: JSON.stringify(body),
			headers: { "content-type": "application/json" },
			method: "POST",
			signal: AbortSignal.timeout(requestTimeoutMs),
		});
	} catch (error: unknown) {
		const cause = error instanceof Error ? error.message : String(error);
		// A network failure is the machine's or Rivet Cloud's, not a bug in Orange.
		throw new ExpectedFailure(`Couldn't reach Rivet Cloud at ${url.origin}: ${cause}`);
	}
	return { ok: response.ok, status: response.status, text: await response.text() };
}

function isCurrent(session: Session): boolean {
	return session.expires_at - refreshSkewMs > Date.now();
}

/**
 * The newest usable session. Refresh tokens rotate, and every process on this machine shares the
 * credentials file, so the token that `held` carries may already be spent. As the Rivet CLI does,
 * this reads the file before each refresh, and it uses a session that another process saved.
 */
async function latestSession(apiUrl: string, held: Session): Promise<Session> {
	const latest = (await readCredentials()).sessions[sessionKey(apiUrl)];
	if (latest === undefined) throw new ExpectedFailure(sessionExpiredMessage);
	if (latest.refresh_token !== held.refresh_token && isCurrent(latest)) return latest;
	const { ok, status, text } = await postAuth(apiUrl, "refresh", { refresh_token: latest.refresh_token });
	if (ok) {
		const refreshed = sessionFrom(tokenResponseSchema.parse(JSON.parse(text)));
		await saveSession(apiUrl, refreshed);
		return refreshed;
	}
	if (status >= 400 && status < 500) {
		// A process that refreshed at the same moment holds the new tokens but has not saved them yet.
		await delay(refreshRaceMs);
		const after = (await readCredentials()).sessions[sessionKey(apiUrl)];
		if (after !== undefined && after.refresh_token !== latest.refresh_token) return await latestSession(apiUrl, latest);
		await saveSession(apiUrl, undefined);
		throw new ExpectedFailure(sessionExpiredMessage);
	}
	throw new Error(`Couldn't refresh the Rivet Cloud session (HTTP ${status}): ${text.slice(0, 200)}`);
}

export interface CloudAuth {
	readonly description: string;
	readonly user?: { email: string; name: string };
	// The token for a request. A login token lasts minutes, so long commands ask before each
	// request. `force` refreshes a login token that the API rejected.
	token(force?: boolean): Promise<string>;
}

function fixedAuth(token: string, description: string): CloudAuth {
	return { description, token: () => Promise.resolve(token) };
}

/**
 * Finds credentials in order: the flag, RIVET_CLOUD_TOKEN, the login session for this API, then the
 * legacy token in ~/.rivet/credentials.
 */
export async function resolveCloudAuth(flag: string | undefined, apiUrl: string): Promise<CloudAuth | undefined> {
	if (flag !== undefined && flag.length > 0) return fixedAuth(flag, "--token flag");
	const fromEnvironment = process.env.RIVET_CLOUD_TOKEN?.trim();
	if (fromEnvironment !== undefined && fromEnvironment.length > 0) {
		return fixedAuth(fromEnvironment, "RIVET_CLOUD_TOKEN");
	}
	const credentials = await readCredentials();
	const saved = credentials.sessions[sessionKey(apiUrl)];
	if (saved === undefined) {
		const legacy = credentials.rivet_cloud_token.trim();
		return legacy.length === 0 ? undefined : fixedAuth(legacy, "Cloud API token in ~/.rivet/credentials");
	}
	let session = saved;
	// A refresh rotates the refresh token, so concurrent requests in this process share one refresh.
	let refreshing: Promise<Session> | undefined;
	return {
		description: "orange login",
		user: { email: session.user.email, name: session.user.name },
		async token(force = false): Promise<string> {
			if (!force && isCurrent(session)) return session.access_token;
			refreshing ??= latestSession(apiUrl, session).finally(() => {
				refreshing = undefined;
			});
			session = await refreshing;
			return session.access_token;
		},
	};
}

// The saved session for this API while it still works. One the server no longer refreshes is gone.
async function workingSession(apiUrl: string): Promise<Session | undefined> {
	const saved = (await readCredentials()).sessions[sessionKey(apiUrl)];
	if (saved === undefined || isCurrent(saved)) return saved;
	try {
		return await latestSession(apiUrl, saved);
	} catch (error: unknown) {
		if (error instanceof ExpectedFailure && error.message === sessionExpiredMessage) return undefined;
		throw error;
	}
}

function openBrowser(url: string): boolean {
	if (process.platform !== "darwin" && process.env.DISPLAY === undefined && process.env.WAYLAND_DISPLAY === undefined) {
		return false;
	}
	const command = process.platform === "darwin" ? "open" : "xdg-open";
	return spawnSync(command, [url], { stdio: "ignore" }).status === 0;
}

function parseJsonOrUndefined(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

async function login(apiUrl: string, useBrowser: boolean, io: AccountIo): Promise<Session> {
	const code = await postAuth(apiUrl, "code", { client_id: clientId, scope });
	if (!code.ok) throw new Error(`Couldn't start sign-in (HTTP ${code.status}): ${code.text.slice(0, 200)}`);
	const device = deviceCodeSchema.parse(JSON.parse(code.text));
	const userCode =
		device.user_code.length === 8 ? `${device.user_code.slice(0, 4)}-${device.user_code.slice(4)}` : device.user_code;
	const url = device.verification_uri_complete ?? device.verification_uri;
	io.error(`Your one-time code: ${userCode}`);
	io.error(useBrowser && openBrowser(url) ? `Opened ${url} in your browser.` : `Open ${url} in a browser to continue.`);
	io.error("Waiting for approval…");

	const deadline = Date.now() + device.expires_in * 1000;
	let intervalMs = Math.max(device.interval, 1) * 1000;
	for (;;) {
		await delay(intervalMs);
		if (Date.now() > deadline) throw new Error("The sign-in code expired. Run `orange login` again.");
		const poll = await postAuth(apiUrl, "token", {
			client_id: clientId,
			device_code: device.device_code,
			grant_type: "urn:ietf:params:oauth:grant-type:device_code",
		});
		if (poll.ok) {
			const session = sessionFrom(tokenResponseSchema.parse(JSON.parse(poll.text)));
			await saveSession(apiUrl, session);
			return session;
		}
		const failure = oauthErrorSchema.safeParse(parseJsonOrUndefined(poll.text));
		// A gateway can answer with HTML, so only a real OAuth error is read as one.
		if (!failure.success) throw new Error(`Sign-in failed (HTTP ${poll.status}): ${poll.text.slice(0, 200)}`);
		const reason = failure.data.error;
		if (reason === "authorization_pending") continue;
		if (reason === "slow_down") {
			intervalMs += 5_000;
			continue;
		}
		if (reason === "access_denied") throw new Error("Sign-in was denied in the browser.");
		if (reason === "expired_token") throw new Error("The sign-in code expired. Run `orange login` again.");
		throw new Error(`Sign-in failed: ${failure.data.error_description ?? reason}`);
	}
}

export interface LinkedTarget {
	readonly cluster?: string;
	readonly org?: string;
	readonly path: string;
}

const linkPath = (directory: string): string => join(directory, ".rivet", "project.json");

/** The nearest `.rivet/project.json` at or above the current directory. */
export function findLink(from: string = process.cwd()): LinkedTarget | undefined {
	for (let directory = from; ; directory = dirname(directory)) {
		const path = linkPath(directory);
		if (existsSync(path)) {
			const parsed = linkSchema.safeParse(parseJsonFile(path, readFileSync(path, "utf8")));
			if (!parsed.success) throw new Error(`Couldn't read ${path}: ${z.prettifyError(parsed.error)}`);
			return {
				path,
				...(parsed.data.cluster === undefined ? {} : { cluster: parsed.data.cluster }),
				...(parsed.data.org === undefined ? {} : { org: parsed.data.org }),
			};
		}
		if (directory === parse(directory).root) return undefined;
	}
}

export interface AccountIo {
	error(message: string): void;
	log(message: string): void;
}

export const accountCommands: ReadonlySet<string> = new Set(["link", "login", "logout", "unlink", "whoami"]);

export function renderAccountHelp(command: string): string {
	const shared = "  --cloud-api <url>   Rivet Cloud API. Default https://cloud-api.rivet.dev.";
	switch (command) {
		case "login":
			return ["open-orange login", "", "Sign in to Rivet Cloud in a browser. Shares the session with `rivet login`.", "Keeps a session that still works. Run `orange logout` first to sign in again.", "", "  --no-browser        Print the sign-in URL instead of opening a browser.", shared].join("\n");
		case "logout":
			return ["open-orange logout", "", "Remove the Rivet Cloud session.", "", shared].join("\n");
		case "whoami":
			return ["open-orange whoami", "", "Show the signed-in account and the linked cluster.", "", "  --token <token>     Describe this Rivet Cloud token instead.", shared].join("\n");
		case "link":
			return ["open-orange link", "", "Link this directory to a Rivet cluster, so `orange deploy` needs no --cluster.", "Writes .rivet/project.json. Shares the link with the Rivet CLI.", "Checks that the cluster exists when signed in.", "", "  --cluster <name>    Cluster to link. Required.", "  --org <slug>        Organization that the cluster belongs to.", shared].join("\n");
		default:
			return ["open-orange unlink", "", "Remove this directory's link to a Rivet cluster."].join("\n");
	}
}

/** Runs `login`, `logout`, `whoami`, `link`, or `unlink`. */
export async function runAccountCommand(args: readonly string[], io: AccountIo): Promise<number> {
	try {
		const [command = "", ...rest] = args;
		const { values } = parseArgs({
			args: [...rest],
			options: {
				"cloud-api": { type: "string" },
				cluster: { type: "string" },
				"no-browser": { type: "boolean" },
				org: { type: "string" },
				token: { type: "string" },
			},
			strict: true,
		});
		const apiUrl = values["cloud-api"] ?? defaultCloudApi;
		switch (command) {
			case "login": {
				const existing = await workingSession(apiUrl);
				if (existing !== undefined) {
					io.error(`Already signed in as ${existing.user.email}. To sign in as someone else, run \`orange logout\` first.`);
				} else {
					const session = await login(apiUrl, values["no-browser"] !== true, io);
					io.error(`Signed in as ${session.user.email}.`);
				}
				// A broken link file is `orange deploy`'s error to report, not sign-in's.
				const linked = (() => {
					try {
						return findLink()?.cluster !== undefined;
					} catch {
						return false;
					}
				})();
				io.error(linked ? "Next: orange deploy" : "Next: orange link --cluster <name>");
				return 0;
			}
			case "logout": {
				const credentials = await readCredentials();
				const session = credentials.sessions[sessionKey(apiUrl)];
				if (session === undefined) {
					io.error("Not signed in.");
					return 0;
				}
				// The session goes away locally even when the server can't revoke it.
				await postAuth(apiUrl, "logout", { refresh_token: session.refresh_token }).catch(() => undefined);
				await saveSession(apiUrl, undefined);
				io.error("Signed out.");
				return 0;
			}
			case "whoami": {
				const auth = await resolveCloudAuth(values.token, apiUrl);
				if (auth === undefined) {
					throw new Error("Not signed in to Rivet Cloud. Run `orange login`, or set RIVET_CLOUD_TOKEN or pass --token for CI.");
				}
				if (auth.user === undefined) io.log("Cloud API token");
				else io.log(auth.user.name.length === 0 ? auth.user.email : `${auth.user.name} <${auth.user.email}>`);
				io.error(`Credentials: ${auth.description}`);
				const link = findLink();
				if (link?.cluster !== undefined) io.error(`Linked cluster: ${link.cluster} (${link.path})`);
				return 0;
			}
			case "link": {
				if (values.cluster === undefined) throw new Error("orange link needs a cluster. Pass --cluster <name>.");
				// The same call that `orange deploy` makes first, so a cluster that does not exist fails here.
				const auth = await resolveCloudAuth(values.token, apiUrl);
				const organization = values.org ?? (process.env.RIVET_ORG?.trim() || undefined);
				if (auth === undefined) {
					io.error(`Not signed in, so Orange did not check that cluster ${values.cluster} exists. Run \`orange login\` to check it.`);
				} else {
					await createRivetCloudClient({
						apiUrl,
						cluster: values.cluster,
						...(organization === undefined ? {} : { organization }),
						token: (force) => auth.token(force),
					}).listRegions();
				}
				const path = linkPath(process.cwd());
				await mkdir(dirname(path), { recursive: true });
				const link = { cluster: values.cluster, ...(values.org === undefined ? {} : { org: values.org }) };
				await writeFile(path, `${JSON.stringify(link, null, 2)}\n`);
				io.error(`Linked cluster ${values.cluster} in ${path}.`);
				io.error("Next: orange deploy");
				if (!isRivetMcpConfigured(process.cwd())) {
					io.error(`Run orange mcp to connect your coding agent to the Rivet MCP for cluster ${values.cluster}.`);
				}
				return 0;
			}
			default: {
				const path = linkPath(process.cwd());
				if (!existsSync(path)) {
					io.error("This directory is not linked.");
					return 0;
				}
				await rm(path);
				await rmdir(dirname(path)).catch(() => undefined);
				io.error(`Removed ${path}.`);
				return 0;
			}
		}
	} catch (error: unknown) {
		io.error(error instanceof Error ? error.message : String(error));
		return error instanceof ExpectedFailure ? exitWithOutcome(1) : 1;
	}
}
