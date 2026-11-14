import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { glob, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import {
	closeWebSocket,
	collectMessages,
	copyProject,
	openWebSocket,
	repositoryRoot,
	type RunningOrangeDev,
	startOrangeDev as startDev,
	type TemporaryProject,
	waitFor,
	withDeadline,
} from "./orange-dev.js";
import { type CloudflareSource, describeSource, migratorToken, startCloudflareSource } from "./migrate-source.js";

const fixture = join(repositoryRoot, "tests", "fixtures", "migrate-room");
const cliEntrypoint = join(repositoryRoot, "src", "bin.ts");

function startOrange(args: readonly string[], cwd: string, env: NodeJS.ProcessEnv = {}): { exited: Promise<number | null>; kill(): void; output(): string } {
	const child = spawn(process.execPath, ["--import", fileURLToPath(import.meta.resolve("tsx")), cliEntrypoint, ...args], {
		cwd,
		env: { ...process.env, CI: "1", NO_COLOR: "1", ...env },
		stdio: ["ignore", "pipe", "pipe"],
	});
	let output = "";
	child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
	child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
	return {
		exited: new Promise((done) => child.once("exit", (code) => done(code))),
		kill: () => child.kill("SIGKILL"),
		output: () => output,
	};
}

async function orange(args: readonly string[], cwd: string, env: NodeJS.ProcessEnv = {}): Promise<{ code: number | null; output: string }> {
	const running = startOrange(args, cwd, env);
	const code = await withDeadline(running.exited, `orange ${args.join(" ")}`, 120_000);
	return { code, output: running.output() };
}

test("a prepared Worker keeps serving the app and the original code does not change", { timeout: 120_000 }, async () => {
	const project = await copyProject(fixture);
	try {
		const before = await readFile(join(project.directory, "worker.js"), "utf8");
		const prepared = await orange(["migrate", "prepare"], project.directory);
		assert.equal(prepared.code, 0, prepared.output);
		assert.match(prepared.output, /wrangler deploy --config wrangler\.migrate\.jsonc/);
		assert.equal(await readFile(join(project.directory, "worker.js"), "utf8"), before);

		const source = await startCloudflareSource(project.directory);
		try {
			assert.equal((await fetch(`${source.origin}/rooms/lobby/write`, { body: "hello", method: "POST" })).status, 200);
			const state = (await (await fetch(`${source.origin}/rooms/lobby/state`)).json()) as { messages: { body: string }[] };
			assert.deepEqual(state.messages.map(({ body }) => body), ["hello"]);
			// The export route is there, and refuses a caller without the token.
			const denied = await fetch(`${source.origin}/__migrate/ROOMS/resolve?name=lobby`);
			assert.equal(denied.status, 401);
		} finally {
			await source.close();
		}
	} finally {
		await project.dispose();
	}
});

test(
	"a prepared Worker still finds its find_additional_modules files, as files and through a dynamic import",
	{ timeout: 120_000 },
	async () => {
		const project = await copyProject(join(repositoryRoot, "tests", "fixtures", "migrate-modules"));
		try {
			const prepared = await orange(["migrate", "prepare"], project.directory);
			assert.equal(prepared.code, 0, prepared.output);
			const source = await startCloudflareSource(project.directory);
			try {
				const response = await fetch(source.origin);
				assert.equal(response.status, 200, `${await response.clone().text()}\n${source.output().slice(-2_000)}`);
				assert.deepEqual(await response.json(), { file: "hello from a skill", imported: "imported" });
			} finally {
				await source.close();
			}
		} finally {
			await project.dispose();
		}
	},
);

test("prepare names each binding whose data it does not move and each generated file that git would commit", { timeout: 120_000 }, async () => {
	const project = await copyProject(fixture);
	try {
		await writeFile(join(project.directory, ".gitignore"), "node_modules/\n.open-orange/\n");
		const first = await orange(["migrate", "prepare"], project.directory);
		assert.equal(first.code, 0, first.output);
		assert.match(first.output, /^! Add wrangler\.migrate\.jsonc to \.gitignore\./m);

		await writeFile(join(project.directory, ".gitignore"), "node_modules/\n.open-orange/\nwrangler.migrate.jsonc\n");
		const quiet = await orange(["migrate", "prepare"], project.directory);
		assert.equal(quiet.code, 0, quiet.output);
		assert.doesNotMatch(quiet.output, /Not moved|\.gitignore/);

		const configPath = join(project.directory, "wrangler.jsonc");
		const config = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
		await writeFile(
			configPath,
			JSON.stringify({
				...config,
				kv_namespaces: [{ binding: "CACHE", id: "cache-id" }],
				r2_buckets: [{ binding: "FILES", bucket_name: "files" }],
				vars: { GREETING: "hello" },
				vectorize: [{ binding: "VECTORIZE", index_name: "embeddings" }],
			}),
		);
		const prepared = await orange(["migrate", "prepare"], project.directory);
		assert.equal(prepared.code, 0, prepared.output);
		assert.match(prepared.output, /^✓ Prepared Room\. Your code did not change\.$/m);
		const notMoved = /^! Not moved: (.*)\. Their data stays on Cloudflare\./m.exec(prepared.output)?.[1]?.split(", ").sort();
		assert.deepEqual(notMoved, ["CACHE (kv_namespace)", "FILES (r2_bucket)", "VECTORIZE (vectorize)"]);
	} finally {
		await project.dispose();
	}
});

test("migrate commands take Wrangler's --cwd and --env before or after the command", { timeout: 120_000 }, async () => {
	const project = await copyProject(fixture);
	try {
		const configPath = join(project.directory, "wrangler.jsonc");
		const config = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
		// Only the environment has the KV namespace, so its Not moved line shows that -e was read.
		await writeFile(configPath, JSON.stringify({ ...config, env: { staging: { durable_objects: config.durable_objects, kv_namespaces: [{ binding: "CACHE", id: "cache-id" }] } } }));
		const parent = join(project.directory, "..");
		const prepared = await orange(["--cwd", "project", "-e", "staging", "migrate", "prepare"], parent);
		assert.equal(prepared.code, 0, prepared.output);
		assert.match(prepared.output, /^! Not moved: CACHE \(kv_namespace\)\./m);
		assert.match(prepared.output, /^ {2}wrangler deploy --config wrangler\.migrate\.jsonc -e staging$/m);
		assert.ok((await readdir(project.directory)).includes("wrangler.migrate.jsonc"));

		const after = await orange(["migrate", "prepare", "--cwd=project"], parent);
		assert.equal(after.code, 0, after.output);
		assert.doesNotMatch(after.output, /Not moved/);
		const missing = await orange(["migrate", "prepare", "--env"], project.directory);
		assert.equal(missing.code, 2, missing.output);
	} finally {
		await project.dispose();
	}
});

// The fixture app, with a single-page app in front of it. As on Cloudflare, only `/rooms/*` reaches
// the Worker first, and any other path that matches no file gets index.html.
async function serveStaticAssets(projectDirectory: string, extra: Record<string, unknown> = {}): Promise<void> {
	await mkdir(join(projectDirectory, "public"));
	await writeFile(join(projectDirectory, "public", "index.html"), "<!doctype html><title>Rooms</title>\n");
	const configPath = join(projectDirectory, "wrangler.jsonc");
	const config = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
	const assets = { directory: "./public", not_found_handling: "single-page-application", run_worker_first: ["/rooms/*"] };
	await writeFile(configPath, JSON.stringify({ ...config, assets, ...extra }));
}

async function readPreparedConfig(projectDirectory: string): Promise<Record<string, any>> {
	const text = await readFile(join(projectDirectory, "wrangler.migrate.jsonc"), "utf8");
	return JSON.parse(text.replace(/^\/\/.*\n/, "")) as Record<string, any>;
}

test("prepare sends the migrator's routes to the Worker before static assets, and keeps the app's own rules", { timeout: 120_000 }, async () => {
	const project = await copyProject(fixture);
	try {
		const assets = (runWorkerFirst: unknown) => ({ directory: "./public", not_found_handling: "single-page-application", run_worker_first: runWorkerFirst });
		await serveStaticAssets(project.directory, {
			env: {
				listed: { assets: assets(["/api/*", "/__migrate/*"]) },
				unset: { assets: { directory: "./public", not_found_handling: "single-page-application" } },
				all: { assets: assets(true) },
			},
		});
		const prepared = await orange(["migrate", "prepare"], project.directory);
		assert.equal(prepared.code, 0, prepared.output);
		const config = await readPreparedConfig(project.directory);
		assert.deepEqual(config.assets, assets(["/rooms/*", "/__migrate/*", "/__migrate-d1/*"]));
		assert.deepEqual(config.env.listed.assets.run_worker_first, ["/api/*", "/__migrate/*", "/__migrate-d1/*"]);
		assert.deepEqual(config.env.unset.assets.run_worker_first, ["/__migrate/*", "/__migrate-d1/*"]);
		assert.equal(config.env.all.assets.run_worker_first, true);
	} finally {
		await project.dispose();
	}
});

test("a KV-backed class fails prepare with a clear error, and nothing is written", { timeout: 120_000 }, async () => {
	const project = await copyProject(fixture);
	try {
		const configPath = join(project.directory, "wrangler.jsonc");
		const config = await readFile(configPath, "utf8");
		await writeFile(configPath, config.replace(`"new_sqlite_classes"`, `"new_classes"`));
		const { code, output } = await orange(["migrate", "prepare"], project.directory);
		assert.equal(code, 1, output);
		assert.match(output, /Room is KV-backed\. orange migrate moves only SQLite-backed classes/);
		// The error points at the guide by a URL that opens from anywhere.
		assert.match(output, /See https:\/\/github\.com\/rivet-dev\/open-orange\/blob\/main\/docs\/migrate\.mdx\.$/m);
		assert.ok(!(await readdir(project.directory)).includes("wrangler.migrate.jsonc"));

		// A rename keeps the backend, so the check follows the class to its new name.
		await writeFile(
			configPath,
			config.replace(
				`"migrations": [{ "tag": "v1", "new_sqlite_classes": ["Room"] }]`,
				`"migrations": [{ "tag": "v1", "new_classes": ["OldRoom"] }, { "tag": "v2", "renamed_classes": [{ "from": "OldRoom", "to": "Room" }] }]`,
			),
		);
		const renamed = await orange(["migrate", "prepare"], project.directory);
		assert.equal(renamed.code, 1, renamed.output);
		assert.match(renamed.output, /Room is KV-backed\./);
	} finally {
		await project.dispose();
	}
});

test("prepare names every blocker that doctor finds, as an expected failure, not a bug", { timeout: 120_000 }, async () => {
	// A KV-backed `Cart`, and a SQLite `Lobby` with no binding.
	const project = await copyProject(join(repositoryRoot, "src", "commands", "fixtures", "mixed-bindings"));
	try {
		const { code, output } = await orange(["migrate", "prepare"], project.directory);
		assert.equal(code, 1, output);
		assert.match(output, /^- Cart is KV-backed\./m);
		assert.match(output, /^- Lobby has no binding\./m);
		assert.doesNotMatch(output, /Looks like a bug/);
		assert.ok(!(await readdir(project.directory)).includes("wrangler.migrate.jsonc"));
	} finally {
		await project.dispose();
	}
});

interface RoomState {
	alarm: number | null;
	index: boolean;
	kv: Record<string, unknown>;
	messages: { body: string; id: number; rawLength: number | null; rawStart: string | null }[];
	name: string | null;
	nextId: number;
}

// RivetKit hides a failed call's reason from its caller, so a failed assertion shows the runtime's output.
const runtimeOutputs = new Map<string, () => string>();

async function startOrangeDev(...args: Parameters<typeof startDev>): Promise<RunningOrangeDev> {
	const running = await startDev(...args);
	runtimeOutputs.set(running.origin, running.output);
	return running;
}

async function roomState(origin: string, path: string): Promise<RoomState> {
	const response = await fetch(`${origin}${path}/state`);
	if (response.status !== 200) {
		const reason = (runtimeOutputs.get(origin)?.() ?? "").split("\n").filter((line) => line.length < 2_000 && !line.includes("sampled SQLite")).slice(-40).join("\n");
		assert.fail(`${path}/state answered ${response.status}: ${await response.text()}\n${reason}`);
	}
	return (await response.json()) as RoomState;
}

async function post(origin: string, path: string, body?: string): Promise<void> {
	const response = await fetch(`${origin}${path}`, { body: body ?? null, method: "POST" });
	assert.equal(response.status, 200, `${path}: ${await response.text()}\n${describeSource(origin)}`);
}

// Answers once the object runs again, because a restart fails the calls in flight.
async function restartRoom(origin: string, path: string): Promise<RoomState> {
	await post(origin, `${path}/restart`);
	// The fixture aborts 50 ms after it answers. Wait past that, so /state reaches the new instance.
	await delay(200);
	const deadline = Date.now() + 30_000;
	for (;;) {
		const response = await fetch(`${origin}${path}/state`);
		if (response.ok) return (await response.json()) as RoomState;
		if (Date.now() > deadline) assert.fail(`${path} did not restart: ${await response.text()}`);
		await delay(100);
	}
}

async function preparedSource(): Promise<{ project: TemporaryProject; source: CloudflareSource }> {
	const project = await copyProject(fixture);
	const prepared = await orange(["migrate", "prepare"], project.directory);
	assert.equal(prepared.code, 0, prepared.output);
	return { project, source: await startCloudflareSource(project.directory) };
}

async function destinationProject(workerUrl: string | undefined): Promise<TemporaryProject> {
	const project = await copyProject(fixture);
	if (workerUrl !== undefined) {
		await writeFile(join(project.directory, ".dev.vars"), `ORANGE_MIGRATE_WORKER_URL=${workerUrl}\nWORKER_MIGRATOR_TOKEN=${migratorToken}\n`);
	}
	return project;
}

test("an object moves on its first request, with its rows, KV values, alarm, and IDs, and stays moved", { timeout: 300_000 }, async () => {
	const { project: sourceProject, source } = await preparedSource();
	const destination = await destinationProject(source.origin);
	const alarm = Date.now() + 3_600_000;
	try {
		await post(source.origin, "/rooms/lobby/seed?rows=1200&bytes=64");
		await post(source.origin, "/rooms/lobby/write", "last on Cloudflare");
		await post(source.origin, `/rooms/lobby/alarm?at=${alarm}`);
		const unique = await (await fetch(`${source.origin}/new`)).text();
		await post(source.origin, `/ids/${unique}/seed?rows=3`);
		await post(source.origin, "/rooms/quiet/seed?rows=2");
		await post(source.origin, "/rooms/rpc-first/seed?rows=7");
		const lobbyBefore = await roomState(source.origin, "/rooms/lobby");
		const uniqueBefore = await roomState(source.origin, `/ids/${unique}`);
		assert.equal(lobbyBefore.messages.length, 1201);
		assert.equal(lobbyBefore.alarm, alarm);

		const orangeDev = await startOrangeDev(destination.directory);
		try {
			assert.deepEqual(await roomState(orangeDev.origin, "/rooms/lobby"), lobbyBefore);
			assert.deepEqual(await roomState(orangeDev.origin, `/ids/${unique}`), uniqueBefore);
			// An RPC call as the first call to an object also waits for the copy.
			assert.equal(await (await fetch(`${orangeDev.origin}/rpc/rpc-first`)).json(), 7);

			// The old copy refuses app traffic, so a late write cannot land there.
			const refused = await fetch(`${source.origin}/rooms/lobby/state`);
			assert.equal(refused.status, 503, await refused.clone().text());
			assert.match(await refused.text(), /migrator\.moved/);

			// A restart does not import again over newer writes.
			await post(orangeDev.origin, "/rooms/lobby/write", "first on Orange");
			const afterRestart = await restartRoom(orangeDev.origin, "/rooms/lobby");
			const newest = afterRestart.messages.at(-1);
			assert.equal(newest?.body, "first on Orange");
			// AUTOINCREMENT continues from Cloudflare's counter.
			assert.equal(newest?.id, lobbyBefore.nextId + 1);

			// deleteAll() stays deleted, even though Cloudflare still has the data.
			await post(orangeDev.origin, "/rooms/lobby/delete-all");
			assert.deepEqual((await restartRoom(orangeDev.origin, "/rooms/lobby")).messages, []);

			// A wake moves an object that gets no traffic, and only with the token.
			const denied = await fetch(`${orangeDev.origin}/__migrate/ROOMS/wake?name=quiet`, { method: "POST" });
			assert.equal(denied.status, 401);
			const woken = await fetch(`${orangeDev.origin}/__migrate/ROOMS/wake?name=quiet`, {
				headers: { authorization: `Bearer ${migratorToken}` },
				method: "POST",
			});
			assert.equal(woken.status, 200, await woken.clone().text());
			assert.equal((await fetch(`${source.origin}/rooms/quiet/state`)).status, 503);

			// With Cloudflare gone, moved objects and objects that Orange creates keep working.
			await source.close();
			assert.equal((await roomState(orangeDev.origin, "/rooms/quiet")).messages.length, 2);
			const created = await (await fetch(`${orangeDev.origin}/new`)).text();
			assert.deepEqual((await roomState(orangeDev.origin, `/ids/${created}`)).messages, []);
		} finally {
			await orangeDev.close();
		}
	} finally {
		await source.close();
		await destination.dispose();
		await sourceProject.dispose();
	}
});

test("an object that still runs code without the migrator fails its copy with a message that says so, and a later try moves it", { timeout: 300_000 }, async () => {
	const project = await copyProject(fixture);
	const destination = await destinationProject(undefined);
	let source: CloudflareSource | undefined;
	try {
		const prepared = await orange(["migrate", "prepare"], project.directory);
		assert.equal(prepared.code, 0, prepared.output);
		// The Worker is the wrapped one, but the class is not, as for an object that kept its old code
		// through open WebSockets after the wrapped deploy.
		const generated = join(project.directory, ".open-orange", "migrate", "worker.mjs");
		const wrapped = await readFile(generated, "utf8");
		await writeFile(generated, wrapped.replace("export const Room = migratable(app.Room);", "export const Room = app.Room;"));
		source = await startCloudflareSource(project.directory);
		await post(source.origin, "/rooms/lobby/seed?rows=3");
		const { port } = new URL(source.origin);
		await writeFile(join(destination.directory, ".dev.vars"), `ORANGE_MIGRATE_WORKER_URL=${source.origin}\nWORKER_MIGRATOR_TOKEN=${migratorToken}\n`);
		const orangeDev = await startOrangeDev(destination.directory);
		try {
			const wake = (): Promise<Response> =>
				fetch(`${orangeDev.origin}/__migrate/ROOMS/wake?name=lobby`, { headers: { authorization: `Bearer ${migratorToken}` }, method: "POST" });
			const refused = await wake();
			assert.equal(refused.status, 502);
			const message = await refused.text();
			assert.match(message, /The Worker on Cloudflare answered, but the object did not answer as a migrator/);
			assert.match(message, /Try again after its old connections close/);
			assert.doesNotMatch(message, /workerUrl must still reach Cloudflare/);

			// The object restarts with the wrapped class, and the next try copies it.
			await source.close();
			await writeFile(generated, wrapped);
			source = await startCloudflareSource(project.directory, Number(port));
			const before = await roomState(source.origin, "/rooms/lobby");
			const moved = await wake();
			assert.equal(moved.status, 200, await moved.clone().text());
			assert.deepEqual(await roomState(orangeDev.origin, "/rooms/lobby"), before);
		} finally {
			await orangeDev.close();
		}
	} finally {
		await source?.close();
		await destination.dispose();
		await project.dispose();
	}
});

test("an app that serves static assets moves its objects, and a Worker prepared without the migrator's routes fails with a message that says so", { timeout: 300_000 }, async () => {
	const project = await copyProject(fixture);
	const destination = await copyProject(fixture);
	let source: CloudflareSource | undefined;
	try {
		await serveStaticAssets(project.directory);
		await serveStaticAssets(destination.directory);
		const prepare = async (): Promise<void> => {
			const prepared = await orange(["migrate", "prepare"], project.directory);
			assert.equal(prepared.code, 0, prepared.output);
		};
		// As an Orange before this fix prepared it: the app's run_worker_first only.
		await prepare();
		const generatedConfig = join(project.directory, "wrangler.migrate.jsonc");
		const prepared = await readFile(generatedConfig, "utf8");
		await writeFile(generatedConfig, prepared.replace(/"run_worker_first": \[[^\]]*\]/, `"run_worker_first": ["/rooms/*"]`));
		source = await startCloudflareSource(project.directory);
		await post(source.origin, "/rooms/lobby/seed?rows=3");
		const { port } = new URL(source.origin);
		await writeFile(join(destination.directory, ".dev.vars"), `ORANGE_MIGRATE_WORKER_URL=${source.origin}\nWORKER_MIGRATOR_TOKEN=${migratorToken}\n`);
		const orangeDev = await startOrangeDev(destination.directory);
		try {
			const wake = (): Promise<Response> =>
				fetch(`${orangeDev.origin}/__migrate/ROOMS/wake?name=lobby`, { headers: { authorization: `Bearer ${migratorToken}` }, method: "POST" });
			const refused = await wake();
			assert.equal(refused.status, 502);
			const message = await refused.text();
			assert.match(message, /the Worker on Cloudflare did not answer as a migrator \(HTTP 200\)/);
			assert.match(message, /`assets\.run_worker_first` in wrangler\.migrate\.jsonc must list `\/__migrate\/\*`/);
			assert.doesNotMatch(message, /old connections/);

			// The prepare that the message asks for routes the migrator to the Worker, and the app's
			// pages still come from its assets.
			await source.close();
			await prepare();
			source = await startCloudflareSource(project.directory, Number(port));
			assert.match(await (await fetch(`${source.origin}/`)).text(), /<title>Rooms<\/title>/);
			const before = await roomState(source.origin, "/rooms/lobby");
			const moved = await wake();
			assert.equal(moved.status, 200, await moved.clone().text());
			assert.deepEqual(await roomState(orangeDev.origin, "/rooms/lobby"), before);
			assert.equal((await fetch(`${source.origin}/rooms/lobby/state`)).status, 503);
		} finally {
			await orangeDev.close();
		}
	} finally {
		await source?.close();
		await destination.dispose();
		await project.dispose();
	}
});

