import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { get } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { globalManifest } from "../../packages/runtime-node/src/globals/manifest.js";
import type { RuntimeStartMessage } from "../../packages/runtime-node/src/process-protocol.js";
import { startRuntime } from "../../packages/runtime-node/src/runner.js";
import { createDurableObjectNamespace } from "../../packages/runtime-node/src/bindings/durable-objects/namespace.js";
import { durableObjectActorName } from "../../packages/runtime-node/src/bindings/durable-objects/actor-routing.js";
import {
	type DurableObjectActorRegistration,
	runningDurableObjectGeneration,
} from "../../packages/runtime-node/src/bindings/durable-objects/registry.js";
import { fakeRivetActorHandle } from "../../packages/runtime-node/src/bindings/durable-objects/test-actor-handle.js";
import { bundleWorker } from "../build/bundle-worker.js";
import { runtimeModuleRewrites } from "../build/rewrite-module-imports.js";

function snapshotGlobals(): Map<string, PropertyDescriptor | undefined> {
	return new Map(
		globalManifest.map((entry) => [
			entry.name,
			Object.getOwnPropertyDescriptor(globalThis, entry.name),
		]),
	);
}

function restoreGlobals(
	descriptors: ReadonlyMap<string, PropertyDescriptor | undefined>,
): void {
	for (const [name, descriptor] of descriptors) {
		if (descriptor === undefined) {
			Reflect.deleteProperty(globalThis, name);
		} else {
			Object.defineProperty(globalThis, name, descriptor);
		}
	}
}

function getJson(url: string): Promise<{ body: unknown; status: number }> {
	return new Promise((resolveResponse, rejectResponse) => {
		const request = get(url, (response) => {
			const chunks: Buffer[] = [];
			response.on("data", (chunk: Buffer) => chunks.push(chunk));
			response.once("end", () => {
				try {
					resolveResponse({
						body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
						status: response.statusCode ?? 0,
					});
				} catch (error: unknown) {
					rejectResponse(error);
				}
			});
		});
		request.once("error", rejectResponse);
	});
}

function startMessage(
	bundlePath: string,
	projectRoot: string,
	className: string,
): RuntimeStartMessage {
	return {
		bindingConfigurations: [],
		builtAt: "2026-09-04T12:00:00.000Z",
		bundlePath,
		deploymentIdentity: "registration-test",
		durableObjectManifest: {
			bindings: [{ binding: "OBJECT", className }],
			classes: [
				{ className, migrationTag: "v1", storageBackend: "sqlite" },
			],
			latestMigrationTag: "v1",
		},
		host: "127.0.0.1",
		normalizedConfiguration: "{}",
		port: 0,
		projectRoot,
		rivetNamespace: "default",
		rivetStoragePath: join(projectRoot, "rivetkit"),
		type: "start",
	};
}

test("registers only configured Durable Object exports through the runner", async () => {
	const directory = await mkdtemp(join(tmpdir(), "open-orange-registration-"));
	const descriptors = snapshotGlobals();
	const previousStoragePath = process.env.RIVETKIT_STORAGE_PATH;
	let runtime: Awaited<ReturnType<typeof startRuntime>> | undefined;
	let registrations:
		| ReadonlyMap<string, DurableObjectActorRegistration>
		| undefined;
	let registryCloses = 0;
	let clientResolutions = 0;
	try {
		const bundle = await bundleWorker({
			entrypoint: new URL(
				"../build/fixtures/durable-object-worker.ts",
				import.meta.url,
			).pathname,
			moduleRewrites: runtimeModuleRewrites(),
			outputPath: join(directory, "worker.mjs"),
		});
		runtime = await startRuntime(
			startMessage(bundle.outputPath, directory, "ConfiguredObject"),
			{
				async startRegistry(options) {
					registrations = options.registrations;
					return {
						client: {
							create: async () => fakeRivetActorHandle(),
							async dispose(): Promise<void> {},
							exists: async () => true,
							fork: async () => "forked",
							resolve: async () => "actor",
							get() {
								clientResolutions += 1;
								return fakeRivetActorHandle();
							},
							getOrCreate() {
								clientResolutions += 1;
								return fakeRivetActorHandle();
							},
						},
						async close(): Promise<void> {
							registryCloses += 1;
						},
						prometheusMetrics: async () => new Response(""),
					};
				},
			},
		);

		assert.ok(registrations);
		// The configured class and the Cache API's internal class.
		assert.equal(registrations.size, 2);
		const actorName = durableObjectActorName(
			"registration-test",
			"ConfiguredObject",
		);
		const registration = registrations.get(actorName);
		assert.ok(registration);
		assert.equal(registration.className, "ConfiguredObject");
		assert.equal(registration.migrationTag, "v1");
		assert.equal(registration.storageBackend, "sqlite");
		assert.equal(Reflect.get(registration.userClass, "methodCalls"), 0);
		assert.equal(clientResolutions, 0);
		const namespaceResponse = await getJson(
			`http://127.0.0.1:${runtime.port}/namespace`,
		);
		assert.equal(namespaceResponse.status, 200);
		assert.deepEqual(namespaceResponse.body, {
			id: createDurableObjectNamespace({
				className: "ConfiguredObject",
				deploymentIdentity: "registration-test",
			})
				.idFromName("fixture")
				.toString(),
			name: "fixture",
		});
		assert.equal(clientResolutions, 0);
		assert.equal(Reflect.get(registration.userClass, "methodCalls"), 0);
		const generation = runningDurableObjectGeneration(
			await registration.definition.config.createVars(),
		);
		assert.equal(generation.className, "ConfiguredObject");
		assert.equal(
			Reflect.get(generation.instance, "constructor"),
			registration.userClass,
		);
		assert.equal(Reflect.get(registration.userClass, "methodCalls"), 0);
		assert.equal(
			[...registrations.values()].some(
				(entry) => entry.className === "UnconfiguredObject",
			),
			false,
		);

		await runtime.close("parent");
		runtime = undefined;
		assert.equal(registryCloses, 1);

		let missingRegistryStarts = 0;
		await assert.rejects(
			startRuntime(
				startMessage(bundle.outputPath, directory, "MissingObject"),
				{
					async startRegistry() {
						missingRegistryStarts += 1;
						return {
							client: {
								create: async () => fakeRivetActorHandle(),
								dispose: async () => undefined,
								exists: async () => true,
								fork: async () => "forked",
								resolve: async () => "actor",
								get: () => fakeRivetActorHandle(),
								getOrCreate: () => fakeRivetActorHandle(),
							},
							close: async () => undefined,
							prometheusMetrics: async () => new Response(""),
						};
					},
				},
			),
			/Configured Durable Object class MissingObject is not a named Worker export/,
		);
		assert.equal(missingRegistryStarts, 0);
		assert.equal(Reflect.get(registration.userClass, "methodCalls"), 0);
	} finally {
		await runtime?.close("parent");
		if (previousStoragePath === undefined) {
			Reflect.deleteProperty(process.env, "RIVETKIT_STORAGE_PATH");
		} else {
			process.env.RIVETKIT_STORAGE_PATH = previousStoragePath;
		}
		restoreGlobals(descriptors);
		await rm(directory, { force: true, recursive: true });
	}
});
