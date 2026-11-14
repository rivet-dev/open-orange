import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { request as createHttpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { RuntimeDiagnosticMessage } from "../../packages/runtime-node/src/process-protocol.js";
import { bundleWorker } from "../build/bundle-worker.js";
import { spawnRuntime } from "./spawn.js";

const workerEntrypoint = new URL(
	"../build/fixtures/basic-worker.ts",
	import.meta.url,
).pathname;

test("runs a Worker in a dedicated HTTP-owning child process", async () => {
	const directory = await mkdtemp(join(tmpdir(), "open-orange-runtime-"));
	let runtime: Awaited<ReturnType<typeof spawnRuntime>> | undefined;
	try {
		const bundle = await bundleWorker({
			entrypoint: workerEntrypoint,
			outputPath: join(directory, "worker.mjs"),
		});
		runtime = await spawnRuntime({
			bindingConfigurations: [],
			builtAt: new Date("2026-09-04T12:00:00.000Z"),
			bundlePath: bundle.outputPath,
			deploymentIdentity: "runtime-test",
			host: "0.0.0.0",
			normalizedConfiguration: "{}",
			port: 0,
			projectRoot: directory,
			rivetNamespace: "openorange_runtime_test",
			rivetStoragePath: join(directory, "rivetkit"),
		});
		const response = await fetch(
			`http://127.0.0.1:${runtime.port}/from-child`,
		);
		assert.equal(response.status, 200);
		assert.equal(await response.text(), "/from-child");
		assert.deepEqual(await runtime.stop(), {
			code: 0,
			reason: "parent",
			signal: null,
		});
		runtime = undefined;
	} finally {
		await runtime?.stop();
		await rm(directory, { force: true, recursive: true });
	}
});

test("runs the Worker in UTC with the en-US locale, whatever the host is set to", async () => {
	const directory = await mkdtemp(join(tmpdir(), "open-orange-runtime-"));
	const host = { LANG: process.env.LANG, LC_ALL: process.env.LC_ALL, TZ: process.env.TZ };
	let runtime: Awaited<ReturnType<typeof spawnRuntime>> | undefined;
	try {
		// The runtime inherits the environment of the process that starts it.
		Object.assign(process.env, { LANG: "de_DE.UTF-8", LC_ALL: "de_DE.UTF-8", TZ: "Asia/Tokyo" });
		const bundle = await bundleWorker({
			entrypoint: new URL("./fixtures/time-and-locale-worker.js", import.meta.url).pathname,
			outputPath: join(directory, "worker.mjs"),
		});
		runtime = await spawnRuntime({
			bindingConfigurations: [],
			builtAt: new Date("2026-09-04T12:00:00.000Z"),
			bundlePath: bundle.outputPath,
			deploymentIdentity: "runtime-time-zone-test",
			host: "0.0.0.0",
			normalizedConfiguration: "{}",
			port: 0,
			projectRoot: directory,
			rivetNamespace: "openorange_runtime_time_zone_test",
			rivetStoragePath: join(directory, "rivetkit"),
		});
		const response = await fetch(`http://127.0.0.1:${runtime.port}/`);
		assert.deepEqual(await response.json(), {
			date: "1/1/1970",
			locale: "en-US",
			number: "1,234,567.891",
			offsetMinutes: 0,
			timeZone: "UTC",
		});
	} finally {
		await runtime?.stop();
		for (const [name, value] of Object.entries(host)) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
		await rm(directory, { force: true, recursive: true });
	}
});

test("streams request and response bodies across the runtime process", async () => {
	const directory = await mkdtemp(join(tmpdir(), "open-orange-runtime-"));
	let runtime: Awaited<ReturnType<typeof spawnRuntime>> | undefined;
	try {
		const bundle = await bundleWorker({
			entrypoint: workerEntrypoint,
			outputPath: join(directory, "worker.mjs"),
		});
		runtime = await spawnRuntime({
			bindingConfigurations: [],
			builtAt: new Date("2026-09-04T12:00:00.000Z"),
			bundlePath: bundle.outputPath,
			deploymentIdentity: "runtime-stream-test",
			host: "0.0.0.0",
			normalizedConfiguration: "{}",
			port: 0,
			projectRoot: directory,
			rivetNamespace: "openorange_runtime_stream_test",
			rivetStoragePath: join(directory, "rivetkit"),
		});
		const origin = `http://127.0.0.1:${runtime.port}`;

		const response = await fetch(`${origin}/response-stream`, {
			signal: AbortSignal.timeout(2_000),
		});
		assert.ok(response.body);
		const responseReader = response.body.getReader();
		const firstResponseChunk = await responseReader.read();
		assert.equal(
			new TextDecoder().decode(firstResponseChunk.value),
			"first",
		);
		await responseReader.cancel();

		const echoed = Promise.withResolvers<string>();
		const outgoing = createHttpRequest(
			`${origin}/request-stream`,
			{ method: "POST" },
			(incoming) => {
				const chunks: Uint8Array[] = [];
				incoming.on("data", (chunk: Uint8Array) => chunks.push(chunk));
				incoming.once("end", () => {
					echoed.resolve(Buffer.concat(chunks).toString());
				});
			},
		);
		outgoing.once("error", echoed.reject);
		outgoing.write("request-first");
		const requestTimeout = setTimeout(() => {
			echoed.reject(new Error("Streaming request response timed out"));
		}, 2_000);
		try {
			assert.equal(await echoed.promise, "request-first");
		} finally {
			clearTimeout(requestTimeout);
			outgoing.end();
		}
	} finally {
		await runtime?.stop();
		await rm(directory, { force: true, recursive: true });
	}
});

test("reports request and background errors to the parent", async () => {
	const directory = await mkdtemp(join(tmpdir(), "open-orange-runtime-"));
	let runtime: Awaited<ReturnType<typeof spawnRuntime>> | undefined;
	let nextDiagnostic = Promise.withResolvers<RuntimeDiagnosticMessage>();
	try {
		const bundle = await bundleWorker({
			entrypoint: workerEntrypoint,
			outputPath: join(directory, "worker.mjs"),
		});
		runtime = await spawnRuntime({
			bindingConfigurations: [],
			builtAt: new Date("2026-09-04T12:00:00.000Z"),
			bundlePath: bundle.outputPath,
			deploymentIdentity: "runtime-test",
			host: "0.0.0.0",
			normalizedConfiguration: "{}",
			onDiagnostic(diagnostic): void {
				nextDiagnostic.resolve(diagnostic);
			},
			port: 0,
			projectRoot: directory,
			rivetNamespace: "openorange_runtime_test",
			rivetStoragePath: join(directory, "rivetkit"),
		});

		const failedResponse = await fetch(
			`http://127.0.0.1:${runtime.port}/error`,
		);
		assert.equal(failedResponse.status, 500);
		assert.deepEqual(
			{
				message: (await nextDiagnostic.promise).message,
				type: (await nextDiagnostic.promise).type,
			},
			{ message: "fixture request failure", type: "request-error" },
		);

		nextDiagnostic = Promise.withResolvers<RuntimeDiagnosticMessage>();
		const backgroundResponse = await fetch(
			`http://127.0.0.1:${runtime.port}/background`,
		);
		assert.equal(backgroundResponse.status, 200);
		assert.deepEqual(
			{
				message: (await nextDiagnostic.promise).message,
				type: (await nextDiagnostic.promise).type,
			},
			{ message: "fixture background failure", type: "background-error" },
		);

		nextDiagnostic = Promise.withResolvers<RuntimeDiagnosticMessage>();
		const unhandledResponse = await fetch(
			`http://127.0.0.1:${runtime.port}/unhandled-rejection`,
		);
		assert.equal(unhandledResponse.status, 200);
		assert.deepEqual(
			{
				message: (await nextDiagnostic.promise).message,
				type: (await nextDiagnostic.promise).type,
			},
			{ message: "fixture unhandled rejection", type: "background-error" },
		);

		nextDiagnostic = Promise.withResolvers<RuntimeDiagnosticMessage>();
		const uncaughtResponse = await fetch(
			`http://127.0.0.1:${runtime.port}/uncaught-exception`,
		);
		assert.equal(uncaughtResponse.status, 200);
		const uncaught = await Promise.race([
			nextDiagnostic.promise,
			runtime.waitForExit(),
		]);
		assert.ok("type" in uncaught, `runtime exited: ${JSON.stringify(uncaught)}`);
		assert.deepEqual(
			{ message: uncaught.message, type: uncaught.type },
			{ message: "fixture uncaught exception", type: "background-error" },
		);
		assert.equal(
			await (
				await fetch(`http://127.0.0.1:${runtime.port}/still-running`)
			).text(),
			"/still-running",
		);
	} finally {
		await runtime?.stop();
		await rm(directory, { force: true, recursive: true });
	}
});

test("reports signal-driven shutdown", async () => {
	const directory = await mkdtemp(join(tmpdir(), "open-orange-runtime-"));
	let runtime: Awaited<ReturnType<typeof spawnRuntime>> | undefined;
	try {
		const bundle = await bundleWorker({
			entrypoint: workerEntrypoint,
			outputPath: join(directory, "worker.mjs"),
		});
		runtime = await spawnRuntime({
			bindingConfigurations: [],
			builtAt: new Date("2026-09-04T12:00:00.000Z"),
			bundlePath: bundle.outputPath,
			deploymentIdentity: "runtime-test",
			host: "0.0.0.0",
			normalizedConfiguration: "{}",
			port: 0,
			projectRoot: directory,
			rivetNamespace: "openorange_runtime_test",
			rivetStoragePath: join(directory, "rivetkit"),
		});
		assert.equal(runtime.signal("SIGTERM"), true);
		assert.deepEqual(await runtime.waitForExit(), {
			code: 0,
			reason: "SIGTERM",
			signal: null,
		});
		runtime = undefined;
	} finally {
		await runtime?.stop();
		await rm(directory, { force: true, recursive: true });
	}
});

test("reports startup failures before readiness", async () => {
	await assert.rejects(
		spawnRuntime({
			bindingConfigurations: [],
			builtAt: new Date("2026-09-04T12:00:00.000Z"),
			bundlePath: "/definitely/missing/open-orange-worker.mjs",
			deploymentIdentity: "runtime-test",
			host: "0.0.0.0",
			normalizedConfiguration: "{}",
			port: 0,
			projectRoot: process.cwd(),
			rivetNamespace: "openorange_runtime_test",
			rivetStoragePath: join(process.cwd(), ".open-orange", "rivetkit-test"),
		}),
		/ENOENT|no such file/i,
	);
});
