import assert from "node:assert/strict";
import test from "node:test";

import type { RivetWebSocket } from "../../../internal/rivetkit.js";
import { DurableObject } from "../../../modules/cloudflare-workers/durable-object.js";
import {
	createDurableObjectActorDefinitions,
	type DurableObjectRouteHandlers,
	runningDurableObjectGeneration,
} from "../registry.js";
import {
	disposeRpcValueExternals,
	encodeRpcValue,
} from "./codec.js";
import {
	DurableObjectRpcContinuationStore,
	type DurableObjectRpcContinuation,
} from "./continuations.js";
import {
	DurableObjectRpcHttpTarget,
	handleDurableObjectRpcHttp,
} from "./http.js";
import {
	callDurableObjectRpc,
	DurableObjectRpcSessionTarget,
	type DurableObjectRpcSessionConnector,
} from "./session.js";
import { DurableObjectRpcTarget } from "./target.js";
import { attachDurableObjectRpcSessionWebSocket } from "./websocket.js";
import { createLinkedTestWebSocketPair } from "./test-websocket.js";

class FailingWebSocket implements RivetWebSocket {
	binaryType: "arraybuffer" | "blob" = "blob";
	readonly readyState = 1;

	addEventListener(): void {
		throw new Error("fixture upgrade failure");
	}

	close(): void {}
	removeEventListener(): void {}
	send(): void {}
}

class DisposableTarget extends DurableObjectRpcTarget {
	disposals = 0;

	ping(value: string): string {
		return `pong:${value}`;
	}

	[Symbol.dispose](): void {
		this.disposals += 1;
	}
}

function createConnector(
	handler: (value: unknown) => unknown | Promise<unknown>,
	continuations: DurableObjectRpcContinuationStore,
	onOpen: (continuation: DurableObjectRpcContinuation | undefined) => void,
	onRelease: () => void,
): DurableObjectRpcSessionConnector {
	return {
		async open(continuation) {
			onOpen(continuation);
			const [clientSocket, serverSocket] = createLinkedTestWebSocketPair();
			const target = new DurableObjectRpcSessionTarget(
				handler,
				continuations,
				continuation,
			);
			const attachment = await attachDurableObjectRpcSessionWebSocket(
				serverSocket,
				target,
			);
			return {
				async release(): Promise<void> {
					onRelease();
					await serverSocket.flush();
					await attachment.dispose();
					clientSocket.close(1000, "fixture complete");
					await serverSocket.flush();
				},
				webSocket: clientSocket,
			};
		},
	};
}

function routeFetch(target: DurableObjectRpcHttpTarget): typeof fetch {
	return (input, init) =>
		handleDurableObjectRpcHttp(new Request(input, init), target);
}

function requireObject(value: unknown): object {
	assert.ok(
		(typeof value === "object" && value !== null) ||
			typeof value === "function",
	);
	return value;
}

test("keeps value-only calls on HTTP without opening a WebSocket", async () => {
	const continuations = new DurableObjectRpcContinuationStore();
	const handler = (value: unknown): unknown => ({ value });
	const httpTarget = new DurableObjectRpcHttpTarget(handler, { continuations });
	let opens = 0;
	const connector = createConnector(
		handler,
		continuations,
		() => {
			opens += 1;
		},
		() => undefined,
	);
	const originalFetch = globalThis.fetch;
	globalThis.fetch = routeFetch(httpTarget);
	try {
		const result = await callDurableObjectRpc("hello", {
			connector,
			endpoint: "http://actor/rpc",
		});
		assert.equal(result.transport, "http");
		assert.equal(Reflect.get(requireObject(result.value), "value"), "hello");
		assert.equal(opens, 0);
		await result.dispose();
	} finally {
		globalThis.fetch = originalFetch;
		await continuations.dispose();
	}
});

