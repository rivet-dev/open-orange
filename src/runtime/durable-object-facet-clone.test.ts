import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import {
	copyProject,
	type RunningOrangeDev,
	startOrangeDev,
	type TemporaryProject,
} from "../../tests/orange-dev.js";

const fixtureDirectory = fileURLToPath(
	new URL("./fixtures/durable-object-facet-clone/", import.meta.url),
);

// Expected bodies are workerd 1.20260903.1's answers to the same fixture, except where a test says
// Orange differs.
describe("ctx.facets.clone()", { timeout: 240_000 }, () => {
	let project: TemporaryProject;
	let orange: RunningOrangeDev | undefined;

	before(async () => {
		project = await copyProject(fixtureDirectory);
		orange = await startOrangeDev(project.directory);
	});

	after(async () => {
		await orange?.close();
		await project.dispose();
	});

	async function call(path: string, parent: string): Promise<string> {
		if (orange === undefined) throw new Error("orange dev did not start");
		const url = new URL(path, orange.origin);
		url.searchParams.set("parent", parent);
		const response = await fetch(url);
		const body = await response.text();
		assert.equal(response.status, 200, `${path}: ${body}\n${orange.output()}`);
		return body;
	}

	test("copies a facet with its children, replaces dst, and the copy survives a restart (workerd's facet cloning test)", async () => {
		assert.equal(await call("/setup", "cloning"), "ok");
		assert.equal(await call("/clone-basic", "cloning"), "dst=10 dst.a=100 dst.b=200");
		assert.equal(await call("/verify-src-unchanged", "cloning"), "src=10 src.a=100 src.b=200");
		assert.equal(await call("/mutate-dst-then-check-src", "cloning"), "src=10 src.a=100");
		assert.equal(await call("/verify-src-unchanged", "cloning"), "src=10 src.a=100 src.b=200");
		assert.equal(
			await call("/clone-replaces-existing", "cloning"),
			"target=10 target.a=100 oldChild=null",
		);
		assert.equal(await call("/clone-from-nonexistent-deletes-dst", "cloning"), "val=null c=null");
		assert.equal(
			await call("/clone-self-aborts-but-preserves", "cloning"),
			"beforeMem=alive oldThrew=true val=7 mem=null",
		);
		await orange?.close();
		orange = await startOrangeDev(project.directory);
		assert.equal(await call("/read-restored", "cloning"), "dst=999 dst.a=888 dst.b=200");
	});

	test("facet names longer than workerd's 256 characters work, and their copies keep their state", async () => {
		assert.equal(await call("/names", "names"), "clone-256=ok copy256=256 copy2000=2000");
	});

	test("writes to src after clone() never reach dst, even from a call started before clone() in the same turn", async () => {
		assert.equal(await call("/snapshot-point", "snapshot"), "d=1 s=2");
		assert.equal(await call("/call-before-clone", "call-before"), "d=1 s=2");
	});

	test("dst's in-flight and old calls fail with workerd's error, and a stub first used after clone() reaches the copy", async () => {
		assert.deepEqual(JSON.parse(await call("/dst-stubs", "dst-stubs")), {
			inflight: { err: "Error: Facet was cloned-over." },
			old: { err: "Error: Facet was cloned-over." },
			stubFirstUsedAfterClone: { ok: 1 },
		});
	});

	test("a dst inside storage.transaction() fails that transaction with workerd's error, and then holds the copy", async () => {
		assert.equal(
			await call("/dst-in-transaction", "dst-in-transaction"),
			'write={"err":"Error: Facet was cloned-over."} d=1',
		);
	});

	test("overlapping and chained clones of one src each copy it as of their clone() call, while dst reads run during the copy", async () => {
		assert.equal(
			await call("/overlap", "overlap"),
			"d1=1 d1.a=11 d2=1 d2.a=11 d3=1 d3.a=11 s=2",
		);
	});

	test("ctx.abort() right after clone() keeps the copy", async () => {
		if (orange === undefined) throw new Error("orange dev did not start");
		const aborted = await fetch(new URL("/abort-after-clone?parent=abort", orange.origin));
		assert.equal(aborted.status, 500);
		await aborted.body?.cancel();
		assert.equal(await call("/read-d", "abort"), "d=41");
	});

	test("copies grandchildren, and dst constructs its own class over the copy", async () => {
		assert.equal(
			await call("/tree", "tree"),
			"d=3 d.a=33 d.n.g=7 seenAtConstruction=3",
		);
	});

	test("a copy of a src that writes on its own timer is never torn, and a src inside storage.transaction() is copied after it commits", async () => {
		assert.equal(await call("/mid-write", "mid-write"), "torn=false copied=true");
		// Workerd copies the files before the open transaction commits and answers d=1. Orange
		// shares one SQLite connection with the open transaction, so it copies after the commit.
		assert.equal(await call("/in-transaction", "in-transaction"), "d=2 s=2");
	});

	test("copying a sleeping src runs none of its code, so a src whose constructor throws still copies", async () => {
		assert.equal(await call("/flag-src", "asleep"), "ok");
		// Facets sleep after ten idle seconds.
		await delay(11_000);
		assert.equal(await call("/clone-flagged", "asleep"), "d=5");
	});

	test("copies SQL exactly: rowids, AUTOINCREMENT, generated columns, triggers, views, FTS5, and value types", async () => {
		const { after: copied, before: original } = JSON.parse(await call("/sql", "sql"));
		assert.deepEqual(copied, original);
		assert.deepEqual(original.types, [
			{ q: "2.0", t: "real" },
			{ q: "9007199254740993", t: "integer" },
			{ q: "X''", t: "blob" },
			{ q: "X'00FF'", t: "blob" },
			{ q: "''", t: "text" },
			{ q: "NULL", t: "null" },
		]);
	});

	async function waitForParent(parent: string): Promise<void> {
		if (orange === undefined) throw new Error("orange dev did not start");
		// Rivet moves the crashed runtime's actors only after its lost timeout, and nothing signals
		// that, so wait until the parent answers a call that touches no facet.
		const deadline = Date.now() + 120_000;
		for (;;) {
			const ping = await fetch(new URL(`/ping?parent=${parent}`, orange.origin));
			const body = await ping.text();
			if (ping.status === 200 && body === "pong") return;
			if (Date.now() > deadline) assert.fail(`the parent did not restart: ${body}\n${orange.output()}`);
		}
	}

	test("a crash while the copy runs: after a restart, dst holds the whole copy once, and later writes to dst stay", { timeout: 240_000 }, async () => {
		assert.equal(await call("/fill", "crash"), "ok");
		// clone() returns before the copy ends, and the crash stops it.
		assert.equal(await call("/clone-and-return", "crash"), "cloned");
		await orange?.kill();
		orange = await startOrangeDev(project.directory);
		await waitForParent("crash");
		assert.deepEqual(JSON.parse(await call("/read-blobs", "crash")), {
			bytes: 41_943_040,
			c: 5,
			rows: 160,
		});
		// A clone that ran again after the restart never copies over writes made after it.
		assert.equal(await call("/write-d?value=6", "crash"), "ok");
		await orange?.close();
		orange = await startOrangeDev(project.directory);
		assert.deepEqual(JSON.parse(await call("/read-blobs", "crash")), {
			bytes: 41_943_040,
			c: 6,
			rows: 160,
		});
	});

	test("a clone of a copy that the engine forked too many times copies rows instead, and says so", async () => {
		// Rivet refuses a fork of an actor that is already 16 forks deep.
		assert.equal(await call("/chain?length=18", "chain"), "v=1 k=2");
		assert.match(orange?.output() ?? "", /facet clone copies rows instead of forking: actor\.fork_too_deep/);
	});

	test("eight parents that clone trees at once all get whole copies", async () => {
		const copies = await Promise.all(
			Array.from({ length: 8 }, (_, index) => call("/wide", `wide-${index}`)),
		);
		assert.deepEqual(copies, Array.from({ length: 8 }, () => "d=10485760 children=1,2,3,4"));
	});

	test("a 100 MB clone finishes, and other Durable Objects keep answering while it runs", { timeout: 240_000 }, async () => {
		if (orange === undefined) throw new Error("orange dev did not start");
		for (let filled = 0; filled < 100; filled += 25) {
			assert.equal(await call("/big-fill?mb=25", "big"), "ok");
		}
		let cloning = true;
		let slowest = 0;
		const pings = (async () => {
			while (cloning) {
				const started = performance.now();
				assert.equal(await call("/ping", "bystander"), "pong");
				slowest = Math.max(slowest, performance.now() - started);
				await delay(10);
			}
		})();
		const started = performance.now();
		const copied = JSON.parse(await call("/big-clone", "big"));
		const elapsed = performance.now() - started;
		cloning = false;
		await pings;
		assert.deepEqual({ bytes: copied.bytes, rows: copied.rows }, { bytes: 104_857_600, rows: 400 });
		// A fork takes well under a second here. The bounds catch a hang, not a slow machine.
		assert.ok(elapsed < 30_000, `the clone took ${Math.round(elapsed)} ms`);
		assert.ok(slowest < 10_000, `another Durable Object waited ${Math.round(slowest)} ms`);
	});

	test("clone() at the maximum facet depth does nothing", async () => {
		// Workerd 1.20260903.1 fails here with an internal error.
		assert.equal(await call("/depth", "depth"), "clone=ok");
	});
});