test("while Cloudflare is down an object fails its requests instead of serving empty data, then recovers", { timeout: 300_000 }, async () => {
	const { project: sourceProject, source } = await preparedSource();
	const destination = await destinationProject(source.origin);
	let restarted: CloudflareSource | undefined;
	try {
		await post(source.origin, "/rooms/lobby/seed?rows=5");
		const before = await roomState(source.origin, "/rooms/lobby");
		const { port } = new URL(source.origin);
		await source.close();

		const orangeDev = await startOrangeDev(destination.directory);
		try {
			const down = await fetch(`${orangeDev.origin}/rooms/lobby/state`);
			assert.notEqual(down.status, 200, await down.clone().text());

			restarted = await startCloudflareSource(sourceProject.directory, Number(port));
			const deadline = Date.now() + 120_000;
			for (;;) {
				const response = await fetch(`${orangeDev.origin}/rooms/lobby/state`);
				if (response.ok) {
					assert.deepEqual(await response.json(), before);
					break;
				}
				if (Date.now() > deadline) assert.fail(`the object did not recover: ${await response.text()}\n${orangeDev.output()}`);
				await delay(250);
			}
		} finally {
			await orangeDev.close();
		}
	} finally {
		await restarted?.close();
		await source.close();
		await destination.dispose();
		await sourceProject.dispose();
	}
});

