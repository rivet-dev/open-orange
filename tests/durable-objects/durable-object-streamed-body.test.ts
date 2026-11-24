import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import test from "node:test";

import { copyProject, repositoryRoot, startOrangeDev } from "../harness/orange-dev.js";

const body = randomBytes(8 * 1024 * 1024);

function describe(bytes: Uint8Array): string {
	return `${bytes.byteLength} ${createHash("sha256").update(bytes).digest("hex")}`;
}

function sized(): RequestInit {
	return { body, method: "POST" };
}

function chunked(): RequestInit {
	const init: RequestInit = {
		body: new ReadableStream<Uint8Array>({
			start(controller) {
				for (let offset = 0; offset < body.byteLength; offset += 64 * 1024) {
					controller.enqueue(body.subarray(offset, offset + 64 * 1024));
				}
				controller.close();
			},
		}),
		method: "POST",
	};
	Reflect.set(init, "duplex", "half");
	return init;
}

// workerd lets an object answer and then read the request body while its answer streams. Orange
// cut the body off at 64 to 128 KiB and ended it as if it were complete, so `git http-backend`
// answering a push failed with `fatal: early EOF`.
test("an object that answers before it reads the request body gets the whole body", { timeout: 180_000 }, async () => {
	const project = await copyProject(join(repositoryRoot, "tests", "fixtures", "durable-object-streamed-body"));
	try {
		const dev = await startOrangeDev(project.directory, "wrangler.jsonc");
		// A call that never answers fails here, so orange dev still stops.
		const call = (path: string, init: RequestInit) =>
			fetch(`${dev.origin}${path}`, { ...init, signal: AbortSignal.timeout(60_000) });
		try {
			for (const [kind, init] of [["sized", sized], ["chunked", chunked]] as const) {
				const answered = await call("/answer-first", init());
				assert.equal(answered.status, 200, kind);
				assert.equal(await answered.text(), `started\n${describe(body)}\n`, kind);

				const echoed = await call("/echo", init());
				assert.equal(echoed.status, 200, kind);
				assert.equal(describe(new Uint8Array(await echoed.arrayBuffer())), describe(body), kind);
			}

			// An object that drops the body unread still answers, and the next call still works.
			const cancelled = await call("/cancel", sized());
			assert.equal(await cancelled.text(), "cancelled\n");
			const next = await call("/answer-first", sized());
			assert.equal(await next.text(), `started\n${describe(body)}\n`);
		} finally {
			await dev.close();
		}
	} finally {
		await project.dispose();
	}
});
