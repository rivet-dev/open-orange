import assert from "node:assert/strict";
import test from "node:test";

import { withOrangeDev } from "../harness/orange-dev.js";

test("a Worker that passes its request on to fetch() gets a redirect back as it is, as on Workers", { timeout: 120_000 }, async () => {
	await withOrangeDev("incoming-redirect", async (dev) => {
		const passed = await fetch(new URL("/pass", dev.origin), { redirect: "manual" });
		assert.equal(passed.status, 302, dev.output());
		assert.equal(passed.headers.get("location"), "/echo");
		assert.equal(passed.headers.get("set-cookie"), "hop=1");

		// A redirect loop reaches the client one hop at a time instead of failing on the server.
		const looped = await fetch(new URL("/loop-pass", dev.origin), { redirect: "manual" });
		assert.equal(looped.status, 302, dev.output());
		assert.equal(looped.headers.get("location"), "/loop-pass");

		// A Worker that asks to follow still follows.
		assert.deepEqual(await (await fetch(new URL("/follow", dev.origin))).json(), {
			body: { redirect: "manual" },
			redirected: true,
		});
	});
});

test("a Durable Object and a service binding get their request with redirect manual, whatever the caller's had", { timeout: 120_000 }, async () => {
	await withOrangeDev("incoming-redirect", async (dev) => {
		assert.deepEqual(await (await fetch(new URL("/object", dev.origin))).json(), { redirect: "manual" });
		assert.deepEqual(await (await fetch(new URL("/service", dev.origin))).json(), { redirect: "manual" });
	});
});
