import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import { copyProject, repositoryRoot, startOrangeDev } from "../harness/orange-dev.js";

// Expected values are workerd 1.20260903.1's output for the same fixture under `wrangler dev`.
test("a node:http server request's socket reports the client address, scheme, and listen port", { timeout: 120_000 }, async () => {
	const project = await copyProject(join(repositoryRoot, "tests", "fixtures", "node-http-socket"));
	try {
		const dev = await startOrangeDev(project.directory);
		try {
			const response = await fetch(`${dev.origin}/run`);
			assert.equal(response.status, 200, `${await response.clone().text()}\n${dev.output()}`);
			const common = { localPortIsServerPort: true, remotePortIsEphemeral: true, hasOn: true };
			assert.deepEqual(await response.json(), {
				plain: {
					...common,
					encrypted: false,
					localAddress: "127.0.0.1",
					remoteAddress: "127.0.0.1",
					remoteFamily: "IPv4",
				},
				forwarded: {
					...common,
					encrypted: true,
					localAddress: "my-worker.example.com",
					remoteAddress: "2001:db8::1",
					remoteFamily: "IPv6",
				},
			});
		} finally {
			await dev.close();
		}
	} finally {
		await project.dispose();
	}
});
