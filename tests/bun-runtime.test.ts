import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import test, { after, before } from "node:test";

import { buildPackage } from "../src/build/build-package.js";
import { copyProject, type OrangeCli, repositoryRoot, startOrangeDev, waitFor } from "./orange-dev.js";

const fixture = join(repositoryRoot, "tests", "fixtures", "bun-runtime");

function installedBun(): string | undefined {
	try {
		execFileSync("bun", ["--version"], { stdio: "ignore" });
		return "bun";
	} catch {
		return undefined;
	}
}

const bun = installedBun();
const skip = bun === undefined ? "Bun is not installed" : false;
let cli: OrangeCli;
let packageDirectory: string;
let home: string;

before(async () => {
	if (bun === undefined) return;
	// The packaged CLI resolves rivetkit and its other dependencies from the repository.
	packageDirectory = await mkdtemp(join(repositoryRoot, "node_modules", ".open-orange-bun-"));
	await buildPackage(packageDirectory);
	cli = { entrypoint: join(packageDirectory, "bin.js"), runtime: bun };
	home = await mkdtemp(join(repositoryRoot, "node_modules", ".open-orange-bun-home-"));
});

after(async () => {
	if (packageDirectory !== undefined) await rm(packageDirectory, { force: true, recursive: true });
	if (home !== undefined) await rm(home, { force: true, recursive: true });
});

async function json(response: Response): Promise<unknown> {
	assert.equal(response.status, 200, await response.clone().text());
	return response.json();
}

test("orange dev on Bun serves Durable Objects, KV, and Workflows", { skip }, async () => {
	const project = await copyProject(fixture);
	try {
		const dev = await startOrangeDev(project.directory, "wrangler.jsonc", { cli, environment: { HOME: home } });
		try {
			assert.equal(await json(await fetch(`${dev.origin}/counter`)), 1, dev.output());
			assert.equal(await json(await fetch(`${dev.origin}/counter`)), 2, dev.output());
			assert.equal(await json(await fetch(`${dev.origin}/kv?value=stored`)), "stored", dev.output());
			const id = await json(await fetch(`${dev.origin}/workflow`));
			assert.equal(typeof id, "string", dev.output());
			let status: unknown;
			// A Workflow binding reports completion only through status(), so the test polls it.
			await waitFor("the Workflow to complete", async () => {
				status = await json(await fetch(`${dev.origin}/workflow-status?id=${String(id)}`));
				return typeof status === "object" && status !== null && Reflect.get(status, "status") === "complete";
			});
			assert.deepEqual(status, { output: "echo hello", status: "complete" }, dev.output());
		} finally {
			await dev.close();
		}
	} finally {
		await project.dispose();
	}
});

test("orange dev on Bun keeps each project's data in that project", { skip }, async () => {
	const first = await copyProject(fixture);
	const second = await copyProject(fixture);
	try {
		const firstDev = await startOrangeDev(first.directory, "wrangler.jsonc", { cli, environment: { HOME: home } });
		try {
			assert.equal(await json(await fetch(`${firstDev.origin}/kv?value=first`)), "first", firstDev.output());
		} finally {
			await firstDev.close();
		}
		const secondDev = await startOrangeDev(second.directory, "wrangler.jsonc", { cli, environment: { HOME: home } });
		try {
			assert.equal(await json(await fetch(`${secondDev.origin}/kv`)), null, secondDev.output());
		} finally {
			await secondDev.close();
		}
	} finally {
		await first.dispose();
		await second.dispose();
	}
});
