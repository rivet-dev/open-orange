import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { minioBucketSettings, minioSkip, startMinio } from "../../tests/minio.js";
import { isRecord } from "../../tests/orange-dev.js";
import { freePort } from "../../tests/free-port.js";

// Drives R2 bindings through a real `orange dev` process and real HTTP. The
// same behavioral suite runs against both storage backends: the default
// internal Rivet Actor (chunked blobs in SQLite) and an S3-compatible store
// (a real MinIO server). MinIO runs from OPEN_ORANGE_TEST_MINIO_BINARY when
// set, otherwise as a Docker container; without either, the S3 suite skips.

const cliEntrypoint = fileURLToPath(new URL("../bin.ts", import.meta.url));
const fixtureWorker = fileURLToPath(new URL("./fixtures/r2/worker.js", import.meta.url));
const chunk = 512 * 1024;
const mib = 1024 * 1024;

interface DevServer {
	origin: string;
	output(): string;
	stop(): Promise<void>;
}

// Narrows a parsed JSON response body, so a wrong shape fails the test with the body.
function record(value: unknown): Record<string, unknown> {
	assert.ok(isRecord(value), JSON.stringify(value));
	return value;
}

function stopChild(child: ChildProcess, signal: NodeJS.Signals): Promise<void> {
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
		child.kill(signal);
	});
}

async function startDev(projectRoot: string, env: Record<string, string>): Promise<DevServer> {
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
	return {
		origin: `http://127.0.0.1:${port}`,
		output: () => output,
		stop: () => stopChild(child, "SIGINT"),
	};
}

async function createProject(): Promise<string> {
	const projectRoot = await mkdtemp(join(tmpdir(), "open-orange-r2-"));
	await cp(fixtureWorker, join(projectRoot, "worker.js"));
	await writeFile(
		join(projectRoot, "wrangler.json"),
		JSON.stringify({
			compatibility_date: "2026-09-03",
			main: "./worker.js",
			name: "r2-e2e",
			r2_buckets: [{ binding: "BUCKET", bucket_name: "uploads" }],
		}),
	);
	return projectRoot;
}

function md5(bytes: Uint8Array | string): string {
	return createHash("md5").update(bytes).digest("hex");
}

function sha256(bytes: Uint8Array | string): string {
	return createHash("sha256").update(bytes).digest("hex");
}

interface SuiteContext {
	projectRoot(): string;
	// Starts a new `orange dev` on the same project after the caller stopped
	// the current one.
	restart(): Promise<DevServer>;
	server(): DevServer;
}

interface Backend {
	extraTests(context: SuiteContext): void;
	name: string;
	// Returns the environment that selects the backend, and its cleanup.
	setup(): Promise<{ cleanup(): Promise<void>; env: Record<string, string> }>;
	skip: string | false;
}

const backends: Backend[] = [
	{
		extraTests(context) {
			it("keeps the previous object when orange dev restarts in the middle of a put", async () => {
				const origin = context.server().origin;
				assert.equal((await fetch(`${origin}/put?key=restart`, { body: "committed", method: "PUT" })).status, 200);
				// Send half of a 4 MiB body, then stop the server under the upload.
				const upload = httpRequest(`${origin}/put?key=restart`, {
					headers: { "content-length": String(4 * mib) },
					method: "PUT",
				});
				upload.on("error", () => undefined);
				await new Promise<void>((resolveWrite) => {
					upload.write(randomBytes(2 * mib), () => resolveWrite());
				});
				await context.server().stop();
				upload.destroy();
				const restarted = await context.restart();
				const after = await fetch(`${restarted.origin}/get?key=restart`);
				assert.equal(after.status, 200, restarted.output());
				assert.equal(await after.text(), "committed");
				await fetch(`${restarted.origin}/put?key=restart`, { body: "after restart", method: "PUT" });
				assert.equal(
					await (await fetch(`${restarted.origin}/get?key=restart`)).text(),
					"after restart",
				);
			});
		},
		name: "the default SQLite actor backend",
		async setup() {
			return { cleanup: async () => undefined, env: {} };
		},
		skip: false,
	},
	{
		extraTests() {
			it("fails calls with an R2 internal error that names the endpoint when the S3 store is down", async () => {
				const projectRoot = await createProject();
				const down = await startDev(projectRoot, {
					ORANGE_R2_UPLOADS_S3_ACCESS_KEY_ID: "key",
					// Nothing listens on a port that was just released.
					ORANGE_R2_UPLOADS_S3_ENDPOINT: `http://127.0.0.1:${await freePort()}`,
					ORANGE_R2_UPLOADS_S3_SECRET_ACCESS_KEY: "secret",
				});
				try {
					for (const path of ["/put?key=down", "/head?key=down"]) {
						const response = await fetch(`${down.origin}${path}`, { body: "v", method: "PUT" });
						const body = record(await response.json());
						assert.equal(response.status, 500);
						assert.match(
							String(record(body.error).message),
							/^(put|head): We encountered an internal error\. Please try again\. \(S3 bucket "uploads" at http:\/\/127\.0\.0\.1:\d+: .+\) \(10001\)$/s,
						);
					}
				} finally {
					await down.stop();
					await rm(projectRoot, { force: true, recursive: true });
				}
			});
		},
		name: "the opt-in S3 backend on MinIO",
		async setup() {
			const store = await startMinio();
			const { env } = await minioBucketSettings(store, "uploads");
			return { cleanup: () => store.stop(), env };
		},
		skip: minioSkip,
	},
];

