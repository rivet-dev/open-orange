import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { copyProject, repositoryRoot, withDeadline } from "./orange-dev.js";

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
	for (const args of [["d1", "not-a-subcommand"], ["not-a-command"], ["migrate", "prepare", "--no-such-flag"]]) {
		const { code, output } = await orange(args, repositoryRoot);
		assert.equal(code, 2, output);
		assert.ok(!output.includes(newIssue), output);
	}
});

test("a command that succeeds prints no issues link", { timeout: 60_000 }, async () => {
	const { code, output } = await orange(["--version"], repositoryRoot);
	assert.equal(code, 0, output);
	assert.ok(!output.includes("issues"), output);
});
