import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { bundleWorker } from "../../src/build/bundle-worker.js";
import { runtimeModuleRewrites } from "../../src/build/rewrite-module-imports.js";
import { isRecord } from "../../src/unknown-values.js";
import { spawnRuntime } from "../../src/runtime/spawn.js";

const workerEntrypoint = new URL(
	"../../src/build/fixtures/node-crypto-worker.ts",
	import.meta.url,
).pathname;

test("node:crypto encrypts with KeyObjects made from JWKs and CryptoKeys, as jose does", async () => {
	const directory = await mkdtemp(join(tmpdir(), "open-orange-node-crypto-"));
	let runtime: Awaited<ReturnType<typeof spawnRuntime>> | undefined;
	try {
		const bundle = await bundleWorker({
			entrypoint: workerEntrypoint,
			moduleRewrites: runtimeModuleRewrites(),
			outputPath: join(directory, "worker.mjs"),
		});
		runtime = await spawnRuntime({
			bindingConfigurations: [],
			builtAt: new Date("2026-09-04T12:00:00.000Z"),
			bundlePath: bundle.outputPath,
			deploymentIdentity: "runtime-node-crypto-test",
			host: "127.0.0.1",
			normalizedConfiguration: "{}",
			port: 0,
			projectRoot: directory,
			rivetNamespace: "openorange_runtime_node_crypto_test",
			rivetStoragePath: join(directory, "rivetkit"),
		});

		const response = await fetch(`http://127.0.0.1:${runtime.port}/`);
		const body: unknown = await response.json();
		assert.ok(isRecord(body), JSON.stringify(body));
		const { wrongKey, ...decrypted } = body;
		assert.deepEqual(decrypted, { fromJwk: "secret", fromCryptoKey: "secret" });
		// The OpenSSL reason depends on the keys, so only the error class is stable.
		assert.ok(typeof wrongKey === "string", JSON.stringify(body));
		assert.match(wrongKey, /^ERR_OSSL_/);
	} finally {
		await runtime?.stop();
		await rm(directory, { force: true, recursive: true });
	}
});
