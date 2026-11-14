import { Buffer } from "node:buffer";

export interface WorkerVmExit {
	exitCode?: number;
	outcome?: string;
	signal?: string | null;
}
export interface WorkerVmSpawnOptions {
	cwd: string;
	env: Record<string, string>;
	onStdout(bytes: Uint8Array): void | Promise<void>;
	onStderr(bytes: Uint8Array): void | Promise<void>;
}
/** The closed VM surface used by Worker Loader, independent of client version. */
export interface WorkerVm {
	filesystem: {
		mkdir(path: string, options: { recursive: boolean }): Promise<void>;
		writeFiles(files: { path: string; content: string | Uint8Array }[]): Promise<{ path: string; success: boolean; error?: string | null }[]>;
	};
	process: {
		spawn(command: string, args: string[], options: WorkerVmSpawnOptions): Promise<{ pid: number }>;
		wait(pid: number): Promise<WorkerVmExit>;
		writeStdin(pid: number, text: string | Uint8Array): Promise<void>;
		signal(pid: number, signal: "SIGKILL"): Promise<void>;
	};
	dispose(): Promise<void>;
}

interface Command {
	id: string;
	operation: "mkdir" | "file-start" | "file-chunk" | "file-finish" | "spawn" | "stdin" | "signal" | "read" | "dispose";
	path?: string;
	size?: number;
	offset?: number;
	data?: string;
}
interface Output {
	stream?: "stdout" | "stderr";
	data?: string;
	exit?: WorkerVmExit;
}
interface Bridge {
	createWorkerVm(input: { network: boolean }): Promise<{ id: string }>;
	workerVmCommand(input: Command): Promise<Output & { pid?: number }>;
}

/** Present only in the main agentOS runtime; ordinary Node keeps its existing backend. */
export function workerVmHostBridge(): Bridge | undefined {
	const runtime = Reflect.get(globalThis, "orangeRuntime") as Partial<Bridge> | undefined;
	return runtime?.createWorkerVm && runtime.workerVmCommand ? runtime as Bridge : undefined;
}

export async function createHostedWorkerVm(bridge: Bridge, network: boolean): Promise<WorkerVm> {
	const { id } = await bridge.createWorkerVm({ network });
	const call = (operation: Command["operation"], fields: Omit<Command, "operation" | "id"> = {}) => bridge.workerVmCommand({ id, operation, ...fields });
	let disposed = false;
	let processRecord: { pid: number; exit: ReturnType<typeof Promise.withResolvers<{ value: WorkerVmExit } | { error: Error }>> } | undefined;
	const checkPid = (pid: number) => {
		if (!processRecord || processRecord.pid !== pid) throw new Error("Unknown dynamic Worker process");
		return processRecord;
	};
	return {
		filesystem: {
			async mkdir(path) { await call("mkdir", { path }); },
			async writeFiles(files) {
				const results = [];
				for (const file of files) {
					const bytes = typeof file.content === "string" ? Buffer.from(file.content) : file.content;
					await call("file-start", { path: file.path, size: bytes.byteLength });
					for (let offset = 0; offset < bytes.byteLength; offset += 65536) {
						await call("file-chunk", { offset, data: Buffer.from(bytes.subarray(offset, offset + 65536)).toString("base64") });
					}
					await call("file-finish");
					results.push({ path: file.path, success: true });
				}
				return results;
			},
		},
		process: {
			async spawn(command, args, options) {
				if (command !== "node" || args.length !== 1 || args[0] !== "/open-orange/runtime/worker-loader-child.mjs") throw new Error("Dynamic Worker boot command must use the fixed runtime child");
				const reply = await call("spawn", { path: options.cwd });
				if (!Number.isSafeInteger(reply.pid)) throw new Error("Invalid dynamic Worker process id");
				const record = { pid: reply.pid!, exit: Promise.withResolvers<{ value: WorkerVmExit } | { error: Error }>() };
				processRecord = record;
				void (async () => {
					for (;;) {
						const output = await call("read");
						if (output.exit) { record.exit.resolve({ value: output.exit }); return; }
						if (!output.stream || typeof output.data !== "string") throw new Error("Invalid dynamic Worker output");
						const bytes = Buffer.from(output.data, "base64");
						await (output.stream === "stdout" ? options.onStdout(bytes) : options.onStderr(bytes));
					}
				})().catch(error => {
					const failure = error instanceof Error ? error : new Error(String(error));
					record.exit.resolve({ error: failure });
					if (!disposed) process.stderr.write(`Dynamic Worker output failed: ${failure.message}\n`);
				});
				return { pid: record.pid };
			},
			async wait(pid) { const result = await checkPid(pid).exit.promise; if ("error" in result) throw result.error; return result.value; },
			async writeStdin(pid, text) {
				checkPid(pid); const bytes = typeof text === "string" ? Buffer.from(text) : Buffer.from(text);
				for (let offset = 0; offset < bytes.byteLength; offset += 65536) await call("stdin", { data: bytes.subarray(offset, offset + 65536).toString("base64") });
			},
			async signal(pid) { checkPid(pid); await call("signal"); },
		},
		async dispose() {
			if (disposed) return; disposed = true;
			try { await call("dispose"); }
			finally { processRecord?.exit.resolve({ error: new Error("The dynamic Worker VM was disposed") }); }
		},
	};
}
