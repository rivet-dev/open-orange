import { readFile, writeFile } from "node:fs/promises";

// This controller runs on the host; every test and assertion runs in the guest.
const [requestPath, resultPath] = process.argv.slice(2);
if (!requestPath || !resultPath) throw new Error("Expected request and result paths");
const request = JSON.parse(await readFile(requestPath, "utf8"));
const modulePath = process.env.OPENORANGE_AGENTOS_MODULE;
if (!modulePath) throw new Error("OPENORANGE_AGENTOS_MODULE must select the exact client build");
const { AgentOs, createHostDirBackend } = await import(modulePath);
const sidecar = await AgentOs.createSidecar();
let vm: any;
let stdout = "", stderr = "", capped = false;
const capture = (stream: "stdout" | "stderr", bytes: Uint8Array) => {
	if (capped) return;
	if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) + bytes.byteLength > request.outputLimit) {
		capped = true;
		return;
	}
	if (stream === "stdout") stdout += Buffer.from(bytes).toString();
	else stderr += Buffer.from(bytes).toString();
};
let result: Record<string, unknown>;
try {
	vm = await AgentOs.create({
		sidecar: { kind: "explicit", handle: sidecar },
		defaultSoftware: false,
		permissions: { network: "deny" },
		environment: { HOME: "/root", TMPDIR: "/tmp", PATH: "/bin:/usr/bin", NODE_ENV: "test" },
		mounts: [{ path: request.root, readOnly: true,
			plugin: createHostDirBackend({ hostPath: request.root, readOnly: true }) }],
	});
	let identity = "";
	const identityProcess = await vm.process.spawn("node", ["-e", "console.log(JSON.stringify({versions:process.versions,platform:process.platform,arch:process.arch,fetch:Object.getOwnPropertyDescriptor(globalThis,'fetch')}))"], {
		timeoutMs: 3000, onStdout: (c: Uint8Array) => { identity += Buffer.from(c).toString(); },
	});
	if ((await vm.process.wait(identityProcess.pid)).exitCode !== 0) throw new Error("Guest runtime identity probe failed");
	const proc = await vm.process.spawn("node", ["--test", request.bundle], {
		cwd: request.root, timeoutMs: request.timeoutMs,
		onStdout: (c: Uint8Array) => capture("stdout", c),
		onStderr: (c: Uint8Array) => capture("stderr", c),
	});
	const exit = await vm.process.wait(proc.pid);
	result = { exit, stdout, stderr, capped, identity: JSON.parse(identity) };
} catch (error) {
	result = { stdout, stderr, capped, error: String(error instanceof Error ? error.stack : error) };
} finally {
	try { await vm?.dispose(); } finally { await sidecar.dispose(); }
}
await writeFile(resultPath, JSON.stringify(result));
