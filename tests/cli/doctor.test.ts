import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { isRecord } from "../../src/unknown-values.js";
import { copyProject, repositoryRoot } from "../harness/orange-dev.js";

const cliEntrypoint = fileURLToPath(new URL("../../src/bin.ts", import.meta.url));
// Resolved here, so the CLI can start in a project directory that has no tsx.
const tsxLoader = import.meta.resolve("tsx");

interface DoctorRun {
	code: number | null;
	stderr: string;
	stdout: string;
}

function runDoctor(project: string, ...args: string[]): Promise<DoctorRun> {
	return runDoctorWithEnv(project, {}, ...args);
}

function runDoctorWithEnv(
	project: string,
	env: Record<string, string>,
	...args: string[]
): Promise<DoctorRun> {
	return runOrangeIn(project, env, "doctor", "--cwd", project, "--port", "0", ...args);
}

// A server on a free port of 127.0.0.1, so doctor finds that port in use.
async function occupyPort(): Promise<{ close(): Promise<void>; port: number }> {
	const server = createNetServer();
	await new Promise<void>((listening) => server.listen(0, "127.0.0.1", listening));
	const address = server.address();
	assert.ok(address !== null && typeof address === "object");
	return { close: () => new Promise((closed) => server.close(() => closed())), port: address.port };
}

// HOME is a directory of the project copy, so the coding agent configuration of
// the machine that runs the tests never reaches the CLI.
function runOrangeIn(project: string, env: Record<string, string>, ...args: string[]): Promise<DoctorRun> {
	const child = spawn(process.execPath, ["--import", tsxLoader, cliEntrypoint, ...args], {
		cwd: project,
		env: { ...process.env, HOME: join(project, ".home"), NO_COLOR: "1", ...env },
		stdio: ["ignore", "pipe", "pipe"],
	});
	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (chunk: Buffer) => {
		stdout += chunk.toString();
	});
	child.stderr.on("data", (chunk: Buffer) => {
		stderr += chunk.toString();
	});
	return new Promise((resolveRun) => {
		child.once("exit", (code) => resolveRun({ code, stderr, stdout }));
	});
}

// A copy of a project with AI (needs a key), a stubbed Images binding, and a variable.
async function withProject(run: (project: string) => Promise<void>, fixture = "stub-bindings"): Promise<void> {
	const project = await copyProject(join(repositoryRoot, "tests", "fixtures", fixture));
	try {
		await run(project.directory);
	} finally {
		await project.dispose();
	}
}

test("orange doctor reports a ready project with exit 0", async () => {
	await withProject(async (project) => {
		await writeFile(join(project, ".dev.vars"), "OPENROUTER_API_KEY=test-key\n");
		const run = await runDoctor(project);
		assert.equal(run.code, 0, run.stdout);
		assert.match(run.stdout, /^✓ Config +wrangler\.jsonc · stub-bindings$/m);
		assert.match(run.stdout, /^✓ Workers AI +env\.AI · OpenRouter$/m);
		assert.match(run.stdout, /^● Ready for orange dev\n\n {2}Next\n {2}orange dev +Run the Worker on Rivet Actors on this machine$/m);
	});
});

test("orange doctor --json reports a missing provider key as an action, which fails only with --strict", async () => {
	await withProject(async (project) => {
		const run = await runDoctor(project, "--json");
		assert.equal(run.code, 0, run.stdout);
		const events = run.stdout
			.trim()
			.split("\n")
			.map((line): unknown => JSON.parse(line));
		assert.ok(events.every(isRecord), run.stdout);
		assert.deepEqual(
			events.find((event) => event.id === "ai:AI"),
			{
				detail: "env.AI needs an API key",
				docs: "https://github.com/rivet-dev/open-orange/blob/main/docs/modules/workers-ai.mdx",
				hint: "Set OPENROUTER_API_KEY, or ORANGE_AI_API_KEY with ORANGE_AI_BASE_URL, in .dev.vars.",
				id: "ai:AI",
				status: "action",
				title: "Workers AI",
				type: "check",
			},
		);
		assert.deepEqual(
			events.filter((event) => event.type === "binding").map((event) => [event.name, event.status]),
			[
				["AI", "pluggable"],
				["IMAGES", "stub"],
			],
		);
		assert.deepEqual(events.at(-1), {
			actions: 1,
			bindings: { needs_service: 1, not_supported: 1, runs_as_is: 0 },
			exitCode: 0,
			failures: 0,
			mcp: { configured: false, url: "https://mcp.rivet.dev/mcp" },
			next: ["orange dev"],
			ok: 6,
			type: "summary",
		});

		const strict = await runDoctor(project, "--json", "--strict");
		assert.equal(strict.code, 1, strict.stdout);
	});
});