test("turning the migration on never replaces data an object already has on Orange", { timeout: 300_000 }, async () => {
	const { project: sourceProject, source } = await preparedSource();
	const destination = await destinationProject(undefined);
	try {
		await post(source.origin, "/rooms/lobby/seed?rows=3");
		const before = await startOrangeDev(destination.directory);
		try {
			await post(before.origin, "/rooms/lobby/write", "only on Orange");
		} finally {
			await before.close();
		}

		await writeFile(join(destination.directory, ".dev.vars"), `ORANGE_MIGRATE_WORKER_URL=${source.origin}\nWORKER_MIGRATOR_TOKEN=${migratorToken}\n`);
		const migrating = await startOrangeDev(destination.directory);
		try {
			const response = await fetch(`${migrating.origin}/rooms/lobby/state`);
			assert.notEqual(response.status, 200, await response.clone().text());
			assert.match(migrating.output(), /has data on Orange that did not come from this migration/);
		} finally {
			await migrating.close();
		}
		// Orange asked Cloudflare for nothing, so the object there still serves.
		assert.equal((await fetch(`${source.origin}/rooms/lobby/state`)).status, 200);

		await rm(join(destination.directory, ".dev.vars"));
		const after = await startOrangeDev(destination.directory);
		try {
			assert.deepEqual((await roomState(after.origin, "/rooms/lobby")).messages.map(({ body }) => body), ["only on Orange"]);
		} finally {
			await after.close();
		}
	} finally {
		await source.close();
		await destination.dispose();
		await sourceProject.dispose();
	}
});

