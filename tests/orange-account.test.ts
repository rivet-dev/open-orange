import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { copyProject, repositoryRoot, withDeadline } from "./orange-dev.js";
import { type RivetCloudDouble, startRivetCloudDouble } from "./rivet-cloud-double.js";

const cliEntrypoint = join(repositoryRoot, "src", "bin.ts");
const cluster = "acme";

interface Account {
	cloud: RivetCloudDouble;
	credentialsPath: string;
	// Runs the real CLI from the project directory with a private home directory.
	orange(args: readonly string[], env?: NodeJS.ProcessEnv): Promise<{ code: number | null; output: string; stdout: string }>;
	projectDirectory: string;
	writeSession(session: { accessToken: string; expiresAt: number; refreshToken: string }): Promise<void>;
}

async function withAccount(body: (account: Account) => Promise<void>): Promise<void> {
	const cloud = await startRivetCloudDouble({
		builds: { bld_ready: "ready" },
		cluster,
		regions: ["iad"],
		token: "ci-token-value",
	});
	const project = await copyProject(join(repositoryRoot, "examples", "hello-durable-object"));
	const home = await mkdtemp(join(tmpdir(), "open-orange-account-"));
	const credentialsPath = join(home, ".rivet", "credentials");
	const orange: Account["orange"] = async (args, env = {}) => {
		const child = spawn(process.execPath, ["--import", fileURLToPath(import.meta.resolve("tsx")), cliEntrypoint, ...args], {
			cwd: project.directory,
			env: { ...process.env, CI: "1", HOME: home, NO_COLOR: "1", ...env },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let output = "";
		let stdout = "";
		child.stdout.on("data", (chunk: Buffer) => {
			output += chunk.toString();
			stdout += chunk.toString();
		});
		child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
		const code = await withDeadline(
			new Promise<number | null>((resolveExit) => child.once("exit", resolveExit)),
			`orange ${args.join(" ")}`,
			120_000,
		);
		return { code, output, stdout };
	};
	// The file `rivet login` writes.
	const writeSession: Account["writeSession"] = async ({ accessToken, expiresAt, refreshToken }) => {
		await mkdir(join(home, ".rivet"), { recursive: true });
		await writeFile(
			credentialsPath,
			JSON.stringify({
				rivet_cloud_token: "",
				sessions: {
					[cloud.url]: {
						access_token: accessToken,
						expires_at: expiresAt,
						refresh_token: refreshToken,
						user: { email: "ada@example.com", id: "user_1", name: "Ada" },
					},
				},
			}),
		);
	};
	try {
		await body({ cloud, credentialsPath, orange, projectDirectory: project.directory, writeSession });
	} finally {
		await project.dispose();
		await rm(home, { force: true, recursive: true });
		await cloud.close();
	}
}

const rollout = (cloud: RivetCloudDouble): string[] => ["--cloud-api", cloud.url, "--build", "bld_ready"];

test("orange login, link, and deploy need no flags or variables after the first sign-in", { timeout: 180_000 }, async () => {
	await withAccount(async ({ cloud, credentialsPath, orange }) => {
		const login = await orange(["login", "--no-browser", "--cloud-api", cloud.url]);
		assert.equal(login.code, 0, login.output);
		assert.match(login.output, /ABCD-1234/);
		assert.match(login.output, /Signed in as ada@example\.com/);
		// Only the user can read the session.
		assert.equal((await stat(credentialsPath)).mode & 0o777, 0o600);

		assert.equal((await orange(["link", "--cluster", cluster, "--org", "my-org"])).code, 0);
		const whoami = await orange(["whoami", "--cloud-api", cloud.url]);
		assert.equal(whoami.stdout.trim(), "Ada <ada@example.com>", whoami.output);
		assert.match(whoami.output, /Linked cluster: acme/);

		const deploy = await orange(["deploy", ...rollout(cloud)]);
		assert.equal(deploy.code, 0, deploy.output);
		assert.deepEqual(cloud.pools.get("iad/default")?.build_id, "bld_ready");
		assert.ok(cloud.organizations.length > 0, "a login token names its organization");
		assert.ok(cloud.organizations.every((organization) => organization === "my-org"), cloud.organizations.join());

		// After `logout` and `unlink`, the deploy says what is missing instead of using old state.
		assert.equal((await orange(["logout", "--cloud-api", cloud.url])).code, 0);
		assert.equal(cloud.session.refreshToken, undefined);
		const signedOut = await orange(["deploy", "--cluster", cluster, ...rollout(cloud)]);
		assert.equal(signedOut.code, 1, signedOut.output);
		assert.match(signedOut.output, /Run `orange login`/);
		assert.equal((await orange(["unlink"])).code, 0);
		const unlinked = await orange(["deploy", ...rollout(cloud)]);
		assert.equal(unlinked.code, 1, unlinked.output);
		assert.match(unlinked.output, /needs a cluster/);
	});
});

test("orange link points at orange mcp only until an agent configuration names the Rivet MCP", { timeout: 120_000 }, async () => {
	await withAccount(async ({ orange, projectDirectory }) => {
		const unset = await orange(["link", "--cluster", cluster]);
		assert.equal(unset.code, 0, unset.output);
		assert.match(unset.output, /Run orange mcp to connect your coding agent to the Rivet MCP for cluster acme\./);

		await writeFile(
			join(projectDirectory, ".mcp.json"),
			JSON.stringify({ mcpServers: { rivet: { type: "http", url: "https://mcp.rivet.dev/mcp?cluster=acme" } } }),
		);
		const configured = await orange(["link", "--cluster", cluster]);
		assert.equal(configured.code, 0, configured.output);
		assert.doesNotMatch(configured.output, /orange mcp/);
	});
});

test("a session that `rivet login` wrote refreshes when it has expired, and the new tokens are saved", { timeout: 120_000 }, async () => {
	await withAccount(async ({ cloud, credentialsPath, orange, writeSession }) => {
		const { refreshToken } = cloud.issueSession();
		await writeSession({ accessToken: "expired", expiresAt: Date.now() - 1_000, refreshToken });
		const deploy = await orange(["deploy", "--cluster", cluster, ...rollout(cloud)]);
		assert.equal(deploy.code, 0, deploy.output);
		const saved: unknown = JSON.parse(await readFile(credentialsPath, "utf8"));
		const session: unknown = Reflect.get(Object(Reflect.get(Object(saved), "sessions")), cloud.url);
		assert.equal(Reflect.get(Object(session), "refresh_token"), cloud.session.refreshToken);
		assert.notEqual(cloud.session.refreshToken, refreshToken);
		// Older Rivet CLIs fail to parse the file without this field.
		assert.equal(Reflect.get(Object(saved), "rivet_cloud_token"), "");
	});
});

test("a token that the API rejects before its expiry time is refreshed once, and the deploy continues", { timeout: 120_000 }, async () => {
	await withAccount(async ({ cloud, orange, writeSession }) => {
		const { refreshToken } = cloud.issueSession();
		await writeSession({ accessToken: "revoked", expiresAt: Date.now() + 3_600_000, refreshToken });
		const deploy = await orange(["deploy", "--cluster", cluster, ...rollout(cloud)]);
		assert.equal(deploy.code, 0, deploy.output);
		assert.equal(cloud.pools.get("iad/default")?.build_id, "bld_ready");
	});
});

test("a session the server no longer accepts fails the deploy, asks for a new sign-in, and leaves the pool alone", { timeout: 120_000 }, async () => {
	await withAccount(async ({ cloud, orange, writeSession }) => {
		await writeSession({ accessToken: "expired", expiresAt: Date.now() - 1_000, refreshToken: "revoked" });
		const deploy = await orange(["deploy", "--cluster", cluster, ...rollout(cloud)]);
		assert.equal(deploy.code, 1, deploy.output);
		assert.match(deploy.output, /session expired\. Run `orange login` again/);
		assert.deepEqual(cloud.poolUpdates, []);
		// The bad session is gone, so the next command does not try it again.
		const whoami = await orange(["whoami", "--cloud-api", cloud.url]);
		assert.equal(whoami.code, 1, whoami.output);
		assert.match(whoami.output, /Not signed in/);
	});
});

test("--token and RIVET_CLOUD_TOKEN win over a session, so CI never uses a developer's login", { timeout: 120_000 }, async () => {
	await withAccount(async ({ cloud, orange, writeSession }) => {
		await writeSession({ accessToken: "not-accepted", expiresAt: Date.now() + 3_600_000, refreshToken: "not-accepted" });
		const fromFlag = await orange(["deploy", "--cluster", cluster, "--token", "ci-token-value", ...rollout(cloud)]);
		assert.equal(fromFlag.code, 0, fromFlag.output);
		const fromVariable = await orange(["deploy", "--cluster", cluster, ...rollout(cloud)], { RIVET_CLOUD_TOKEN: "ci-token-value" });
		assert.equal(fromVariable.code, 0, fromVariable.output);
	});
});

test("a link's organization goes only to the linked cluster, not to a cluster named on the command", { timeout: 120_000 }, async () => {
	await withAccount(async ({ cloud, orange, writeSession }) => {
		const { accessToken, refreshToken } = cloud.issueSession();
		await writeSession({ accessToken, expiresAt: Date.now() + 3_600_000, refreshToken });
		assert.equal((await orange(["link", "--cluster", "other", "--org", "other-org"])).code, 0);
		const deploy = await orange(["deploy", "--cluster", cluster, ...rollout(cloud)]);
		assert.equal(deploy.code, 0, deploy.output);
		assert.deepEqual(cloud.organizations, []);
	});
});

test("a broken credentials or link file fails the command and names the file", { timeout: 120_000 }, async () => {
	await withAccount(async ({ cloud, credentialsPath, orange, projectDirectory }) => {
		await mkdir(dirname(credentialsPath), { recursive: true });
		await writeFile(credentialsPath, "{not json");
		const whoami = await orange(["whoami", "--cloud-api", cloud.url]);
		assert.equal(whoami.code, 1, whoami.output);
		assert.match(whoami.output, /Couldn't read .*credentials: it is not valid JSON/);

		await rm(credentialsPath);
		await mkdir(join(projectDirectory, ".rivet"), { recursive: true });
		await writeFile(join(projectDirectory, ".rivet", "project.json"), "{not json");
		const deploy = await orange(["deploy", "--token", "ci-token-value", ...rollout(cloud)]);
		assert.equal(deploy.code, 1, deploy.output);
		assert.match(deploy.output, /Couldn't read .*project\.json: it is not valid JSON/);
	});
});

test("a deploy whose login token went stale uses the session another process saved, and keeps it", { timeout: 120_000 }, async () => {
	await withAccount(async ({ cloud, credentialsPath, orange, writeSession }) => {
		const first = cloud.issueSession();
		await writeSession({ accessToken: first.accessToken, expiresAt: Date.now() + 3_600_000, refreshToken: first.refreshToken });
		const build = cloud.holdNext(`/v2/clusters/${cluster}/builds/bld_ready`);
		const deploy = orange(["deploy", "--cluster", cluster, ...rollout(cloud)]);
		await withDeadline(build.reached, "the deploy's build check", 60_000);

		// Another process refreshes while this deploy waits, so this deploy's tokens are spent.
		const second = cloud.issueSession();
		await writeSession({ accessToken: second.accessToken, expiresAt: Date.now() + 3_600_000, refreshToken: second.refreshToken });
		build.release();

		const finished = await deploy;
		assert.equal(finished.code, 0, finished.output);
		assert.equal(cloud.pools.get("iad/default")?.build_id, "bld_ready");
		const saved = JSON.parse(await readFile(credentialsPath, "utf8")) as { sessions: Record<string, { refresh_token: string }> };
		assert.equal(saved.sessions[cloud.url]?.refresh_token, second.refreshToken);
		assert.equal(cloud.session.refreshToken, second.refreshToken);
	});
});

test("deploys that find an expired session at the same moment both finish, and the session survives", { timeout: 180_000 }, async () => {
	await withAccount(async ({ cloud, credentialsPath, orange, writeSession }) => {
		const { refreshToken } = cloud.issueSession();
		await writeSession({ accessToken: "expired", expiresAt: Date.now() - 1_000, refreshToken });
		const [one, two] = await Promise.all([
			orange(["deploy", "--cluster", cluster, ...rollout(cloud)]),
			orange(["deploy", "--cluster", cluster, ...rollout(cloud)]),
		]);
		assert.equal(one.code, 0, one.output);
		assert.equal(two.code, 0, two.output);
		const saved = JSON.parse(await readFile(credentialsPath, "utf8")) as { sessions: Record<string, { refresh_token: string }> };
		assert.equal(saved.sessions[cloud.url]?.refresh_token, cloud.session.refreshToken);
	});
});

test("an admin token and a cluster the token cannot see each fail with what to do next", { timeout: 120_000 }, async () => {
	await withAccount(async ({ cloud, orange }) => {
		const admin = await orange(["deploy", "--cluster", cluster, "--token", "admin_not-a-cloud-token", ...rollout(cloud)]);
		assert.equal(admin.code, 1, admin.output);
		assert.match(admin.output, /cluster admin token \(admin_\.\.\.\), which is for the Rivet Engine, not the Rivet Cloud API/);
		assert.ok(!admin.output.includes("admin_not-a-cloud-token"), admin.output);

		const other = await orange(["deploy", "--cluster", "someone-elses", "--token", "ci-token-value", ...rollout(cloud)]);
		assert.equal(other.code, 1, other.output);
		assert.match(other.output, /this token may belong to another organization/);
		// The user's to fix, not a bug in Orange.
		assert.doesNotMatch(admin.output + other.output, /Looks like a bug/);
	});
});

test("an unreachable Rivet Cloud fails the deploy with one clear reason and no bug report link", { timeout: 120_000 }, async () => {
	await withAccount(async ({ cloud, orange, writeSession }) => {
		const { refreshToken } = cloud.issueSession();
		// An expired session must refresh first, so this covers the sign-in request and the API call.
		await writeSession({ accessToken: "expired", expiresAt: Date.now() - 1_000, refreshToken });
		await cloud.close();
		for (const credentials of [[], ["--token", "ci-token-value"]]) {
			const deploy = await orange(["deploy", "--cluster", cluster, ...credentials, ...rollout(cloud)]);
			assert.equal(deploy.code, 1, deploy.output);
			assert.equal(deploy.output.match(/Couldn't reach Rivet Cloud at /g)?.length, 1, deploy.output);
			assert.doesNotMatch(deploy.output, /Looks like a bug/);
		}
	});
});