const docs = "https://github.com/rivet-dev/open-orange/blob/main/docs/modules";
const migrateDocs = "https://github.com/rivet-dev/open-orange/blob/main/docs/migrate.mdx";
// Each binding that is not supported has a next step, even without a specific alternative.
const noBackend = "Orange has no backend for this binding. Call the service's HTTP API with fetch(), or keep this code off Orange.";

// The fixture has three bindings that run on Rivet Actors (KV and two Durable
// Objects), two that need a service (Workers AI and Send Email), Analytics Engine,
// which drops its writes, a stub (Vectorize), a binding type that OpenOrange has
// never heard of, and a variable. It also has a Cron Trigger, a Tail Worker, and
// three Durable Object classes: SQLite-backed Room, KV-backed Cart, and Lobby,
// which has no binding.
test("orange doctor lists unsupported bindings first, then what each other binding needs, and still exits 0", async () => {
	await withProject(async (project) => {
		// With the AI key and the SMTP server set, nothing needs setup, so --strict
		// shows that an unsupported binding alone does not fail doctor.
		const run = await runDoctorWithEnv(
			project,
			{ ORANGE_EMAIL_SMTP_URL: "smtp://127.0.0.1:2525", OPENROUTER_API_KEY: "test-key" },
			"--strict",
		);
		assert.equal(run.code, 0, run.stdout);
		const lines = run.stdout.split("\n");
		// Each binding row, and the first full URL after it: a pipe cannot show a hyperlink.
		const rows = lines.flatMap((line, index) =>
			/^[! ] env\./.test(line)
				? [[...line.trim().split(/ {2,}/), lines.slice(index + 1).find((next) => next.trim().startsWith("https://"))?.trim()]]
				: [],
		);
		assert.deepEqual(rows, [
			["! env.FUTURE", "unsafe_quantum_ledger", "not supported", "stub · calls throw", `${docs}/bindings.mdx`],
			["! env.STATS", "Analytics Engine", "not supported", "drops writes", `${docs}/bindings.mdx`],
			["! env.VECTORS", "Vectorize", "not supported", "stub · calls throw", `${docs}/bindings.mdx`],
			["env.AI", "Workers AI", "needs a service", "OpenAI-compatible API", `${docs}/workers-ai.mdx`],
			["env.EMAIL", "Send Email", "needs a service", "SMTP", `${docs}/email.mdx`],
			["env.CART", "Durable Object", "runs as is", "Rivet Actor · Cart", `${docs}/durable-objects.mdx`],
			["env.ROOM", "Durable Object", "runs as is", "Rivet Actor · Room", `${docs}/durable-objects.mdx`],
			["env.CACHE", "KV Namespace", "runs as is", "Rivet Actor", `${docs}/kv.mdx`],
		]);
		// Every docs link is a full URL that a reader can open, never a path in the repository.
		assert.doesNotMatch(run.stdout, /(^|[^/])docs\/[\w/-]+\.mdx/m);
		// Each line fits a 100-column terminal. Long hints wrap under their row.
		assert.deepEqual(lines.filter((line) => line.length > 100), []);
		assert.match(
			run.stdout,
			/^! env\.FUTURE .*\n {16}Orange has no backend for this binding\. Call the service's HTTP API with fetch\(\), or\n {16}keep this code off Orange\.\n {16}https:\/\/github\.com\/rivet-dev\/open-orange\/blob\/main\/docs\/modules\/bindings\.mdx$/m,
		);
		assert.match(run.stdout, /^ +Send data points to your own analytics store with fetch\(\)\.$/m);
		// A stub with no specific alternative points only at its docs page.
		assert.doesNotMatch(run.stdout, /See the OpenOrange bindings documentation/);
		assert.match(run.stdout, /^  3 of 8 bindings run as is, 2 need a service, 3 are not supported$/m);
		assert.match(run.stdout, /^  1 Cron Trigger and 1 Tail Worker run as is$/m);
		assert.match(run.stdout, /^  Docs  https:\/\/github\.com\/rivet-dev\/open-orange\/blob\/main\/docs\/modules\/bindings\.mdx$/m);
		assert.match(run.stdout, /^  Docs  https:\/\/github\.com\/rivet-dev\/open-orange\/blob\/main\/docs\/migrate\.mdx$/m);
	}, "mixed-bindings");
});

