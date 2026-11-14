import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

import { DurableObjectHibernationLifecycle } from "./hibernation-lifecycle.js";
import { DurableObjectStateController } from "./state.js";

test(
	"requests sleep after a resettable hibernation idle deadline",
	{ timeout: 1_000 },
	async () => {
		let sleepRequests = 0;
		const lifecycle = new DurableObjectHibernationLifecycle(10);
		const requested = new Promise<void>((resolve) => {
			lifecycle.bind(() => {
				sleepRequests++;
				resolve();
			});
		});
		lifecycle.eventSettled();
		await requested;
		// Past a second idle deadline, so a repeated request would show.
		await delay(20);
		assert.equal(sleepRequests, 1);
		lifecycle.dispose();
	},
);

test("requests sleep immediately after an event timeout", async () => {
	let sleepRequests = 0;
	const lifecycle = new DurableObjectHibernationLifecycle(50);
	lifecycle.bind(() => sleepRequests++);
	lifecycle.eventTimedOut();
	assert.equal(sleepRequests, 1);
	// Past the 50 ms idle deadline, so a second request would show.
	await delay(60);
	assert.equal(sleepRequests, 1);
	lifecycle.dispose();
});

test("does not sleep while a standard WebSocket keeps the actor awake", { timeout: 1_000 }, async () => {
	let sleepRequests = 0;
	let releaseStandardSocket: (() => void) | undefined;
	const standardSocket = new Promise<void>((resolve) => {
		releaseStandardSocket = resolve;
	});
	const requested = Promise.withResolvers<void>();
	const lifecycle = new DurableObjectHibernationLifecycle(20);
	lifecycle.bind(() => {
		sleepRequests++;
		requested.resolve();
	});
	lifecycle.preventSleepUntil(standardSocket, "standard-websocket");
	await delay(30);
	assert.equal(sleepRequests, 0);
	releaseStandardSocket?.();
	await requested.promise;
	assert.equal(sleepRequests, 1);
	lifecycle.dispose();
});

test("does not sleep while a Durable Object event is in flight", { timeout: 1_000 }, async () => {
	let sleepRequests = 0;
	const requested = Promise.withResolvers<void>();
	const lifecycle = new DurableObjectHibernationLifecycle(20);
	const controller = new DurableObjectStateController(
		{},
		undefined,
		undefined,
		lifecycle,
	);
	await controller.finishConstruction();
	lifecycle.bind(() => {
		sleepRequests++;
		requested.resolve();
	});
	const release = Promise.withResolvers<void>();
	const event = controller.runEvent(() => release.promise);
	await delay(40);
	assert.equal(sleepRequests, 0);
	release.resolve();
	await event;
	await requested.promise;
	assert.equal(sleepRequests, 1);
	lifecycle.dispose();
});
