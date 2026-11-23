import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { probesDirectory, realProjectsDirectory } from "../commands/real-projects.js";
import { readCorpus } from "./corpus.js";
import { deriveStatus, type RealProjectResult } from "./result.js";

test("a project that could run its install scripts is refused", async () => {
	const directory = await mkdtemp(join(tmpdir(), "corpus-"));
	await mkdir(join(directory, "bad"));
	await writeFile(
		join(directory, "bad", "project.json"),
		JSON.stringify({
			id: "bad",
			repo: "a/b",
			commit: "0".repeat(40),
			stars: 1,
			origin: "search",
			directory: ".",
			configs: ["wrangler.jsonc"],
			installDirectory: ".",
			install: "npm install",
			durableObjects: { classes: ["A"], file: "a.ts", uses: ["storage"] },
			changes: [],
		}),
	);
	await assert.rejects(readCorpus(directory), /bad: install must pass --ignore-scripts/);
});

test("a project with no Durable Object class is refused unless it declares worker_loaders", async () => {
	const directory = await mkdtemp(join(tmpdir(), "corpus-"));
	const write = async (id: string, uses: string[]) => {
		await mkdir(join(directory, id));
		await writeFile(
			join(directory, id, "project.json"),
			JSON.stringify({
				id,
				repo: "a/b",
				commit: "0".repeat(40),
				stars: 1,
				origin: "search",
				directory: ".",
				configs: ["wrangler.jsonc"],
				installDirectory: ".",
				install: "npm install --ignore-scripts",
				durableObjects: { classes: [], file: "a.ts", uses },
				changes: [],
			}),
		);
	};
	await write("loader", ["worker_loaders"]);
	assert.deepEqual((await readCorpus(directory)).map((project) => project.id), ["loader"]);
	await write("plain", ["kv"]);
	await assert.rejects(readCorpus(directory), /plain: durableObjects must name its classes/);
});

test("the corpus and probes load, and each one can run or says why not", async () => {
	for (const root of [realProjectsDirectory, probesDirectory]) {
		for (const project of await readCorpus(root)) {
			assert.ok(
				project.notRun !== undefined || existsSync(join(root, project.id, "scenario.ts")),
				`${project.id} has no scenario and no notRun reason`,
			);
			const patched = existsSync(join(root, project.id, "changes.patch"));
			assert.equal(patched, project.changes.length > 0, `${project.id}: changes and changes.patch must agree`);
		}
	}
});

test("every saved status is what its recorded phases and steps give", () => {
	for (const root of [realProjectsDirectory, probesDirectory]) {
		for (const entry of readdirSync(root, { withFileTypes: true })) {
			const path = join(root, entry.name, "result.json");
			if (!entry.isDirectory() || !existsSync(path)) continue;
			const result = JSON.parse(readFileSync(path, "utf8")) as RealProjectResult;
			if (result.notRun !== undefined) {
				assert.equal(result.status, "not-run", entry.name);
				continue;
			}
			assert.equal(result.status, deriveStatus([result.install, result.build, result.boot], result.steps), entry.name);
		}
	}
});

test("a run with one failed step and one passed step is partial, never works", () => {
	const passed = { name: "a", kind: "do-state", status: "pass", seconds: 0 } as const;
	const failed = { name: "b", kind: "do-state", status: "fail", seconds: 0, error: "x" } as const;
	const secret = { name: "c", kind: "binding", status: "needs-secrets", seconds: 0 } as const;
	assert.equal(deriveStatus([], [passed, failed]), "partial");
	assert.equal(deriveStatus([], [passed]), "works");
	assert.equal(deriveStatus([], [passed, secret]), "needs-secrets");
	assert.equal(deriveStatus([{ ok: false, seconds: 0, error: "boot" }], [passed]), "fails");
	// A boot alone proves nothing about Durable Objects.
	assert.equal(deriveStatus([], [{ ...passed, kind: "http" }]), "not-run");
	// A dynamic Worker that ran is proof too.
	assert.equal(deriveStatus([], [{ ...passed, kind: "http" }, { ...passed, kind: "worker-loader" }]), "works");
});
