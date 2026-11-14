import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, writeFile } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import {
	type ClientWebSocket,
	closeWebSocket,
	collectMessages,
	copyProject,
	openWebSocket,
	repositoryRoot,
	type RunningOrangeDev,
	runOrange,
	startOrangeDev,
	withDeadline,
} from "./orange-dev.js";
import { freePort } from "./free-port.js";

// `examples/` holds what a user would copy. The fixtures prove one feature each. Both run the same way.
const exampleParents = [
	join(repositoryRoot, "examples"),
	join(repositoryRoot, "tests", "fixtures", "examples"),
];

async function withDev(
	projectDirectory: string,
	exercise: (dev: RunningOrangeDev) => Promise<void>,
	configFiles?: readonly string[],
): Promise<void> {
	const dev = await startOrangeDev(projectDirectory, configFiles);
	try {
		await exercise(dev);
	} catch (error) {
		throw new Error(`Example failed. orange dev output:\n${dev.output()}`, {
			cause: error,
		});
	} finally {
		await dev.close();
	}
}

async function json(response: Response, status = 200): Promise<unknown> {
	const body = await response.text();
	assert.equal(response.status, status, body);
	return JSON.parse(body);
}

async function nextText(socket: ClientWebSocket): Promise<string> {
	const [message] = await withDeadline(collectMessages(socket, 1), "WebSocket message");
	assert.ok(message !== undefined);
	return message;
}

async function next(socket: ClientWebSocket): Promise<unknown> {
	return JSON.parse(await nextText(socket));
}

function post(url: string, body: unknown): Promise<Response> {
	return fetch(url, {
		body: JSON.stringify(body),
		headers: { "content-type": "application/json" },
		method: "POST",
	});
}

const navigation = { accept: "text/html", "sec-fetch-mode": "navigate" };

