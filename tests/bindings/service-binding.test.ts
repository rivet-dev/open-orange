import assert from "node:assert/strict";
import test from "node:test";

import { withOrangeDev } from "../harness/orange-dev.js";

test("calls a named entrypoint over a self service binding with workerd RPC semantics", async () => {
	await withOrangeDev("service-binding", async (dev) => {
		const response = await fetch(`${dev.origin}/`);
		assert.equal(response.status, 200);
		assert.deepEqual(await response.json(), {
			// A disposed stub fails instead of reaching the target.
			afterDispose: "RPC stub used after being disposed.",
			aggregateFailure: { message: "every calculation failed", name: "AggregateError" },
			// The callee mutates its own clone of the argument.
			calleeSize: 2,
			callerSize: 1,
			// A thrown error keeps its type and own properties and is marked remote.
			failure: { code: 7, message: "calculator failed", name: "TypeError", remote: true },
			// Overlapping calls each get a new entrypoint instance.
			overlapping: [1, 1],
			pipelined: 7,
		});
	});
});
