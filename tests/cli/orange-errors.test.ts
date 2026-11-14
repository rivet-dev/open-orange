import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { copyProject, repositoryRoot, withDeadline } from "../harness/orange-dev.js";

const cliEntrypoint = join(repositoryRoot, "src", "bin.ts");
const newIssue = "https://github.com/rivet-dev/open-orange/issues/new?";

async function orange(
	args: readonly string[],
	cwd: string,
	env: NodeJS.ProcessEnv = {},
): Promise<{ code: number | null; output: string }> {
	const child = spawn(process.execPath, ["--import", fileURLToPath(import.meta.resolve("tsx")), cliEntrypoint, ...args], {
		cwd,
		env: { ...process.env, CI: "1", NO_COLOR: "1", ...env },
		stdio: ["ignore", "pipe", "pipe"],
	});
	let output = "";
	child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
	child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
	const code = await withDeadline(
		new Promise<number | null>((resolveExit) => child.once("exit", resolveExit)),
		`orange ${args.join(" ")}`,
		60_000,
	);
	return { code, output };
}

// The text of the issue that the printed link opens.
function reportedIssue(output: string): { body: string; title: string } {
	const line = output.split("\n").find((candidate) => candidate.includes(newIssue));
	assert.ok(line !== undefined, `the output has no issues link:\n${output}`);
	assert.match(line, /^Looks like a bug\? Report it: /);
	const query = new URLSearchParams(line.slice(line.indexOf(newIssue) + newIssue.length));
	return { body: query.get("body") ?? "", title: query.get("title") ?? "" };
}

test("a failed command links to a prefilled issue that holds the error but no secret or local path", { timeout: 120_000 }, async () => {
	const project = await copyProject(join(repositoryRoot, "examples", "hello-durable-object"));
	const flagSecret = "correct-horse-battery-staple";
	const envSecret = "tr0ub4dor-and-3";
	// A real API that repeats the caller's credentials and a server path in its error, as a proxy might.
	const api = createServer((request, response) => {
		response.writeHead(500, { "content-type": "application/json" });
		response.end(
			JSON.stringify({
				code: "bad_token",
				message: `rejected ${request.headers.authorization ?? ""} password=hunter2hunter2 read from ${join(project.directory, "wrangler.jsonc")} and /etc/orange/deploy.key via https://user:pa55word@internal.example/v1?key=abc`,
			}),
		);
	});
	await new Promise<void>((listening) => api.listen(0, "127.0.0.1", listening));
	const cloudApi = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
	try {
		for (const { args, env, secret } of [
			{ args: ["--token", flagSecret], env: {}, secret: flagSecret },
			{ args: [], env: { RIVET_CLOUD_TOKEN: envSecret }, secret: envSecret },
		]) {
			const { code, output } = await orange(
				["deploy", "--cluster", "acme", "--build", "bld_1", "--cloud-api", cloudApi, ...args],
				project.directory,
				env,
			);
			assert.equal(code, 1, output);
			const { body, title } = reportedIssue(output);
			assert.match(title, /^orange deploy: /);
			assert.match(title, /\(HTTP 500\): rejected/);
			assert.match(body, /\(HTTP 500\): rejected/);
			const report = title + body;
			for (const leak of [secret, "hunter2hunter2", "pa55word", project.directory, "/etc/orange"]) {
				assert.ok(!report.includes(leak), `${leak} leaked into:\n${report}`);
			}
		}
	} finally {
		await new Promise((closed) => api.close(closed));
		await project.dispose();
	}
});

test("a usage error is the user's input, not a bug, so it prints no issues link", { timeout: 60_000 }, async () => {
	for (const args of [["d1", "not-a-subcommand"], ["not-a-command"], ["migrate", "prepare", "--no-such-flag"], ["deploy", "--no-such-flag"], ["serve", "--no-such-flag"], ["whoami", "--no-such-flag"]]) {
		const { code, output } = await orange(args, repositoryRoot);
		assert.equal(code, 2, output);
		assert.ok(!output.includes(newIssue), output);
	}
});

test("a mistake in the user's input or Worker fails with its reason and no issues link", { timeout: 120_000 }, async () => {
	const project = await copyProject(join(repositoryRoot, "examples", "hello-durable-object"));
	const broken = await copyProject(join(repositoryRoot, "examples", "hello-durable-object"));
	const withDatabase = await copyProject(join(repositoryRoot, "examples", "hello-durable-object"));
	await appendFile(join(broken.directory, "src", "index.ts"), "\nexport const = ;\n");
	await writeFile(
		join(withDatabase.directory, "wrangler.jsonc"),
		JSON.stringify({ compatibility_date: "2026-09-03", d1_databases: [{ binding: "DB", database_id: "db-1", database_name: "notes" }], main: "src/index.ts", name: "notes" }),
	);
	// A credentials file that is not JSON, as after an edit by hand.
	const brokenHome = join(project.directory, "home");
	await mkdir(join(brokenHome, ".rivet"), { recursive: true });
	await writeFile(join(brokenHome, ".rivet", "credentials"), "{");
	const noEndpoint = { RIVET_ENDPOINT: "" };
	try {
		for (const { args, cwd, env, reason } of [
			{ args: ["deploy", "--dry-run", "--var", "A=b"], cwd: project.directory, reason: /--var "A=b" needs the form NAME:value/ },
			{ args: ["deploy", "--dry-run", "--var", "RIVET_TOKEN:x"], cwd: project.directory, reason: /Rivet or Orange sets RIVET_TOKEN on every runner/ },
			{ args: ["deploy", "--dry-run"], cwd: broken.directory, reason: /src\/index\.ts:\d+:\d+: ERROR: / },
			{ args: ["serve"], cwd: project.directory, reason: /orange serve needs RIVET_ENDPOINT/ },
			{ args: ["d1", "execute", "DB", "--remote", "--command", "select 1"], cwd: withDatabase.directory, reason: /--remote needs a Rivet cluster\. Run `orange login` and `orange link --cluster <name>`, or set RIVET_ENDPOINT/ },
			{ args: ["d1", "execute", "NOPE", "--command", "select 1"], cwd: withDatabase.directory, reason: /Couldn't find a D1 DB with the name or binding 'NOPE'/ },
			{ args: ["whoami"], cwd: project.directory, env: { HOME: brokenHome }, reason: /credentials: it is not valid JSON .*Fix the file, or delete it/ },
		] as { args: string[]; cwd: string; env?: NodeJS.ProcessEnv; reason: RegExp }[]) {
			const { code, output } = await orange(args, cwd, { ...noEndpoint, ...env });
			assert.equal(code, 1, output);
			assert.match(output, reason);
			assert.ok(!output.includes(newIssue), output);
		}
	} finally {
		await Promise.all([project.dispose(), broken.dispose(), withDatabase.dispose()]);
	}
});

test("a command that succeeds prints no issues link", { timeout: 60_000 }, async () => {
	const { code, output } = await orange(["--version"], repositoryRoot);
	assert.equal(code, 0, output);
	assert.ok(!output.includes("issues"), output);
});
