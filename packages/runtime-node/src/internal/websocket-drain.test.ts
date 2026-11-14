import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { drainWebSockets } from "./websocket-drain.js";

test("disconnecting clients cancel pending drain timers", async () => {
	const random = Math.random;
	Math.random = () => 1;
	try {
	let resolveClosed!: () => void;
	const closed = new Promise<void>((resolve) => { resolveClosed = resolve; });
	let calls = 0;
	const closers = Array.from({ length: 100 }, () => Object.assign(async () => { calls++; }, { closed }));
	const started = performance.now();
	const draining = drainWebSockets(closers);
	await delay(20);
	resolveClosed();
	await draining;
	assert.equal(calls, 0, "do not invoke closers after their client has disconnected");
	assert.ok(performance.now() - started < 250, "cancel the original one-second drain timers");
	} finally {
		Math.random = random;
	}
});
