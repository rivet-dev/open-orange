import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { runOrange } from "../../src/bin.js";

const cliEntrypoint = fileURLToPath(new URL("../../src/bin.ts", import.meta.url));

// The CLI as a user starts it: a process with these arguments. With `closedStdout`, the reader of
// its output is gone before it writes, as for `orange doctor --json | head -n 1`.
function runCli(...args: string[]): Promise<{ code: number | null; stderr: string; stdout: string }> {
	return runCliWith({}, ...args);
}

function runCliWith(
	options: { closedStdout?: boolean; cwd?: string },
	...args: string[]
): Promise<{ code: number | null; stderr: string; stdout: string }> {
	const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), cliEntrypoint, ...args], {
		...(options.cwd === undefined ? {} : { cwd: options.cwd }),
		env: { ...process.env, NO_COLOR: "1" },
		stdio: ["ignore", "pipe", "pipe"],
	});
	if (options.closedStdout === true) child.stdout.destroy();
	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
	child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
	return new Promise((done) => child.once("exit", (code) => done({ code, stderr, stdout })));
}

function captureIo(): {
	io: { log(message: string): void; error(message: string): void };
	logs: string[];
	errors: string[];
} {
	const logs: string[] = [];
	const errors: string[] = [];
	return {
		io: {
			log: (message) => logs.push(message),
			error: (message) => errors.push(message),
		},
		logs,
		errors,
	};
}

test("renders the landing screen and nested open-orange help", async () => {
	const root = captureIo();
	assert.equal(await runOrange([], root.io), 0);
	assert.match(root.logs[0] ?? "", /^🍊 open-orange v\d/);
	assert.match(root.logs[0] ?? "", /^ {2}open-orange dev +Run the Worker in this directory$/m);

	const nested = captureIo();
	assert.equal(await runOrange(["d1", "migrations", "create", "--help"], nested.io), 0);
	assert.match(
		nested.logs[0] ?? "",
		/^open-orange d1 migrations create <database> <message>\n/,
	);
});

test("prints help for the Rivet-only serve and deploy commands", async () => {
	for (const command of ["serve", "deploy"]) {
		const { io, logs, errors } = captureIo();
		assert.equal(await runOrange([command, "--help"], io), 0);
		assert.match(logs[0] ?? "", new RegExp(`^open-orange ${command}\\n`));
		assert.deepEqual(errors, []);
	}
});

test("accepts a global option before a nested help path", async () => {
	const { io, logs } = captureIo();
	assert.equal(
		await runOrange(["--config", "wrangler.jsonc", "kv", "namespace", "--help"], io),
		0,
	);
	assert.match(logs[0] ?? "", /^open-orange kv namespace\n/);
});

test("fails unimplemented and unknown commands explicitly", async () => {
	const unimplemented = captureIo();
	assert.equal(await runOrange(["tail"], unimplemented.io), 1);
	assert.match(unimplemented.errors[0] ?? "", /is not implemented/);

	const unknown = captureIo();
	assert.equal(await runOrange(["not-a-command"], unknown.io), 2);
	assert.match(unknown.errors[0] ?? "", /Unknown open-orange command/);
});

test("each migrate command has its own help, also after a global option, and an unknown one is a usage error", async () => {
	for (const [args, heading] of [
		[["migrate", "prepare", "--help"], "open-orange migrate prepare"],
		[["migrate", "d1", "--help"], "open-orange migrate d1 <database>"],
		[["--cwd", ".", "migrate", "backfill", "-h"], "open-orange migrate backfill --url <url>"],
		[["-c", "wrangler.jsonc", "doctor", "--help"], "open-orange doctor"],
	] as const) {
		const run = await runCli(...args);
		assert.equal(run.code, 0, run.stderr);
		assert.equal(run.stdout.split("\n", 1)[0], heading);
	}
	// `--file --remote` copies into the Engine that RIVET_ENDPOINT names.
	const d1 = await runCli("migrate", "d1", "--help");
	assert.match(d1.stdout, /^ {2}RIVET_ENDPOINT +.*--file --remote/m);
	const overview = await runCli("migrate", "--help");
	assert.match(overview.stdout, /^ {2}d1 <database> --url <url> {2,}Move a D1 database/m);

	const unknown = await runCli("migrate", "nope", "--help");
	assert.equal(unknown.code, 2);
	assert.match(unknown.stderr, /Unknown orange migrate command: nope/);
});

