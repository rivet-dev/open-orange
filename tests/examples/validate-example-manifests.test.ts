import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { validateExampleManifests } from "../../scripts/validate-example-manifests.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map((directory) =>
			rm(directory, { force: true, recursive: true }),
		),
	);
});

async function createRepository(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "orange-example-manifests-"));
	temporaryDirectories.push(root);
	return root;
}

async function writeExample(
	root: string,
	area: string,
	id: string,
	manifest: Record<string, unknown>,
): Promise<void> {
	const directory = join(root, "tests", "cloudflare-examples", area, id);
	await mkdir(join(directory, "src"), { recursive: true });
	await Promise.all([
		writeFile(join(directory, "src", "index.ts"), "export default {};\n"),
		writeFile(join(directory, "wrangler.jsonc"), "{}\n"),
		writeFile(
			join(directory, "example.json"),
			`${JSON.stringify(manifest, null, 2)}\n`,
		),
	]);
}

function validManifest(id: string): Record<string, unknown> {
	const prefix = `tests/cloudflare-examples/durable-objects/${id}`;
	return {
		id,
		source: `${prefix}/src/index.ts`,
		wranglerConfig: `${prefix}/wrangler.jsonc`,
		reference:
			"https://github.com/cloudflare/cloudflare-docs/blob/e65ba8b1fa64a5dc7c5c42a96c455398945cdf5e/src/content/docs/durable-objects/examples/build-a-counter.mdx#L87-L153",
		expectation: "expected-pass",
	};
}

test("accepts the checked-in example corpus", async () => {
	const result = await validateExampleManifests();
	assert.deepEqual(result.errors, []);
	assert.ok(result.manifests.length >= 7);
});

test("accepts a strict valid manifest", async () => {
	const root = await createRepository();
	await writeExample(
		root,
		"durable-objects",
		"counter",
		validManifest("counter"),
	);
	const result = await validateExampleManifests(root);
	assert.deepEqual(result.errors, []);
	assert.deepEqual(result.manifests.map(({ id }) => id), ["counter"]);
});

test("reports duplicate IDs, traversal, unknown fields, and missing reasons", async () => {
	const root = await createRepository();
	const first = validManifest("first");
	first.id = "duplicate";
	first.source = "../outside.ts";
	first.expectation = "known-broken";
	first.extra = true;
	const second = validManifest("second");
	second.id = "duplicate";
	await writeExample(root, "durable-objects", "first", first);
	await writeExample(root, "durable-objects", "second", second);

	const result = await validateExampleManifests(root);
	assert.ok(result.errors.some((error) => error.includes("duplicate example id")));
	assert.ok(result.errors.some((error) => error.includes("without traversal")));
	assert.ok(result.errors.some((error) => error.includes("fields must be exactly")));
	assert.ok(result.errors.some((error) => error.includes("require a non-empty reason")));
});

test("rejects moving GitHub references and missing files", async () => {
	const root = await createRepository();
	const manifest = validManifest("counter");
	manifest.reference =
		"https://github.com/cloudflare/cloudflare-docs/blob/production/example.ts";
	manifest.wranglerConfig =
		"tests/cloudflare-examples/durable-objects/counter/missing.jsonc";
	await writeExample(root, "durable-objects", "counter", manifest);

	const result = await validateExampleManifests(root);
	assert.ok(result.errors.some((error) => error.includes("full commit SHA")));
	assert.ok(result.errors.some((error) => error.includes("file does not exist")));
});