test("a moved object with an open WebSocket keeps serving after it hibernates", { timeout: 180_000 }, async () => {
	const { project: sourceProject, source } = await preparedSource();
	const destination = await destinationProject(source.origin);
	try {
		await post(source.origin, "/rooms/chat/seed?rows=2");
		const orangeDev = await startOrangeDev(destination.directory);
		try {
			const socket = await openWebSocket(`${orangeDev.origin.replace(/^http/, "ws")}/rooms/chat/socket`);
			const ask = async (message: string): Promise<string> => {
				const reply = collectMessages(socket, 1);
				socket.send(message);
				return String((await withDeadline(reply, `reply to ${message}\n${orangeDev.output().slice(-3_000)}`, 20_000))[0]);
			};
			assert.equal(await ask("first on Orange"), "3");
			// Past the 10-second idle timeout (`sleepTimeout` in the Durable Object registry), so the
			// object's instance is dropped and the socket stays.
			await delay(16_000);
			assert.equal(await ask("after hibernation"), "4");
			await closeWebSocket(socket);
		} finally {
			await orangeDev.close();
		}
	} finally {
		await source.close();
		await destination.dispose();
		await sourceProject.dispose();
	}
});

test("an object that a read started on Orange before the migration copies from Cloudflare after its actor is destroyed", { timeout: 300_000 }, async () => {
	const { project: sourceProject, source } = await preparedSource();
	const destination = await destinationProject(undefined);
	try {
		await post(source.origin, "/rooms/lobby/seed?rows=3");
		const before = await roomState(source.origin, "/rooms/lobby");
		// A smoke test of the deployed app before the migration is on: one read, no write.
		const early = await startOrangeDev(destination.directory);
		try {
			assert.deepEqual((await roomState(early.origin, "/rooms/lobby")).messages, []);
		} finally {
			await early.close();
		}

		await writeFile(join(destination.directory, ".dev.vars"), `ORANGE_MIGRATE_WORKER_URL=${source.origin}\nWORKER_MIGRATOR_TOKEN=${migratorToken}\n`);
		const migrating = await startOrangeDev(destination.directory);
		try {
			// The constructor's CREATE TABLE ran on Orange, so the read left data that blocks the copy.
			const blocked = await fetch(`${migrating.origin}/rooms/lobby/state`);
			assert.notEqual(blocked.status, 200, await blocked.clone().text());
			const endpoint = await engineEndpoint(destination.directory);
			for (const { actor_id } of await roomActors(destination.directory)) {
				const destroyed = await fetch(new URL(`/actors/${actor_id}?namespace=default`, endpoint), { headers: engineHeaders, method: "DELETE" });
				assert.equal(destroyed.status, 200, await destroyed.text());
			}
			const deadline = Date.now() + 30_000;
			for (;;) {
				const response = await fetch(`${migrating.origin}/rooms/lobby/state`);
				if (response.ok) {
					assert.deepEqual(await response.json(), before);
					break;
				}
				if (Date.now() > deadline) assert.fail(`the object did not copy after its actor was destroyed: ${await response.text()}`);
				await delay(250);
			}
		} finally {
			await migrating.close();
		}
	} finally {
		await source.close();
		await destination.dispose();
		await sourceProject.dispose();
	}
});

test("an alarm that is due soon fires once on Orange after the move", { timeout: 180_000 }, async () => {
	const { project: sourceProject, source } = await preparedSource();
	const destination = await destinationProject(source.origin);
	try {
		await post(source.origin, "/rooms/timed/seed?rows=1");
		const orangeDev = await startOrangeDev(destination.directory);
		try {
			const alarm = Date.now() + 6_000;
			await post(source.origin, `/rooms/timed/alarm?at=${alarm}`);
			// Still pending when it moved, so Cloudflare did not fire it first.
			assert.equal((await roomState(orangeDev.origin, "/rooms/timed")).alarm, alarm);
			// Poll for the handler's write. getAlarm() is already null while the handler runs.
			const fired = (state: RoomState): number => state.messages.filter(({ body }) => body === "alarm fired").length;
			const deadline = alarm + 30_000;
			let state = await roomState(orangeDev.origin, "/rooms/timed");
			while (fired(state) === 0 && Date.now() < deadline) {
				await delay(100);
				state = await roomState(orangeDev.origin, "/rooms/timed");
			}
			// Long enough for a retry or a second copy of the alarm to show up.
			await delay(3_000);
			state = await roomState(orangeDev.origin, "/rooms/timed");
			assert.equal(state.alarm, null, orangeDev.output());
			assert.equal(fired(state), 1, orangeDev.output());
		} finally {
			await orangeDev.close();
		}
	} finally {
		await source.close();
		await destination.dispose();
		await sourceProject.dispose();
	}
});

test("without ORANGE_MIGRATE_WORKER_URL the migration route and Cloudflare IDs do not exist", { timeout: 120_000 }, async () => {
	const destination = await destinationProject(undefined);
	const orangeDev = await startOrangeDev(destination.directory);
	try {
		const wake = await fetch(`${orangeDev.origin}/__migrate/ROOMS/wake?name=x`, { method: "POST" });
		assert.equal(wake.status, 404);
		const foreign = await fetch(`${orangeDev.origin}/ids/${"ab".repeat(32)}/state`);
		assert.equal(foreign.status, 500, await foreign.clone().text());
		await post(orangeDev.origin, "/rooms/lobby/write", "local");
		assert.equal((await roomState(orangeDev.origin, "/rooms/lobby")).messages.length, 1);
	} finally {
		await orangeDev.close();
		await destination.dispose();
	}
});

interface CloudflareApi {
	close(): Promise<void>;
	// The `cursor` of each list request, in order. The first page has none.
	readonly listCursors: (string | null)[];
	origin: string;
	// Holds the list request with this cursor until `release()`.
	holdPage(cursor: string): { reached: Promise<void>; release(): void };
}

// Cloudflare's list API is the one part of the source with no local runtime, so this stands in for
// it. Everything else that backfill calls is real.
async function startCloudflareApi(ids: () => readonly string[], pageSize: number): Promise<CloudflareApi> {
	const listCursors: (string | null)[] = [];
	const holds = new Map<string, { reached(): void; released: Promise<void> }>();
	const server: Server = createServer((request, response) => {
		void (async () => {
			const url = new URL(request.url ?? "/", "http://localhost");
			const send = (body: unknown): void => {
				response.writeHead(200, { "content-type": "application/json" });
				response.end(JSON.stringify({ success: true, ...(body as object) }));
			};
			if (url.pathname.endsWith("/workers/durable_objects/namespaces")) {
				send({ result: [{ class: "Room", id: "namespace-1", script: "migrate-room" }], result_info: { total_pages: 1 } });
				return;
			}
			const cursor = url.searchParams.get("cursor");
			listCursors.push(cursor);
			const hold = cursor === null ? undefined : holds.get(cursor);
			if (hold !== undefined) {
				hold.reached();
				await hold.released;
			}
			const start = cursor === null ? 0 : Number(cursor);
			const page = ids().slice(start, start + pageSize);
			const next = start + pageSize;
			send({
				result: page.map((id) => ({ hasStoredData: true, id })),
				result_info: { cursor: next < ids().length ? String(next) : "" },
			});
		})();
	});
	await new Promise<void>((listening) => server.listen(0, "127.0.0.1", listening));
	return {
		close: () =>
			new Promise((closed) => {
				server.closeAllConnections();
				server.close(() => closed());
			}),
		holdPage(cursor) {
			const reached = Promise.withResolvers<void>();
			const released = Promise.withResolvers<void>();
			holds.set(cursor, { reached: reached.resolve, released: released.promise });
			return {
				reached: reached.promise,
				release: () => {
					holds.delete(cursor);
					released.resolve();
				},
			};
		},
		listCursors,
		origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
	};
}