test("no line of Orange's own help is wider than 100 columns", async () => {
	// Help that mirrors Wrangler's, such as `orange d1 --help`, keeps Wrangler's lines.
	const screens = [[], ["--help"], ["migrate", "--help"], ["migrate", "prepare", "--help"], ["migrate", "d1", "--help"], ["migrate", "backfill", "--help"], ["doctor", "--help"], ["deploy", "--help"], ["serve", "--help"], ["mcp", "--help"]];
	const wide: string[] = [];
	for (const args of screens) {
		const run = await runCli(...args);
		assert.equal(run.code, 0, run.stderr);
		for (const line of run.stdout.split("\n")) {
			if ([...line].length > 100) wide.push(`orange ${args.join(" ")}: ${line}`);
		}
	}
	assert.deepEqual(wide, []);
});

test("orange --help lists only the commands and global flags that work in Orange", async () => {
	const run = await runCli("--help");
	assert.equal(run.code, 0, run.stderr);
	assert.match(run.stdout, /^COMMANDS\n {2}dev +Run the Worker in this directory$/m);
	assert.match(run.stdout, /^ {2}login +Sign in to Rivet Cloud$/m);
	// Wrangler's Cloudflare commands and flags, which do not run in Orange.
	assert.doesNotMatch(run.stdout, /^ {2}open-orange |Cloudflare Tunnels|Delete a Worker|--install-skills|--profile|Login to Cloudflare/m);
	// A Wrangler command that Orange does not run says so, and reaches nothing.
	const deleted = captureIo();
	assert.equal(await runOrange(["delete", "my-worker"], deleted.io), 1);
	assert.match(deleted.errors[0] ?? "", /"delete" is not implemented/);
});

async function withFixture(name: string, run: (project: string) => Promise<void>): Promise<void> {
	const project = await mkdtemp(join(tmpdir(), "open-orange-pipe-"));
	try {
		await cp(fileURLToPath(new URL(`../../src/commands/fixtures/${name}/`, import.meta.url)), project, { recursive: true });
		await run(project);
	} finally {
		await rm(project, { force: true, recursive: true });
	}
}

test("a command whose reader closes the pipe drops the rest of its output and exits with its usual code", async () => {
	await withFixture("stub-bindings", async (project) => {
		await writeFile(join(project, ".dev.vars"), "OPENROUTER_API_KEY=test-key\n");
		const open = await runCliWith({ cwd: project }, "doctor", "--json", "--port", "0");
		const closed = await runCliWith({ closedStdout: true, cwd: project }, "doctor", "--json", "--port", "0");
		assert.equal(closed.code, open.code, closed.stderr);
		assert.doesNotMatch(closed.stderr, /EPIPE|Looks like a bug/);
	});
});

test("orange dev stops as for Ctrl-C when the reader of its output goes away", { timeout: 120_000 }, async () => {
	await withFixture("cloudflare-project", async (project) => {
		const run = await runCliWith({ closedStdout: true, cwd: project }, "dev", "--json", "--port", "0", "--ip", "127.0.0.1");
		assert.doesNotMatch(run.stderr, /EPIPE|Looks like a bug/);
		// The codes of a stop by Ctrl-C: 130 before the Worker is ready, 0 after.
		assert.ok(run.code === 130 || run.code === 0, `exit ${run.code}: ${run.stderr}`);
	});
});
