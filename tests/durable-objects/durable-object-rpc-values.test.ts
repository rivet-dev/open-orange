import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import { copyProject, repositoryRoot, startOrangeDev } from "../harness/orange-dev.js";

async function getJson(origin: string, path: string, output: () => string): Promise<unknown> {
	const response = await fetch(new URL(path, origin));
	assert.equal(response.status, 200, `${await response.clone().text()}\n${output()}`);
	return await response.json();
}

test(
	"Durable Object RPC carries the values workerd serializes and rejects the rest with workerd's error",
	{ timeout: 180_000 },
	async (t) => {
		const project = await copyProject(join(repositoryRoot, "tests", "fixtures", "rpc-values"));
		try {
			const dev = await startOrangeDev(project.directory);
			try {
				await t.test("an object returns a stub it got from a WorkerEntrypoint, and that stub's own stubs work", async () => {
					assert.deepEqual(await getJson(dev.origin, "/entrypoint-stub", dev.output), {
						direct: "pong a",
						child: "pong b",
					});
				});

				await t.test("an 8 MiB Blob arrives byte for byte in both directions", async () => {
					const result = await getJson(dev.origin, "/large-blob", dev.output);
					assert.ok(typeof result === "object" && result !== null && "expected" in result);
					assert.deepEqual(result, {
						expected: result.expected,
						received: result.expected,
						returned: result.expected,
					});
				});

				await t.test("Blob, Response.error(), DOMException, and boxed primitives keep their type", async () => {
					const expected = {
						domException: { code: 8, message: "missing", name: "NotFoundError" },
						networkError: { status: 0, type: "error" },
						number: 3,
						typed: { bytes: [0, 255, 7], type: "application/x-bytes" },
					};
					assert.deepEqual(await getJson(dev.origin, "/mixed", dev.output), {
						echoed: expected,
						returned: expected,
					});
				});

				await t.test("File and FormData fail with workerd's DataCloneError", async () => {
					const fileError = {
						message:
							'Could not serialize object of type "File". This type does not support serialization.',
						name: "DataCloneError",
					};
					assert.deepEqual(await getJson(dev.origin, "/unsupported", dev.output), {
						returnedFile: fileError,
						sentFile: fileError,
						sentFormData: {
							message:
								'Could not serialize object of type "FormData". This type does not support serialization.',
							name: "DataCloneError",
						},
					});
				});
			} finally {
				await dev.close();
			}
		} finally {
			await project.dispose();
		}
	},
);