test("orange doctor --json gives each binding its support, hint, and documentation page, and the next commands", async () => {
	await withProject(async (project) => {
		const run = await runDoctor(project, "--json");
		assert.equal(run.code, 0, run.stdout);
		const events = run.stdout
			.trim()
			.split("\n")
			.map((line): unknown => JSON.parse(line));
		assert.ok(events.every(isRecord), run.stdout);
		assert.deepEqual(
			events
				.filter((event) => event.type === "binding")
				.map((event) => [event.name, event.status, event.support, event.hint, event.docs]),
			[
				["CART", "local", "runs_as_is", undefined, `${docs}/durable-objects.mdx`],
				["ROOM", "local", "runs_as_is", undefined, `${docs}/durable-objects.mdx`],
				["AI", "pluggable", "needs_service", "Set OPENROUTER_API_KEY, or ORANGE_AI_BASE_URL for another provider.", `${docs}/workers-ai.mdx`],
				["CACHE", "local", "runs_as_is", undefined, `${docs}/kv.mdx`],
				["EMAIL", "pluggable", "needs_service", "Set ORANGE_EMAIL_SMTP_URL to your SMTP server, such as Amazon SES, Resend, or Postmark.", `${docs}/email.mdx`],
				["FUTURE", "stub", "not_supported", noBackend, `${docs}/bindings.mdx`],
				// Analytics Engine has no backend either: it drops each data point.
				["STATS", "stub", "not_supported", "Send data points to your own analytics store with fetch().", `${docs}/bindings.mdx`],
				[
					"VECTORS",
					"stub",
					"not_supported",
					"Call a vector database, such as Qdrant Cloud or Pinecone, with fetch(), or use pgvector through Hyperdrive. For a few thousand vectors, store the embeddings in SQLite and rank them by cosine similarity in JavaScript.",
					`${docs}/bindings.mdx`,
				],
			],
		);
		assert.deepEqual(events.find((event) => event.name === "FUTURE")?.bindingType, "unsafe_quantum_ledger");
		assert.deepEqual(events.at(-1)?.bindings, { needs_service: 2, not_supported: 3, runs_as_is: 3 });
		// orange migrate prepare refuses this Worker, so doctor does not suggest orange migrate.
		assert.deepEqual(events.at(-1)?.next, ["orange dev"]);
		assert.deepEqual(
			events.filter((event) => event.type === "trigger").map((event) => [event.kind, event.name, event.support, event.docs]),
			[
				["cron", "*/5 * * * *", "runs_as_is", `${docs}/cron-triggers.mdx`],
				["tail_consumer", "mixed-bindings", "runs_as_is", `${docs}/tail-workers.mdx`],
			],
		);
	}, "mixed-bindings");
});

test("orange doctor says that orange migrate prepare refuses a Worker with a KV-backed or unbound class, and marks no class movable", async () => {
	await withProject(async (project) => {
		const run = await runDoctor(project);
		assert.equal(run.code, 0, run.stdout);
		const table = run.stdout.slice(run.stdout.indexOf("  Durable Object  "));
		assert.match(table, /^! Cart +KV-backed +cannot move its data\n +Cloudflare gives a KV-backed class no way to export its data\.$/m);
		assert.match(table, /^! Lobby +SQLite +needs a binding\n +Add a binding for Lobby to durable_objects\.bindings\./m);
		assert.match(table, /^! Room +SQLite +blocked$/m);
		assert.match(table, /^! orange migrate prepare refuses this Worker while Cart is KV-backed and Lobby has no binding\.$/m);
		assert.doesNotMatch(run.stdout, /orange migrate --help/);

		const json = await runDoctor(project, "--json");
		const events = json.stdout
			.trim()
			.split("\n")
			.map((line): unknown => JSON.parse(line));
		assert.ok(events.every(isRecord), json.stdout);
		const refusal = "orange migrate prepare refuses this Worker while Cart is KV-backed and Lobby has no binding.";
		assert.deepEqual(
			events
				.filter((event) => event.type === "durable_object_class")
				.map((event) => [event.name, event.storage, event.migratable, event.name === "Room" ? event.hint : typeof event.hint, event.docs]),
			[
				["Cart", "key-value", false, "string", migrateDocs],
				["Lobby", "sqlite", false, "string", migrateDocs],
				["Room", "sqlite", false, refusal, migrateDocs],
			],
		);
		assert.deepEqual(events.at(-1)?.next, ["orange dev"]);

		// prepare agrees: it refuses the same Worker and writes nothing.
		const prepare = await runOrangeIn(project, {}, "migrate", "prepare");
		assert.equal(prepare.code, 1);
		assert.equal(existsSync(join(project, "wrangler.migrate.jsonc")), false);
	}, "mixed-bindings");
});

