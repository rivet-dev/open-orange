import { createHash } from "node:crypto";
import { closeSync, fstatSync, openSync, readFileSync, readSync, realpathSync } from "node:fs";
import { isAbsolute } from "node:path";

export interface SourceEngineBuild {
	format: "openorange-rust-engine-build-v1";
	sourceRevision: string;
	path: string;
	sha256: string;
}

// Host controller configuration only. This selects the existing Rust server;
// application and SDK JavaScript still run in the guest WASM runtime.
export function readAgentOsSourceEngineBuild(
	manifestPath = process.env.OPENORANGE_AGENTOS_RIVET_ENGINE_BUILD,
): SourceEngineBuild | undefined {
	if (manifestPath === undefined) return undefined;
	const manifest = openSync(manifestPath, "r");
	let parsed: unknown;
	try {
		if (fstatSync(manifest).size > 16 * 1024) throw new Error("Source Engine manifest exceeds 16 KiB");
		parsed = JSON.parse(readFileSync(manifest, "utf8"));
	} finally {
		closeSync(manifest);
	}
	if (
		!parsed || typeof parsed !== "object" ||
		!("format" in parsed) || parsed.format !== "openorange-rust-engine-build-v1" ||
		!("sourceRevision" in parsed) || typeof parsed.sourceRevision !== "string" || !/^[0-9a-f]{40}$/.test(parsed.sourceRevision) ||
		!("path" in parsed) || typeof parsed.path !== "string" || !isAbsolute(parsed.path) ||
		!("sha256" in parsed) || typeof parsed.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(parsed.sha256)
	) throw new Error("Invalid source Rust Engine build manifest");
	if (realpathSync(parsed.path) !== parsed.path) throw new Error("Source Engine path must be canonical");
	const binary = openSync(parsed.path, "r");
	try {
		const stat = fstatSync(binary);
		if (!stat.isFile() || stat.size === 0 || stat.size > 1024 ** 3 || (stat.mode & 0o222) !== 0 || (stat.mode & 0o111) === 0)
			throw new Error("Source Engine must be a read-only regular executable up to 1 GiB");
		const hash = createHash("sha256");
		const buffer = Buffer.allocUnsafe(64 * 1024);
		let count: number;
		while ((count = readSync(binary, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, count));
		if (hash.digest("hex") !== parsed.sha256) throw new Error("Source Engine SHA-256 mismatch");
	} finally {
		closeSync(binary);
	}
	return { format: parsed.format, sourceRevision: parsed.sourceRevision, path: parsed.path, sha256: parsed.sha256 };
}
