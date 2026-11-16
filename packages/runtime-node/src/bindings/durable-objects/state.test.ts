import assert from "node:assert/strict";
import test from "node:test";

import {
	DurableObject,
	type DurableObjectState,
} from "../../modules/cloudflare-workers/durable-object.js";
import { WebSocketPair } from "../../globals/websocket.js";
import type { RivetActorConnection } from "../../internal/rivetkit.js";
import { durableObjectAbortRetriesAlarm } from "./abort.js";
import { DurableObjectHibernatableWebSocketStore } from "./hibernatable-websockets.js";
import { createDurableObjectIdScope } from "./id.js";
import {
	createDurableObjectGeneration,
	disposeDurableObjectGeneration,
} from "./state.js";

test("waits for constructor startup blocks before admitting events", async () => {
	const release = Promise.withResolvers<void>();
	const entered = Promise.withResolvers<void>();
	class StartupObject extends DurableObject {
		initialized = false;

		constructor(ctx: DurableObjectState, env: unknown) {
			super(ctx, env);
			void ctx.blockConcurrencyWhile(async () => {
				entered.resolve();
				await release.promise;
				this.initialized = true;
			});
		}

		outsideStartup(): Promise<void> {
			return this.ctx.blockConcurrencyWhile(async () => undefined);
		}
	}

	const generation = createDurableObjectGeneration({
		bindings: {},
		className: "StartupObject",
		userClass: StartupObject,
	});
	await entered.promise;
	assert.equal(
		await Promise.race([
			generation.ready.then(() => "ready"),
			new Promise<string>((resolve) => setImmediate(() => resolve("pending"))),
		]),
		"pending",
	);
	release.resolve();
	await generation.ready;
	const instance = generation.instance;
	assert.ok(instance instanceof StartupObject);
	assert.equal(instance.initialized, true);
	assert.equal(await instance.outsideStartup(), undefined);
});

test("fails generation startup even when user code observes a rejected block", async () => {
	class FailedStartupObject extends DurableObject {
		constructor(ctx: DurableObjectState, env: unknown) {
			super(ctx, env);
			void ctx
				.blockConcurrencyWhile(async () => {
					throw new Error("startup failed");
				})
				.catch(() => undefined);
		}
	}

	const generation = createDurableObjectGeneration({
		bindings: {},
		className: "FailedStartupObject",
		userClass: FailedStartupObject,
	});
	await assert.rejects(generation.ready, /startup failed/);
});

test("restores hibernatable sockets before the user constructor runs", async () => {
	const connection: RivetActorConnection = {
		id: "restored",
		isHibernatable: true,
		state: null,
	};
	const original = new DurableObjectHibernatableWebSocketStore();
	const pair = new WebSocketPair();
	original.acceptWebSocket(pair[1]);
	pair[1].serializeAttachment({ id: "fixture" });
	assert.equal(original.bindConnection(pair[0], connection), true);

	class RestoredObject extends DurableObject {
		readonly restoredSocket;

		constructor(ctx: DurableObjectState, env: unknown) {
			super(ctx, env);
			this.restoredSocket = ctx.getWebSockets()[0];
		}
	}
	const generation = createDurableObjectGeneration({
		bindings: {},
		className: "RestoredObject",
		hibernatableConnections: [connection],
		userClass: RestoredObject,
	});
	await generation.ready;
	const instance = generation.instance;
	assert.ok(instance instanceof RestoredObject);
	const restored = generation.hibernatableWebSockets.restoreConnection(connection);
	assert.ok(restored);
	assert.equal(instance.restoredSocket, restored.userSocket);
});

test("exposes the object id, delegates waitUntil, and diagnoses excluded state", async () => {
	const id = createDurableObjectIdScope({ namespaceKey: "state-test" }).idFromName(
		"object",
	);
	const pending: Promise<unknown>[] = [];
	const generation = createDurableObjectGeneration({
		bindings: {},
		className: "StateObject",
		stateRuntime: {
			id,
			waitUntil: (promise) => pending.push(promise),
		},
		userClass: class StateObject extends DurableObject {},
	});
	await generation.ready;
	assert.equal(generation.state.id, id);
	const task = Promise.resolve("complete");
	generation.state.waitUntil(task);
	assert.deepEqual(pending, [task]);
	assert.deepEqual(generation.state.props, {});
	assert.throws(() => generation.state.facets, /facets is not implemented/);
	assert.equal(generation.state.container, undefined);
});

test("makes abort uncatchable at the event boundary and poisons the generation", async () => {
	const resets: Error[] = [];
	class AbortObject extends DurableObject {
		catchAbort(): string {
			try {
				this.ctx.abort("reset fixture", { retryAlarm: false });
			} catch {}
			return "caught";
		}
	}
	const generation = createDurableObjectGeneration({
		bindings: {},
		className: "AbortObject",
		stateRuntime: { requestReset: (error) => resets.push(error) },
		userClass: AbortObject,
	});
	await generation.ready;
	const instance = generation.instance;
	assert.ok(instance instanceof AbortObject);
	await assert.rejects(
		generation.stateController.runEvent(() => instance.catchAbort()),
		(error: unknown) => {
			assert.ok(error instanceof Error);
			assert.equal(error.message, "reset fixture");
			assert.equal(durableObjectAbortRetriesAlarm(error), false);
			return true;
		},
	);
	assert.equal(resets.length, 1);
	await assert.rejects(
		generation.stateController.runEvent(() => "later"),
		/reset fixture/,
	);
});

test("revokes state capabilities when its generation is disposed", async () => {
	const generation = createDurableObjectGeneration({
		bindings: {},
		className: "DisposedObject",
		userClass: class DisposedObject extends DurableObject {},
	});
	await generation.ready;
	await disposeDurableObjectGeneration(generation);
	assert.throws(
		() => generation.state.waitUntil(Promise.resolve()),
		/generation is no longer active/,
	);
});