// A class that transferred_classes moves in from another Worker, and a staging environment
// whose own migrations make the same class KV-backed.
const transferProject = {
	compatibility_date: "2026-09-03",
	durable_objects: { bindings: [{ class_name: "Room", name: "ROOM" }] },
	env: {
		staging: {
			durable_objects: { bindings: [{ class_name: "Room", name: "ROOM" }] },
			migrations: [{ new_classes: ["Room"], tag: "v1" }],
		},
	},
	main: "./worker.js",
	migrations: [{ tag: "v1", transferred_classes: [{ from: "Room", from_script: "old-app", to: "Room" }] }],
	name: "transfer",
};

test("orange doctor and orange migrate prepare count a transferred class, and doctor -e reads that environment's migrations", async () => {
	await withProject(async (project) => {
		await writeFile(join(project, "wrangler.jsonc"), JSON.stringify(transferProject));
		const classes = async (...args: string[]): Promise<unknown[]> => {
			const run = await runDoctor(project, "--json", ...args);
			assert.equal(run.code, 0, run.stdout);
			const events = run.stdout
				.trim()
				.split("\n")
				.map((line): unknown => JSON.parse(line));
			assert.ok(events.every(isRecord), run.stdout);
			return [
				...events.filter((event) => event.type === "durable_object_class").map((event) => [event.name, event.storage, event.migratable]),
				events.at(-1)?.next,
			];
		};
		assert.deepEqual(await classes(), [["Room", "sqlite", true], ["orange dev", "orange migrate --help"]]);
		assert.deepEqual(await classes("-e", "staging"), [["Room", "key-value", false], ["orange dev"]]);

		const prepare = await runOrangeIn(project, {}, "migrate", "prepare");
		assert.equal(prepare.code, 0, prepare.stdout);
		assert.match(prepare.stdout, /Prepared Room\./);
	}, "mixed-bindings");
});

// Bindings whose calls throw until a setting is present, and Hyperdrive, whose config does not
// load without its connection string.
const settingsProject = {
	browser: { binding: "BROWSER" },
	compatibility_date: "2026-09-03",
	hyperdrive: [{ binding: "HYPER", id: "hyper", localConnectionString: "postgres://user:hyper-pass@127.0.0.1:5432/app" }],
	main: "./worker.js",
	name: "settings",
	secrets_store_secrets: [{ binding: "API_KEY", secret_name: "api-key", store_id: "store" }],
	send_email: [{ name: "EMAIL" }],
};

interface SettingsReport {
	checks: Record<string, unknown>;
	hints: Record<string, unknown>;
	actions: unknown;
	stdout: string;
}

async function settingsReport(project: string, env: Record<string, string> = {}): Promise<SettingsReport> {
	const run = await runDoctorWithEnv(project, env, "--json");
	const events = run.stdout
		.trim()
		.split("\n")
		.map((line): unknown => JSON.parse(line));
	assert.ok(events.every(isRecord), run.stdout);
	return {
		actions: events.at(-1)?.actions,
		checks: Object.fromEntries(
			events.filter((event) => event.type === "check" && /:/.test(String(event.id))).map((event) => [event.id, event.status]),
		),
		hints: Object.fromEntries(events.filter((event) => event.type === "binding").map((event) => [event.name, event.hint])),
		stdout: run.stdout,
	};
}

