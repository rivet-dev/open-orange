import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { copyProject, repositoryRoot, startOrangeDev } from "../harness/orange-dev.js";

const fixture = join(repositoryRoot, "tests", "fixtures", "worker-tmp");

// Expected values follow workerd 1.20260903.1: each request and each Durable Object has its own
// /tmp, which is gone when it ends. Outside every event /tmp is writable, as in Node.js, where
// workerd makes it read-only, and files have no workerd size limit.
test("each request, Worker, and Durable Object gets a private /tmp, as in workerd", { timeout: 180_000 }, async (t) => {
	const project = await copyProject(fixture);
	try {
		const dev = await startOrangeDev(project.directory, ["wrangler.jsonc", "other/wrangler.jsonc"]);
		const get = async (path: string): Promise<unknown> => {
			const response = await fetch(new URL(path, dev.origin));
			assert.equal(response.status, 200, `${await response.clone().text()}\n${dev.output()}`);
			return response.headers.get("content-type")?.includes("json") === true
				? await response.json()
				: await response.text();
		};
		try {
			await t.test("module evaluation writes a /tmp that requests do not see, as in Node.js", async () => {
				assert.deepEqual(await get("/global"), {
					entries: [],
					write: "no error",
					readBack: "global",
				});
				assert.deepEqual(await get("/list"), []);
			});

			await t.test("a /tmp write never reaches the host /tmp", async () => {
				const name = `oo-worker-tmp-${randomUUID()}`;
				assert.deepEqual(await get(`/write?name=${name}`), [name]);
				assert.equal(existsSync(join("/tmp", name)), false);
				assert.equal(existsSync(join(tmpdir(), name)), false);
			});

			await t.test("overlapping requests do not see each other's /tmp, and a later request starts empty", async () => {
				const first = get("/write?name=first.txt&wait=second-done");
				assert.equal(await get("/wait?name=first.txt"), "ready");
				// The first request is still running with first.txt in its /tmp.
				assert.deepEqual(await get("/write?name=second.txt"), ["second.txt"]);
				assert.equal(await get("/open?name=second-done"), "opened");
				assert.deepEqual(await first, ["first.txt"]);
				assert.deepEqual(await get("/list"), []);
			});

			await t.test("two Workers do not see each other's /tmp", async () => {
				assert.deepEqual(await get("/other"), { main: ["main.txt"], other: [] });
			});

			await t.test("a Durable Object keeps one /tmp across its requests, apart from the Worker's", async () => {
				assert.deepEqual(await get("/object?name=one.txt"), ["one.txt"]);
				assert.deepEqual(await get("/object?name=two.txt"), ["one.txt", "two.txt"]);
				assert.deepEqual(await get("/list"), []);
			});
		} finally {
			await dev.close();
		}
	} finally {
		await project.dispose();
	}
});
