import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { withOrangeDev, type RunningOrangeDev } from "../harness/orange-dev.js";

const mebibyte = 1024 * 1024;

// The fixture's body of `length` bytes: byte i is i % 251.
function expectedHash(length: number): string {
	const body = Buffer.alloc(length);
	for (let i = 0; i < length; i += 1) body[i] = i % 251;
	return createHash("sha256").update(body).digest("hex");
}

interface Download {
	encoding: string | null;
	hash: string;
	length: number;
}

async function download(dev: RunningOrangeDev, way: string, length: number): Promise<Download> {
	// A body that stalls fails here instead of at the test's own timeout.
	const response = await fetch(`${dev.origin}/${way}?n=${length}`, { signal: AbortSignal.timeout(30_000) });
	assert.equal(response.status, 200);
	const body = Buffer.from(await response.arrayBuffer());
	return {
		encoding: response.headers.get("content-encoding"),
		hash: createHash("sha256").update(body).digest("hex"),
		length: body.byteLength,
	};
}

test("a node:http server in a dynamic Worker sends bodies of several megabytes in full", async () => {
	await withOrangeDev("worker-loader-large-body", async (dev) => {
		const length = 5 * mebibyte;
		const whole = { encoding: null, hash: expectedHash(length), length };

		// One res.end() with the whole body.
		assert.deepEqual(await download(dev, "end", length), whole);

		// A stream piped to a response whose writeHead() middleware has wrapped, as the compression
		// middleware of Next.js and Express does. The pipe waits for "drain" after its first 64 KiB.
		assert.deepEqual(await download(dev, "wrapped", length), whole);

		// A body that the server gzipped itself reaches the client encoded once, so the client
		// decodes it to the same bytes.
		assert.deepEqual(await download(dev, "gzip", length), { ...whole, encoding: "gzip" });

		// Two downloads of different bodies at the same time each arrive whole.
		const other = 3 * mebibyte + 1;
		assert.deepEqual(await Promise.all([download(dev, "wrapped", length), download(dev, "wrapped", other)]), [
			whole,
			{ encoding: null, hash: expectedHash(other), length: other },
		]);
	});
});
