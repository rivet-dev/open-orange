import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import { copyProject, repositoryRoot, startOrangeDev } from "../harness/orange-dev.js";

// The expected values match `wrangler dev` on the same fixture.
test("a Worker encodes and decodes Uint8Array hex and base64 as on workerd, also for a subarray and a pooled Buffer", { timeout: 120_000 }, async () => {
	const project = await copyProject(join(repositoryRoot, "tests", "fixtures", "uint8array-encoding"));
	try {
		const dev = await startOrangeDev(project.directory, "wrangler.jsonc");
		try {
			const response = await fetch(dev.origin);
			const body = await response.text();
			assert.equal(response.status, 200, body);
			assert.deepEqual(JSON.parse(body), {
				pooledBuffer: { hex: "0102ff", base64: "AQL/" },
				subarray: { hex: "02fffe", base64: "Av/+" },
				hex: {
					empty: "",
					fromMixedCase: [1, 171, 255],
					fromOddLength: "SyntaxError",
					fromNonHex: "SyntaxError",
					fromNonString: "TypeError",
					wrongReceiver: "TypeError",
					detached: "TypeError",
				},
				base64: {
					padded: "AQI=",
					omitPadding: "AQI",
					url: "-_8=",
					badAlphabet: "TypeError",
					detached: "TypeError",
					fromWhitespace: [1, 2],
					fromLooseNoPadding: [1, 2],
					fromStrictNoPadding: "SyntaxError",
					fromStrictExtraBits: "SyntaxError",
					fromStopBeforePartial: [1, 2, 3],
					fromUrl: [251, 255],
					fromUrlInStandard: "SyntaxError",
					fromInvalid: "SyntaxError",
				},
				shape: { enumerable: false, toBase64Length: 0, fromBase64Length: 1, constructible: "TypeError" },
			});

			// A subclass's `length`, a Worker's patches, setFromHex(), and setFromBase64().
			const probe = (await (await fetch(`${dev.origin}/probe`)).json()) as { failures: unknown[]; total: number };
			assert.deepEqual(probe.failures, []);
			assert.equal(probe.total, 123);

			// A piece per byte would exhaust the heap at this size, and end the runtime with the request.
			const large = await fetch(`${dev.origin}/large?mib=200`);
			assert.equal(large.status, 200);
			assert.deepEqual(await large.json(), { hex: 419430400, hexEnd: "abab", base64: 279620268, base64End: "q6s=" });
		} finally {
			await dev.close();
		}
	} finally {
		await project.dispose();
	}
});
