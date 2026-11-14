import assert from "node:assert/strict";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { copyProject, repositoryRoot, type RunningOrangeDev, startOrangeDev, type TemporaryProject } from "../harness/orange-dev.js";

// Orange's limits are Rivet's limits. Each test goes past a quota that Cloudflare enforces.
let project: TemporaryProject;
let dev: RunningOrangeDev;

before(async () => {
	project = await copyProject(join(repositoryRoot, "tests", "fixtures", "beyond-cloudflare-quotas"));
	dev = await startOrangeDev(project.directory);
});

after(async () => {
	await dev?.close();
	await project?.dispose();
});

async function call(path: string, status = 200): Promise<Record<string, unknown>> {
	const response = await fetch(`${dev.origin}${path}`);
	const body = (await response.json()) as Record<string, unknown>;
	assert.equal(response.status, status, `${JSON.stringify(body)}\n${dev.output()}`);
	return body;
}

test("one request can have more than 10,000 timeouts active, and each one fires", { timeout: 120_000 }, async () => {
	assert.deepEqual(await call("/timers?count=20000"), { fired: 20_000 });
});

test("a Blob can be larger than 128 MiB, and reads back whole", { timeout: 120_000 }, async () => {
	assert.deepEqual(await call("/blob?mib=200"), { size: 200 * 1024 * 1024 + 3, tail: "\u0007end" });
});

test("KV takes keys, metadata, values, bulk reads, lists, and TTLs past Cloudflare's quotas", { timeout: 180_000 }, async () => {
	assert.deepEqual(await call("/kv?keyKiB=64&metadataKiB=64&valueKiB=30720&keys=1500"), {
		bulk: 1500,
		listed: 1500,
		metadata: 64 * 1024,
		value: 30 * 1024 * 1024,
	});
});

test("a KV write over Rivet's 128 MiB commit fails at once with Rivet's limit, and the namespace keeps working", { timeout: 120_000 }, async () => {
	const { error } = await call("/kv?keyKiB=1&valueKiB=131072", 500);
	assert.match(String(error), /^RangeError: KV PUT: the key, value, and metadata together is \d+ bytes\. Rivet stores at most 134217728 bytes \(128 MiB\)/);
	assert.deepEqual(await call("/kv?keyKiB=1&valueKiB=1"), { bulk: 0, listed: 0, metadata: 0, value: 1024 });
});

test("a cache with a name longer than 1,024 characters stores and matches its own entries", { timeout: 120_000 }, async () => {
	assert.deepEqual(await call("/cache?nameLength=4096"), { hit: "kept", other: null });
});

test("Durable Object storage takes a key and value past 2 MiB, and one over Rivet's 128 MiB commit fails with that limit", { timeout: 120_000 }, async () => {
	assert.deepEqual(await call("/storage?valueKiB=8192"), { async: 8 * 1024 * 1024, sync: 8 * 1024 * 1024 });
	const { error } = await call("/storage?valueKiB=131072", 500);
	assert.match(String(error), /^RangeError: A storage key and value together is \d+ bytes\. Rivet stores at most 134217728 bytes \(128 MiB\)/);
});

test("blockConcurrencyWhile() nests past workerd's 64 levels", { timeout: 60_000 }, async () => {
	assert.deepEqual(await call("/nesting?depth=200"), { reached: 200 });
});

test("an RPC property path can be longer than workerd's 64 levels", { timeout: 60_000 }, async () => {
	assert.deepEqual(await call("/properties?depth=200"), { level: 200 });
});

test("a Durable Object RPC value over Rivet's 32 MiB message fails at once with that limit, and smaller ones work", { timeout: 120_000 }, async () => {
	assert.deepEqual(await call("/rpc?MiB=16"), { echoed: 16 * 1024 * 1024 });
	const { error } = await call("/rpc?MiB=33", 500);
	assert.match(String(error), /^RangeError: This Durable Object RPC call is \d+ bytes on the wire\. Rivet's Engine takes at most 33554432 bytes \(32 MiB\)/);
});

test("Queues take messages past 128 KB, delays past 24 hours, and batches past 100, and a send over Rivet's 32 MiB message fails with that limit", { timeout: 120_000 }, async () => {
	const seen = await call("/queue?messageKiB=1024&run=within");
	assert.equal(seen.messageBytes, 1024 * 1024);
	assert.equal(seen.batch, 250);
	assert.ok(Number(seen.largestBatch) > 100, JSON.stringify(seen));
	const { error } = await call("/queue?messageKiB=40960&run=over", 500);
	assert.match(String(error), /^RangeError: Queue send failed: the messages are \d+ bytes\. One send\(\) or sendBatch\(\) is one message to Rivet's Engine, which takes at most 33554432 bytes \(32 MiB\)/);
});

test("Workflows take instance IDs and step names past Cloudflare's lengths, and batches past 100", { timeout: 120_000 }, async () => {
	assert.deepEqual(await call("/workflows?run=long"), { batch: 150, idLength: 155, output: { stepNameLength: 300 } });
});

test("a Dynamic Worker can have more than 1 MiB of env, and a module over agentOS's 16 MiB file message fails with that limit", { timeout: 180_000 }, async () => {
	assert.deepEqual(await call("/loader?codeMiB=1&envMiB=2"), { envLength: 2 * 1024 * 1024 });
	const { error } = await call("/loader?codeMiB=17&envMiB=0", 500);
	assert.match(String(error), /^RangeError: Dynamic Worker file part0\.js is \d+ bytes\. agentOS writes one file into its VM as one message of at most 16777216 bytes \(16 MiB\)/);
	// The session's later Dynamic Workers still run.
	assert.deepEqual(await call("/loader?codeMiB=0&envMiB=0"), { envLength: 0 });
});

test("an accepted WebSocket takes tags, an attachment, an auto-response, and an event timeout past Cloudflare's limits", { timeout: 60_000 }, async () => {
	const socket = new WebSocket(`${dev.origin.replace("http", "ws")}/socket`);
	await new Promise((resolve, reject) => {
		socket.addEventListener("open", resolve, { once: true });
		socket.addEventListener("error", reject, { once: true });
	});
	const replies: string[] = [];
	const next = () => new Promise<string>((resolve) => socket.addEventListener("message", (event) => resolve(String(event.data)), { once: true }));
	let reply = next();
	socket.send(`ping-${"r".repeat(4096)}`);
	replies.push(await reply);
	reply = next();
	socket.send("state");
	replies.push(await reply);
	socket.close();
	assert.equal(replies[0], `pong-${"s".repeat(4096)}`);
	assert.deepEqual(JSON.parse(replies[1]!), { attachment: 64 * 1024, tagged: 1, tags: 20, timeout: 20 * 24 * 60 * 60 * 1000 });
});