test("orange doctor counts a missing Browser, Send Email, or Secrets Store setting as an action, and drops the Set hint once it is set", async () => {
	await withProject(async (project) => {
		await writeFile(join(project, "wrangler.jsonc"), JSON.stringify(settingsProject));
		const missing = await settingsReport(project);
		assert.deepEqual(missing.checks, { "browser:BROWSER": "action", "email:EMAIL": "action", "secret:API_KEY": "action" });
		assert.equal(missing.actions, 3);
		assert.deepEqual(missing.hints, {
			API_KEY: undefined,
			BROWSER: "Set ORANGE_BROWSER_CDP_URL to a Chrome DevTools Protocol endpoint, such as Browserbase or Browserless.",
			EMAIL: "Set ORANGE_EMAIL_SMTP_URL to your SMTP server, such as Amazon SES, Resend, or Postmark.",
			HYPER: undefined,
		});
		assert.equal((await runDoctor(project, "--strict")).code, 1);

		// The SMTP URL and the secret come from .dev.vars, the endpoint from the shell.
		await writeFile(join(project, ".dev.vars"), "ORANGE_EMAIL_SMTP_URL=smtp://mailer:smtp-pass@127.0.0.1:2525\nAPI_KEY=secret-value\n");
		const set = await settingsReport(project, { ORANGE_BROWSER_CDP_URL: "ws://127.0.0.1:9222/devtools?token=cdp-token" });
		assert.deepEqual(set.checks, { "browser:BROWSER": "ok", "email:EMAIL": "ok", "secret:API_KEY": "ok" });
		assert.equal(set.actions, 0);
		assert.deepEqual(set.hints, { API_KEY: undefined, BROWSER: undefined, EMAIL: undefined, HYPER: undefined });
		assert.doesNotMatch(set.stdout, /smtp-pass|secret-value|cdp-token|hyper-pass/);
		assert.equal((await runDoctorWithEnv(project, { ORANGE_BROWSER_CDP_URL: "ws://127.0.0.1:9222" }, "--strict")).code, 0);

		// The runner refuses an SMTP URL with another scheme, so orange dev cannot start.
		await writeFile(join(project, ".dev.vars"), "ORANGE_EMAIL_SMTP_URL=http://127.0.0.1:2525\nAPI_KEY=secret-value\n");
		const invalid = await runDoctor(project);
		assert.equal(invalid.code, 1, invalid.stdout);
		assert.match(invalid.stdout, /^× Send Email +ORANGE_EMAIL_SMTP_URL must be a URL that starts with smtp:\/\/ or smtps:\/\/$/m);
	}, "mixed-bindings");
});

test("orange doctor says that a binding to another Worker works only when the same orange dev session runs that Worker", async () => {
	await withProject(async (project) => {
		await writeFile(
			join(project, "wrangler.jsonc"),
			JSON.stringify({
				compatibility_date: "2026-09-03",
				dispatch_namespaces: [{ binding: "DISPATCH", namespace: "users" }],
				durable_objects: { bindings: [{ class_name: "Session", name: "SESSIONS", script_name: "auth" }] },
				main: "./worker.js",
				name: "api",
				services: [
					{ binding: "AUTH", service: "auth" },
					{ binding: "SELF", service: "api" },
				],
				tail_consumers: [{ service: "logger" }, { service: "api" }],
				workflows: [{ binding: "JOBS", class_name: "Job", name: "jobs", script_name: "auth" }],
			}),
		);
		const run = await runDoctor(project, "--json");
		assert.equal(run.code, 0, run.stdout);
		const events = run.stdout
			.trim()
			.split("\n")
			.map((line): unknown => JSON.parse(line));
		assert.ok(events.every(isRecord), run.stdout);
		const session = 'Works only when the same orange dev session runs Worker "auth": orange dev -c wrangler.jsonc -c <config of auth>.';
		assert.deepEqual(
			Object.fromEntries(events.filter((event) => event.type === "binding").map((event) => [event.name, [event.support, event.hint]])),
			{
				AUTH: ["runs_as_is", session],
				DISPATCH: ["runs_as_is", "Reaches only the Workers that the same orange dev session runs. Pass the config of each Worker with -c."],
				JOBS: ["runs_as_is", session],
				SELF: ["runs_as_is", undefined],
				SESSIONS: ["runs_as_is", session],
			},
		);
		assert.deepEqual(
			events.filter((event) => event.type === "trigger").map((event) => [event.name, event.hint]),
			[
				["logger", 'Tail Worker "logger" gets the events only when an orange dev session runs it. They wait in a stream until then.'],
				["api", undefined],
			],
		);
		assert.match((await runDoctor(project)).stdout, /Works only when the same orange dev session runs Worker "auth"/);
	});
});

