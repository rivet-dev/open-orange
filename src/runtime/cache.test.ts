import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { isRecord } from "../unknown-values.js";

// Drives the Cache API through a real `orange dev` process and real HTTP. The
// fixture Worker maps each route to one caches.default or caches.open() call.

const cliEntrypoint = fileURLToPath(new URL("../bin.ts", import.meta.url));
const fixtureWorker = fileURLToPath(new URL("./fixtures/cache/worker.js", import.meta.url));
const kib = 1024;

interface DevServer {
	origin: string;
	stop(): Promise<void>;
}

function stopChild(child: ChildProcess): Promise<void> {
	return new Promise<void>((resolveStop) => {
		if (child.exitCode !== null || child.signalCode !== null) {
			resolveStop();
			return;
		}
		const timeout = setTimeout(() => child.kill("SIGKILL"), 15_000);
		child.once("exit", () => {
			clearTimeout(timeout);
			resolveStop();
		});
		child.kill("SIGINT");
	});
}

async function startDev(projectRoot: string, env: Record<string, string> = {}): Promise<DevServer> {
	const child: ChildProcess = spawn(
		process.execPath,
		[
			"--import",
			"tsx",
			cliEntrypoint,
			"dev",
			"--config",
			join(projectRoot, "wrangler.json"),
			"--port",
			"0",
			"--ip",
			"127.0.0.1",
			"--show-interactive-dev-session=false",
		],
		{
			env: { ...process.env, ...env, CI: "1", NO_COLOR: "1" },
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	let output = "";
	const port = await new Promise<number>((resolveReady, rejectReady) => {
		const timeout = setTimeout(
			() => rejectReady(new Error(`orange dev readiness timed out: ${output}`)),
			60_000,
		);
		const onData = (data: unknown): void => {
			output += String(data);
			const match = /Local\s+http:\/\/127\.0\.0\.1:(\d+)/.exec(output);
			if (match?.[1] !== undefined) {
				clearTimeout(timeout);
				resolveReady(Number(match[1]));
			}
		};
		child.stdout?.on("data", onData);
		child.stderr?.on("data", onData);
		child.once("exit", (code) => {
			clearTimeout(timeout);
			rejectReady(new Error(`orange dev exited before readiness (code ${code}): ${output}`));
		});
	});
	return { origin: `http://127.0.0.1:${port}`, stop: () => stopChild(child) };
}

async function createProject(): Promise<string> {
	const projectRoot = await mkdtemp(join(tmpdir(), "open-orange-cache-"));
	await cp(fixtureWorker, join(projectRoot, "worker.js"));
	await writeFile(
		join(projectRoot, "wrangler.json"),
		JSON.stringify({ compatibility_date: "2026-09-03", main: "./worker.js", name: "cache-e2e" }),
	);
	return projectRoot;
}

function query(parameters: Record<string, string>): string {
	return new URLSearchParams(parameters).toString();
}

// Fixture headers: x-res-* go on the stored response, x-req-* on the match request.
function prefixed(prefix: string, headers: Record<string, string>): Record<string, string> {
	return Object.fromEntries(Object.entries(headers).map(([name, value]) => [`${prefix}${name}`, value]));
}

describe("Cache API through orange dev", { timeout: 300_000 }, () => {
	let projectRoot = "";
	let server: DevServer | undefined;
	const origin = (): string => {
		if (server === undefined) throw new Error("orange dev is not running");
		return server.origin;
	};
	const put = async (
		url: string,
		body: Uint8Array | string,
		headers: Record<string, string>,
		extra: Record<string, string> = {},
		requestHeaders: Record<string, string> = {},
	): Promise<Response> =>
		await fetch(`${origin()}/put?${query({ url, ...extra })}`, {
			body,
			headers: { ...prefixed("x-res-", headers), ...prefixed("x-req-", requestHeaders) },
			method: "POST",
		});
	const match = async (
		url: string,
		headers: Record<string, string> = {},
		extra: Record<string, string> = {},
	): Promise<Response> =>
		await fetch(`${origin()}/match?${query({ url, ...extra })}`, {
			headers: prefixed("x-req-", headers),
		});
	const remove = async (url: string): Promise<boolean> => {
		const response = await fetch(`${origin()}/delete?${query({ url })}`, { method: "POST" });
		const body: unknown = await response.json();
		assert.ok(isRecord(body) && typeof body.deleted === "boolean", JSON.stringify(body));
		return body.deleted;
	};
	const fresh = { "cache-control": "public, max-age=3600", "content-type": "text/plain" };

	before(async () => {
		projectRoot = await createProject();
		server = await startDev(projectRoot);
	});

	after(async () => {
		await server?.stop();
		await rm(projectRoot, { force: true, recursive: true });
	});

	it("when a fresh response is put, match returns its body with cf-cache-status HIT in that cache only", async () => {
		const url = "https://example.com/hit";
		assert.equal((await put(url, "cached body", fresh)).status, 204);
		const hit = await match(url);
		assert.equal(hit.status, 200);
		assert.equal(hit.headers.get("cf-cache-status"), "HIT");
		assert.equal(hit.headers.get("content-type"), "text/plain");
		assert.equal(await hit.text(), "cached body");
		const otherCache = await match(url, {}, { cache: "other" });
		assert.equal(otherCache.headers.get("x-match"), "miss");
		await otherCache.body?.cancel();
		// A POST misses unless ignoreMethod treats it as a GET.
		const post = await match(url, {}, { method: "POST" });
		assert.equal(post.headers.get("x-match"), "miss");
		await post.body?.cancel();
		const ignored = await match(url, {}, { ignoreMethod: "", method: "POST" });
		assert.equal(await ignored.text(), "cached body");
	});

	it("when an entry's max-age passes, match misses and delete returns false", async () => {
		const url = "https://example.com/short";
		await put(url, "short-lived", { "cache-control": "max-age=1" });
		assert.equal(await (await match(url)).text(), "short-lived");
		await delay(1_500);
		const expired = await match(url);
		assert.equal(expired.headers.get("x-match"), "miss");
		await expired.body?.cancel();
		assert.equal(await remove(url), false);
	});

	it("when a live entry is deleted, delete returns true once and match misses", async () => {
		const url = "https://example.com/deleted";
		await put(url, "to delete", fresh);
		assert.equal(await remove(url), true);
		assert.equal(await remove(url), false);
		const after = await match(url);
		assert.equal(after.headers.get("x-match"), "miss");
		await after.body?.cancel();
	});

	it("when the response has no-store, private, or Set-Cookie, match misses", async () => {
		const uncacheable: Record<string, Record<string, string>> = {
			"https://example.com/no-store": { "cache-control": "no-store" },
			"https://example.com/private": { "cache-control": "private, max-age=3600" },
			"https://example.com/cookie": { ...fresh, "set-cookie": "session=1" },
		};
		for (const [url, headers] of Object.entries(uncacheable)) {
			assert.equal((await put(url, "secret", headers)).status, 204);
			const missed = await match(url);
			assert.equal(missed.headers.get("x-match"), "miss", url);
			await missed.body?.cancel();
		}
		// private=Set-Cookie stores the response without the cookie.
		const url = "https://example.com/cookie-stripped";
		await put(url, "public part", {
			"cache-control": "public, max-age=3600, private=Set-Cookie",
			"set-cookie": "session=1",
		});
		const stripped = await match(url);
		assert.equal(stripped.headers.get("set-cookie"), null);
		assert.equal(await stripped.text(), "public part");
	});

	it("when a Worker puts a clone of a response that is not stored, put resolves and the original body still arrives", async () => {
		for (const headers of [{ "cache-control": "no-store" }, { "cache-control": "private, max-age=3600" }]) {
			const response = await fetch(`${origin()}/proxy?${query({ url: "https://example.com/proxied" })}`, {
				body: "live body",
				headers: prefixed("x-res-", headers),
				method: "POST",
				signal: AbortSignal.timeout(10_000),
			});
			assert.equal(response.status, 200);
			assert.equal(await response.text(), "live body");
		}
	});

	it("when a Worker streams a body into puts that do not store it, its writes and the puts succeed", async () => {
		const response = await fetch(`${origin()}/put-streamed?${query({ url: "https://example.com/streamed" })}`);
		assert.equal(response.status, 200);
		assert.deepEqual(await response.json(), ["fulfilled", "fulfilled"]);
	});

	it("when the request matches the ETag or Last-Modified, match returns 304 without a body", async () => {
		const url = "https://example.com/conditional";
		await put(url, "validated", {
			...fresh,
			etag: '"v1"',
			"last-modified": "Wed, 21 Oct 2020 07:28:00 GMT",
		});
		const byEtag = await match(url, { "if-none-match": 'W/"v0", "v1"' });
		assert.equal(byEtag.status, 304);
		assert.equal(byEtag.headers.get("cf-cache-status"), "HIT");
		assert.equal(await byEtag.text(), "");
		const byDate = await match(url, { "if-modified-since": "Thu, 22 Oct 2020 07:28:00 GMT" });
		assert.equal(byDate.status, 304);
		await byDate.body?.cancel();
		const changed = await match(url, { "if-none-match": '"v2"' });
		assert.equal(changed.status, 200);
		assert.equal(await changed.text(), "validated");
	});

	it("when the response has Vary, match still answers a request with other values of those headers, as on Cloudflare", async () => {
		const url = "https://example.com/vary";
		const varied = { ...fresh, vary: "Accept-Language" };
		await put(url, "english", varied, {}, { "accept-language": "en" });
		const others: Record<string, string>[] = [{ "accept-language": "en" }, { "accept-language": "fr" }, {}];
		for (const headers of others) {
			const hit = await match(url, headers);
			assert.equal(hit.headers.get("cf-cache-status"), "HIT", JSON.stringify(headers));
			assert.equal(hit.headers.get("vary"), "Accept-Language");
			assert.equal(await hit.text(), "english");
		}
		// A key holds one entry, so a put for another value replaces it.
		await put(url, "french", varied, {}, { "accept-language": "fr" });
		for (const headers of others) {
			const hit = await match(url, headers);
			assert.equal(await hit.text(), "french", JSON.stringify(headers));
		}
	});

	it("when the request has a Range, match returns 206 with exactly those bytes, and 416 past the end", async () => {
		const url = "https://example.com/range";
		// Three storage chunks, so the range crosses chunk boundaries.
		const body = randomBytes(1_300 * kib);
		await put(url, body, fresh);
		const partial = await match(url, { range: "bytes=500000-1100000" });
		assert.equal(partial.status, 206);
		assert.equal(partial.headers.get("content-range"), `bytes 500000-1100000/${body.byteLength}`);
		assert.deepEqual(Buffer.from(await partial.arrayBuffer()), body.subarray(500_000, 1_100_001));
		const suffix = await match(url, { range: "bytes=-10" });
		assert.equal(suffix.status, 206);
		assert.deepEqual(Buffer.from(await suffix.arrayBuffer()), body.subarray(body.byteLength - 10));
		const unsatisfiable = await match(url, { range: `bytes=${body.byteLength}-` });
		assert.equal(unsatisfiable.status, 416);
		assert.equal(unsatisfiable.headers.get("content-range"), `bytes */${body.byteLength}`);
		await unsatisfiable.body?.cancel();
	});

	it("when puts of different bodies race on one URL, every match returns one complete body", async () => {
		const url = "https://example.com/race";
		const size = 1_200 * kib;
		const bodies = Array.from({ length: 6 }, (_, index) => Buffer.alloc(size, 0x41 + index));
		const reads: Promise<Buffer | undefined>[] = [];
		const puts = bodies.map(async (body) => {
			assert.equal((await put(url, body, fresh)).status, 204);
		});
		for (let index = 0; index < 12; index += 1) {
			reads.push(
				(async () => {
					await delay(index * 50);
					const response = await match(url);
					if (response.headers.get("x-match") === "miss") {
						await response.body?.cancel();
						return undefined;
					}
					return Buffer.from(await response.arrayBuffer());
				})(),
			);
		}
		await Promise.all(puts);
		const results = [...(await Promise.all(reads)), Buffer.from(await (await match(url)).arrayBuffer())];
		const hits = results.filter((result): result is Buffer => result !== undefined);
		assert.ok(hits.length > 0);
		for (const hit of hits) {
			assert.equal(hit.byteLength, size);
			assert.ok(
				bodies.some((body) => body.equals(hit)),
				`torn body starting with ${hit.subarray(0, 4).toString("hex")}`,
			);
		}
	});

	it("when put gets a non-GET request, a 206, or Vary: *, it throws workerd's TypeError", async () => {
		const url = "https://example.com/invalid";
		const post = await put(url, "x", fresh, { method: "POST" });
		assert.equal(await post.text(), "TypeError: Cannot cache response to non-GET request.");
		const partial = await put(url, "x", fresh, { status: "206" });
		assert.equal(
			await partial.text(),
			"TypeError: Cannot cache response to a range request (206 Partial Content).",
		);
		const vary = await put(url, "x", { ...fresh, vary: "*" });
		assert.equal(await vary.text(), "TypeError: Cannot cache response with 'Vary: *' header.");
	});

	it("when orange dev restarts, a stored entry still matches", async () => {
		const url = "https://example.com/durable";
		const body = randomBytes(700 * kib);
		await put(url, body, fresh);
		await server?.stop();
		server = undefined;
		server = await startDev(projectRoot);
		const hit = await match(url);
		assert.equal(hit.headers.get("cf-cache-status"), "HIT");
		assert.deepEqual(Buffer.from(await hit.arrayBuffer()), body);
	});
});

describe("Cache API with ORANGE_CACHE=off", { timeout: 120_000 }, () => {
	let projectRoot = "";
	let server: DevServer | undefined;

	before(async () => {
		projectRoot = await createProject();
		server = await startDev(projectRoot, { ORANGE_CACHE: "off" });
	});

	after(async () => {
		await server?.stop();
		await rm(projectRoot, { force: true, recursive: true });
	});

	it("when a response is put, match misses and delete returns false, as on workers.dev", async () => {
		const origin = server?.origin ?? "";
		const put = await fetch(`${origin}/put`, {
			body: "dropped",
			headers: { "x-res-cache-control": "public, max-age=3600" },
			method: "POST",
		});
		assert.equal(put.status, 204);
		const missed = await fetch(`${origin}/match`);
		assert.equal(missed.headers.get("x-match"), "miss");
		await missed.body?.cancel();
		const deleted = await fetch(`${origin}/delete`, { method: "POST" });
		assert.deepEqual(await deleted.json(), { deleted: false });
	});
});
