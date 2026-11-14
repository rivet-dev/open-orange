import assert from "node:assert/strict";
import { lstatSync, readFileSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { bundleWorker } from "../../src/build/bundle-worker.js";
import { runtimeModuleRewrites } from "../../src/build/rewrite-module-imports.js";
import { spawnRuntime } from "../../src/runtime/spawn.js";

const workerEntrypoint = new URL(
	"../../src/build/fixtures/node-fs-worker.ts",
	import.meta.url,
).pathname;

async function startWorker(directory: string) {
	const bundle = await bundleWorker({
		entrypoint: workerEntrypoint,
		moduleRewrites: runtimeModuleRewrites(),
		outputPath: join(directory, "build", "worker.mjs"),
	});
	return spawnRuntime({
		bindingConfigurations: [],
		builtAt: new Date("2026-09-04T12:00:00.000Z"),
		bundlePath: bundle.outputPath,
		deploymentIdentity: "runtime-node-fs-test",
		host: "127.0.0.1",
		normalizedConfiguration: "{}",
		port: 0,
		projectRoot: directory,
		rivetNamespace: "openorange_runtime_node_fs_test",
		rivetStoragePath: join(directory, "rivetkit"),
	});
}

test("node:fs serves the Worker read-only at /bundle and the host disk outside /bundle and /tmp", async () => {
	// A Worker's /tmp is private, so the host directory must not be under /tmp, as os.tmpdir() is on Linux.
	const cache = fileURLToPath(new URL("../../node_modules/.cache/", import.meta.url));
	await mkdir(cache, { recursive: true });
	const directory = await mkdtemp(join(cache, "open-orange-node-fs-"));
	let runtime: Awaited<ReturnType<typeof spawnRuntime>> | undefined;
	try {
		runtime = await startWorker(directory);
		const origin = `http://127.0.0.1:${runtime.port}`;

		const bundle = await (await fetch(`${origin}/bundle`)).json();
		assert.deepEqual(bundle, {
			entries: ["worker"],
			holdsWorker: true,
			missing: { code: "ENOENT", path: "/bundle/missing.txt" },
			syncWrite: { code: "EPERM", path: "/bundle/worker" },
			promiseWrite: { code: "EPERM", path: "/bundle/a" },
		});

		// The first request holds its file open across the second request's write.
		const first = fetch(
			`${origin}/write?hold&file=${encodeURIComponent(join(directory, "first.txt"))}&value=first`,
		);
		const second = await fetch(
			`${origin}/write?file=${encodeURIComponent(join(directory, "second.txt"))}&value=second`,
		);
		assert.equal(await second.text(), "second");
		assert.equal(await (await first).text(), "first");
		assert.equal(readFileSync(join(directory, "first.txt"), "utf8"), "first");
		assert.equal(readFileSync(join(directory, "second.txt"), "utf8"), "second");

		// Writes, streams, copies, links, and modes land on the host disk, and /bundle stays read-only.
		const scratch = join(directory, "scratch");
		await mkdir(scratch);
		const result = await (
			await fetch(`${origin}/scratch?dir=${encodeURIComponent(scratch)}`)
		).json();
		assert.deepEqual(result, {
			read: "alpha",
			stream: "one,two",
			copied: "nested",
			entries: ["a.txt", "link", "stream.txt", "tree", "tree-copy"],
			stat: { size: 5, file: true },
			link: { target: join(scratch, "a.txt"), symbolic: true, read: "alpha" },
			mode: 0o600,
			bundleStream: { code: "EPERM", path: "/bundle/stream.txt" },
			bundleCopy: { code: "EPERM", path: "/bundle/a.txt" },
		});
		assert.equal(readFileSync(join(scratch, "tree-copy/nested/file.txt"), "utf8"), "nested");
		assert.equal(statSync(join(scratch, "a.txt")).mode & 0o777, 0o600);
		assert.equal(lstatSync(join(scratch, "link")).isSymbolicLink(), true);

		// Stopping removes the /bundle directory next to the bundle.
		await runtime.stop();
		runtime = undefined;
		assert.deepEqual(await readdir(join(directory, "build")), ["worker.mjs"]);
	} finally {
		await runtime?.stop();
		await rm(directory, { force: true, recursive: true });
	}
});
