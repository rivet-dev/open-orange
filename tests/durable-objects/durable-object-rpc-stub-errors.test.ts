import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import { copyProject, repositoryRoot, startOrangeDev } from "../harness/orange-dev.js";

async function getJson(origin: string, path: string, output: () => string): Promise<unknown> {
	const response = await fetch(new URL(path, origin));
	assert.equal(response.status, 200, `${await response.clone().text()}\n${output()}`);
	return await response.json();
}

const remoteKeys = ["durableObjectId", "remote"];
const appError = { isDOMException: false, isTypeError: false, keys: remoteKeys, message: "app failure", name: "Error" };

test(
	"a Durable Object stub stays usable after the object's own code throws, and breaks after a reset",
	{ timeout: 180_000 },
	async (t) => {
		const project = await copyProject(join(repositoryRoot, "tests", "fixtures", "rpc-stub-errors"));
		try {
			const dev = await startOrangeDev(project.directory);
			try {
				await t.test("later calls on the stub succeed, and the error keeps its type and fields", async () => {
					assert.deepEqual(await getJson(dev.origin, "/keeps", dev.output), {
						error: { error: appError },
						afterError: { value: 1 },
						typeError: {
							error: { isDOMException: false, isTypeError: true, keys: remoteKeys, message: "bad input", name: "TypeError" },
						},
						afterTypeError: { value: 2 },
						customError: {
							error: { code: 7, isDOMException: false, isTypeError: false, keys: ["code", ...remoteKeys], message: "over quota", name: "QuotaError" },
						},
						afterCustomError: { value: 3 },
					});
				});

				await t.test("a call in flight on the same stub still completes when another call throws", async () => {
					assert.deepEqual(await getJson(dev.origin, "/in-flight", dev.output), {
						failed: { error: appError },
						slow: { value: "slow done" },
						after: { value: 4 },
					});
				});

				await t.test("an error thrown by the object's fetch() rejects the caller's fetch() and keeps the stub", async () => {
					assert.deepEqual(await getJson(dev.origin, "/fetch-throws", dev.output), {
						thrown: { error: { isDOMException: false, isTypeError: false, keys: ["remote"], message: "fetch failure", name: "Error" } },
						afterFetch: { value: "fetched" },
						afterRpc: { value: 7 },
					});
				});

				await t.test("a call to a method the object lacks rejects with workerd's TypeError and keeps the stub", async () => {
					assert.deepEqual(await getJson(dev.origin, "/missing-method", dev.output), {
						missing: {
							error: {
								isDOMException: false,
								isTypeError: true,
								keys: remoteKeys,
								message: 'The RPC receiver does not implement the method "nope".',
								name: "TypeError",
							},
						},
						afterMissing: { value: 10 },
						numericName: true,
					});
				});

				await t.test("an argument that cannot be cloned rejects only that call, and the stub stays usable", async () => {
					const cloneError = (message: string) => ({
						error: { code: 25, isDOMException: true, isTypeError: false, message, name: "DataCloneError" },
					});
					assert.deepEqual(await getJson(dev.origin, "/unserializable", dev.output), {
						symbol: cloneError("Symbol(s) could not be cloned."),
						afterSymbol: { value: 8 },
						weakMap: cloneError("#<WeakMap> could not be cloned."),
						afterWeakMap: { value: 9 },
					});
				});

				await t.test("ctx.abort() breaks the stub with a durableObjectReset error, and a new stub reaches the restarted object", async () => {
					const resetError = {
						isDOMException: false,
						isTypeError: false,
						keys: ["durableObjectId", "durableObjectReset", "remote"],
						message: "reset by test",
						name: "Error",
					};
					assert.deepEqual(await getJson(dev.origin, "/abort-breaks", dev.output), {
						reset: { error: resetError },
						afterReset: { error: resetError },
						freshStub: { value: 6 },
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
