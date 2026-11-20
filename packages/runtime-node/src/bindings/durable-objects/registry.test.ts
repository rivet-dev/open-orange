import assert from "node:assert/strict";
import test from "node:test";
import type { RivetWebSocket } from "../../internal/rivetkit.js";
import {
	DurableObject,
	type DurableObjectState,
} from "../../modules/cloudflare-workers/durable-object.js";
import { durableObjectActorKey, durableObjectActorName } from "./actor-routing.js";
import { durableObjectAlarmAction } from "./alarm-storage.js";
import { durableObjectOrangeForkActions } from "./orange-fork.js";
import { createDurableObjectIdScope } from "./id.js";
import { durableObjectNamespaceKey } from "./namespace.js";
import { runtimeActorRequest } from "./test-actor-handle.js";
import {
	createDurableObjectActorDefinitions,
	type DurableObjectClassStorageConfiguration,
	type DurableObjectRouteHandlers,
	dispatchDurableObjectPrivateRequest,
	dispatchDurableObjectPrivateWebSocket,
	durableObjectPrivateRoutes,
	runningDurableObjectGeneration,
} from "./registry.js";
import { createDurableObjectGeneration } from "./state.js";

class Counter extends DurableObject {}
class Room extends DurableObject {}

let generationConstructions = 0;

class GenerationObject extends DurableObject<{ binding: object }> {
	constructor(ctx: DurableObjectState, env: { binding: object }) {
		super(ctx, env);
		generationConstructions += 1;
	}

	inspect(): { ctx: DurableObjectState; env: { binding: object } } {
		return { ctx: this.ctx, env: this.env };
	}
}

const routes: DurableObjectRouteHandlers = {
	fetch: (generation) => new Response(`fetch:${generation.className}`),
	rpc: (generation) => new Response(`rpc:${generation.className}`),
	rpcWebSocket: () => undefined,
	webSocket: () => undefined,
};

const counterGeneration = createDurableObjectGeneration({
	bindings: {},
	className: "Counter",
	userClass: Counter,
});

test("generates one deterministic collision-safe Rivet actor per class", () => {
	const classes = new Map([
		["Counter", Counter],
		["Room", Room],
	]);
	const classStorage = new Map<
		string,
		DurableObjectClassStorageConfiguration
	>([
		["Counter", { migrationTag: "v1", storageBackend: "sqlite" }],
		["Room", { migrationTag: "v2", storageBackend: "sqlite" }],
	]);
	const registrations = createDurableObjectActorDefinitions({
		classStorage,
		classes,
		deploymentIdentity: "project:development",
		routes,
	});

	assert.equal(registrations.size, 2);
	const counterName = durableObjectActorName("project:development", "Counter");
	assert.match(counterName, /^counter-[a-f0-9]{8}$/);
	assert.notEqual(
		counterName,
		durableObjectActorName("another-project:development", "Counter"),
	);
	assert.notEqual(
		counterName,
		durableObjectActorName("project:development", "Room"),
	);
	assert.equal(registrations.get(counterName)?.userClass, Counter);
	assert.equal(registrations.get(counterName)?.migrationTag, "v1");
	assert.equal(registrations.get(counterName)?.storageBackend, "sqlite");
	assert.deepEqual(
		Object.keys(
			registrations.get(counterName)?.definition.config.actions ?? {},
		),
		[
			durableObjectOrangeForkActions.fork,
			durableObjectOrangeForkActions.facetsCopied,
			durableObjectAlarmAction,
		],
	);
	assert.equal(
		typeof registrations.get(counterName)?.definition.config.db.createClient,
		"function",
	);
	assert.equal(
		typeof registrations.get(counterName)?.definition.config.onRequest,
		"function",
	);
	assert.equal(
		typeof registrations.get(counterName)?.definition.config.onWebSocket,
		"function",
	);
});

test("requires one applied storage migration for every discovered class", () => {
	assert.throws(
		() =>
			createDurableObjectActorDefinitions({
				classes: new Map([["Counter", Counter]]),
				classStorage: new Map(),
				deploymentIdentity: "project:development",
			}),
		/Durable Object class Counter is missing its applied storage migration/,
	);
	assert.throws(
		() =>
			createDurableObjectActorDefinitions({
				classes: new Map([["Counter", Counter]]),
				classStorage: new Map([
					["Counter", { migrationTag: "v1", storageBackend: "sqlite" }],
					["Missing", { migrationTag: "v1", storageBackend: "sqlite" }],
				]),
				deploymentIdentity: "project:development",
			}),
		/SQLite migration references undiscovered Durable Object class Missing/,
	);
});