test("opens a WebSocket immediately for live input externals", async () => {
	const continuations = new DurableObjectRpcContinuationStore();
	let opens = 0;
	let releases = 0;
	const handler = async (value: unknown): Promise<unknown> => {
		const callback = Reflect.get(requireObject(value), "callback");
		assert.equal(typeof callback, "function");
		return await Reflect.apply(callback, undefined, ["server"]);
	};
	const connector = createConnector(
		handler,
		continuations,
		(continuation) => {
			assert.equal(continuation, undefined);
			opens += 1;
		},
		() => {
			releases += 1;
		},
	);
	const result = await callDurableObjectRpc(
		{ callback: (value: string) => `callback:${value}` },
		{ connector, endpoint: "http://unused.invalid/rpc" },
	);
	assert.equal(result.transport, "websocket");
	assert.equal(result.value, "callback:server");
	assert.equal(opens, 1);
	await result.dispose();
	assert.equal(releases, 1);
	await continuations.dispose();
});

test("promotes one executed HTTP result and claims it once", async () => {
	const continuations = new DurableObjectRpcContinuationStore();
	const output = new DisposableTarget();
	let handlerCalls = 0;
	let continuationSeen: DurableObjectRpcContinuation | undefined;
	let releases = 0;
	const handler = (): unknown => {
		handlerCalls += 1;
		return output;
	};
	const connector = createConnector(
		handler,
		continuations,
		(continuation) => {
			continuationSeen = continuation;
		},
		() => {
			releases += 1;
		},
	);
	const httpTarget = new DurableObjectRpcHttpTarget(handler, { continuations });
	const originalFetch = globalThis.fetch;
	globalThis.fetch = routeFetch(httpTarget);
	try {
		const result = await callDurableObjectRpc("input", {
			connector,
			endpoint: "http://actor/rpc",
		});
		assert.equal(result.transport, "websocket");
		assert.equal(handlerCalls, 1);
		assert.ok(continuationSeen);
		assert.equal(continuations.size, 0);
		const ping = Reflect.get(requireObject(result.value), "ping");
		assert.equal(typeof ping, "function");
		assert.equal(await Reflect.apply(ping, result.value, ["claimed"]), "pong:claimed");
		await result.dispose();
		assert.equal(releases, 1);
		assert.equal(handlerCalls, 1);
		assert.equal(output.disposals, 1);
	} finally {
		globalThis.fetch = originalFetch;
		await continuations.dispose();
	}
});

test("expires, rejects duplicate claims, and releases retained externals", async () => {
	const continuations = new DurableObjectRpcContinuationStore({ ttlMs: 10 });
	const expiredTarget = new DisposableTarget();
	continuations.retain(encodeRpcValue(expiredTarget));
	// The store releases an expired continuation on its own timer, which runs late on a loaded host.
	const deadline = Date.now() + 5_000;
	while (expiredTarget.disposals === 0 && Date.now() < deadline) {
		await new Promise<void>((resolve) => setTimeout(resolve, 5));
	}
	assert.equal(continuations.size, 0);
	assert.equal(expiredTarget.disposals, 1);

	const claimedTarget = new DisposableTarget();
	const continuation = continuations.retain(encodeRpcValue(claimedTarget));
	const claimed = continuations.claim(continuation.token);
	assert.throws(
		() => continuations.claim(continuation.token),
		/missing, expired, or claimed/,
	);
	assert.equal(claimedTarget.disposals, 0);
	await disposeRpcValueExternals(claimed);
	assert.equal(claimedTarget.disposals, 1);
	await continuations.dispose();
});