// Each test starts its own `orange dev`, so a crash or a fault reaches no other test.
describe("ctx.facets.clone() recovery", { timeout: 600_000 }, () => {
	let project: TemporaryProject;
	let orange: RunningOrangeDev | undefined;

	before(async () => {
		project = await copyProject(fixtureDirectory);
	});

	after(async () => {
		await orange?.close();
		await project.dispose();
	});

	async function restart(environment: NodeJS.ProcessEnv = {}, crash = false): Promise<void> {
		if (crash) await orange?.kill();
		else await orange?.close();
		orange = await startOrangeDev(project.directory, undefined, { environment });
	}

	async function fetchPath(path: string, parent: string): Promise<Response> {
		if (orange === undefined) throw new Error("orange dev did not start");
		const url = new URL(path, orange.origin);
		url.searchParams.set("parent", parent);
		return await fetch(url);
	}

	async function call(path: string, parent: string): Promise<string> {
		const response = await fetchPath(path, parent);
		const body = await response.text();
		assert.equal(response.status, 200, `${path}: ${body}\n${orange?.output()}`);
		return body;
	}

	async function waitForParent(parent: string): Promise<void> {
		// Rivet moves the crashed runtime's actors only after its lost timeout.
		const deadline = Date.now() + 120_000;
		for (;;) {
			const ping = await fetchPath("/ping", parent);
			const body = await ping.text();
			if (ping.status === 200 && body === "pong") return;
			if (Date.now() > deadline) assert.fail(`the parent did not restart: ${body}\n${orange?.output()}`);
		}
	}

	test("a fork that the engine made while its caller saw an error still copies the children", async () => {
		await restart({ ORANGE_TEST_FACET_FORK_FAULT: "reply-lost" });
		assert.equal(await call("/setup", "reply-lost"), "ok");
		assert.equal(await call("/clone-basic", "reply-lost"), "dst=10 dst.a=100 dst.b=200");
	});

	test("a child that src registers while the fork waits is copied with the snapshot that names it", async () => {
		// Each fork waits 500 ms first, while src keeps registering children.
		await restart({ ORANGE_TEST_FACET_FORK_FAULT: "slow" });
		assert.deepEqual(JSON.parse(await call("/spawn-during-clone", "spawn")), { copied: true, missing: [] });
	});

	test("a clone whose dst an earlier row copy created before a crash finishes after a restart", async () => {
		await restart({ ORANGE_FACET_CLONE: "copy" });
		assert.equal(await call("/fill", "copy-crash"), "ok");
		assert.equal(await call("/clone-and-return", "copy-crash"), "cloned");
		// The row copy of 40 MB takes seconds, so the crash stops it after it created dst.
		await delay(300);
		await restart({}, true);
		await waitForParent("copy-crash");
		assert.deepEqual(JSON.parse(await call("/read-blobs", "copy-crash")), {
			bytes: 41_943_040,
			c: 5,
			rows: 160,
		});
	});

	test("a crash after ctx.abort() discarded clone()'s record leaves no copy that a later delete() and get() reach", async () => {
		await restart();
		const aborted = await fetchPath("/abort-after-clone", "abort-crash");
		assert.equal(aborted.status, 500);
		await aborted.body?.cancel();
		// Time for a copy in the background to finish, if one ran.
		await delay(2_000);
		await restart({}, true);
		await waitForParent("abort-crash");
		assert.equal(await call("/delete-then-read-d", "abort-crash"), "d=null");
	});
});