const scenarios: Record<string, (projectDirectory: string) => Promise<void>> = {
	async "alarms"(projectDirectory) {
		await withDev(projectDirectory, async ({ origin }) => {
			const list = `${origin}/reminders/me`;
			const { dueAt, ...later } = (await json(
				await post(list, { text: "later", inSeconds: 3600 }),
				201,
			)) as { dueAt: number };
			assert.deepEqual(later, { firedAt: null, id: 1, text: "later" });
			assert.ok(dueAt > Date.now() + 3_500_000);
			await json(await post(list, { text: "soon", inSeconds: 1 }), 201);
			assert.deepEqual(await json(await post(list, { text: "now", inSeconds: 0 }), 400), {
				error: 'Send JSON like {"text":"stretch","inSeconds":5}',
			});

			type Reminder = { firedAt: number | null; text: string };
			let reminders: Reminder[] = [];
			const deadline = Date.now() + 15_000;
			// The alarm fires in the background; the caller can only see it by
			// reading the list again.
			while (Date.now() < deadline) {
				({ reminders } = (await json(await fetch(list))) as { reminders: Reminder[] });
				if (reminders.some(({ firedAt }) => firedAt !== null)) break;
				await delay(250);
			}
			assert.deepEqual(
				reminders.map(({ firedAt, text }) => ({ fired: firedAt !== null, text })),
				[
					{ fired: true, text: "soon" },
					{ fired: false, text: "later" },
				],
			);
		});
	},

	async "assets-spa"(projectDirectory) {
		await withDev(projectDirectory, async ({ origin }) => {
			const home = await fetch(`${origin}/`);
			assert.equal(home.status, 200);
			assert.match(home.headers.get("content-type") ?? "", /^text\/html/);
			const index = await home.text();
			assert.match(index, /<script type="module" src="\/app\.js">/);

			const script = await fetch(`${origin}/app.js`);
			assert.equal(script.status, 200);
			assert.match(script.headers.get("content-type") ?? "", /javascript/);

			// A browser navigation to an app route gets the app's index.html.
			const route = await fetch(`${origin}/about`, { headers: navigation });
			assert.equal(route.status, 200);
			assert.equal(await route.text(), index);

			assert.deepEqual(await json(await fetch(`${origin}/api/hello`)), {
				message: "Hello from the Worker",
			});
			// An unknown API route is a Worker 404, never the app's index.html.
			assert.deepEqual(
				await json(await fetch(`${origin}/api/missing`, { headers: navigation }), 404),
				{ error: "No API route for /api/missing" },
			);
		});
	},

	async "cache-api"(projectDirectory) {
		type Body = { renderedAt: string; version: string };
		const get = async (url: string, headers?: Record<string, string>) => {
			const response = await fetch(url, { headers });
			return { response, status: response.headers.get("cf-cache-status") };
		};
		await withDev(projectDirectory, async ({ origin }) => {
			const article = `${origin}/articles/a`;
			const miss = await get(article);
			assert.equal(miss.status, "MISS");
			const first = (await json(miss.response)) as Body;
			const hit = await get(article);
			assert.equal(hit.status, "HIT");
			assert.deepEqual(await json(hit.response), first);
			// HEAD reuses the GET entry through ignoreMethod.
			const head = await fetch(article, { method: "HEAD" });
			assert.equal(head.headers.get("cf-cache-status"), "HIT");
			assert.equal(await head.text(), "");

			// The client's ETag matches the cached entry, so it gets 304 and no body.
			const etag = hit.response.headers.get("etag");
			assert.ok(etag !== null);
			const notModified = await get(article, { "if-none-match": etag });
			assert.equal(notModified.response.status, 304);
			assert.equal(await notModified.response.text(), "");
			assert.equal((await get(article, { "if-none-match": '"other"' })).response.status, 200);

			await get(`${origin}/videos/v`);
			const range = await get(`${origin}/videos/v`, { range: "bytes=256-259" });
			assert.equal(range.response.status, 206);
			assert.equal(range.status, "HIT");
			assert.equal(range.response.headers.get("content-range"), "bytes 256-259/1024");
			assert.deepEqual([...new Uint8Array(await range.response.arrayBuffer())], [0, 1, 2, 3]);
			const unsatisfiable = await get(`${origin}/videos/v`, { range: "bytes=5000-" });
			assert.equal(unsatisfiable.response.status, 416);
			await unsatisfiable.response.body?.cancel();

			// no-store and private responses are never cached.
			for (const path of ["/live", "/me"]) {
				const a = (await json((await get(`${origin}${path}`)).response)) as Body;
				const again = await get(`${origin}${path}`);
				assert.equal(again.status, "MISS", path);
				assert.notEqual(((await json(again.response)) as Body).version, a.version, path);
			}

			// max-age=1 expires.
			const score = (await json((await get(`${origin}/scores/s`)).response)) as Body;
			assert.equal((await get(`${origin}/scores/s`)).status, "HIT");
			await delay(1_500);
			const expired = await get(`${origin}/scores/s`);
			assert.equal(expired.status, "MISS");
			assert.notEqual(((await json(expired.response)) as Body).version, score.version);

			// A named cache is separate from caches.default.
			await json((await get(`${origin}/thumbs/articles/a`)).response);
			const peek = (path: string, cache: string) =>
				fetch(`${origin}/peek?path=${path}&cache=${cache}`).then((r) => json(r));
			assert.deepEqual(await peek("/thumbs/articles/a", "thumbnails"), { cached: true });
			assert.deepEqual(await peek("/thumbs/articles/a", "default"), { cached: false });
			assert.deepEqual(await peek("/articles/a", "thumbnails"), { cached: false });

			assert.deepEqual(
				await json(await post(`${origin}/purge`, { cache: "thumbnails", path: "/thumbs/articles/a" })),
				{ deleted: true },
			);
			assert.deepEqual(
				await json(await post(`${origin}/purge`, { cache: "thumbnails", path: "/thumbs/articles/a" })),
				{ deleted: false },
			);
			assert.deepEqual(await json(await post(`${origin}/purge`, { path: "/articles/a" })), { deleted: true });
			assert.equal((await get(article)).status, "MISS");
			assert.equal((await post(`${origin}/purge`, {})).status, 400);
			assert.equal((await fetch(article, { method: "POST" })).headers.get("cf-cache-status"), "BYPASS");
		});

		// With ORANGE_CACHE=off the Cache API stores nothing, as on workers.dev.
		process.env.ORANGE_CACHE = "off";
		try {
			await withDev(projectDirectory, async ({ origin }) => {
				await (await get(`${origin}/articles/b`)).response.text();
				const again = await get(`${origin}/articles/b`);
				assert.equal(again.status, "MISS");
				await again.response.text();
				assert.deepEqual(await json(await post(`${origin}/purge`, { path: "/articles/b" })), {
					deleted: false,
				});
			});
		} finally {
			delete process.env.ORANGE_CACHE;
		}
	},

	async "chat-hibernation"(projectDirectory) {
		await withDev(projectDirectory, async ({ origin }) => {
			const room = `${origin}/rooms/lobby`;
			assert.equal((await fetch(`${room}?user=alice`)).status, 426);
			await assert.rejects(openWebSocket(room), /400/);

			const alice = await openWebSocket(`${room}?user=alice`);
			const bob = await openWebSocket(`${room}?user=bob`);
			try {
				assert.deepEqual(await next(alice), { messages: [], type: "history" });
				assert.deepEqual(await next(bob), { messages: [], type: "history" });

				alice.send("ping");
				assert.equal(await nextText(alice), "pong");

				alice.send(JSON.stringify({ text: "hello" }));
				const hello = { from: "alice", text: "hello", type: "message" };
				assert.deepEqual(await next(alice), hello);
				assert.deepEqual(await next(bob), hello);

				bob.send(JSON.stringify({ text: "hi", to: "carol" }));
				assert.deepEqual(await next(bob), {
					error: "carol is not in this room",
					type: "error",
				});

				// Stay idle past the 10-second window so the room hibernates. The
				// sockets stay open, and the woken room finds alice by her tag.
				await delay(11_000);
				bob.send(JSON.stringify({ text: "psst", to: "alice" }));
				assert.deepEqual(await next(alice), { from: "bob", text: "psst", type: "direct" });

				const carol = await openWebSocket(`${room}?user=carol`);
				const dave = await openWebSocket(`${origin}/rooms/other?user=dave`);
				try {
					assert.deepEqual(await next(carol), {
						messages: [{ from: "alice", text: "hello" }],
						type: "history",
					});
					assert.deepEqual(await next(dave), { messages: [], type: "history" });
				} finally {
					await Promise.all([closeWebSocket(carol), closeWebSocket(dave)]);
				}
			} finally {
				await Promise.all([closeWebSocket(alice), closeWebSocket(bob)]);
			}
		});
	},

	async "collaborative-counter"(projectDirectory) {
		await withDev(projectDirectory, async ({ origin }) => {
			const counter = `${origin}/counters/shared`;
			assert.equal((await fetch(counter)).status, 426);
			const first = await openWebSocket(counter);
			const second = await openWebSocket(counter);
			try {
				assert.deepEqual(await next(first), { value: 0 });
				assert.deepEqual(await next(second), { value: 0 });

				first.send("reset");
				assert.deepEqual(await next(first), { error: "Unknown command: reset" });

				// Overlapping updates from two clients: none is lost, and both
				// clients see every value in order.
				for (let index = 0; index < 5; index++) {
					first.send("increment");
					second.send("increment");
				}
				const expected = Array.from({ length: 10 }, (_, index) => ({ value: index + 1 }));
				for (const socket of [first, second]) {
					const messages = await withDeadline(collectMessages(socket, 10), "updates");
					assert.deepEqual(messages.map((message) => JSON.parse(message)), expected);
				}

				second.send("decrement");
				assert.deepEqual(await next(first), { value: 9 });
				assert.deepEqual(await next(second), { value: 9 });
			} finally {
				await Promise.all([closeWebSocket(first), closeWebSocket(second)]);
			}

			const late = await openWebSocket(counter);
			const other = await openWebSocket(`${origin}/counters/other`);
			try {
				assert.deepEqual(await next(late), { value: 9 });
				assert.deepEqual(await next(other), { value: 0 });
			} finally {
				await Promise.all([closeWebSocket(late), closeWebSocket(other)]);
			}
		});
	},

	async "cron"(projectDirectory) {
		await withDev(projectDirectory, async ({ origin, output }) => {
			// The ready block lists every cron, including Cloudflare-only syntax.
			for (const cron of ["*/5 * * * *", "0 3 * * *", "0 18 LW * *", "0 9 * * 2#1", "15 * * * *"]) {
				assert.match(output(), new RegExp(`${JSON.stringify(cron).replace(/[*#]/g, "\\$&")} next \\d{4}-`));
			}

			const run = (cron: string, query = "") =>
				fetch(`${origin}/cdn-cgi/local/scheduled?cron=${encodeURIComponent(cron)}${query}`);
			type Run = { count: number; cron: string; lastError?: string; lastOutcome: string; scheduledTime: number };
			const state = async () =>
				(await json(await fetch(`${origin}/`))) as {
					digestSentAt: number | null;
					lastHeartbeat: number | null;
					runs: (Run & { job: string })[];
				};
			const job = async (name: string) => (await state()).runs.find((run) => run.job === name);

			// The audit write in waitUntil() finishes before the route answers.
			const heartbeat = await run("*/5 * * * *", "&time=1792551600000");
			assert.equal(heartbeat.status, 200);
			assert.equal(await heartbeat.text(), "ok");
			assert.equal((await state()).lastHeartbeat, 1792551600000);

			assert.equal((await fetch(`${origin}/tmp/a`, { body: "1", method: "PUT" })).status, 204);
			assert.equal((await fetch(`${origin}/tmp/b`, { body: "2", method: "PUT" })).status, 204);
			assert.deepEqual(await json(await fetch(`${origin}/tmp`)), { keys: ["a", "b"] });
			assert.equal((await run("0 3 * * *")).status, 200);
			assert.deepEqual(await json(await fetch(`${origin}/tmp`)), { keys: [] });

			assert.equal((await run("0 18 LW * *", "&time=1793383200000")).status, 200);
			assert.equal((await job("month-end-report"))?.scheduledTime, 1793383200000);

			// The handler returns, but its rejected waitUntil() promise fails the event.
			const unsent = await run("0 9 * * 2#1", "&format=json");
			assert.equal(unsent.status, 500);
			assert.deepEqual(await unsent.json(), { noRetry: false, outcome: "exception" });
			assert.equal((await state()).digestSentAt, null);
			assert.equal((await fetch(`${origin}/digest/subscribe`, { method: "POST" })).status, 204);
			assert.equal((await run("0 9 * * 2#1", "&time=1793610000000")).status, 200);
			assert.equal((await state()).digestSentAt, 1793610000000);

			const failed = await run("15 * * * *", "&format=json");
			assert.equal(failed.status, 500);
			assert.deepEqual(await failed.json(), { noRetry: false, outcome: "exception" });
			assert.deepEqual(
				{ ...(await job("upstream-sync")), scheduledTime: 0 },
				{
					count: 1,
					cron: "15 * * * *",
					job: "upstream-sync",
					lastError: "Upstream sync failed: https://upstream.example is unavailable",
					lastOutcome: "exception",
					scheduledTime: 0,
				},
			);

			// A cron with no job calls noRetry() and throws.
			const unknown = await run("1 2 3 4 5", "&format=json");
			assert.equal(unknown.status, 500);
			assert.deepEqual(await unknown.json(), { noRetry: true, outcome: "exception" });
			const plain = await run("1 2 3 4 5");
			assert.equal(plain.status, 500);
			assert.equal(await plain.text(), "exception");

			// Without --test-scheduled, the Worker serves /__scheduled itself.
			assert.equal((await fetch(`${origin}/__scheduled?cron=*/5+*+*+*+*`)).status, 404);
		});
	},

	async "d1-migrations"(projectDirectory) {
		await withDev(projectDirectory, async ({ origin }) => {
			const comments = `${origin}/comments`;
			// The table does not exist until the migrations run.
			assert.equal((await fetch(comments)).status, 500);

			const applied = await runOrange(projectDirectory, ["d1", "migrations", "apply", "DB"]);
			assert.equal(applied.code, 0, applied.output);
			assert.match(applied.output, /0001_create_comments_table\.sql/);
			assert.match(applied.output, /0002_index_comments_by_author\.sql/);

			assert.deepEqual(await json(await fetch(comments)), {
				comments: [
					{ author: "Kristian", content: "Congrats!", id: 1 },
					{ author: "Serena", content: "Great job!", id: 2 },
					{ author: "Max", content: "Keep up the good work!", id: 3 },
				],
			});
			const ada = { author: "Ada", content: "Nice work", id: 4 };
			assert.deepEqual(await json(await post(comments, { author: "Ada", content: "Nice work" }), 201), ada);
			assert.deepEqual(await json(await post(comments, { author: "Ada" }), 400), {
				error: "Send JSON with string author and content fields",
			});
			assert.deepEqual(await json(await fetch(`${comments}?author=Ada`)), { comments: [ada] });
		});
	},

	async "facets-loader"(projectDirectory) {
		await withDev(projectDirectory, async ({ origin }) => {
			const ada = `${origin}/workspaces/team/users/ada`;
			const add = (url: string, text: string) => fetch(`${url}/notes`, { body: text, method: "POST" });
			assert.deepEqual(await json(await add(ada, " buy milk "), 201), { id: 1, text: " buy milk " });
			assert.deepEqual(await json(await add(ada, ""), 400), { error: "Send the note text as the body" });
			// Each user is a separate facet with its own database.
			await json(await add(`${origin}/workspaces/team/users/bob`, "bob's note"), 201);
			assert.deepEqual(await json(await fetch(`${ada}/notes`)), {
				notes: [{ id: 1, text: " buy milk " }],
				version: 1,
			});

			// Swapping the class aborts the running facet; its data stays.
			assert.deepEqual(await json(await fetch(`${ada}/upgrade`, { method: "POST" })), {
				inFlightError: "upgrading to NotesV2",
				notes: [{ id: 1, text: " buy milk " }],
				oldStubError: "upgrading to NotesV2",
				version: 2,
			});
			assert.deepEqual(await json(await add(ada, " call home "), 201), { id: 2, text: "call home" });

			const run = (code: string) => fetch(`${ada}/run`, { body: code, method: "POST" });
			assert.deepEqual(
				await json(await run("export default { run(notes) { return notes.map((n) => n.text.trim().toUpperCase()); } };")),
				{ result: ["BUY MILK", "CALL HOME"] },
			);
			assert.deepEqual(
				await json(await run("export default { async run() { return (await fetch('https://example.com')).status; } };"), 422),
				{
					error: {
						message:
							"This worker is not permitted to access the internet via global functions like fetch(). It must use capabilities (such as bindings in 'env') to talk to the outside world.",
						name: "Error",
					},
				},
			);
			// The exact parser message depends on the JavaScript engine.
			const broken = (await json(await run("export default { run( };"), 422)) as {
				error: { message: string; name: string };
			};
			assert.equal(broken.error.name, "SyntaxError");
			assert.match(broken.error.message, /^Unexpected token/);
			assert.deepEqual(await json(await run("export default { run() { throw new TypeError('bad plugin'); } };"), 422), {
				error: { message: "bad plugin", name: "TypeError" },
			});

			// delete() stops the facet and erases its data. Other users keep theirs.
			assert.deepEqual(await json(await fetch(ada, { method: "DELETE" })), { inFlightError: "Facet was deleted." });
			assert.deepEqual(await json(await fetch(`${ada}/notes`)), { notes: [], version: 1 });
			assert.deepEqual(await json(await fetch(`${origin}/workspaces/team/users/bob/notes`)), {
				notes: [{ id: 1, text: "bob's note" }],
				version: 1,
			});
		});
	},

	async "hello-durable-object"(projectDirectory) {
		await withDev(projectDirectory, async ({ origin }) => {
			assert.deepEqual(await json(await fetch(`${origin}/alice`)), {
				greeting: "Hello, alice!",
				visits: 1,
			});
			assert.deepEqual(await json(await fetch(`${origin}/alice`)), {
				greeting: "Hello, alice!",
				visits: 2,
			});
			// Another name is another object with its own database.
			assert.deepEqual(await json(await fetch(`${origin}/bob`)), {
				greeting: "Hello, bob!",
				visits: 1,
			});
		});
		// The count survives a restart of orange dev.
		await withDev(projectDirectory, async ({ origin }) => {
			assert.deepEqual(await json(await fetch(`${origin}/alice`)), {
				greeting: "Hello, alice!",
				visits: 3,
			});
		});
	},

	async "kv"(projectDirectory) {
		await withDev(projectDirectory, async ({ origin }) => {
			const put = (key: string, value: string) =>
				fetch(`${origin}/notes/${key}`, { body: value, method: "PUT" });
			assert.equal((await put("todo-1", "buy milk")).status, 204);
			assert.equal((await put("todo-2?ttl=120", "call home")).status, 204);
			assert.equal((await put("draft", "idea")).status, 204);

			// Cloudflare refuses a TTL under 60 s. Orange does not copy that quota.
			assert.equal((await put("todo-3?ttl=30", "soon")).status, 204);

			assert.equal(await (await fetch(`${origin}/notes/todo-1`)).text(), "buy milk");
			const { keys } = (await json(await fetch(`${origin}/notes?prefix=todo-`))) as {
				keys: { expiration?: number; name: string }[];
			};
			assert.deepEqual(
				keys.map(({ expiration, name }) => ({ expires: expiration !== undefined, name })),
				[
					{ expires: false, name: "todo-1" },
					{ expires: true, name: "todo-2" },
					{ expires: true, name: "todo-3" },
				],
			);

			assert.equal((await fetch(`${origin}/notes/todo-1`, { method: "DELETE" })).status, 204);
			const deleted = await fetch(`${origin}/notes/todo-1`);
			assert.equal(deleted.status, 404);
			assert.equal(await deleted.text(), "No note named todo-1");
		});
	},

	async "multi-worker"(projectDirectory) {
		const configs = ["wrangler.jsonc", "auth/wrangler.jsonc", "jobs/wrangler.jsonc"];
		await withDev(
			projectDirectory,
			async ({ origin }) => {
				assert.equal(await (await fetch(`${origin}/health`)).text(), "auth is up");
				assert.deepEqual(await json(await fetch(`${origin}/login/ada`)), { logins: 1, user: "ada" });
				assert.deepEqual(await json(await fetch(`${origin}/login/ada`)), { logins: 2, user: "ada" });
				// The RangeError thrown in auth reaches gateway over RPC.
				assert.deepEqual(await json(await fetch(`${origin}/login/Ada!`), 400), {
					error: "user must be lowercase letters",
				});
				// gateway reads auth's Durable Object through script_name.
				assert.deepEqual(await json(await fetch(`${origin}/sessions/ada`)), { active: true, logins: 2 });
				assert.deepEqual(await json(await fetch(`${origin}/stats`)), { users: ["ada"] });
				assert.deepEqual(await json(await fetch(`${origin}/sessions/ada`, { method: "DELETE" })), {
					revoked: "ada",
				});
				assert.deepEqual(await json(await fetch(`${origin}/sessions/ada`)), { active: false, logins: 0 });

				await json(await post(`${origin}/emails`, { to: "ada@example.com" }), 202);
				await json(await post(`${origin}/emails`, { to: "nobody@bounce.test" }), 202);
				assert.deepEqual(await json(await post(`${origin}/emails`, {}), 400), {
					error: 'Send JSON like {"to":"ada@example.com"}',
				});
				const signup = `${origin}/signups/bob`;
				assert.deepEqual(await json(await post(signup, { email: "bob@example.com" }), 201), { id: "bob" });
				// One Workflow instance per id: a second signup fails.
				await json(await post(signup, { email: "bob@example.com" }), 409);
				assert.deepEqual(await json(await fetch(`${origin}/signups/nobody`), 404), {
					error: "No signup for nobody",
				});

				type Email = { status: string; to: string };
				let emails: Email[] = [];
				let status: { output?: unknown; status: string } = { status: "unknown" };
				const deadline = Date.now() + 30_000;
				// The consumer and the Workflow run in jobs in the background; the
				// caller can only see them by reading again.
				while (Date.now() < deadline) {
					({ emails } = (await json(await fetch(`${origin}/workers/jobs/emails`))) as { emails: Email[] });
					status = (await json(await fetch(signup))) as typeof status;
					if (emails.length === 3 && status.status === "complete") break;
					await delay(250);
				}
				assert.deepEqual(status, { output: { user: "bob", welcomed: "bob@example.com" }, status: "complete" });
				assert.deepEqual(
					emails.map(({ status, to }) => ({ status, to })).sort((a, b) => a.to.localeCompare(b.to)),
					[
						{ status: "sent", to: "ada@example.com" },
						{ status: "sent", to: "bob@example.com" },
						{ status: "bounced", to: "nobody@bounce.test" },
					],
				);
				const missing = (await json(await fetch(`${origin}/workers/billing/`), 404)) as { error: string };
				assert.match(missing.error, /^Worker not found\./);
			},
			configs,
		);
	},

	async "queues"(projectDirectory) {
		await withDev(projectDirectory, async ({ origin }) => {
			const jobs = `${origin}/jobs`;
			type Result = { attempts?: number; id: string; status: string; waitedMs: number };
			type Jobs = { maxBatchSize: number; results: Result[] };
			// The consumers run in the background; the caller can only see them by
			// reading the results again.
			const waitFor = async <T>(url: string, done: (value: T) => boolean): Promise<T> => {
				const deadline = Date.now() + 30_000;
				let value = (await json(await fetch(url))) as T;
				while (!done(value) && Date.now() < deadline) {
					await delay(250);
					value = (await json(await fetch(url))) as T;
				}
				return value;
			};

			assert.deepEqual(await json(await post(jobs, { id: "a" }), 202), { queued: "a" });
			await json(await post(jobs, { failUntilAttempt: 1, id: "b" }), 202);
			// It fails more often than max_retries allows, so it lands in the dead letter queue.
			await json(await post(jobs, { failUntilAttempt: 9, id: "c" }), 202);
			await json(await post(jobs, { delaySeconds: 2, id: "d" }), 202);
			const batch = Array.from({ length: 7 }, (_, index) => ({ id: `batch-${index}` }));
			assert.deepEqual(await json(await post(`${jobs}/batch`, { delaySeconds: 1, jobs: batch }), 202), {
				queued: batch.map(({ id }) => id),
			});

			assert.deepEqual(await json(await post(jobs, {}), 400), {
				error: 'Send JSON like {"id":"a","failUntilAttempt":1,"delaySeconds":2}',
			});
			assert.deepEqual(await json(await post(jobs, { delaySeconds: -1, id: "late" }), 400), {
				error: "Queue send failed: message delay -1 is invalid. It must be a whole number of seconds, 0 or more.",
			});

			const { maxBatchSize, results } = await waitFor<Jobs>(jobs, ({ results }) => results.length === 11);
			const byId = new Map(results.map((result) => [result.id, result]));
			assert.deepEqual(
				results.map(({ attempts, id, status }) => ({ attempts, id, status })),
				[
					{ attempts: 1, id: "a", status: "done" },
					{ attempts: 2, id: "b", status: "done" },
					...batch.map(({ id }) => ({ attempts: 1, id, status: "done" })),
					{ attempts: undefined, id: "c", status: "failed" },
					{ attempts: 1, id: "d", status: "done" },
				].sort((left, right) => left.id.localeCompare(right.id)),
			);
			assert.ok((byId.get("d")?.waitedMs ?? 0) >= 2_000, "delaySeconds holds the message back");
			assert.ok((byId.get("batch-0")?.waitedMs ?? 0) >= 1_000, "the batch delay holds every message back");
			// b waited for its retry delay of 1 second.
			assert.ok((byId.get("b")?.waitedMs ?? 0) >= 1_000);
			assert.ok(maxBatchSize >= 1 && maxBatchSize <= 5, `max_batch_size is 5, got ${maxBatchSize}`);

			const events = `${origin}/events`;
			const send = (body: string | Uint8Array, contentType?: string) =>
				fetch(`${events}${contentType === undefined ? "" : `?contentType=${contentType}`}`, {
					body,
					method: "POST",
				});
			assert.equal((await send("hello", "text")).status, 202);
			assert.equal((await send(new Uint8Array([1, 2, 3]), "bytes")).status, 202);
			assert.equal((await send(JSON.stringify({ kind: "signup" }))).status, 202);
			const xml = await send("<a/>", "xml");
			assert.deepEqual(await json(xml, 400), { error: "Unsupported queue message content type: xml" });

			type Event = { attempts: number; type: string; value: unknown };
			const first = await waitFor<{ events: Event[] }>(events, ({ events }) => events.length === 3);
			assert.deepEqual(
				first.events.map(({ type, value }) => ({ type, value })).sort((l, r) => l.type.localeCompare(r.type)),
				[
					{ type: "bytes", value: [1, 2, 3] },
					{ type: "json", value: { kind: "signup" } },
					{ type: "text", value: "hello" },
				],
			);

			// retryAll() sends the batch back, so the flaky event arrives a second time.
			assert.equal((await send(JSON.stringify({ kind: "flaky" }))).status, 202);
			const second = await waitFor<{ events: Event[] }>(events, ({ events }) => events.length === 4);
			const flaky = second.events.find(({ value }) => (value as { kind?: string }).kind === "flaky");
			assert.equal(flaky?.attempts, 2);

			assert.deepEqual(await json(await fetch(`${origin}/metrics`)), { backlogBytes: 0, backlogCount: 0 });
		});
	},

	async "r2"(projectDirectory) {
		await withDev(projectDirectory, async ({ origin }) => {
			const files = `${origin}/files`;
			const put = (key: string, body: RequestInit["body"], headers?: Record<string, string>) =>
				fetch(`${files}/${key}`, { body, headers, method: "PUT" });
			const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

			type Stored = { checksums: { sha256?: string }; etag: string; size: number };
			const created = (await json(
				await put("notes/a.txt", "hello world", {
					"cache-control": "max-age=60",
					"content-disposition": 'attachment; filename="a.txt"',
					"content-type": "text/plain",
					"x-meta-owner": "ada",
					"x-sha256": sha256("hello world"),
				}),
				201,
			)) as Stored;
			assert.equal(created.checksums.sha256, sha256("hello world"));
			// A body that does not match its checksum is rejected and not stored.
			const corrupt = (await json(
				await put("notes/bad.txt", "tampered", { "x-sha256": sha256("original") }),
				400,
			)) as { error: string };
			assert.match(corrupt.error, /put/);
			assert.equal((await fetch(`${files}/notes/bad.txt`)).status, 404);

			// Downloads carry the stored HTTP and custom metadata.
			const file = await fetch(`${files}/notes/a.txt`);
			assert.equal(file.status, 200);
			assert.equal(file.headers.get("content-type"), "text/plain");
			assert.equal(file.headers.get("cache-control"), "max-age=60");
			assert.equal(file.headers.get("content-disposition"), 'attachment; filename="a.txt"');
			assert.equal(file.headers.get("x-meta-owner"), "ada");
			const etag = file.headers.get("etag");
			assert.equal(etag, `"${created.etag}"`);
			assert.equal(await file.text(), "hello world");

			const head = await fetch(`${files}/notes/a.txt`, { method: "HEAD" });
			assert.equal(head.headers.get("etag"), etag);
			assert.equal(head.headers.get("x-meta-owner"), "ada");

			const partial = await fetch(`${files}/notes/a.txt`, { headers: { range: "bytes=6-" } });
			assert.equal(partial.status, 206);
			assert.equal(partial.headers.get("content-range"), "bytes 6-10/11");
			assert.equal(await partial.text(), "world");

			const unchanged = await fetch(`${files}/notes/a.txt`, { headers: { "if-none-match": etag! } });
			assert.equal(unchanged.status, 304);
			assert.equal(await unchanged.text(), "");
			const stale = await fetch(`${files}/notes/a.txt`, { headers: { "if-match": '"old"' } });
			assert.equal(stale.status, 412);

			// Optimistic writes: a stale If-Match leaves the file alone.
			await json(await put("notes/a.txt", "lost update", { "if-match": '"old"' }), 412);
			await json(await put("notes/a.txt", "hello again", { "if-match": etag! }), 201);
			assert.equal(await (await fetch(`${files}/notes/a.txt`)).text(), "hello again");

			await json(await put("notes/b.txt", "b"), 201);
			await json(await put("notes/archive/c.txt", "c"), 201);
			await json(await put("images/d.png", "d", { "content-type": "image/png" }), 201);

			type Page = { cursor?: string; files: { key: string }[]; folders: string[]; truncated: boolean };
			const tree = (await json(await fetch(`${files}?prefix=notes/&delimiter=/`))) as Page;
			assert.deepEqual(tree.files.map(({ key }) => key), ["notes/a.txt", "notes/b.txt"]);
			assert.deepEqual(tree.folders, ["notes/archive/"]);

			const keys: string[] = [];
			let cursor: string | undefined;
			let pages = 0;
			do {
				const query = cursor === undefined ? "" : `&cursor=${encodeURIComponent(cursor)}`;
				const page = (await json(await fetch(`${files}?limit=2${query}`))) as Page;
				keys.push(...page.files.map(({ key }) => key));
				cursor = page.cursor;
				pages += 1;
			} while (cursor !== undefined);
			assert.equal(pages, 2);
			assert.deepEqual(keys, ["images/d.png", "notes/a.txt", "notes/archive/c.txt", "notes/b.txt"]);

			assert.deepEqual(
				await json(await post(`${files}/delete`, { keys: ["notes/a.txt", "notes/b.txt", "missing"] })),
				{ deleted: 3 },
			);
			assert.deepEqual(
				((await json(await fetch(files))) as Page).files.map(({ key }) => key),
				["images/d.png", "notes/archive/c.txt"],
			);

			// Multipart: a 5 MiB part plus a short last part.
			const uploads = `${origin}/uploads/videos/big.bin`;
			const start = async () =>
				(
					(await json(
						await fetch(uploads, { headers: { "content-type": "video/mp4" }, method: "POST" }),
						201,
					)) as { uploadId: string }
				).uploadId;
			const sendPart = async (uploadId: string, part: number, body: Uint8Array) =>
				json(await fetch(`${uploads}?uploadId=${uploadId}&part=${part}`, { body, method: "PUT" }));
			const uploadId = await start();
			const first = new Uint8Array(5 * 1024 * 1024).fill(1);
			const parts = [await sendPart(uploadId, 1, first), await sendPart(uploadId, 2, new Uint8Array(1024).fill(2))];
			const big = (await json(await post(`${uploads}?uploadId=${uploadId}`, { parts }), 201)) as Stored;
			assert.equal(big.size, 5 * 1024 * 1024 + 1024);
			const tail = await fetch(`${files}/videos/big.bin`, { headers: { range: "bytes=-2" } });
			assert.equal(tail.status, 206);
			assert.equal(tail.headers.get("content-type"), "video/mp4");
			assert.deepEqual([...new Uint8Array(await tail.arrayBuffer())], [2, 2]);

			// A non-final part under 5 MiB fails the completion.
			const small = await start();
			const smallParts = [
				await sendPart(small, 1, new Uint8Array(10)),
				await sendPart(small, 2, new Uint8Array(10)),
			];
			await json(await post(`${uploads}?uploadId=${small}`, { parts: smallParts }), 400);
			assert.equal((await fetch(`${uploads}?uploadId=${small}`, { method: "DELETE" })).status, 204);
		});
	},

	async "rate-limiting"(projectDirectory) {
		await withDev(projectDirectory, async ({ origin }) => {
			const call = async (path: string, ip: string, body?: unknown) => {
				const response = await fetch(`${origin}${path}`, {
					headers: { "cf-connecting-ip": ip },
					...(body === undefined ? {} : { body: JSON.stringify(body), method: "POST" }),
				});
				return {
					body: (await response.json()) as Record<string, unknown>,
					retryAfter: response.headers.get("retry-after"),
					status: response.status,
				};
			};
			// Windows start on wall-clock multiples of the period. Start well inside
			// a 60 second window so no burst below straddles a rollover.
			const intoWindow = Date.now() % 60_000;
			if (intoWindow > 45_000) await delay(60_000 - intoWindow + 100);

			// Overlapping requests from one user: exactly the limit gets through,
			// and the rejected ones say when to retry.
			const burst = await Promise.all(
				Array.from({ length: 7 }, (_, index) => call("/api/me?user=ada", `10.0.1.${index}`)),
			);
			assert.deepEqual(
				burst.map(({ status }) => status).sort(),
				[200, 200, 200, 200, 200, 429, 429],
			);
			const rejected = burst.find(({ status }) => status === 429);
			assert.equal(rejected?.body.error, "Too many requests for user ada");
			const retryAfter = Number(rejected?.retryAfter);
			assert.ok(retryAfter >= 1 && retryAfter <= 60, `Retry-After ${rejected?.retryAfter}`);
			// The pro plan overrides the limit per call: the same binding allows more.
			for (let index = 0; index < 7; index += 1) {
				assert.equal((await call("/api/me?user=grace&plan=pro", `10.0.2.${index}`)).status, 200);
			}

			// One IP gets 10 requests per 10 seconds across every user and route.
			const intoShortWindow = Date.now() % 10_000;
			if (intoShortWindow > 7_000) await delay(10_000 - intoShortWindow + 100);
			const fromOneIp = await Promise.all(
				Array.from({ length: 12 }, (_, index) => call(`/api/me?user=ip-${index}`, "10.0.3.1")),
			);
			assert.equal(fromOneIp.filter(({ status }) => status === 429).length, 2);
			assert.equal(
				fromOneIp.find(({ status }) => status === 429)?.body.error,
				"Too many requests from 10.0.3.1",
			);

			// Login and password reset share namespace_id 1003, so they share a budget.
			assert.equal((await call("/login", "10.0.4.1", { password: "guess", username: "bob" })).status, 401);
			assert.equal((await call("/password-reset", "10.0.4.2", { username: "bob" })).status, 202);
			assert.deepEqual(
				(await call("/login", "10.0.4.3", { password: "correct-horse", username: "bob" })).body,
				{ loggedIn: "bob" },
			);
			// The right password is throttled too once the budget is spent.
			const throttled = await call("/login", "10.0.4.4", { password: "correct-horse", username: "bob" });
			assert.equal(throttled.status, 429);
			assert.ok(Number(throttled.retryAfter) >= 1);
			assert.equal((await call("/password-reset", "10.0.4.5", { username: "bob" })).status, 429);
			// Another account has its own budget.
			assert.equal((await call("/login", "10.0.4.6", { password: "hunter2", username: "ada" })).status, 200);

			// Invalid options throw from limit(), as on Cloudflare.
			assert.deepEqual(await call("/probe?key=k&period=30", "10.0.5.1"), {
				body: { error: "unsupported period: 30" },
				retryAfter: null,
				status: 400,
			});
			assert.deepEqual((await call("/probe?key=k&limit=1", "10.0.5.2")).body, { success: true });
			assert.deepEqual((await call("/probe?key=k&limit=1", "10.0.5.3")).body, { success: false });
			assert.equal((await call("/api/me", "10.0.5.4")).status, 400);
		});
	},

	async "rpc-entrypoints"(projectDirectory) {
		await withDev(projectDirectory, async ({ origin }) => {
			assert.equal(await (await fetch(`${origin}/greet?name=Ada`)).text(), "Hello, Ada!");

			const counter = `${origin}/counters/a`;
			assert.deepEqual(await json(await fetch(`${counter}?amount=2`, { method: "POST" })), { total: 2 });
			assert.deepEqual(await json(await fetch(counter, { method: "POST" })), { total: 3 });
			// The error thrown inside the Durable Object reaches the Worker.
			assert.deepEqual(
				await json(await fetch(`${counter}?amount=-1`, { method: "POST" }), 400),
				{ error: "amount must be a positive integer" },
			);
			assert.deepEqual(await json(await fetch(counter)), { total: 3 });
			assert.deepEqual(await json(await fetch(`${origin}/counters/b`)), { total: 0 });
		});
	},

	async "sandbox"(projectDirectory) {
		await withDev(projectDirectory, async ({ origin }) => {
			const ada = `${origin}/users/ada`;
			const run = async (user: string, command: string) =>
				(await json(await post(`${origin}/users/${user}/run`, { command }))) as {
					exitCode: number;
					stderr: string;
					stdout: string;
					success: boolean;
				};

			assert.deepEqual(await run("ada", "echo hi; echo oops >&2"), {
				exitCode: 0,
				stderr: "oops\n",
				stdout: "hi\n",
				success: true,
			});
			// A failing command is a result the caller can read, not an HTTP error.
			assert.deepEqual(await run("ada", "exit 3"), { exitCode: 3, stderr: "", stdout: "", success: false });
			assert.deepEqual(await json(await post(`${ada}/run`, {}), 400), {
				error: 'Send JSON like {"command":"echo hi"}',
			});
			assert.equal((await json(await post(`${origin}/users/Not_Valid/run`, { command: "true" }), 400) as { error: string }).error, "User ids are lowercase letters, digits, and dashes");

			const stream = await fetch(`${ada}/stream`, { body: "echo one; echo two >&2; exit 1", method: "POST" });
			assert.equal(stream.headers.get("content-type"), "text/event-stream");
			const events = (await stream.text())
				.split("\n\n")
				.filter((chunk) => chunk.startsWith("data: "))
				.map((chunk) => JSON.parse(chunk.slice("data: ".length)) as { data?: string; exitCode?: number; type: string });
			assert.equal(events[0]?.type, "start");
			assert.ok(events.some(({ data, type }) => type === "stdout" && data === "one\n"));
			assert.ok(events.some(({ data, type }) => type === "stderr" && data === "two\n"));
			assert.deepEqual(events.at(-1) && { exitCode: events.at(-1)?.exitCode, type: events.at(-1)?.type }, {
				exitCode: 1,
				type: "complete",
			});

			assert.equal((await fetch(`${ada}/files/notes/todo.txt`, { body: "ship it", method: "PUT" })).status, 204);
			assert.equal(await (await fetch(`${ada}/files/notes/todo.txt`)).text(), "ship it");
			// Commands see the files the file API wrote.
			assert.equal((await run("ada", "cat notes/todo.txt")).stdout, "ship it");
			assert.deepEqual(await json(await fetch(`${ada}/files`)), [{ path: "notes/todo.txt", size: 7 }]);
			assert.deepEqual(await json(await fetch(`${ada}/files/missing.txt`), 404), {
				error: "No file /workspace/missing.txt",
			});
			// Each user id has its own sandbox.
			assert.deepEqual(await json(await fetch(`${origin}/users/bob/files/notes/todo.txt`), 404), {
				error: "No file /workspace/notes/todo.txt",
			});

			const git = await fetch(`${ada}/git`, { method: "POST" });
			if (git.status !== 503) {
				assert.deepEqual(((await json(git)) as { files: string[] }).files, ["README.md"]);
			}

			const port = await freePort();
			const { previewUrl } = (await json(await fetch(`${ada}/server?port=${port}`, { method: "POST" }), 201)) as {
				previewUrl: string;
			};
			const preview = new URL(previewUrl);
			assert.match(preview.hostname.split(".")[0] ?? "", new RegExp(`^${port}-ada-[a-z0-9_]{16}$`));
			// Preview URLs reach the Worker by Host header; proxyToSandbox forwards them.
			const previewBody = await new Promise<string>((resolve, reject) => {
				const { port: devPort } = new URL(origin);
				httpRequest(
					{ headers: { host: preview.host }, host: "127.0.0.1", path: "/hi", port: Number(devPort) },
					(response) => {
						let body = "";
						response.setEncoding("utf8");
						response.on("data", (chunk: string) => (body += chunk));
						response.on("end", () => resolve(body));
					},
				)
					.on("error", reject)
					.end();
			});
			assert.equal(previewBody, "hello from the sandbox /hi");
			assert.deepEqual(await json(await fetch(`${ada}/server?port=${port}`, { method: "POST" }), 409), {
				error: "The server is already running",
			});

			assert.deepEqual(await json(await fetch(`${ada}/processes/web`, { method: "DELETE" })), {
				id: "web",
				status: "killed",
			});
			assert.deepEqual(await json(await fetch(`${ada}/processes/nope`, { method: "DELETE" }), 404), {
				error: "No process nope",
			});

			assert.equal((await fetch(ada, { method: "DELETE" })).status, 204);
			// After destroy, the next call gets a new, empty sandbox.
			assert.deepEqual(await json(await fetch(`${ada}/files`)), []);
		});
	},

	async "sandbox-v1"(projectDirectory) {
		await withDev(projectDirectory, async ({ origin }) => {
			const ada = `${origin}/sandboxes/ada`;
			const exec = async (name: string, argv: string[]) =>
				(await json(await fetch(`${origin}/sandboxes/${name}/exec`, { body: JSON.stringify({ argv }), method: "POST" }))) as {
					exitCode: number;
					stderr: string;
					stdout: string;
				};

			// A failing command is a result the caller can read, not an HTTP error.
			assert.deepEqual(await exec("ada", ["sh", "-c", "echo hi; echo oops >&2; exit 3"]), {
				exitCode: 3,
				stderr: "oops\n",
				stdout: "hi\n",
			});
			assert.equal((await fetch(`${ada}/exec`, { body: "{}", method: "POST" })).status, 400);

			// Files opens the path as Linux does, so a missing parent directory is ENOENT.
			assert.equal((await fetch(`${ada}/files/notes/todo.txt`, { body: "ship it", method: "PUT" })).status, 404);
			assert.equal((await exec("ada", ["mkdir", "notes"])).exitCode, 0);
			assert.equal((await fetch(`${ada}/files/notes/todo.txt`, { body: "ship it", method: "PUT" })).status, 204);
			assert.equal(await (await fetch(`${ada}/files/notes/todo.txt`)).text(), "ship it");
			// Commands see the files Files wrote.
			assert.equal((await exec("ada", ["cat", "notes/todo.txt"])).stdout, "ship it");
			assert.equal((await fetch(`${ada}/files/missing.txt`)).status, 404);
			// Each name has its own sandbox.
			assert.equal((await fetch(`${origin}/sandboxes/bob/files/notes/todo.txt`)).status, 404);

			assert.equal((await fetch(ada, { method: "DELETE" })).status, 204);
			// After destroy, the next call gets a new, empty sandbox.
			assert.equal((await fetch(`${ada}/files/notes/todo.txt`)).status, 404);
		});
	},

	async "workers-ai"(projectDirectory) {
		// A hand-written OpenAI-compatible provider. It never needs a real key.
		const providerModels: string[] = [];
		const provider = createServer((request, response) => {
			let raw = "";
			request.on("data", (chunk) => (raw += chunk));
			request.on("end", () => {
				const body = JSON.parse(raw) as {
					input?: string[];
					messages?: { content: string; role: string }[];
					model: string;
					stream?: boolean;
					tools?: unknown[];
				};
				providerModels.push(body.model);
				const send = (status: number, value: unknown): void => {
					response.writeHead(status, { "content-type": "application/json" });
					response.end(JSON.stringify(value));
				};
				if (request.url === "/v1/embeddings") {
					// A tiny "embedding": does the text mention storage or messaging?
					const data = (body.input ?? []).map((text, index) => ({
						embedding: [/stor|kv/i.test(text) ? 1 : 0, /messag|queue/i.test(text) ? 1 : 0, 0.1],
						index,
					}));
					send(200, { data, model: body.model });
					return;
				}
				const messages = body.messages ?? [];
				const last = messages.at(-1)?.content ?? "";
				if (last.includes("provider-down")) {
					send(503, { error: { message: "the model is overloaded" } });
					return;
				}
				if (body.stream === true) {
					response.writeHead(200, { "content-type": "text/event-stream" });
					for (const word of ["one", " two", " three"]) {
						response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: word } }] })}\n\n`);
					}
					response.end("data: [DONE]\n\n");
					return;
				}
				const tool = messages.find(({ role }) => role === "tool");
				const message =
					body.tools !== undefined && tool === undefined
						? {
								content: null,
								role: "assistant",
								tool_calls: [
									{
										function: { arguments: '{"city":"Lisbon"}', name: "get_weather" },
										id: "call_1",
										type: "function",
									},
								],
							}
						: { content: tool ? `weather: ${tool.content}` : `echo: ${last}`, role: "assistant" };
				send(200, {
					choices: [{ index: 0, message }],
					model: body.model,
					usage: { completion_tokens: 2, prompt_tokens: 3, total_tokens: 5 },
				});
			});
		});
		await new Promise<void>((resolveListen) => provider.listen(0, "127.0.0.1", resolveListen));
		const { port } = provider.address() as AddressInfo;
		const models = { "@cf/meta/llama-3.1-8b-instruct": { model: "local-chat", task: "text" } };
		await writeFile(
			join(projectDirectory, ".dev.vars"),
			`ORANGE_AI_BASE_URL=http://127.0.0.1:${port}/v1\nORANGE_AI_MODELS=${JSON.stringify(models)}\n`,
		);
		try {
			await withDev(projectDirectory, async ({ origin }) => {
				const user = (content: string) => ({ messages: [{ content, role: "user" }] });

				assert.deepEqual(await json(await post(`${origin}/chat`, user("hi"))), {
					answer: "echo: hi",
					usage: { completion_tokens: 2, prompt_tokens: 3, total_tokens: 5 },
				});
				// ORANGE_AI_MODELS sent the Workers AI model to the mapped provider model.
				assert.equal(providerModels.at(-1), "local-chat");
				assert.deepEqual(await json(await post(`${origin}/chat`, {}), 400), {
					error: 'Send {"messages":[{"role":"user","content":"..."}]}',
				});

				const stream = await post(`${origin}/chat`, { ...user("count"), stream: true });
				assert.equal(stream.status, 200);
				assert.match(stream.headers.get("content-type") ?? "", /^text\/event-stream/);
				const events = (await stream.text())
					.split("\n\n")
					.filter((event) => event.startsWith("data: "))
					.map((event) => event.slice(6));
				assert.equal(events.at(-1), "[DONE]");
				assert.equal(
					events
						.slice(0, -1)
						.map((event) => (JSON.parse(event) as { response: string }).response)
						.join(""),
					"one two three",
				);

				assert.deepEqual(
					await json(await post(`${origin}/ask`, { question: "Weather in Lisbon?" })),
					{
						answer: 'weather: {"city":"Lisbon","forecast":"sunny","celsius":24}',
						toolCalls: [{ arguments: { city: "Lisbon" }, name: "get_weather" }],
					},
				);

				const ranked = (await json(
					await post(`${origin}/search`, {
						documents: ["Queues send messages", "KV stores values"],
						query: "storage",
					}),
				)) as { ranked: { text: string }[]; shape: number[] };
				assert.deepEqual(ranked.shape, [3, 3]);
				assert.deepEqual(
					ranked.ranked.map(({ text }) => text),
					["KV stores values", "Queues send messages"],
				);

				assert.deepEqual(await json(await post(`${origin}/openai`, user("hello"))), {
					answer: "echo: hello",
					model: "openai/gpt-oss-20b",
				});

				// A provider failure is an InferenceUpstreamError with the provider's message.
				const failed = (await json(await post(`${origin}/chat`, user("provider-down")), 502)) as {
					error: string;
					name: string;
				};
				assert.equal(failed.name, "InferenceUpstreamError");
				assert.match(failed.error, /the model is overloaded/);

				// returnRawResponse never throws: the caller sees the provider status.
				const rawOk = await fetch(`${origin}/raw`, { body: "hey", method: "POST" });
				assert.equal(rawOk.headers.get("x-provider-status"), "200");
				assert.equal(((await rawOk.json()) as { response: string }).response, "echo: hey");
				const rawFailed = await fetch(`${origin}/raw`, { body: "provider-down", method: "POST" });
				assert.equal(rawFailed.status, 503);
				assert.match(await rawFailed.text(), /the model is overloaded/);

				const listed = (await json(await fetch(`${origin}/models?search=llama-3.1-8b`))) as {
					models: string[];
				};
				assert.ok(listed.models.includes("@cf/meta/llama-3.1-8b-instruct"));
			});

			// With the provider down, the Worker still answers with a clear 502.
			await new Promise<void>((resolveClose) => provider.close(() => resolveClose()));
			await withDev(projectDirectory, async ({ origin }) => {
				const down = (await json(
					await post(`${origin}/chat`, { messages: [{ content: "hi", role: "user" }] }),
					502,
				)) as { error: string };
				assert.match(down.error, /Could not reach the AI provider/);
			});
		} finally {
			provider.close();
		}
	},

	async "workflows"(projectDirectory) {
		await withDev(projectDirectory, async ({ origin }) => {
			const orders = `${origin}/orders`;
			type Status = { error?: { message: string; name: string }; output?: unknown; status: string };
			const waitFor = async (id: string, status: string): Promise<Status> => {
				let current: Status = { status: "unknown" };
				const deadline = Date.now() + 30_000;
				// The Workflow runs in the background; the caller can only see its
				// progress by reading the status again.
				while (Date.now() < deadline) {
					current = (await json(await fetch(`${orders}/${id}`))) as Status;
					if (current.status === status) return current;
					await delay(250);
				}
				assert.fail(`${id} never reached ${status}; last status ${JSON.stringify(current)}`);
			};

			// A flaky payment succeeds on its third attempt. The approval is sent
			// early and waits in the queue until the Workflow asks for it.
			assert.deepEqual(
				await json(await post(orders, { card: "flaky", id: "order-1", item: "book", quantity: 2 }), 201),
				{ ids: ["order-1"] },
			);
			// A batch: one order the manager rejects, and one nobody answers in time.
			assert.deepEqual(
				await json(
					await post(`${orders}/batch`, [
						{ id: "order-2", item: "lamp", quantity: 1 },
						{ approvalTimeout: "2 seconds", id: "order-3", item: "book", quantity: 1 },
					]),
					201,
				),
				{ ids: ["order-2", "order-3"] },
			);
			// Failures that a retry cannot fix.
			await json(await post(orders, { id: "order-4", item: "lamp", quantity: 5 }), 201);
			await json(await post(orders, { card: "declined", id: "order-5", item: "book", quantity: 1 }), 201);

			// A taken id and an invalid id reject the create.
			assert.deepEqual(await json(await post(orders, { id: "order-1", item: "book", quantity: 1 }), 409), {
				error: '(instance.already_exists) Workflow instance with id "order-1" already exists',
				name: "WorkflowError",
			});
			assert.equal((await post(orders, { id: "bad id!", item: "book", quantity: 1 })).status, 400);
			assert.equal((await post(orders, { item: "book" })).status, 400);
			// Without an id, the instance gets a random UUID.
			const { ids } = (await json(await post(orders, { item: "book", quantity: 1 }), 201)) as { ids: string[] };
			assert.match(ids[0] ?? "", /^[0-9a-f-]{36}$/);

			await json(await fetch(`${orders}/order-1/approve?by=ada`, { method: "POST" }), 202);
			await json(await fetch(`${orders}/order-2/reject?by=grace`, { method: "POST" }), 202);

			assert.deepEqual((await waitFor("order-1", "complete")).output, {
				approvedBy: "ada",
				charge: { attempts: 3, chargeId: "ch_order-1" },
				reservation: { item: "book", quantity: 2 },
				result: "shipped",
				tracking: "track_order-1",
			});
			assert.deepEqual((await waitFor("order-2", "complete")).output, {
				refund: "refunded ch_order-2",
				reservation: { item: "lamp", quantity: 1 },
				result: "rejected by grace",
			});
			assert.deepEqual((await waitFor("order-3", "complete")).output, {
				refund: "refunded ch_order-3",
				reservation: { item: "book", quantity: 1 },
				result: "cancelled: no decision in time",
			});
			assert.deepEqual((await waitFor("order-4", "errored")).error, {
				message: "Only 2 lamp in stock",
				name: "NonRetryableError",
			});
			assert.deepEqual((await waitFor("order-5", "errored")).error, {
				message: "Card declined",
				name: "NonRetryableError",
			});

			// Pausing a finished instance does nothing, and terminating it fails.
			assert.deepEqual(await json(await fetch(`${orders}/order-1/pause`, { method: "POST" })), {
				done: "pause",
			});
			assert.deepEqual(await json(await fetch(`${orders}/order-1/terminate`, { method: "POST" }), 409), {
				error: "(instance.cannot_terminate) Cannot terminate instance since its on a finite state",
				name: "WorkflowError",
			});
			assert.deepEqual(await json(await fetch(`${orders}/missing`), 404), { error: "No order missing" });
		});
	},
};

test(
	"runs every example and example fixture through orange dev",
	{ timeout: 300_000 },
	async (context) => {
		const directories = new Map<string, string>();
		for (const parent of exampleParents) {
			for (const entry of await readdir(parent, { withFileTypes: true })) {
				if (entry.isDirectory()) directories.set(entry.name, join(parent, entry.name));
			}
		}
		assert.deepEqual(
			[...directories.keys()].sort(),
			Object.keys(scenarios).sort(),
			"Every example must have exactly one scenario",
		);

		for (const [name, directory] of [...directories].sort(([a], [b]) => a.localeCompare(b))) {
			await context.test(name, async () => {
				const scenario = scenarios[name];
				assert.ok(scenario);
				// Run a copy so the example's local state never lands in the repository.
				const project = await copyProject(directory);
				try {
					await scenario(project.directory);
				} finally {
					await project.dispose();
				}
			});
		}
	},
);
