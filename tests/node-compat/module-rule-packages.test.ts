import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { copyProject, repositoryRoot, startOrangeDev } from "../harness/orange-dev.js";

// (module (func (export "add") (param i32 i32) (result i32) local.get 0 local.get 1 i32.add))
const addWasm = Buffer.from(
	"0061736d0100000001070160027f7f017f030201000707010361646400000a09010700200020016a0b",
	"hex",
);

test("Wasm and Data modules load from a package by bare specifier", { timeout: 120_000 }, async () => {
	const project = await copyProject(join(repositoryRoot, "tests", "fixtures", "module-rule-packages"));
	try {
		const packageDirectory = join(project.directory, "node_modules", "wasm-pkg");
		await mkdir(packageDirectory, { recursive: true });
		await writeFile(join(packageDirectory, "package.json"), JSON.stringify({ name: "wasm-pkg", version: "1.0.0" }));
		await writeFile(join(packageDirectory, "add.wasm"), addWasm);
		await writeFile(join(packageDirectory, "blob.bin"), Buffer.from([1, 2, 254]));
		await writeFile(join(project.directory, "local.wasm"), addWasm);
		const dev = await startOrangeDev(project.directory);
		try {
			const response = await fetch(dev.origin);
			assert.equal(response.status, 200, dev.output());
			assert.deepEqual(await response.json(), { blob: [1, 2, 254], fromPackage: 5, fromProject: 30 });
		} finally {
			await dev.close();
		}
	} finally {
		await project.dispose();
	}
});
