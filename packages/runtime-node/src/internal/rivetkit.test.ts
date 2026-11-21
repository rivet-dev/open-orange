import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import test from "node:test";

import {
	createRivetActorClient,
	type RivetSqliteDatabase,
	type RivetSqliteExecuteResult,
	retryingSqliteDatabase,
	sleepActorsOfExitedHosts,
	SqliteBusyTimeoutError,
} from "./rivetkit.js";

test("creates stateless get-or-create handles with the pinned RivetKit client", async () => {
	const client = createRivetActorClient({
		endpoint: "http://127.0.0.1:1",
		namespace: "default",
	});
	const handle = client.getOrCreate("openorange_fixture", [
		"deployment",
		"Counter",
		"",
		"canonical-id",
	]);

	assert.equal(typeof handle, "object");
	await client.dispose();
});

// An HTTP server that answers as the Engine's actor API: one page of stale actors, then `sleep`.
async function withStaleActors(
	count: number,
	sleep: (request: IncomingMessage, response: ServerResponse) => void,
	run: (recover: () => Promise<void>) => Promise<void>,
): Promise<void> {
	const actors = Array.from({ length: count }, (_, index) => ({
		actor_id: `actor-${index}`,
		connectable_ts: 20,
		pool: "owned",
	}));
	const server = createServer((request, response) => {
		response.setHeader("content-type", "application/json");
		if (request.method === "GET") {
			response.end(JSON.stringify({ actors, pagination: {} }));
			return;
		}
		request.resume();
		sleep(request, response);
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	assert.ok(address !== null && typeof address === "object");
	try {
		await run(() =>
			sleepActorsOfExitedHosts({
				actorNames: ["fixtureActor"],
				endpoint: `http://127.0.0.1:${address.port}`,
				namespace: "fixture",
				poolName: "owned",
				startedAt: 100,
			}),
		);
	} finally {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
}

test("the Engine gets at most 4 sleep calls at once when a restart finds many stale actors", async () => {
	let active = 0;
	let peak = 0;
	const slept = new Set<string>();
	await withStaleActors(
		300,
		(request, response) => {
			active++;
			peak = Math.max(peak, active);
			slept.add(new URL(request.url ?? "", "http://fixture").pathname);
			setTimeout(() => {
				active--;
				response.end("{}");
			}, 10);
		},
		async (recover) => {
			await recover();
			assert.equal(slept.size, 300, "every stale actor is put to sleep once");
			assert.ok(peak <= 4, `the Engine saw ${peak} sleep calls at once`);
			assert.equal(active, 0);
		},
	);
});

test("a failed sleep call stops new calls and waits for the calls already sent", async () => {
	const fourSent = Promise.withResolvers<void>();
	const fail = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	let sent = 0;
	let active = 0;
	await withStaleActors(
		12,
		(_request, response) => {
			const index = sent++;
			active++;
			if (sent === 4) fourSent.resolve();
			void (index === 0 ? fail.promise : release.promise).then(() => {
				active--;
				response.statusCode = index === 0 ? 503 : 200;
				response.end("{}");
			});
		},
		async (recover) => {
			let settled = false;
			const outcome = recover().then(
				() => undefined,
				(error: unknown) => error,
			);
			void outcome.then(() => {
				settled = true;
			});
			try {
				await fourSent.promise;
				fail.resolve();
				await new Promise((resolve) => setTimeout(resolve, 30));
				assert.equal(settled, false, "recovery waits for the calls that the Engine still holds");
				assert.equal(sent, 4, "no call starts after the failure");
				release.resolve();
				assert.match(String(await outcome), /status 503/);
				assert.equal(active, 0);
			} finally {
				fail.resolve();
				release.resolve();
				await outcome;
			}
		},
	);
});

function fakeSqliteDatabase(executeSync: () => RivetSqliteExecuteResult): RivetSqliteDatabase {
	const fail = (): never => {
		throw new Error("not used");
	};
	return {
		beginTransactionSync: fail,
		commitTicket: () => 0,
		execSync: fail,
		executeSync,
		whenDurable: async () => {},
	};
}

const writerBusy = (): Error => Object.assign(new Error("SQLite writer is busy."), { code: "writer_busy", group: "sqlite" });

test("a SQLite call that finds the writer busy returns its result once the writer is free", () => {
	let calls = 0;
	const database = retryingSqliteDatabase(
		fakeSqliteDatabase(() => {
			calls += 1;
			if (calls <= 2) throw writerBusy();
			return { changes: 0, columns: ["x"], rows: [[1]] };
		}),
		1_000,
	);
	assert.deepEqual(database.executeSync("SELECT 1").rows, [[1]]);
});

test("a SQLite writer busy past the limit fails with an error that names the setting", () => {
	const database = retryingSqliteDatabase(
		fakeSqliteDatabase(() => {
			throw writerBusy();
		}),
		30,
	);
	assert.throws(() => database.executeSync("SELECT 1"), (error: unknown) => {
		assert.ok(error instanceof SqliteBusyTimeoutError);
		assert.match(error.message, /stayed busy for 30 ms, the limit\. Set ORANGE_SQLITE_BUSY_TIMEOUT_MS to raise it\./);
		return true;
	});
});
