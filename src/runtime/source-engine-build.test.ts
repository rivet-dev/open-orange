import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readAgentOsSourceEngineBuild } from "./source-engine-build.js";

function fixture(run: (path: string, binary: string, manifest: Record<string, string>) => void) {
	const directory = mkdtempSync(join(tmpdir(), "orange-engine-build-"));
	try {
		const binary = join(directory, "engine");
		writeFileSync(binary, "synthetic executable bytes");
		chmodSync(binary, 0o555);
		const manifest = { format: "openorange-rust-engine-build-v1", sourceRevision: "a".repeat(40), path: binary, sha256: createHash("sha256").update("synthetic executable bytes").digest("hex") };
		const path = join(directory, "build.json");
		writeFileSync(path, JSON.stringify(manifest));
		run(path, binary, manifest);
	} finally { rmSync(directory, { recursive: true, force: true }); }
}

test("source Engine selection verifies immutable bytes and reports the source revision", () => {
	fixture((path, _binary, manifest) => assert.deepEqual(readAgentOsSourceEngineBuild(path), manifest));
});

test("source Engine selection rejects changed bytes and writable executables", () => {
	fixture((path, binary) => {
		chmodSync(binary, 0o755);
		assert.throws(() => readAgentOsSourceEngineBuild(path), /read-only/);
		writeFileSync(binary, "changed"); chmodSync(binary, 0o555);
		assert.throws(() => readAgentOsSourceEngineBuild(path), /SHA-256 mismatch/);
	});
});

test("source Engine selection rejects symlinks, invalid revisions and oversized manifests", () => {
	fixture((path, binary, manifest) => {
		const link = binary + "-link"; symlinkSync(binary, link);
		writeFileSync(path, JSON.stringify({ ...manifest, path: link }));
		assert.throws(() => readAgentOsSourceEngineBuild(path), /canonical/);
		writeFileSync(path, JSON.stringify({ ...manifest, sourceRevision: "unknown" }));
		assert.throws(() => readAgentOsSourceEngineBuild(path), /Invalid/);
		writeFileSync(path, " ".repeat(16 * 1024 + 1));
		assert.throws(() => readAgentOsSourceEngineBuild(path), /exceeds/);
	});
});
