import assert from "node:assert/strict";
import { setInterval as nativeSetInterval, setTimeout as nativeSetTimeout } from "node:timers";
import test from "node:test";
import { clearInterval, clearTimeout } from "./timers.js";

test("clearTimeout cancels a native handle retained before Worker global installation", async () => {
	let fired = false;
	const timer = nativeSetTimeout(() => { fired = true; }, 5);
	clearTimeout(timer as unknown as Parameters<typeof clearTimeout>[0]);
	await new Promise<void>((resolve) => nativeSetTimeout(resolve, 25));
	assert.equal(fired, false);
});

test("clearInterval cancels a native interval retained before Worker global installation", async () => {
	let count = 0;
	const timer = nativeSetInterval(() => { count++; }, 5);
	clearInterval(timer as unknown as Parameters<typeof clearInterval>[0]);
	await new Promise<void>((resolve) => nativeSetTimeout(resolve, 25));
	assert.equal(count, 0);
});
