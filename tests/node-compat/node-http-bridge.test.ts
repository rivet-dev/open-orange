import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import { copyProject, repositoryRoot, startOrangeDev, type RunningOrangeDev } from "../harness/orange-dev.js";

// Expected values are workerd 1.20260903.1's output for the same fixture under `wrangler dev`.
async function withDev(run: (dev: RunningOrangeDev) => Promise<void>): Promise<void> {
	const project = await copyProject(join(repositoryRoot, "tests", "fixtures", "node-http-bridge"));
	try {
		const dev = await startOrangeDev(project.directory);
		try {
			await run(dev);
		} finally {
			await dev.close();
		}
	} finally {
		await project.dispose();
	}
}

async function get(dev: RunningOrangeDev, path: string): Promise<{ status: number; body: string }> {
	const response = await fetch(`${dev.origin}${path}`);
	return { status: response.status, body: await response.text() };
}

test("a node:http server can still respond after it destroys the request", { timeout: 120_000 }, async () => {
	await withDev(async (dev) => {
		assert.deepEqual(await get(dev, "/destroy-with-error"), {
			status: 400,
			body: "Request destroyed: Destroy test",
		});
		assert.deepEqual(await get(dev, "/destroy-without-error"), {
			status: 200,
			body: "Request destroyed without error",
		});
	});
});

// workerd's body ends when the server ends the response, so a short body is not an error.
test("a node:http response with fewer bytes than its Content-Length ends with the bytes sent", { timeout: 120_000 }, async () => {
	await withDev(async (dev) => {
		const read = async (path: string): Promise<unknown> =>
			(await fetch(`${dev.origin}/read${path}`)).json();
		assert.deepEqual(await read("/too-few"), { status: 200, body: "0123456789" });
		assert.deepEqual(await read("/too-many"), { status: 200, body: "0123456789" });
	});
});