test("orange doctor and orange mcp point at the Rivet MCP until an agent configuration of this project names it", async () => {
	await withProject(async (project) => {
		await mkdir(join(project, ".rivet"));
		await writeFile(join(project, ".rivet", "project.json"), JSON.stringify({ cluster: "prod" }));
		// Claude Code has the server for another project only, which does not count.
		await mkdir(join(project, ".home"));
		await writeFile(
			join(project, ".home", ".claude.json"),
			JSON.stringify({ projects: { "/somewhere/else": { mcpServers: { rivet: { type: "http", url: "https://mcp.rivet.dev/mcp" } } } } }),
		);
		const pinned = "https://mcp.rivet.dev/mcp?cluster=prod";

		const human = await runDoctor(project);
		assert.match(human.stdout, /^ {2}orange mcp +Connect your coding agent to the Rivet MCP$/m);
		const json = await runDoctor(project, "--json");
		assert.doesNotMatch(json.stdout, /orange mcp/);
		const summary: unknown = JSON.parse(json.stdout.trim().split("\n").at(-1) ?? "");
		assert.ok(isRecord(summary), json.stdout);
		assert.deepEqual(summary.mcp, { configured: false, url: pinned });
		const mcp = await runOrangeIn(project, {}, "mcp");
		assert.equal(mcp.code, 0, mcp.stdout);
		assert.match(mcp.stdout, /^! Rivet MCP is not set up\. Connect /m);
		assert.ok(mcp.stdout.includes(pinned), mcp.stdout);

		await writeFile(join(project, ".mcp.json"), JSON.stringify({ mcpServers: { rivet: { type: "http", url: pinned } } }));
		assert.doesNotMatch((await runDoctor(project)).stdout, /orange mcp/);
		const configured: unknown = JSON.parse((await runDoctor(project, "--json")).stdout.trim().split("\n").at(-1) ?? "");
		assert.ok(isRecord(configured));
		assert.deepEqual(configured.mcp, { configured: true, url: pinned });
		assert.match((await runOrangeIn(project, {}, "mcp")).stdout, /^✓ Rivet MCP is set up for Claude Code · cluster prod$/m);
	});
});

test("orange doctor reports a project with no bindings as having none", async () => {
	await withProject(async (project) => {
		await writeFile(
			join(project, "wrangler.jsonc"),
			JSON.stringify({ compatibility_date: "2026-09-03", main: "./worker.js", name: "bare" }),
		);
		const run = await runDoctor(project);
		assert.equal(run.code, 0, run.stdout);
		assert.match(run.stdout, /^  No bindings in this configuration$/m);
		assert.doesNotMatch(run.stdout, /bindings? runs? as is/);

		const json = await runDoctor(project, "--json");
		const events = json.stdout
			.trim()
			.split("\n")
			.map((line): unknown => JSON.parse(line));
		assert.ok(events.every(isRecord), json.stdout);
		assert.deepEqual(events.filter((event) => event.type === "binding"), []);
		assert.deepEqual(events.at(-1)?.bindings, { needs_service: 0, not_supported: 0, runs_as_is: 0 });
	});
});

test("orange doctor fails with exit 1 on an invalid config, points back at itself, and exits 2 on an unknown option", async () => {
	await withProject(async (project) => {
		await writeFile(
			join(project, "wrangler.jsonc"),
			JSON.stringify({ compatibility_date: "2026-09-03", kv_namespace: [{ binding: "KV", id: "kv" }], main: "./worker.js", name: "typo" }),
		);
		const run = await runDoctor(project);
		assert.equal(run.code, 1, run.stdout);
		assert.match(run.stdout, /^× Config +Unknown Wrangler configuration fields: kv_namespace\./m);
		assert.match(run.stdout, /^× 1 check to fix before orange dev can start$/m);
		assert.match(run.stdout, /^ {2}orange doctor +Check again after you fix each check marked ×$/m);
		assert.doesNotMatch(run.stdout, /^ {2}orange dev /m);

		const json = await runDoctor(project, "--json");
		assert.equal(json.code, 1, json.stdout);
		const summary: unknown = JSON.parse(json.stdout.trim().split("\n").at(-1) ?? "");
		assert.ok(isRecord(summary), json.stdout);
		assert.deepEqual([summary.failures, summary.exitCode, summary.next], [1, 1, ["orange doctor"]]);

		assert.equal((await runDoctor(project, "--bogus")).code, 2);
	});
});

