import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { runOrange } from "../../src/bin.js";

const configPath = fileURLToPath(
	new URL("../../src/config/fixtures/wrangler.toml", import.meta.url),
);

function captureIo(): {
	io: { error(message: string): void; log(message: string): void };
	errors: string[];
	logs: string[];
} {
	const errors: string[] = [];
	const logs: string[] = [];
	return {
		io: {
			error: (message) => errors.push(message),
			log: (message) => logs.push(message),
		},
		errors,
		logs,
	};
}

test("generates and freshness-checks self-contained Worker types", async () => {
	const directory = await mkdtemp(join(tmpdir(), "open-orange-types-"));
	const outputPath = join(directory, "worker-types.d.ts");
	try {
		const generated = captureIo();
		assert.equal(
			await runOrange(
				["types", outputPath, "--config", configPath],
				generated.io,
			),
			0,
		);
		const content = await readFile(outputPath, "utf8");
		assert.match(content, /interface Env/);
		assert.match(content, /TOML_SECRET: SecretsStoreSecret/);
		assert.match(content, /Runtime types generated with workerd@/);

		const current = captureIo();
		assert.equal(
			await runOrange(
				["types", outputPath, "--config", configPath, "--check"],
				current.io,
			),
			0,
		);
		assert.match(current.logs[0] ?? "", /up to date/);

		await writeFile(outputPath, `${content}\n// stale\n`, "utf8");
		const stale = captureIo();
		assert.equal(
			await runOrange(
				["types", outputPath, "--config", configPath, "--check"],
				stale.io,
			),
			1,
		);
		assert.match(stale.errors[0] ?? "", /out of date/);
	} finally {
		await rm(directory, { force: true, recursive: true });
	}
});