for (const backend of backends) {
	describe(`R2 bindings through orange dev with ${backend.name}`, { skip: backend.skip }, () => {
		let projectRoot: string;
		let server: DevServer;
		let env: Record<string, string> = {};
		let cleanup: () => Promise<void> = async () => undefined;

		async function call(path: string, init?: RequestInit): Promise<{ body: unknown; status: number }> {
			const response = await fetch(`${server.origin}${path}`, init);
			const text = await response.text();
			return { body: text === "" ? null : JSON.parse(text), status: response.status };
		}

		// Returns the stored object, or null when `onlyIf` failed.
		async function putOrNull(key: string, body: Uint8Array | string, options?: unknown): Promise<unknown> {
			const query = options === undefined ? "" : `&options=${encodeURIComponent(JSON.stringify(options))}`;
			const result = await call(`/put?key=${encodeURIComponent(key)}${query}`, { body, method: "PUT" });
			assert.equal(result.status, 200, `${JSON.stringify(result.body)}\n${server.output()}`);
			return result.body;
		}

		async function put(key: string, body: Uint8Array | string, options?: unknown): Promise<Record<string, unknown>> {
			return record(await putOrNull(key, body, options));
		}

		async function getBytes(key: string, options?: unknown): Promise<{ bytes: Buffer; headers: Headers }> {
			const query = options === undefined ? "" : `&options=${encodeURIComponent(JSON.stringify(options))}`;
			const response = await fetch(`${server.origin}/get?key=${encodeURIComponent(key)}${query}`);
			const bytes = Buffer.from(await response.arrayBuffer());
			assert.equal(response.status, 200, `${bytes.toString()}\n${server.output()}`);
			return { bytes, headers: response.headers };
		}

		function errorOf(result: { body: unknown; status: number }): { message: string; name: string } {
			assert.equal(result.status, 500, JSON.stringify(result.body));
			const error = record(record(result.body).error);
			assert.ok(typeof error.message === "string" && typeof error.name === "string");
			return { message: error.message, name: error.name };
		}

		before(async () => {
			const setup = await backend.setup();
			cleanup = setup.cleanup;
			env = setup.env;
			projectRoot = await createProject();
			server = await startDev(projectRoot, env);
		});

		after(async () => {
			try {
				await server?.stop();
			} finally {
				await rm(projectRoot, { force: true, recursive: true });
				await cleanup();
			}
		});

		it("returns byte-equal bodies with MD5 ETags for sizes around the chunk size and above the actor request limit", async () => {
			for (const size of [0, 1, chunk - 1, chunk, chunk + 1, 30 * mib]) {
				const body = randomBytes(size);
				const stored = await put(`size-${size}`, body);
				assert.equal(stored.size, size);
				assert.equal(stored.etag, md5(body));
				const { bytes, headers } = await getBytes(`size-${size}`);
				assert.equal(bytes.length, size);
				assert.ok(bytes.equals(body), `size ${size} round trip differs`);
				assert.equal(headers.get("etag"), `"${md5(body)}"`);
			}
		});

		it("returns a body-less object or null and keeps the stored value when onlyIf fails", async () => {
			const first = await put("conditional", "v1");
			const stale = md5("stale");
			const failedGet = await call(
				`/get?key=conditional&options=${encodeURIComponent(JSON.stringify({ onlyIf: { etagMatches: stale } }))}`,
			);
			assert.equal(failedGet.status, 412);
			assert.equal(record(failedGet.body).hasBody, false);
			assert.equal(record(failedGet.body).etag, first.etag);
			const headerGet = await call(
				`/get?key=conditional&options=${encodeURIComponent(JSON.stringify({ onlyIfHeaders: { "if-none-match": `"${String(first.etag)}"` } }))}`,
			);
			assert.equal(headerGet.status, 412);

			const failedPut = await call(
				`/put?key=conditional&options=${encodeURIComponent(JSON.stringify({ onlyIf: { etagMatches: stale } }))}`,
				{ body: "v2", method: "PUT" },
			);
			assert.deepEqual(failedPut, { body: null, status: 200 });
			assert.equal((await getBytes("conditional")).bytes.toString(), "v1");

			// "Create only if absent" with If-None-Match: *.
			const createOnly = { onlyIfHeaders: { "if-none-match": "*" } };
			assert.notEqual(await putOrNull("create-only", "first", createOnly), null);
			assert.equal(await putOrNull("create-only", "second", createOnly), null);
			assert.equal((await getBytes("create-only")).bytes.toString(), "first");

			assert.notEqual(await putOrNull("conditional", "v2", { onlyIf: { etagMatches: first.etag } }), null);
			assert.equal((await getBytes("conditional")).bytes.toString(), "v2");
		});

		it("returns exactly the requested bytes for ranges that cross a chunk boundary", async () => {
			const body = randomBytes(chunk + 5);
			await put("ranged", body);
			const suffix = await getBytes("ranged", { range: { suffix: 10 } });
			assert.ok(suffix.bytes.equals(body.subarray(body.length - 10)));
			assert.deepEqual(JSON.parse(suffix.headers.get("x-object") ?? "{}").range, {
				length: 10,
				offset: body.length - 10,
			});
			const middle = await getBytes("ranged", { range: { length: 6, offset: chunk - 3 } });
			assert.ok(middle.bytes.equals(body.subarray(chunk - 3, chunk + 3)));
			const header = await getBytes("ranged", { rangeHeader: `bytes=${chunk - 2}-${chunk + 1}` });
			assert.ok(header.bytes.equals(body.subarray(chunk - 2, chunk + 2)));
			const invalid = await call(
				`/get?key=ranged&options=${encodeURIComponent(JSON.stringify({ range: { suffix: 0 } }))}`,
			);
			assert.equal(errorOf(invalid).message, "get: The requested range is not satisfiable (10039)");
		});

		it("never returns a mix of two concurrent puts on one key", async () => {
			const size = 3 * mib;
			const [base, left, right] = ["a", "b", "c"].map((fill) => Buffer.alloc(size, fill));
			assert.ok(base !== undefined && left !== undefined && right !== undefined);
			const versions = [base, left, right];
			const etags = new Set(versions.map((version) => md5(version)));
			await put("race", base);
			const reads = Array.from({ length: 6 }, () => getBytes("race"));
			const writes = [put("race", left), put("race", right)];
			await Promise.all(writes);
			for (const { bytes, headers } of await Promise.all(reads)) {
				assert.equal(bytes.length, size);
				assert.ok(etags.has(md5(bytes)), "a read returned bytes from more than one put");
				assert.equal(headers.get("etag"), `"${md5(bytes)}"`);
			}
			const final = (await getBytes("race")).bytes;
			assert.ok(final.equals(left) || final.equals(right));
		});

		it("rejects a mismatched checksum and keeps the previous value", async () => {
			await put("checked", "before");
			const rejected = await call(
				`/put?key=checked&options=${encodeURIComponent(JSON.stringify({ sha256: sha256("other") }))}`,
				{ body: "value", method: "PUT" },
			);
			assert.equal(
				errorOf(rejected).message,
				[
					"put: The SHA-256 checksum you specified did not match what we received.",
					`You provided a SHA-256 checksum with value: ${sha256("other")}`,
					`Actual SHA-256 was: ${sha256("value")} (10037)`,
				].join("\n"),
			);
			assert.equal((await getBytes("checked")).bytes.toString(), "before");
			await put("checked", "value", { sha256: sha256("value").toUpperCase() });
			const head = await call("/head?key=checked");
			assert.deepEqual(record(head.body).checksums, {
				md5: md5("value"),
				sha256: sha256("value"),
			});
		});

		it("stores HTTP and custom metadata with the case of each key and writes the HTTP metadata to responses", async () => {
			// R2 keeps the case of custom metadata keys. S3 lowercases them.
			const customMetadata = { "Content-Owner": "Sree", owner: "sree", uploadedBy: "cli" };
			const result = await call(
				`/put?key=meta&options=${encodeURIComponent(JSON.stringify({ customMetadata }))}`,
				{ body: "{}", headers: { "x-content-type": "application/json" }, method: "PUT" },
			);
			assert.equal(result.status, 200);
			const head = record((await call("/head?key=meta")).body);
			assert.deepEqual(head.customMetadata, customMetadata);
			assert.equal(record(head.httpMetadata).contentType, "application/json");
			const got = await getBytes("meta");
			assert.equal(got.headers.get("content-type"), "application/json");
			const described: unknown = JSON.parse(got.headers.get("x-object") ?? "null");
			assert.ok(isRecord(described));
			assert.deepEqual(described.customMetadata, customMetadata);
		});

		it("lists keys by prefix with delimiters and cursors", async () => {
			for (const key of ["list/a/1", "list/a/2", "list/b", "list/c"]) await put(key, key);
			const grouped = record((await call(
				`/list?options=${encodeURIComponent(JSON.stringify({ delimiter: "/", prefix: "list/" }))}`,
			)).body);
			assert.ok(Array.isArray(grouped.objects));
			assert.deepEqual(
				grouped.objects.map((object: unknown) => record(object).key),
				["list/b", "list/c"],
			);
			assert.deepEqual(grouped.delimitedPrefixes, ["list/a/"]);
			assert.equal(grouped.truncated, false);
			const keys: unknown[] = [];
			let cursor: unknown;
			do {
				const page = record((await call(
					`/list?options=${encodeURIComponent(JSON.stringify({ cursor, limit: 3, prefix: "list/" }))}`,
				)).body);
				assert.ok(Array.isArray(page.objects));
				keys.push(...page.objects.map((object: unknown) => record(object).key));
				assert.equal(page.truncated, page.cursor !== undefined);
				cursor = page.cursor;
			} while (cursor !== undefined);
			assert.deepEqual(keys, ["list/a/1", "list/a/2", "list/b", "list/c"]);
			const invalid = await call(`/list?options=${encodeURIComponent(JSON.stringify({ limit: 0 }))}`);
			assert.equal(
				errorOf(invalid).message,
				"list: MaxKeys params must be positive integer <= 1000. (10022)",
			);
		});

		it("completes multipart uploads and rejects parts for finished or aborted uploads", async () => {
			const create = async (): Promise<string> =>
				String(record((await call("/multipart/create?key=parts")).body).uploadId);
			const part = async (uploadId: string, number: number, body: Uint8Array) =>
				call(`/multipart/part?key=parts&uploadId=${encodeURIComponent(uploadId)}&part=${number}`, {
					body,
					method: "PUT",
				});
			const complete = async (uploadId: string, parts: unknown) =>
				call(`/multipart/complete?key=parts&uploadId=${encodeURIComponent(uploadId)}`, {
					body: JSON.stringify(parts),
					method: "POST",
				});

			const uploadId = await create();
			const first = Buffer.alloc(5 * mib, "1");
			const second = Buffer.from("2");
			const parts = [(await part(uploadId, 1, first)).body, (await part(uploadId, 2, second)).body];
			const completed = await complete(uploadId, parts);
			assert.equal(completed.status, 200, JSON.stringify(completed.body));
			assert.equal(record(completed.body).size, first.length + 1);
			assert.match(String(record(completed.body).etag), /^[0-9a-f]{32}-2$/);
			assert.ok((await getBytes("parts")).bytes.equals(Buffer.concat([first, second])));
			const acrossParts = await getBytes("parts", { range: { length: 3, offset: first.length - 2 } });
			assert.equal(acrossParts.bytes.toString(), "112");
			assert.equal(
				errorOf(await complete(uploadId, parts)).message,
				"completeMultipartUpload: The specified multipart upload does not exist. (10024)",
			);

			const small = await create();
			const smallParts = [(await part(small, 1, second)).body, (await part(small, 2, second)).body];
			assert.equal(
				errorOf(await complete(small, smallParts)).message,
				"completeMultipartUpload: Your proposed upload is smaller than the minimum allowed object size. (10011)",
			);

			const aborted = await create();
			await call(`/multipart/abort?key=parts&uploadId=${encodeURIComponent(aborted)}`);
			assert.equal(
				errorOf(await part(aborted, 1, second)).message,
				"uploadPart: The specified multipart upload does not exist. (10024)",
			);
			assert.ok((await getBytes("parts")).bytes.equals(Buffer.concat([first, second])));
		});

		it("rejects invalid keys and unsupported SSE-C keys before storing anything", async () => {
			const longKey = "x".repeat(1025);
			assert.equal(
				errorOf(await call(`/put?key=${longKey}`, { body: "v", method: "PUT" })).message,
				"put: The specified object name is not valid. (10020)",
			);
			const ssec = errorOf(await call("/ssec?key=ssec"));
			assert.equal(ssec.name, "NotSupportedError");
			assert.equal((await call("/head?key=ssec")).body, null);
		});

		backend.extraTests({
			projectRoot: () => projectRoot,
			restart: async () => {
				server = await startDev(projectRoot, env);
				return server;
			},
			server: () => server,
		});
	});
}