async function cloudflareIdOf(source: CloudflareSource, name: string): Promise<string> {
	const response = await fetch(`${source.origin}/__migrate/ROOMS/resolve?name=${name}`, {
		headers: { authorization: `Bearer ${migratorToken}` },
	});
	assert.equal(response.status, 200);
	return ((await response.json()) as { id: string }).id;
}

const backfillEnvironment = (api: CloudflareApi, source: CloudflareSource): NodeJS.ProcessEnv => ({
	CLOUDFLARE_ACCOUNT_ID: "account-1",
	CLOUDFLARE_API_BASE_URL: api.origin,
	CLOUDFLARE_API_TOKEN: "cloudflare-api-token",
	ORANGE_MIGRATE_WORKER_URL: source.origin,
	WORKER_MIGRATOR_TOKEN: migratorToken,
});

test("a backfill killed halfway resumes at its saved place, and a repeat run changes nothing", { timeout: 300_000 }, async () => {
	const { project: sourceProject, source } = await preparedSource();
	const destination = await destinationProject(source.origin);
	const names = ["room-0", "room-1", "room-2", "room-3", "room-4"];
	const before = new Map<string, RoomState>();
	const ids: string[] = [];
	for (const name of names) {
		await post(source.origin, `/rooms/${name}/seed?rows=4`);
		before.set(name, await roomState(source.origin, `/rooms/${name}`));
		ids.push(await cloudflareIdOf(source, name));
	}
	const unique = await (await fetch(`${source.origin}/new`)).text();
	await post(source.origin, `/ids/${unique}/seed?rows=2`);
	const uniqueBefore = await roomState(source.origin, `/ids/${unique}`);
	ids.push(unique);
	const api = await startCloudflareApi(() => ids, 2);
	const orangeDev = await startOrangeDev(destination.directory);
	const environment = backfillEnvironment(api, source);
	const backfill = ["migrate", "backfill", "--url", orangeDev.origin];
	try {
		const held = api.holdPage("4");
		const first = startOrange(backfill, destination.directory, environment);
		await withDeadline(held.reached, "the first two pages of the backfill", 120_000);
		first.kill();
		await first.exited;
		// Nothing past the saved place moved, so the last page still serves on Cloudflare.
		assert.equal((await fetch(`${source.origin}/rooms/room-4/state`)).status, 200);
		held.release();

		api.listCursors.length = 0;
		const resumed = await orange(backfill, destination.directory, environment);
		assert.equal(resumed.code, 0, resumed.output);
		assert.deepEqual(api.listCursors, ["4"]);
		assert.match(resumed.output, /Room: 2 moved, 0 failed/);
		assert.match(resumed.output, /Run this command once more in a few minutes/);

		for (const name of names) {
			assert.deepEqual(await roomState(orangeDev.origin, `/rooms/${name}`), before.get(name));
			assert.equal((await fetch(`${source.origin}/rooms/${name}/state`)).status, 503);
		}
		assert.deepEqual(await roomState(orangeDev.origin, `/ids/${unique}`), uniqueBefore);

		await post(orangeDev.origin, "/rooms/room-0/write", "after the move");
		const repeat = await orange(backfill, destination.directory, environment);
		assert.equal(repeat.code, 0, repeat.output);
		assert.match(repeat.output, /^Room: 0 moved, 0 failed, already moved: 6\.$/m);
		assert.doesNotMatch(repeat.output, /Run this command once more/);
		const room0 = await roomState(orangeDev.origin, "/rooms/room-0");
		assert.equal(room0.messages.at(-1)?.body, "after the move");
		assert.equal(room0.messages.length, 5);
	} finally {
		await orangeDev.close();
		await api.close();
		await source.close();
		await destination.dispose();
		await sourceProject.dispose();
	}
});

test("a backfill dry run counts each class's objects on Cloudflare and moves none of them", { timeout: 300_000 }, async () => {
	const { project: sourceProject, source } = await preparedSource();
	const destination = await destinationProject(source.origin);
	const ids: string[] = [];
	for (const name of ["one", "two"]) {
		await post(source.origin, `/rooms/${name}/seed?rows=2`);
		ids.push(await cloudflareIdOf(source, name));
	}
	const api = await startCloudflareApi(() => ids, 1);
	try {
		const { CLOUDFLARE_API_TOKEN: _, ...withoutToken } = backfillEnvironment(api, source);
		const refused = await orange(["migrate", "backfill", "--dry-run"], destination.directory, withoutToken);
		assert.equal(refused.code, 1, refused.output);
		assert.match(refused.output, /needs CLOUDFLARE_API_TOKEN/);

		// No --url and no Orange: a dry run only reads Cloudflare's list.
		const counted = await orange(["migrate", "backfill", "--dry-run"], destination.directory, backfillEnvironment(api, source));
		assert.equal(counted.code, 0, counted.output);
		assert.match(counted.output, /^Room: 2 objects on Cloudflare, including any that already moved to Orange\. Dry run: nothing moved\.$/m);
		for (const name of ["one", "two"]) assert.equal((await fetch(`${source.origin}/rooms/${name}/state`)).status, 200);
		assert.ok(!(await readdir(destination.directory)).includes(".open-orange"));
	} finally {
		await api.close();
		await source.close();
		await destination.dispose();
		await sourceProject.dispose();
	}
});

test("a backfill that cannot reach Cloudflare reports each object, fails, and a later run moves them", { timeout: 300_000 }, async () => {
	const { project: sourceProject, source } = await preparedSource();
	const destination = await destinationProject(source.origin);
	let restarted: CloudflareSource | undefined;
	await post(source.origin, "/rooms/lobby/seed?rows=3");
	const before = await roomState(source.origin, "/rooms/lobby");
	const ids = [await cloudflareIdOf(source, "lobby")];
	const api = await startCloudflareApi(() => ids, 2);
	const orangeDev = await startOrangeDev(destination.directory);
	const environment = backfillEnvironment(api, source);
	const backfill = ["migrate", "backfill", "--url", orangeDev.origin];
	try {
		const wrongDestination = await orange(["migrate", "backfill", "--url", api.origin], destination.directory, environment);
		assert.equal(wrongDestination.code, 1, wrongDestination.output);
		assert.match(wrongDestination.output, /did not answer as an Orange Worker that is migrating/);

		const { port } = new URL(source.origin);
		await source.close();
		const failed = await orange(backfill, destination.directory, environment);
		assert.equal(failed.code, 1, failed.output);
		assert.match(failed.output, /Room: 0 moved, 1 failed/);
		assert.ok(failed.output.includes(ids[0] ?? ""), failed.output);
		// Objects to retry are the backfill's result, not a bug in Orange.
		assert.doesNotMatch(failed.output, /Looks like a bug/);

		restarted = await startCloudflareSource(sourceProject.directory, Number(port));
		const retried = await orange(backfill, destination.directory, environment);
		assert.equal(retried.code, 0, retried.output);
		assert.match(retried.output, /Room: 1 moved, 0 failed/);
		assert.deepEqual(await roomState(orangeDev.origin, "/rooms/lobby"), before);
	} finally {
		await orangeDev.close();
		await api.close();
		await restarted?.close();
		await source.close();
		await destination.dispose();
		await sourceProject.dispose();
	}
});