test("orange exits right after a config typo even when the npm registry never finishes answering", { timeout: 60_000 }, async () => {
	// Wrangler checks npm for a newer version after it reports unknown fields. This
	// registry sends a byte every 500 ms and never ends the body, so the check's
	// 2 second idle timeout never fires and its socket stays open.
	const responses = new Set<ServerResponse>();
	const trickle = setInterval(() => {
		for (const response of responses) response.write(" ");
	}, 500);
	const registry = createServer((_request, response) => {
		response.writeHead(200, { "content-type": "application/json" });
		responses.add(response);
	});
	await new Promise<void>((resolveListen) => registry.listen(0, "127.0.0.1", resolveListen));
	const address = registry.address();
	assert.ok(address !== null && typeof address === "object");
	// The update check caches its answer under the temp directory, so each run needs a fresh one.
	const temp = await mkdtemp(join(tmpdir(), "open-orange-doctor-npm-"));
	try {
		await withProject(async (project) => {
			await writeFile(
				join(project, "wrangler.jsonc"),
				JSON.stringify({ compatibility_date: "2026-09-03", kv_namespace: [{ binding: "KV", id: "kv" }], main: "./worker.js", name: "typo" }),
			);
			const run = await runDoctorWithEnv(project, {
				TMPDIR: temp,
				npm_registry: `http://127.0.0.1:${address.port}/`,
			});
			assert.equal(run.code, 1, run.stdout);
			assert.match(run.stdout, /^× Config +Unknown Wrangler configuration fields: kv_namespace\./m);
		});
	} finally {
		clearInterval(trickle);
		registry.closeAllConnections();
		registry.close();
		await rm(temp, { force: true, recursive: true });
	}
});

test("a port in use fails doctor with exit 1 and no bug report, and the hint names a port that is free", async () => {
	await withProject(async (project) => {
		await writeFile(join(project, ".dev.vars"), "OPENROUTER_API_KEY=test-key\n");
		const occupied = await occupyPort();
		// The port right after it is taken too, so a hint of port + 1 would fail.
		const next = createNetServer();
		const nextListen = await new Promise<NodeJS.ErrnoException | undefined>((done) => {
			next.once("error", done);
			next.listen(occupied.port + 1, "127.0.0.1", () => done(undefined));
		});
		try {
			const run = await runOrangeIn(project, {}, "doctor", "--cwd", project, "--port", String(occupied.port));
			assert.equal(run.code, 1, run.stdout);
			assert.match(run.stdout, new RegExp(`^× Port +127\\.0\\.0\\.1:${occupied.port} is in use$`, "m"));
			assert.doesNotMatch(run.stderr, /Looks like a bug/);
			const hinted = Number(/run orange dev --port (\d+)\./.exec(run.stdout)?.[1]);
			assert.ok(Number.isInteger(hinted), run.stdout);
			if (nextListen === undefined) assert.notEqual(hinted, occupied.port + 1);
			// The hinted port takes a listener.
			const check = createNetServer();
			await new Promise<void>((listening, failed) => {
				check.once("error", failed);
				check.listen(hinted, "127.0.0.1", () => listening());
			});
			await new Promise((closed) => check.close(closed));
		} finally {
			if (nextListen === undefined) await new Promise((closed) => next.close(closed));
			await occupied.close();
		}
	});
});

test("doctor fails the disk check when the Engine log setting from the shell does not fit the free disk", async () => {
	await withProject(async (project) => {
		await writeFile(join(project, ".dev.vars"), "OPENROUTER_API_KEY=test-key\n");
		const fits = await runDoctor(project);
		assert.equal(fits.code, 0, fits.stdout);
		assert.match(fits.stdout, /^✓ Disk +\S+ \S+ free · Rivet Engine log up to \S+ \S+$/m);

		// 1 PiB is more than any test machine has free.
		const tooLarge = await runDoctorWithEnv(project, { RIVET__STORAGE__LOG_SHARD__MAX_DISK_BYTES: String(1024 ** 5) }, "--json");
		assert.equal(tooLarge.code, 1, tooLarge.stdout);
		const disk: unknown = tooLarge.stdout
			.trim()
			.split("\n")
			.map((line): unknown => JSON.parse(line))
			.find((event) => isRecord(event) && event.id === "disk");
		assert.ok(isRecord(disk), tooLarge.stdout);
		assert.equal(disk.status, "fail");
		assert.match(String(disk.detail), /^RIVET__STORAGE__LOG_SHARD__MAX_DISK_BYTES is 1073741824 MiB, but only \d+ MiB is free/);
	});
});

