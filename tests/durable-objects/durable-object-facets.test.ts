import assert from "node:assert/strict";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import {
	copyProject,
	repositoryRoot,
	startOrangeDev,
	type RunningOrangeDev,
	type TemporaryProject,
} from "../harness/orange-dev.js";

// The agents SDK names facets `${className}\0${name}`, so the name must round-trip a NUL.
const facetName = "Counter\0chat";

function storedCount(result: unknown): unknown {
	return typeof result === "object" && result !== null
		? Reflect.get(result, "stored")
		: undefined;
}

describe("Durable Object facets", () => {
	let project: TemporaryProject | undefined;
	let orange: RunningOrangeDev | undefined;

	before(async () => {
		project = await copyProject(join(repositoryRoot, "tests", "fixtures", "durable-object-facets"));
		orange = await startOrangeDev(project.directory);
	});

	after(async () => {
		try {
			await orange?.close();
		} finally {
			await project?.dispose();
		}
	});

	async function call(
		path: string,
		parent: string,
		query: Record<string, string> = {},
	): Promise<unknown> {
		if (orange === undefined) throw new Error("orange dev did not start");
		const search = new URLSearchParams({ parent, facet: facetName, ...query });
		return orange.json(`${path}?${search}`);
	}

	test("two parents that call the same facet name concurrently each see only their own storage", async () => {
		await Promise.all([
			call("/increment", "isolation-a"),
			call("/increment", "isolation-b"),
			call("/increment", "isolation-a"),
			call("/increment", "isolation-b"),
			call("/increment", "isolation-a"),
		]);
		assert.equal(storedCount(await call("/increment", "isolation-a")), 4);
		assert.equal(storedCount(await call("/increment", "isolation-b")), 3);
	});

	test("delete() rejects the in-flight call, and the next get() starts with empty storage", async () => {
		await call("/increment", "delete");
		assert.deepEqual(await call("/delete", "delete"), {
			after: { memory: 1, stored: 1 },
			before: { memory: 2, stored: 2 },
			inFlightError: "Facet was deleted.",
		});
		// The new facet keeps its own storage after the delete.
		assert.equal(storedCount(await call("/increment", "delete")), 2);
	});

	test("get() with a new class after abort() runs the new class on the facet's stored data", async () => {
		assert.deepEqual(await call("/swap", "swap"), {
			after: { stored: 1, version: "v2" },
			before: { memory: 1, stored: 1 },
			whileRunning: "v1",
		});
	});

	test("a facet that changes class after abort() keeps its children's storage", async () => {
		assert.deepEqual(await call("/swap-children", "swap-children"), { child: "kept" });
	});

	test("abort() rejects in-flight and later calls on old stubs with the reason, and a new get() keeps storage with fresh memory", async () => {
		assert.deepEqual(await call("/abort", "abort", { reason: "boom" }), {
			after: { memory: 1, stored: 2 },
			before: { memory: 1, stored: 1 },
			inFlightError: "boom",
			oldStubError: "boom",
		});
	});
});