test("a backfill whose copy fails inside Orange offers a bug report, and names the reason last", { timeout: 300_000 }, async () => {
	const { project: sourceProject, source } = await preparedSource();
	const destination = await destinationProject(source.origin);
	await post(source.origin, "/rooms/lobby/seed?rows=1");
	await post(source.origin, "/rooms/lobby/math-table");
	const ids = [await cloudflareIdOf(source, "lobby")];
	const api = await startCloudflareApi(() => ids, 10);
	const orangeDev = await startOrangeDev(destination.directory);
	try {
		const failed = await orange(["migrate", "backfill", "--url", orangeDev.origin], destination.directory, backfillEnvironment(api, source));
		assert.equal(failed.code, 1, failed.output);
		assert.match(failed.output, /Room: 0 moved, 1 failed/);
		assert.match(failed.output, /^Orange failed on its own side: .*sqrt/m);
		assert.match(failed.output, /Looks like a bug\? Report it: .*title=orange\+migrate%3A\+Orange\+failed\+on\+its\+own\+side/);
	} finally {
		await orangeDev.close();
		await api.close();
		await source.close();
		await destination.dispose();
		await sourceProject.dispose();
	}
});

// An Orange that answers backfill's check but fails each wake, as when Orange goes down mid-run.
async function startFailingWakes(orangeOrigin: string): Promise<{ close(): Promise<void>; origin: string }> {
	const server = createServer((request, response) => {
		void (async () => {
			const url = new URL(request.url ?? "/", "http://localhost");
			if (url.searchParams.has("id") || url.searchParams.has("name")) {
				response.writeHead(502, { "content-type": "application/json" });
				response.end(JSON.stringify({ error: { code: "migrate.import_failed", message: "Orange is down" } }));
				return;
			}
			const upstream = await fetch(`${orangeOrigin}${request.url ?? "/"}`, { headers: { authorization: request.headers.authorization ?? "" }, method: request.method ?? "GET" });
			response.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "text/plain" });
			response.end(Buffer.from(await upstream.arrayBuffer()));
		})();
	});
	await new Promise<void>((listening) => server.listen(0, "127.0.0.1", listening));
	return {
		close: () =>
			new Promise((closed) => {
				server.closeAllConnections();
				server.close(() => closed());
			}),
		origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
	};
}

test("a backfill whose wakes fail leaves objects of more than one export page serving on Cloudflare, and a later run moves every object", { timeout: 300_000 }, async () => {
	const { project: sourceProject, source } = await preparedSource();
	const destination = await destinationProject(source.origin);
	// Objects by ID have no saved name, so backfill reads the first page of each export first.
	const [large, small] = [await (await fetch(`${source.origin}/new`)).text(), await (await fetch(`${source.origin}/new`)).text()];
	// About 6 MB of export, so two pages of about 4 MB.
	await post(source.origin, `/ids/${large}/seed?rows=1500&bytes=2048`);
	await post(source.origin, `/ids/${small}/seed?rows=2`);
	const largeBefore = await roomState(source.origin, `/ids/${large}`);
	const smallBefore = await roomState(source.origin, `/ids/${small}`);
	const api = await startCloudflareApi(() => [large, small], 10);
	const orangeDev = await startOrangeDev(destination.directory);
	const failingWakes = await startFailingWakes(orangeDev.origin);
	const environment = backfillEnvironment(api, source);
	try {
		const failed = await orange(["migrate", "backfill", "--url", failingWakes.origin], destination.directory, environment);
		assert.equal(failed.code, 1, failed.output);
		assert.match(failed.output, /Room: 0 moved, 2 failed/);
		assert.equal((await fetch(`${source.origin}/ids/${large}/state`)).status, 200, "the first page finished a longer export");
		// A one-page export finishes when backfill reads it, so the object refuses app traffic there.
		assert.equal((await fetch(`${source.origin}/ids/${small}/state`)).status, 503);

		const retried = await orange(["migrate", "backfill", "--url", orangeDev.origin], destination.directory, environment);
		assert.equal(retried.code, 0, retried.output);
		assert.match(retried.output, /Room: 2 moved, 0 failed/);
		assert.deepEqual(await roomState(orangeDev.origin, `/ids/${large}`), largeBefore);
		assert.deepEqual(await roomState(orangeDev.origin, `/ids/${small}`), smallBefore);
	} finally {
		await failingWakes.close();
		await orangeDev.close();
		await api.close();
		await source.close();
		await destination.dispose();
		await sourceProject.dispose();
	}
});

const engineHeaders = { authorization: "Bearer default" };

async function engineEndpoint(projectDirectory: string): Promise<string> {
	for await (const path of glob(".open-orange/rivetkit/*/.rivetkit/var/engine/runtime.json", { cwd: projectDirectory })) {
		return (JSON.parse(await readFile(join(projectDirectory, path), "utf8")) as { endpoint: string }).endpoint;
	}
	throw new Error("The project has no running Rivet Engine");
}

// The Room actors on the project's Engine: one for each object that Orange holds.
async function roomActors(projectDirectory: string): Promise<{ actor_id: string; key: string }[]> {
	const endpoint = await engineEndpoint(projectDirectory);
	const names = (await (await fetch(new URL("/actors/names?namespace=default", endpoint), { headers: engineHeaders })).json()) as { names: Record<string, unknown> };
	const actors: { actor_id: string; key: string }[] = [];
	for (const name of Object.keys(names.names).filter((candidate) => candidate.startsWith("room-"))) {
		const url = new URL("/actors", endpoint);
		url.searchParams.set("namespace", "default");
		url.searchParams.set("name", name);
		const body = (await (await fetch(url, { headers: engineHeaders })).json()) as { actors: { actor_id: string; key: string }[] };
		actors.push(...body.actors);
	}
	return actors;
}

async function roomActorKeys(projectDirectory: string): Promise<string[]> {
	return (await roomActors(projectDirectory)).map(({ key }) => key).sort();
}

test("a backfill after the objects moved by name reports them as already moved, adds no actors, and reaches 0 moved", { timeout: 300_000 }, async () => {
	const { project: sourceProject, source } = await preparedSource();
	const destination = await destinationProject(source.origin);
	await post(source.origin, "/rooms/lobby/seed?rows=3");
	const lobbyBefore = await roomState(source.origin, "/rooms/lobby");
	const api = await startCloudflareApi(() => ids, 10);
	const ids: string[] = [];
	const orangeDev = await startOrangeDev(destination.directory);
	const environment = backfillEnvironment(api, source);
	const backfill = ["migrate", "backfill", "--url", orangeDev.origin];
	try {
		// After cutover the app reaches each object by name on Orange. "ghost" never existed on
		// Cloudflare: its copy is empty, but the export still marks it moved there.
		assert.deepEqual(await roomState(orangeDev.origin, "/rooms/lobby"), lobbyBefore);
		assert.deepEqual((await roomState(orangeDev.origin, "/rooms/ghost")).messages, []);
		assert.equal((await fetch(`${source.origin}/rooms/ghost/state`)).status, 503);
		// Cloudflare now lists both, because both have stored data there.
		ids.push(await cloudflareIdOf(source, "lobby"), await cloudflareIdOf(source, "ghost"));
		const actorsBefore = await roomActorKeys(destination.directory);

		for (const run of [1, 2]) {
			const result = await orange(backfill, destination.directory, environment);
			assert.equal(result.code, 0, `run ${run}: ${result.output}`);
			assert.match(result.output, /^Room: 0 moved, 0 failed, already moved: 1, no data on Cloudflare: 1\.$/m);
			assert.deepEqual(await roomActorKeys(destination.directory), actorsBefore, `run ${run}`);
		}
		assert.deepEqual(await roomState(orangeDev.origin, "/rooms/lobby"), lobbyBefore);
	} finally {
		await orangeDev.close();
		await api.close();
		await source.close();
		await destination.dispose();
		await sourceProject.dispose();
	}
});

