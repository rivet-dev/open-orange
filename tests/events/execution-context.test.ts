import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import { copyProject, repositoryRoot, startOrangeDev } from "../harness/orange-dev.js";

async function getJson(origin: string, path: string, output: () => string): Promise<unknown> {
	const response = await fetch(new URL(path, origin));
	assert.equal(response.status, 200, `${await response.clone().text()}\n${output()}`);
	return await response.json();
}

// Expected values are workerd 1.20260903.1's output for the same fixture.
test("a fetch() whose handler is missing, throws, or returns a non-Response rejects with workerd's remote error", { timeout: 120_000 }, async () => {
	const project = await copyProject(join(repositoryRoot, "tests", "fixtures", "execution-context"));
	try {
		const dev = await startOrangeDev(project.directory);
		try {
			const noHandler = { error: { isTypeError: false, message: "Handler does not export a fetch() function.", name: "Error", remote: true } };
			const nonResponse = {
				error: { isTypeError: true, message: "Incorrect type for Promise: the Promise did not resolve to 'Response'.", name: "TypeError", remote: true },
			};
			assert.deepEqual(await getJson(dev.origin, "/no-fetch", dev.output), {
				entrypoint: noHandler,
				durableObject: noHandler,
				nonResponse,
				durableObjectNonResponse: nonResponse,
				thrown: { error: { isTypeError: true, message: "bad input", name: "TypeError", remote: true } },
				thrownCustom: { error: { code: 7, isTypeError: false, message: "over quota", name: "QuotaError", remote: true } },
			});
		} finally {
			await dev.close();
		}
	} finally {
		await project.dispose();
	}
});

test("ctx.passThroughOnException() lets the Worker respond, and a later throw still fails the request", { timeout: 120_000 }, async () => {
	const project = await copyProject(join(repositoryRoot, "tests", "fixtures", "execution-context"));
	try {
		const dev = await startOrangeDev(project.directory);
		try {
			const handled = await fetch(new URL("/pass-through", dev.origin));
			assert.equal(handled.status, 200, dev.output());
			assert.equal(await handled.text(), "handled");

			// With no origin to fall back to, workerd answers the exception with a 500.
			const thrown = await fetch(new URL("/pass-through-then-throw", dev.origin));
			await thrown.body?.cancel();
			assert.equal(thrown.status, 500, dev.output());
		} finally {
			await dev.close();
		}
	} finally {
		await project.dispose();
	}
});

// Expected values are workerd 1.20260903.1's output for the same fixture.
test("ctx.props is an empty object when the caller passes no props, and holds the binding's props otherwise", { timeout: 120_000 }, async () => {
	const project = await copyProject(join(repositoryRoot, "tests", "fixtures", "execution-context"));
	try {
		const dev = await startOrangeDev(project.directory);
		try {
			assert.deepEqual(await getJson(dev.origin, "/props", dev.output), {
				request: {},
				serviceFetch: {},
				entrypoint: {},
				entrypointWithProps: { tenant: "acme" },
			});
		} finally {
			await dev.close();
		}
	} finally {
		await project.dispose();
	}
});

test("copying every ctx property, as Sentry does, reads ctx.cache as undefined", { timeout: 120_000 }, async () => {
	const project = await copyProject(join(repositoryRoot, "tests", "fixtures", "execution-context"));
	try {
		const dev = await startOrangeDev(project.directory);
		try {
			assert.deepEqual(await getJson(dev.origin, "/copy-context", dev.output), {
				access: "undefined",
				cache: "undefined",
				waitUntil: "function",
			});
		} finally {
			await dev.close();
		}
	} finally {
		await project.dispose();
	}
});