test("doctor flags a D1 app on chanfana before 3.1.0, whose deletes Orange's D1 rejects, and not one on 3.1.0", async () => {
	await withProject(async (project) => {
		await writeFile(join(project, ".dev.vars"), "OPENROUTER_API_KEY=test-key\n");
		await writeFile(
			join(project, "wrangler.jsonc"),
			JSON.stringify({
				compatibility_date: "2026-09-03",
				d1_databases: [{ binding: "DB", database_id: "db-id", database_name: "db" }],
				main: "./worker.js",
				name: "chanfana-app",
			}),
		);
		const installChanfana = async (version: string): Promise<void> => {
			await mkdir(join(project, "node_modules", "chanfana"), { recursive: true });
			await writeFile(join(project, "node_modules", "chanfana", "package.json"), JSON.stringify({ name: "chanfana", version }));
		};
		const chanfanaCheck = async (): Promise<unknown> => {
			const run = await runDoctor(project, "--json");
			assert.equal(run.code, 0, run.stdout);
			return run.stdout
				.trim()
				.split("\n")
				.map((line): unknown => JSON.parse(line))
				.find((event) => isRecord(event) && event.id === "chanfana");
		};

		await installChanfana("3.0.0");
		const old = await chanfanaCheck();
		assert.ok(isRecord(old));
		assert.equal(old.status, "action");
		assert.match(String(old.detail), /^chanfana 3\.0\.0 deletes with DELETE \.\.\. RETURNING \* LIMIT 1/);
		assert.equal(old.hint, "Upgrade chanfana to 3.1.0 or later, which deletes without LIMIT.");

		await installChanfana("3.1.0");
		assert.equal(await chanfanaCheck(), undefined);
	});
});

function diskEvent(run: DoctorRun): Record<string, unknown> {
	const disk: unknown = run.stdout
		.trim()
		.split("\n")
		.map((line): unknown => JSON.parse(line))
		.find((event) => isRecord(event) && event.id === "disk");
	assert.ok(isRecord(disk), `${run.stdout}\n${run.stderr}`);
	return disk;
}

// Another storage directory's log is space that this Worker's Engine cannot reuse.
test("doctor counts only the Engine log that orange dev would start, as the Engine does", async () => {
	await withProject(async (project) => {
		await writeFile(join(project, ".dev.vars"), "OPENROUTER_API_KEY=test-key\n");
		const otherLog = join(project, ".open-orange", "rivetkit", "another-worker", ".rivetkit", "var", "engine", "depot", "log");
		await mkdir(otherLog, { recursive: true });
		// A sparse file: 8 TiB in size, under ext4's 16 TiB file limit, and almost no disk.
		await writeFile(join(otherLog, "segment"), "");
		await truncate(join(otherLog, "segment"), 8 * 1024 ** 4);
		// More than any test machine has free, and less than the free disk plus that file.
		const run = await runDoctorWithEnv(project, { RIVET__STORAGE__LOG_SHARD__MAX_DISK_BYTES: String(4 * 1024 ** 4) }, "--json");
		assert.equal(run.code, 1, run.stdout);
		assert.equal(diskEvent(run).status, "fail");
	});
});

test("doctor reports a storage directory it cannot read as a failed disk check, not a crash", { skip: process.getuid?.() === 0 ? "root reads every directory" : false }, async () => {
	await withProject(async (project) => {
		const storage = join(project, ".open-orange", "rivetkit");
		await mkdir(storage, { recursive: true });
		await chmod(storage, 0o000);
		try {
			const run = await runDoctor(project, "--json");
			assert.equal(run.code, 1, `${run.stdout}\n${run.stderr}`);
			const disk = diskEvent(run);
			assert.equal(disk.status, "fail");
			assert.match(String(disk.detail), /^Couldn't read the free disk space for the Rivet Engine: EACCES/);
			assert.doesNotMatch(run.stderr, /Looks like a bug/);
		} finally {
			await chmod(storage, 0o755);
		}
	});
});
