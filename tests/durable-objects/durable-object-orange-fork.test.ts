import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import {
	copyProject,
	type RunningOrangeDev,
	startOrangeDev,
	type TemporaryProject,
} from "../harness/orange-dev.js";

const fixtureDirectory = fileURLToPath(
	new URL("../fixtures/durable-object-orange-fork/", import.meta.url),
);

interface ReadResult {
	chain: { id: string; name: string | null }[];
	entries: string[];
	fork: { forkedAt: string; from: string; fromName: string | null; input: unknown } | null;
	id: string;
	name: string | null;
}

// `orange.fork()` is an OpenOrange extension, so there is no workerd answer to compare with.
describe("env.MY_DO.orange.fork()", { timeout: 240_000 }, () => {
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

	async function call<Result>(path: string, params: Record<string, string> = {}): Promise<Result> {
		if (orange === undefined) throw new Error("orange dev did not start");
		const url = new URL(path, orange.origin);
		for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
		const response = await fetch(url);
		const body = await response.text();
		assert.equal(response.status, 200, `${path}: ${body}\n${orange.output()}`);
		return JSON.parse(body) as Result;
	}

	test("the copy starts with the source's storage and then runs on its own", async () => {
		await call("/append", { name: "doc", entry: "one" });
		const source = await call<ReadResult>("/append", { name: "doc", entry: "two" });
		const copy = await call<ReadResult>("/fork", { name: "doc", to: "doc-copy", input: "hello" });
		assert.deepEqual(copy.entries, ["one", "two"]);
		assert.equal(copy.name, "doc-copy");
		assert.notEqual(copy.id, source.id);
		assert.deepEqual(copy.chain, [{ id: source.id, name: "doc" }]);
		assert.deepEqual(copy.fork, { forkedAt: "number", from: source.id, fromName: "doc", input: { note: "hello" } });
		assert.deepEqual(source.chain, []);

		const copyAfter = await call<ReadResult>("/append", { name: "doc-copy", entry: "copy-only" });
		const sourceAfter = await call<ReadResult>("/append", { name: "doc", entry: "source-only" });
		assert.deepEqual(copyAfter.entries, ["one", "two", "copy-only"]);
		assert.deepEqual(sourceAfter.entries, ["one", "two", "source-only"]);
		assert.equal(sourceAfter.fork, null);
	});

	test("a fork of a fork lists both forks, oldest first, and the hook runs only once", async () => {
		const source = await call<ReadResult>("/read", { name: "doc" });
		const first = await call<ReadResult>("/read", { name: "doc-copy" });
		const second = await call<ReadResult>("/fork", { name: "doc-copy", to: "doc-copy-2" });
		assert.deepEqual(second.chain, [
			{ id: source.id, name: "doc" },
			{ id: first.id, name: "doc-copy" },
		]);
		assert.deepEqual(second.fork?.input, null);
		assert.equal(second.fork?.fromName, "doc-copy");
		// A later call finds the same hook result: it ran once, at the copy's first start.
		assert.deepEqual((await call<ReadResult>("/read", { name: "doc-copy-2" })).fork, second.fork);
	});

	test("without a name, the copy gets a new unique ID", async () => {
		const result = await call<{ named: string | null; read: ReadResult }>("/fork-unique", { name: "doc" });
		assert.equal(result.named, null);
		assert.equal(result.read.name, null);
		assert.match(result.read.id, /^[0-9a-f]{64}$/);
		assert.deepEqual(result.read.entries.slice(0, 2), ["one", "two"]);
	});

	test("an object that forks itself forks the writes of its current turn", async () => {
		await call("/append", { name: "self", entry: "before" });
		const result = await call<{ copy: ReadResult; sameAsName: boolean }>("/self-fork", {
			name: "self",
			to: "self-copy",
			entry: "same-turn",
		});
		assert.equal(result.sameAsName, true);
		assert.deepEqual(result.copy.entries, ["before", "same-turn"]);
		assert.deepEqual(result.copy.fork?.input, { self: true });
	});

	test("the source keeps its alarm and the copy has none", async () => {
		await call("/append", { name: "alarmed", entry: "x" });
		assert.deepEqual(await call("/alarm", { name: "alarmed", to: "alarmed-copy" }), { copy: null, source: true });
	});

	test("the source's facets are copied as they were at the fork, and the copies are independent", async () => {
		await call("/append", { name: "parent", entry: "x" });
		assert.deepEqual(await call("/facets", { name: "parent", to: "parent-copy" }), {
			copied: "from-source",
			copyAfterWrite: "from-copy",
			facetHasOrange: false,
			source: "after-fork",
		});
	});

	test("a taken name and a source that never ran fail with OrangeForkError codes", async () => {
		assert.deepEqual(await call("/fork-error", { name: "doc", to: "doc-copy" }), {
			code: "duplicate_key",
			message: "An object with the copy's ID already exists.",
			name: "OrangeForkError",
		});
		const missing = await call<{ code: string; name: string }>("/fork-error", { name: "never-ran", to: "never-copy" });
		assert.equal(missing.name, "OrangeForkError");
		assert.equal(missing.code, "not_found");
	});

	test("orange is not an enumerable key of the namespace", async () => {
		const shape = await call<{ hasOrange: boolean; keys: string[] }>("/shape");
		assert.equal(shape.hasOrange, true);
		assert.equal(shape.keys.includes("orange"), false);
	});

	test("copies survive a restart", async () => {
		await orange?.close();
		if (project === undefined) throw new Error("no project");
		orange = await startOrangeDev(project.directory);
		const copy = await call<ReadResult>("/read", { name: "doc-copy" });
		assert.deepEqual(copy.entries, ["one", "two", "copy-only"]);
		assert.equal(copy.name, "doc-copy");
		assert.equal(copy.chain.length, 1);
	});
});