test("releases an unclaimed result on disconnect or failed attachment", async () => {
	const disconnectedStore = new DurableObjectRpcContinuationStore();
	const disconnectedTarget = new DisposableTarget();
	const disconnected = disconnectedStore.retain(
		encodeRpcValue(disconnectedTarget),
	);
	const [, serverSocket] = createLinkedTestWebSocketPair();
	const sessionTarget = new DurableObjectRpcSessionTarget(
		(value) => value,
		disconnectedStore,
		disconnected,
	);
	await attachDurableObjectRpcSessionWebSocket(serverSocket, sessionTarget);
	serverSocket.close(1006, "fixture disconnect");
	await serverSocket.flush();
	assert.equal(disconnectedStore.size, 0);
	assert.equal(disconnectedTarget.disposals, 1);

	const failedStore = new DurableObjectRpcContinuationStore();
	const failedTarget = new DisposableTarget();
	const failed = failedStore.retain(encodeRpcValue(failedTarget));
	await assert.rejects(
		attachDurableObjectRpcSessionWebSocket(
			new FailingWebSocket(),
			new DurableObjectRpcSessionTarget(
				(value) => value,
				failedStore,
				failed,
			),
		),
		/fixture upgrade failure/,
	);
	assert.equal(failedStore.size, 0);
	assert.equal(failedTarget.disposals, 1);
	await disconnectedStore.dispose();
	await failedStore.dispose();
});

test("releases a promoted result when the client upgrade fails", async () => {
	const continuations = new DurableObjectRpcContinuationStore();
	const target = new DisposableTarget();
	let handlerCalls = 0;
	const handler = (): unknown => {
		handlerCalls += 1;
		return target;
	};
	const httpTarget = new DurableObjectRpcHttpTarget(handler, { continuations });
	const connector: DurableObjectRpcSessionConnector = {
		open(): never {
			throw new Error("fixture connector failure");
		},
	};
	const originalFetch = globalThis.fetch;
	globalThis.fetch = routeFetch(httpTarget);
	try {
		await assert.rejects(
			callDurableObjectRpc("input", {
				connector,
				endpoint: "http://actor/rpc",
			}),
			/fixture connector failure/,
		);
		assert.equal(handlerCalls, 1);
		assert.equal(continuations.size, 0);
		assert.equal(target.disposals, 1);
	} finally {
		globalThis.fetch = originalFetch;
		await continuations.dispose();
	}
});

test("releases continuations when a Rivet actor generation ends", async () => {
	class FixtureObject extends DurableObject {}
	const routes: DurableObjectRouteHandlers = {
		fetch: () => new Response("not used"),
		rpc: () => new Response("not used"),
		rpcWebSocket: () => undefined,
		webSocket: () => undefined,
	};
	const registrations = createDurableObjectActorDefinitions({
		classes: new Map([["FixtureObject", FixtureObject]]),
		deploymentIdentity: "fixture:development",
		routes,
	});
	const registration = registrations.values().next().value;
	assert.ok(registration);
	const generation = await registration.definition.config.createVars();
	const value = runningDurableObjectGeneration(generation);
	const continuations = Reflect.get(value, "rpcContinuations");
	assert.ok(continuations instanceof DurableObjectRpcContinuationStore);
	const target = new DisposableTarget();
	continuations.retain(encodeRpcValue(target));
	const onSleep = registration.definition.config.onSleep;
	assert.ok(onSleep);
	await onSleep({ vars: generation });
	assert.equal(continuations.size, 0);
	assert.equal(target.disposals, 1);
	const onDestroy = registration.definition.config.onDestroy;
	assert.ok(onDestroy);
	await onDestroy({ vars: generation });

	const destroyedGeneration = await registration.definition.config.createVars();
	const destroyedValue = runningDurableObjectGeneration(destroyedGeneration);
	const destroyedContinuations = Reflect.get(
		destroyedValue,
		"rpcContinuations",
	);
	assert.ok(
		destroyedContinuations instanceof DurableObjectRpcContinuationStore,
	);
	const destroyedTarget = new DisposableTarget();
	destroyedContinuations.retain(encodeRpcValue(destroyedTarget));
	await onDestroy({ vars: destroyedGeneration });
	assert.equal(destroyedContinuations.size, 0);
	assert.equal(destroyedTarget.disposals, 1);
});
