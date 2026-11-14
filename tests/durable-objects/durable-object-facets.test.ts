import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { stopProjectEngines } from "../harness/orange-dev.js";

const cliEntrypoint = fileURLToPath(new URL("../../src/bin.ts", import.meta.url));
const fixtureDirectory = fileURLToPath(
	new URL("../fixtures/durable-object-facets/", import.meta.url),
);

// The agents SDK names facets `${className}\0${name}`, so the name must round-trip a NUL.
const facetName = "Counter\0chat";

function storedCount(result: unknown): unknown {
	return typeof result === "object" && result !== null
		? Reflect.get(result, "stored")
		: undefined;
}

// The local Rivet Engine outlives `orange dev`, so stop it by the PID it recorded.
async function startOrangeDev(
	projectDirectory: string,
): Promise<{ child: ChildProcess; origin: string }> {
	const child = spawn(
		process.execPath,
		[
			"--import",
			"tsx",
			cliEntrypoint,
			"dev",
			"--config",
			join(projectDirectory, "wrangler.jsonc"),
			"--port",
			"0",
			"--ip",
			"127.0.0.1",
			"--show-interactive-dev-session=false",
		],
		{
			env: { ...process.env, CI: "1", NO_COLOR: "1" },
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	let output = "";
	const ready = Promise.withResolvers<number>();
	const timeout = setTimeout(() => {
		ready.reject(new Error(`orange dev readiness timed out:\n${output}`));
	}, 30_000);
	const collect = (chunk: unknown): void => {
		output += String(chunk);
		const match = /Local\s+http:\/\/127\.0\.0\.1:(\d+)/.exec(output);
		if (match?.[1] !== undefined) ready.resolve(Number(match[1]));
	};
	child.stdout?.on("data", collect);
	child.stderr?.on("data", collect);
	child.once("exit", (code) => {
		ready.reject(new Error(`orange dev exited (code ${code}):\n${output}`));
	});
	try {
		const port = await ready.promise;
		return { child, origin: `http://127.0.0.1:${port}` };
	} catch (error: unknown) {
		child.kill("SIGKILL");
		throw error;
	} finally {
		clearTimeout(timeout);
	}
}

function stopOrangeDev(child: ChildProcess): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
	return new Promise((resolveStop) => {
		const timeout = setTimeout(() => child.kill("SIGKILL"), 10_000);
		child.once("exit", () => {
			clearTimeout(timeout);
			resolveStop();
		});
		child.kill("SIGINT");
	});
}

describe("Durable Object facets", () => {
	let directory: string;
	let projectDirectory: string;
	let orange: { child: ChildProcess; origin: string } | undefined;

	before(async () => {
		directory = await mkdtemp(join(tmpdir(), "open-orange-facets-"));
		projectDirectory = join(directory, "project");
		await cp(fixtureDirectory, projectDirectory, { recursive: true });
		orange = await startOrangeDev(projectDirectory);
	});

	after(async () => {
		if (orange !== undefined) await stopOrangeDev(orange.child);
		await stopProjectEngines(projectDirectory);
		await rm(directory, { force: true, recursive: true });
	});

	async function call(
		path: string,
		parent: string,
		query: Record<string, string> = {},
	): Promise<unknown> {
		if (orange === undefined) throw new Error("orange dev did not start");
		const url = new URL(path, orange.origin);
		url.searchParams.set("parent", parent);
		url.searchParams.set("facet", facetName);
		for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
		const response = await fetch(url);
		const body = await response.text();
		assert.equal(response.status, 200, body);
		return JSON.parse(body);
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
