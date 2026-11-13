import assert from "node:assert/strict";
import test from "node:test";

import { DurableObject } from "../../modules/cloudflare-workers/durable-object.js";
import { createDurableObjectActorDefinitions } from "./registry.js";
import { startDurableObjectRegistry } from "./lifecycle.js";
import { fakeRivetActorHandle } from "./test-actor-handle.js";

class Counter extends DurableObject {}

test("waits for Rivet registry readiness and shuts down once", async () => {
	const registrations = createDurableObjectActorDefinitions({
		classes: new Map([["Counter", Counter]]),
		deploymentIdentity: "project:development",
	});
	const ready = Promise.withResolvers<void>();
	let starts = 0;
	let shutdowns = 0;
	let clientDisposals = 0;
	let configuredActorNames: string[] = [];
	let clientEndpoint = "";
	const startup = startDurableObjectRegistry({
		createClient(options) {
			clientEndpoint = options.endpoint;
			return {
				create: async () => fakeRivetActorHandle(),
				async dispose(): Promise<void> {
					clientDisposals += 1;
				},
				exists: async () => true,
				fork: async () => "forked",
				resolve: async () => "actor",
				get: () => fakeRivetActorHandle(),
				getOrCreate() {
					return fakeRivetActorHandle();
				},
			};
		},
		createRegistry(options) {
			configuredActorNames = Object.keys(options.use);
			return {
				async handler(): Promise<never> {
					throw new Error("unused");
				},
				async prometheusMetrics(): Promise<never> {
					throw new Error("unused");
				},
				async shutdown(): Promise<void> {
					shutdowns += 1;
				},
				startAndWait(): Promise<void> {
					starts += 1;
					return ready.promise;
				},
			};
		},
		enginePort: 6123,
		namespace: "openorange_test",
		registrations,
	});
	let started = false;
	void startup.then(() => {
		started = true;
	});
	await Promise.resolve();
	assert.equal(started, false);
	assert.equal(starts, 1);
	assert.deepEqual(
		configuredActorNames,
		[...registrations.values()].map((registration) => registration.actorName),
	);

	ready.resolve();
	const lifecycle = await startup;
	assert.equal(started, true);
	assert.equal(clientEndpoint, "http://127.0.0.1:6123");
	await Promise.all([lifecycle.close(), lifecycle.close()]);
	assert.equal(clientDisposals, 1);
	assert.equal(shutdowns, 1);
});

test("shuts down a ready registry when client creation fails", async () => {
	let shutdowns = 0;
	await assert.rejects(
		startDurableObjectRegistry({
			createClient() {
				throw new Error("client creation failed");
			},
			createRegistry() {
				return {
					async handler(): Promise<never> {
						throw new Error("unused");
					},
					async prometheusMetrics(): Promise<never> {
						throw new Error("unused");
					},
					async shutdown(): Promise<void> {
						shutdowns += 1;
					},
					async startAndWait(): Promise<void> {},
				};
			},
			enginePort: 6123,
			namespace: "openorange_test",
			registrations: new Map(),
		}),
		/client creation failed/,
	);
	assert.equal(shutdowns, 1);
});

test("shuts down a registry whose readiness fails", async () => {
	let shutdowns = 0;
	await assert.rejects(
		startDurableObjectRegistry({
			createRegistry() {
				return {
					async handler(): Promise<never> {
						throw new Error("unused");
					},
					async prometheusMetrics(): Promise<never> {
						throw new Error("unused");
					},
					async shutdown(): Promise<void> {
						shutdowns += 1;
					},
					async startAndWait(): Promise<void> {
						throw new Error("registry readiness failed");
					},
				};
			},
			enginePort: 6123,
			namespace: "openorange_test",
			registrations: new Map(),
		}),
		/registry readiness failed/,
	);
	assert.equal(shutdowns, 1);
});