test("constructs one user instance and environment per actor generation", async () => {
	generationConstructions = 0;
	const binding = {};
	const bindings = { binding };
	const observedGenerations: unknown[] = [];
	const registrations = createDurableObjectActorDefinitions({
		bindings,
		classes: new Map([["GenerationObject", GenerationObject]]),
		deploymentIdentity: "project:development",
		routes: {
			fetch(generation): Response {
				observedGenerations.push(generation);
				return new Response();
			},
			rpc: () => new Response(),
			rpcWebSocket: () => undefined,
			webSocket: () => undefined,
		},
	});
	const registration = registrations.values().next().value;
	assert.ok(registration);
	const first = runningDurableObjectGeneration(
		await registration.definition.config.createVars(),
	);
	assert.equal(generationConstructions, 1);
	assert.ok(first.instance instanceof GenerationObject);
	assert.notEqual(first.environment, bindings);
	assert.equal(first.environment.binding, binding);
	assert.deepEqual(first.instance.inspect(), {
		ctx: first.state,
		env: first.environment,
	});
	assert.deepEqual(first.state.props, {});
	assert.throws(
		() => Reflect.get(first.state, "storage"),
		/DurableObjectState\.storage is not initialized/,
	);

	await runtimeActorRequest(registration.definition.config, first, new Request(`http://actor${durableObjectPrivateRoutes.fetch}`));
	await runtimeActorRequest(registration.definition.config, first, new Request(`http://actor${durableObjectPrivateRoutes.fetch}`));
	assert.deepEqual(observedGenerations, [first, first]);
	assert.equal(generationConstructions, 1);

	const second = runningDurableObjectGeneration(
		await registration.definition.config.createVars(),
	);
	assert.equal(generationConstructions, 2);
	assert.notEqual(second.instance, first.instance);
	assert.notEqual(second.state, first.state);
	assert.notEqual(second.environment, first.environment);
	assert.equal(second.orderCoordinator, first.orderCoordinator);
});

test("reconstructs ctx.id from the canonical Rivet actor key", async () => {
	const deploymentIdentity = "project:state";
	const className = "GenerationObject";
	const namespaceKey = durableObjectNamespaceKey(deploymentIdentity, className);
	const registrations = createDurableObjectActorDefinitions({
		bindings: { binding: {} },
		classes: new Map([[className, GenerationObject]]),
		deploymentIdentity,
		routes,
	});
	const registration = registrations.values().next().value;
	assert.ok(registration);
	for (const jurisdiction of [undefined, "eu"] as const) {
		const id = createDurableObjectIdScope({ namespaceKey, jurisdiction }).idFromName(
			"alice",
		);
		const restored = runningDurableObjectGeneration(
			await registration.definition.config.createVars({
				key: [...durableObjectActorKey({ id, jurisdiction })],
				vars: undefined,
				waitUntil: () => {},
			}),
		);
		assert.equal(restored.state.id.toString(), id.toString());
		assert.equal(restored.state.id.jurisdiction, jurisdiction);
	}
	const id = createDurableObjectIdScope({ namespaceKey }).idFromName("bob");
	const waited: Promise<unknown>[] = [];
	const generation = runningDurableObjectGeneration(
		await registration.definition.config.createVars({
			key: [...durableObjectActorKey({ id, jurisdiction: undefined })],
			vars: undefined,
			waitUntil: (promise) => waited.push(promise),
		}),
	);
	const background = Promise.resolve("done");
	generation.state.waitUntil(background);
	assert.deepEqual(waited, [background]);
	assert.equal(
		registration.definition.config.options.createVarsTimeout,
		31_000,
	);
});

test("dispatches only the private RPC and user WebSocket slots", async () => {
	const calls: string[] = [];
	const socket: RivetWebSocket = {
		addEventListener: () => undefined,
		binaryType: "blob",
		close(code?: number, reason?: string): void {
			calls.push(`close:${code ?? "none"}:${reason ?? ""}`);
		},
		readyState: 1,
		removeEventListener: () => undefined,
		send: () => undefined,
	};
	const socketRoutes: DurableObjectRouteHandlers = {
		...routes,
		rpcWebSocket(generation): void {
			calls.push(`rpc:${generation.className}`);
		},
		webSocket(generation): void {
			calls.push(`websocket:${generation.className}`);
		},
	};

	await dispatchDurableObjectPrivateWebSocket(
		counterGeneration,
		new Request(`http://actor${durableObjectPrivateRoutes.rpc}`),
		socket,
		socketRoutes,
	);
	await dispatchDurableObjectPrivateWebSocket(
		counterGeneration,
		new Request(`http://actor/websocket${durableObjectPrivateRoutes.rpc}`),
		socket,
		socketRoutes,
	);
	await dispatchDurableObjectPrivateWebSocket(
		counterGeneration,
		new Request(`http://actor${durableObjectPrivateRoutes.webSocket}`),
		socket,
		socketRoutes,
	);
	await dispatchDurableObjectPrivateWebSocket(
		counterGeneration,
		new Request("http://actor/public"),
		socket,
		socketRoutes,
	);

	assert.deepEqual(calls, [
		"rpc:Counter",
		"rpc:Counter",
		"websocket:Counter",
		"close:1008:Unknown OpenOrange Durable Object route: /public",
	]);
});

test("dispatches only the private fetch and RPC request slots", async () => {
	const fetchResponse = await dispatchDurableObjectPrivateRequest(
		counterGeneration,
		new Request(`http://actor${durableObjectPrivateRoutes.fetch}`),
		routes,
	);
	assert.equal(await fetchResponse.text(), "fetch:Counter");

	const rpcResponse = await dispatchDurableObjectPrivateRequest(
		counterGeneration,
		new Request(`http://actor${durableObjectPrivateRoutes.rpc}`),
		routes,
	);
	assert.equal(await rpcResponse.text(), "rpc:Counter");

	const missingResponse = await dispatchDurableObjectPrivateRequest(
		counterGeneration,
		new Request("http://actor/public"),
		routes,
	);
	assert.equal(missingResponse.status, 404);
});