// Stands in for DNS: every client goes through it, and cutover changes where it points.
async function startFrontDoor(initialTarget: string): Promise<{ close(): Promise<void>; origin: string; pointAt(target: string): void }> {
	let target = initialTarget;
	const server = createServer((request, response) => {
		void (async () => {
			const chunks: Buffer[] = [];
			for await (const chunk of request) chunks.push(chunk as Buffer);
			const method = request.method ?? "GET";
			const body = chunks.length === 0 ? null : Buffer.concat(chunks);
			const upstream = await fetch(`${target}${request.url ?? "/"}`, { body, method });
			response.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "text/plain" });
			response.end(Buffer.from(await upstream.arrayBuffer()));
		})().catch((error: unknown) => {
			response.writeHead(599);
			response.end(String(error));
		});
	});
	await new Promise<void>((listening) => server.listen(0, "127.0.0.1", listening));
	return {
		close: () =>
			new Promise((closed) => {
				server.closeAllConnections();
				server.close(() => closed());
			}),
		origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
		pointAt: (next) => {
			target = next;
		},
	};
}

test("cutover moves a live app with no failed request and no lost write, and the old copy stops taking writes", { timeout: 600_000 }, async () => {
	const { project: sourceProject, source } = await preparedSource();
	const destination = await destinationProject(source.origin);
	const door = await startFrontDoor(source.origin);
	const quietNames = Array.from({ length: 12 }, (_, index) => `quiet-${index}`);
	const before = new Map<string, RoomState>();
	const ids: string[] = [];
	try {
		// Rows of 1 MB, so the export takes several pages and writes can land during it.
		await post(source.origin, "/rooms/lobby/seed?rows=24&bytes=1000000");
		await post(source.origin, "/rooms/calm/seed?rows=10");
		for (const name of quietNames) {
			await post(source.origin, `/rooms/${name}/seed?rows=20`);
			before.set(name, await roomState(source.origin, `/rooms/${name}`));
		}
		for (const name of ["lobby", "calm", ...quietNames]) ids.push(await cloudflareIdOf(source, name));
		const unique = await (await fetch(`${source.origin}/new`)).text();
		await post(source.origin, `/ids/${unique}/seed?rows=5`);
		const uniqueBefore = await roomState(source.origin, `/ids/${unique}`);
		ids.push(unique);
		const lobbySeed = (await roomState(source.origin, "/rooms/lobby")).messages;
		assert.equal(lobbySeed.length, 24);

		const api = await startCloudflareApi(() => ids, 5);
		// Orange is deployed but gets no traffic until cutover.
		const orangeDev = await startOrangeDev(destination.directory);
		try {
			const failures: string[] = [];
			const acknowledged: string[] = [];
			let running = true;

			// A client on the domain. It sees one service through cutover and backfill.
			const liveWriter = (async () => {
				for (let index = 0; running; index += 1) {
					const body = `live-${index}`;
					const response = await fetch(`${door.origin}/rooms/lobby/write`, { body, method: "POST" });
					if (response.ok) acknowledged.push(body);
					else failures.push(`write ${response.status}: ${await response.text()}`);
					await delay(20);
				}
			})();
			// An object nobody writes to keeps answering, including while it moves.
			const liveReader = (async () => {
				while (running) {
					const response = await fetch(`${door.origin}/rooms/calm/state`);
					if (response.ok) {
						if (((await response.json()) as RoomState).messages.length !== 10) failures.push("calm lost rows");
					} else {
						failures.push(`read ${response.status}: ${await response.text()}`);
					}
					await delay(20);
				}
			})();
			await waitFor("a live write through Cloudflare before cutover", () => acknowledged.length + failures.length > 0);

			door.pointAt(orangeDev.origin);
			const cutoverAt = Date.now();

			// A client with stale DNS still writes to Cloudflare during the export.
			let staleAfterCutover = 0;
			const staleWriter = (async () => {
				for (let index = 0; Date.now() - cutoverAt < 1_500; index += 1) {
					const body = `stale-${index}`;
					const response = await fetch(`${source.origin}/rooms/lobby/write`, { body, method: "POST" });
					if (!response.ok) return;
					acknowledged.push(body);
					staleAfterCutover += 1;
				}
			})();

			// Backfill runs while the app serves, then once more to confirm.
			const environment = backfillEnvironment(api, source);
			const backfill = ["migrate", "backfill", "--url", orangeDev.origin];
			const firstPass = await orange(backfill, destination.directory, environment);
			assert.equal(firstPass.code, 0, firstPass.output);
			// The app's own requests may have moved lobby and calm first.
			const counts = /^Room: (\d+) moved, 0 failed, already moved: (\d+)\.$/m.exec(firstPass.output);
			assert.ok(counts !== null, firstPass.output);
			assert.equal(Number(counts[1]) + Number(counts[2]), ids.length, firstPass.output);
			const confirmPass = await orange(backfill, destination.directory, environment);
			assert.equal(confirmPass.code, 0, confirmPass.output);
			assert.match(confirmPass.output, new RegExp(`^Room: 0 moved, 0 failed, already moved: ${ids.length}\\.$`, "m"));

			await staleWriter;
			const attemptsBeforeStop = acknowledged.length + failures.length;
			await waitFor("a live write after the backfill", () => acknowledged.length + failures.length > attemptsBeforeStop);
			running = false;
			await Promise.all([liveWriter, liveReader]);

			assert.deepEqual(failures, []);
			assert.ok(staleAfterCutover > 0, "the stale client must write during the export for this test to mean anything");

			const lobby = await roomState(orangeDev.origin, "/rooms/lobby");
			assert.deepEqual(lobby.messages.slice(0, 24), lobbySeed);
			const bodies = lobby.messages.slice(24).map(({ body }) => body);
			assert.deepEqual([...bodies].sort(), [...acknowledged].sort());
			assert.equal(new Set(bodies).size, bodies.length);
			assert.equal(lobby.kv.plain !== undefined, true);

			for (const name of quietNames) assert.deepEqual(await roomState(orangeDev.origin, `/rooms/${name}`), before.get(name));
			assert.deepEqual(await roomState(orangeDev.origin, `/ids/${unique}`), uniqueBefore);

			// Every object left Cloudflare, so a late write is never acknowledged and never arrives.
			// The answer is usually 503 migrator.moved. `wrangler dev` can also answer `Network connection
			// lost` or drop the connection. See `tests/migrate-source.ts`.
			for (const path of ["/rooms/lobby", "/rooms/calm", `/rooms/${quietNames[0]}`, `/ids/${unique}`]) {
				const refused = await fetch(`${source.origin}${path}/write`, { body: "too late", method: "POST" }).catch(() => undefined);
				assert.ok(refused === undefined || !refused.ok, path);
				const moved = await roomState(orangeDev.origin, path);
				assert.ok(!moved.messages.some(({ body }) => body === "too late"), path);
			}
		} finally {
			await orangeDev.close();
			await api.close();
		}
	} finally {
		await door.close();
		await source.close();
		await destination.dispose();
		await sourceProject.dispose();
	}
});

// Slows each export page, so a copy takes as long as a large object's would over a real network.
async function startSlowExportProxy(target: string, delayMs: () => number): Promise<{ close(): Promise<void>; origin: string; exportRequests(): number }> {
	let exportRequests = 0;
	const server = createServer((request, response) => {
		void (async () => {
			const path = request.url ?? "/";
			if (path.includes("/export")) {
				exportRequests += 1;
			}
			// The delay is after the source answers, because a source object with no request for a
			// while restarts, which voids its export. A slow network has requests in flight.
			const upstream = await fetch(`${target}${path}`, { headers: { authorization: request.headers.authorization ?? "" } });
			const answer = await upstream.arrayBuffer();
			if (path.includes("/export")) await delay(delayMs());
			const headers = Object.fromEntries(upstream.headers);
			delete headers["content-encoding"];
			delete headers["content-length"];
			response.writeHead(upstream.status, headers);
			response.end(Buffer.from(answer));
		})().catch((error: unknown) => {
			response.writeHead(599);
			response.end(String(error));
		});
	});
	await new Promise<void>((listening) => server.listen(0, "127.0.0.1", listening));
	return {
		close: () =>
			new Promise((closed) => {
				server.closeAllConnections();
				server.close(() => closed());
			}),
		exportRequests: () => exportRequests,
		origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
	};
}

