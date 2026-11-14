import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { adaptWasmRivetWebSocket } from "./wasm-rivet-websocket.js";
import { createRuntimeWebSocket } from "../globals/websocket.js";

// Set only by the agentOS host driver after it validates and mounts a complete
// portable SDK package. Ordinary Node installations retain their pinned build.
export function portableRivetPackage(): string | undefined {
	return process.env.OPENORANGE_RIVETKIT_PACKAGE;
}

export function selectedRivetRequire(): NodeJS.Require | undefined {
	const directory = portableRivetPackage();
	return directory === undefined ? undefined : createRequire(join(directory, "package.json"));
}

export function assertPortableRivetBuild(): void {
	const directory = portableRivetPackage();
	if (directory === undefined) throw new Error("No portable RivetKit build selected");
	const receipt: unknown = JSON.parse(process.env.OPENORANGE_RIVETKIT_BUILD ?? "null");
	if (
		!receipt ||
		typeof receipt !== "object" ||
		!("files" in receipt) ||
		!receipt.files ||
		typeof receipt.files !== "object"
	)
		throw new Error("Portable RivetKit build receipt is missing");
	for (const [path, expected] of Object.entries(receipt.files)) {
		if (createHash("sha256").update(readFileSync(path)).digest("hex") !== expected)
			throw new Error(`Portable RivetKit build mismatch: ${path}`);
	}
	const require = selectedRivetRequire()!;
}

export function portableRivetOptions(): Record<string, unknown> {
	const require = selectedRivetRequire();
	if (!require) return {};
	return {
		runtime: "wasm",
		sqlite: "remote",
		wasm: {
			initInput: {
				module_or_path: readFileSync(
					require.resolve("@rivetkit/rivetkit-wasm/rivetkit_wasm_bg.wasm"),
				),
			},
			webSocketFactory: (url: string, protocols: string[] = []) =>
				adaptWasmRivetWebSocket(createRuntimeWebSocket(url, protocols)),
		},
	};
}

export async function ensurePortableRivetEndpoint(): Promise<string> {
	const bridge = (
		globalThis as typeof globalThis & {
			orangeRuntime?: { ensureRivet(input: Record<string, never>): Promise<{ endpoint: string }> };
		}
	).orangeRuntime;
	if (!bridge) throw new Error("Portable RivetKit requires the agentOS Engine capability");
	return (await bridge.ensureRivet({})).endpoint;
}