test("a copy far longer than the idle limit serves its first request, and a crash mid-copy starts over cleanly", { timeout: 600_000 }, async () => {
	const { project: sourceProject, source } = await preparedSource();
	// 20 seconds or more per object: past both Orange's 10-second idle limit and the Engine's 15-second start limit.
	const proxy = await startSlowExportProxy(source.origin, () => 2_500);
	const destination = await destinationProject(proxy.origin);
	try {
		await post(source.origin, "/rooms/big/seed?rows=24&bytes=1000000");
		await post(source.origin, "/rooms/crash/seed?rows=24&bytes=1000000");
		const big = await roomState(source.origin, "/rooms/big");
		const crash = await roomState(source.origin, "/rooms/crash");

		const firstDev = await startOrangeDev(destination.directory);
		let firstDevKilled = false;
		try {
			assert.deepEqual(await roomState(firstDev.origin, "/rooms/big"), big);

			// Orange dies with part of the copy written. The object has not left Cloudflare yet.
			const exportsBefore = proxy.exportRequests();
			void fetch(`${firstDev.origin}/rooms/crash/state`).catch(() => undefined);
			await waitFor("three export pages of the crash object", () => proxy.exportRequests() >= exportsBefore + 3, 60_000);
			await firstDev.kill();
			firstDevKilled = true;
			assert.equal((await fetch(`${source.origin}/rooms/crash/state`)).status, 200);
		} finally {
			if (!firstDevKilled) await firstDev.close();
		}

		const secondDev = await startOrangeDev(destination.directory);
		try {
			assert.deepEqual(await roomState(secondDev.origin, "/rooms/crash"), crash);
		} finally {
			await secondDev.close();
		}
	} finally {
		await proxy.close();
		await source.close();
		await destination.dispose();
		await sourceProject.dispose();
	}
});

test("an unfinished copy with the migration turned off fails its calls and returns no partial rows, until the migration resumes", { timeout: 600_000 }, async () => {
	const { project: sourceProject, source } = await preparedSource();
	const proxy = await startSlowExportProxy(source.origin, () => 2_500);
	const destination = await destinationProject(proxy.origin);
	const devVars = await readFile(join(destination.directory, ".dev.vars"), "utf8");
	try {
		await post(source.origin, "/rooms/big/seed?rows=24&bytes=1000000");
		const before = await roomState(source.origin, "/rooms/big");

		// Orange dies with some pages of the copy written.
		const copying = await startOrangeDev(destination.directory);
		void fetch(`${copying.origin}/rooms/big/state`).catch(() => undefined);
		await waitFor("three export pages of the big object", () => proxy.exportRequests() >= 3, 60_000);
		await copying.kill();

		await rm(join(destination.directory, ".dev.vars"));
		const off = await startOrangeDev(destination.directory);
		try {
			for (const attempt of [1, 2]) {
				const response = await fetch(`${off.origin}/rooms/big/state`);
				const text = await response.text();
				assert.notEqual(response.status, 200, `attempt ${attempt}: ${text.slice(0, 200)}`);
				assert.ok(!text.includes("seed-"), `attempt ${attempt}: ${text.slice(0, 200)}`);
			}
			assert.match(off.output(), /has an unfinished copy from Cloudflare/);
		} finally {
			await off.close();
		}

		await writeFile(join(destination.directory, ".dev.vars"), devVars);
		const resumed = await startOrangeDev(destination.directory);
		try {
			assert.deepEqual(await roomState(resumed.origin, "/rooms/big"), before);
		} finally {
			await resumed.close();
		}
	} finally {
		await proxy.close();
		await source.close();
		await destination.dispose();
		await sourceProject.dispose();
	}
});

test("a class with a rename and a deleted class in its history moves like any other", { timeout: 300_000 }, async () => {
	const history = `"migrations": [{ "tag": "v1", "new_sqlite_classes": ["OldRoom", "Gone"] }, { "tag": "v2", "renamed_classes": [{ "from": "OldRoom", "to": "Room" }], "deleted_classes": ["Gone"] }]`;
	const withHistory = async (project: TemporaryProject): Promise<void> => {
		const configPath = join(project.directory, "wrangler.jsonc");
		const config = await readFile(configPath, "utf8");
		await writeFile(configPath, config.replace(`"migrations": [{ "tag": "v1", "new_sqlite_classes": ["Room"] }]`, history));
	};
	const sourceProject = await copyProject(fixture);
	await withHistory(sourceProject);
	const prepared = await orange(["migrate", "prepare"], sourceProject.directory);
	assert.equal(prepared.code, 0, prepared.output);
	assert.match(prepared.output, /Prepared Room\./);
	const source = await startCloudflareSource(sourceProject.directory);
	const destination = await destinationProject(source.origin);
	await withHistory(destination);
	try {
		await post(source.origin, "/rooms/lobby/seed?rows=4");
		const before = await roomState(source.origin, "/rooms/lobby");
		const orangeDev = await startOrangeDev(destination.directory);
		try {
			assert.deepEqual(await roomState(orangeDev.origin, "/rooms/lobby"), before);
			assert.equal((await fetch(`${source.origin}/rooms/lobby/state`)).status, 503);
		} finally {
			await orangeDev.close();
		}
	} finally {
		await source.close();
		await destination.dispose();
		await sourceProject.dispose();
	}
});

test("rollback serves every object on Cloudflare again, from its state at the move, with its alarm back", { timeout: 300_000 }, async () => {
	const { project: sourceProject, source } = await preparedSource();
	const destination = await destinationProject(source.origin);
	const alarm = Date.now() + 3_600_000;
	let rolledBack: CloudflareSource | undefined;
	try {
		await post(source.origin, "/rooms/lobby/seed?rows=3");
		await post(source.origin, `/rooms/lobby/alarm?at=${alarm}`);
		const before = await roomState(source.origin, "/rooms/lobby");
		const orangeDev = await startOrangeDev(destination.directory);
		try {
			assert.deepEqual(await roomState(orangeDev.origin, "/rooms/lobby"), before);
			await post(orangeDev.origin, "/rooms/lobby/write", "only on Orange");
		} finally {
			await orangeDev.close();
		}
		assert.equal((await fetch(`${source.origin}/rooms/lobby/state`)).status, 503);

		const { port } = new URL(source.origin);
		await source.close();
		rolledBack = await startCloudflareSource(sourceProject.directory, Number(port), { MIGRATOR_DISABLED: "true" });
		assert.deepEqual(await roomState(rolledBack.origin, "/rooms/lobby"), before);
		await post(rolledBack.origin, "/rooms/lobby/write", "back on Cloudflare");
		assert.equal((await roomState(rolledBack.origin, "/rooms/lobby")).messages.at(-1)?.body, "back on Cloudflare");
	} finally {
		await rolledBack?.close();
		await source.close();
		await destination.dispose();
		await sourceProject.dispose();
	}
});

test("prepare keeps a default export that is a class, and the other handlers of a default object", { timeout: 180_000 }, async () => {
	for (const defaultExport of [
		`export default class extends WorkerEntrypoint { fetch() { return new Response("from the class"); } }`,
		`export default { fetch() { return new Response("from the object"); }, scheduled() { globalThis.ran = true; } };`,
	]) {
		const project = await copyProject(fixture);
		try {
			const entry = join(project.directory, "worker.js");
			const source = await readFile(entry, "utf8");
			const replaced = source.slice(0, source.indexOf("export default {")).replace(`import { DurableObject } from "cloudflare:workers";`, `import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";`);
			await writeFile(entry, `${replaced}\n${defaultExport}\n`);
			const prepared = await orange(["migrate", "prepare"], project.directory);
			assert.equal(prepared.code, 0, prepared.output);
			const running = await startCloudflareSource(project.directory);
			try {
				const app = await fetch(`${running.origin}/anything`);
				assert.match(await app.text(), /^from the (class|object)$/);
				const denied = await fetch(`${running.origin}/__migrate/ROOMS/resolve?name=x`);
				assert.equal(denied.status, 401);
				const resolved = await fetch(`${running.origin}/__migrate/ROOMS/resolve?name=x`, { headers: { authorization: `Bearer ${migratorToken}` } });
				assert.equal(resolved.status, 200);
			} finally {
				await running.close();
			}
		} finally {
			await project.dispose();
		}
	}
});
