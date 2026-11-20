import { randomUUID } from "node:crypto";
import { posix } from "node:path";
import { z } from "zod";
import type { WorkerVm, WorkerVmExit } from "../../packages/runtime-node/src/bindings/worker-loader/host-vm.js";
import { agentOsSetting } from "./agentos-http-forwarder.js";

const chunkBytes = 65536;
const fileBytes = 16 * 1024 * 1024;
export const workerVmCommandSchema = z.object({
	id: z.string().uuid(),
	operation: z.enum(["mkdir", "file-start", "file-chunk", "file-finish", "spawn", "stdin", "signal", "read", "dispose"]),
	path: z.string().max(4096).optional(),
	size: z.number().int().min(0).max(fileBytes).optional(),
	offset: z.number().int().min(0).max(fileBytes).optional(),
	data: z.string().max(Math.ceil(chunkBytes / 3) * 4).optional(),
}).strict();
type Command = z.infer<typeof workerVmCommandSchema>;
interface Output { stream?: "stdout" | "stderr"; data?: string; exit?: WorkerVmExit }
interface Upload { path: string; bytes: Buffer; offset: number; phase: "receiving" | "committing"; done?: Promise<void>; released: boolean }
interface Entry {
	vm: Promise<WorkerVm>;
	pid?: number;
	starting: boolean;
	writing: boolean;
	exit?: WorkerVmExit;
	failure?: Error;
	queue: { stream: "stdout" | "stderr"; bytes: Buffer; offset: number }[];
	queuedBytes: number;
	reader?: ReturnType<typeof Promise.withResolvers<Output>>;
	upload?: Upload;
	closing?: Promise<void>;
}

function failure(code: string, message: string) { return Object.assign(new Error(`${code}: ${message}`), { code }); }
function workerPath(path: string | undefined): string {
	if (!path || path.includes("\0")) throw failure("EINVAL", "dynamic Worker path is required");
	const normalized = posix.resolve(path);
	if (!normalized.startsWith("/open-orange/workers/")) throw failure("EACCES", "dynamic Worker writes must stay under /open-orange/workers");
	return normalized;
}
function decodeChunk(data: string | undefined): Buffer {
	if (data === undefined) throw failure("EINVAL", "dynamic Worker chunk is required");
	const bytes = Buffer.from(data, "base64");
	if (bytes.length > chunkBytes || bytes.toString("base64") !== data) throw failure("EINVAL", "dynamic Worker chunks must be canonical base64 and at most65536 bytes");
	return bytes;
}

/** Owns fresh child VMs; the guest never supplies host paths or executable commands. */
export class AgentOsWorkerVms {
	readonly #entries = new Map<string, Entry>();
	readonly #factory: (network: boolean) => Promise<WorkerVm>;
	readonly #maxVms = agentOsSetting("OPENORANGE_AGENTOS_MAX_CHILD_VMS", 64);
	readonly #maxUpload = agentOsSetting("OPENORANGE_AGENTOS_MAX_CHILD_UPLOAD_BYTES", 32 * 1024 * 1024);
	readonly #maxOutput = agentOsSetting("OPENORANGE_AGENTOS_MAX_CHILD_OUTPUT_BYTES", 32 * 1024 * 1024);
	readonly #maxVmOutput = agentOsSetting("OPENORANGE_AGENTOS_MAX_CHILD_VM_OUTPUT_BYTES", 2 * 1024 * 1024);
	readonly #maxOutputEntries = agentOsSetting("OPENORANGE_AGENTOS_MAX_CHILD_OUTPUT_ENTRIES", 8192);
	readonly #maxVmOutputEntries = agentOsSetting("OPENORANGE_AGENTOS_MAX_CHILD_VM_OUTPUT_ENTRIES", 1024);
	#uploadBytes = 0;
	#outputBytes = 0;
	#outputEntries = 0;
	#closed = false;
	constructor(factory: (network: boolean) => Promise<WorkerVm>) { this.#factory = factory; }

	async create(network: boolean): Promise<{ id: string }> {
		if (this.#closed) throw failure("ERR_WORKER_VM_CLOSED", "dynamic Worker VM manager is closed");
		if (this.#entries.size >= this.#maxVms) throw failure("ERR_WORKER_VM_LIMIT", `child VM limit ${this.#maxVms} reached; raise OPENORANGE_AGENTOS_MAX_CHILD_VMS`);
		if (this.#entries.size + 1 >= this.#maxVms * 0.8) process.stderr.write(`WARN_OPENORANGE_CHILD_VMS_NEAR_LIMIT: ${this.#entries.size + 1}/${this.#maxVms}; raise OPENORANGE_AGENTOS_MAX_CHILD_VMS\n`);
		const id = randomUUID();
		const entry: Entry = { vm: Promise.resolve().then(() => this.#factory(network)), starting: false, writing: false, queue: [], queuedBytes: 0 };
		this.#entries.set(id, entry);
		try { await entry.vm; if (this.#closed || entry.closing) throw failure("ERR_WORKER_VM_CLOSED", "dynamic Worker VM closed during boot"); return { id }; }
		catch (error) { await this.#dispose(id, entry); throw error; }
	}

	#next(entry: Entry): Output | undefined {
		if (entry.failure) throw entry.failure;
		const first = entry.queue[0];
		if (first) {
			const end = Math.min(first.bytes.length, first.offset + chunkBytes);
			const bytes = first.bytes.subarray(first.offset, end);
			first.offset = end;
			entry.queuedBytes -= bytes.length; this.#outputBytes -= bytes.length;
			if (end === first.bytes.length) { entry.queue.shift(); this.#outputEntries--; }
			return { stream: first.stream, data: bytes.toString("base64") };
		}
		if (entry.exit) return { exit: entry.exit };
		return undefined;
	}
	#wake(entry: Entry) {
		if (!entry.reader) return;
		try {
			const next = this.#next(entry);
			if (next) { const reader = entry.reader; entry.reader = undefined; reader.resolve(next); }
		} catch (error) { const reader = entry.reader; entry.reader = undefined; reader?.reject(error); }
	}
	#push(entry: Entry, stream: "stdout" | "stderr", bytes: Uint8Array) {
		if (entry.closing || !bytes.byteLength || entry.failure) return;
		const entries = Math.ceil(bytes.byteLength / chunkBytes);
		if (entry.queuedBytes + bytes.byteLength > this.#maxVmOutput || this.#outputBytes + bytes.byteLength > this.#maxOutput || entry.queue.length + entries > this.#maxVmOutputEntries || this.#outputEntries + entries > this.#maxOutputEntries) {
			entry.failure = failure("ERR_WORKER_OUTPUT_LIMIT", `child output queue exceeds ${this.#maxVmOutput} bytes/${this.#maxVmOutputEntries} entries per VM or ${this.#maxOutput} bytes/${this.#maxOutputEntries} entries total; raise OPENORANGE_AGENTOS_MAX_CHILD_VM_OUTPUT_BYTES, OPENORANGE_AGENTOS_MAX_CHILD_OUTPUT_BYTES, OPENORANGE_AGENTOS_MAX_CHILD_VM_OUTPUT_ENTRIES or OPENORANGE_AGENTOS_MAX_CHILD_OUTPUT_ENTRIES`);
			process.stderr.write(`${entry.failure.message}\n`);
			this.#wake(entry);
			if (entry.pid !== undefined) void entry.vm.then(vm => vm.process.signal(entry.pid!, "SIGKILL")).catch(error => process.stderr.write(`Dynamic Worker output-limit stop failed: ${String(error)}\n`));
			return;
		}
		const before = entry.queuedBytes;
		for (let offset = 0; offset < bytes.byteLength; offset += chunkBytes) entry.queue.push({ stream, bytes: Buffer.from(bytes.subarray(offset, offset + chunkBytes)), offset: 0 });
		entry.queuedBytes += bytes.byteLength; this.#outputBytes += bytes.byteLength; this.#outputEntries += entries;
		if (before < this.#maxVmOutput * 0.8 && entry.queuedBytes >= this.#maxVmOutput * 0.8) process.stderr.write(`WARN_OPENORANGE_CHILD_OUTPUT_NEAR_LIMIT: ${entry.queuedBytes}/${this.#maxVmOutput}; raise OPENORANGE_AGENTOS_MAX_CHILD_VM_OUTPUT_BYTES\n`);
		if (entry.queue.length - entries < this.#maxVmOutputEntries * 0.8 && entry.queue.length >= this.#maxVmOutputEntries * 0.8) process.stderr.write(`WARN_OPENORANGE_CHILD_OUTPUT_ENTRIES_NEAR_LIMIT: ${entry.queue.length}/${this.#maxVmOutputEntries}; raise OPENORANGE_AGENTOS_MAX_CHILD_VM_OUTPUT_ENTRIES\n`);
		this.#wake(entry);
	}
	#releaseUpload(entry: Entry, upload: Upload) {
		if (upload.released) return; upload.released = true;
		this.#uploadBytes -= upload.bytes.length;
		if (entry.upload === upload) entry.upload = undefined;
	}

	async command(input: Command): Promise<Output & { pid?: number }> {
		const entry = this.#entries.get(input.id);
		if (!entry) throw failure("ERR_WORKER_VM_CLOSED", "unknown or closed dynamic Worker VM");
		if (input.operation === "dispose") { await this.#dispose(input.id, entry); return {}; }
		if (this.#closed || entry.closing) throw failure("ERR_WORKER_VM_CLOSED", "dynamic Worker VM is closing");
		const vm = await entry.vm;
		switch (input.operation) {
			case "mkdir": await vm.filesystem.mkdir(workerPath(input.path), { recursive: true }); return {};
			case "file-start": {
				if (entry.upload) throw failure("EBUSY", "await the prior dynamic Worker file upload");
				const path = workerPath(input.path), size = input.size;
				if (size === undefined || size > fileBytes) throw failure("EINVAL", "dynamic Worker file size must be0 through16777216 bytes");
				if (this.#uploadBytes + size > this.#maxUpload) throw failure("ERR_WORKER_UPLOAD_LIMIT", `child file uploads exceed ${this.#maxUpload} bytes; raise OPENORANGE_AGENTOS_MAX_CHILD_UPLOAD_BYTES`);
				if (this.#uploadBytes + size >= this.#maxUpload * 0.8) process.stderr.write(`WARN_OPENORANGE_CHILD_UPLOAD_NEAR_LIMIT: ${this.#uploadBytes + size}/${this.#maxUpload}; raise OPENORANGE_AGENTOS_MAX_CHILD_UPLOAD_BYTES\n`);
				const bytes = Buffer.alloc(size); this.#uploadBytes += size;
				entry.upload = { path, bytes, offset: 0, phase: "receiving", released: false }; return {};
			}
			case "file-chunk": {
				const upload = entry.upload, bytes = decodeChunk(input.data);
				if (!upload || upload.phase !== "receiving" || input.offset !== upload.offset || bytes.length > upload.bytes.length - upload.offset) throw failure("EINVAL", "dynamic Worker file chunk is out of sequence");
				bytes.copy(upload.bytes, upload.offset); upload.offset += bytes.length; return {};
			}
			case "file-finish": {
				const upload = entry.upload;
				if (!upload || upload.phase !== "receiving" || upload.offset !== upload.bytes.length) throw failure("EINVAL", "dynamic Worker file upload is incomplete");
				upload.phase = "committing";
				upload.done = (async () => {
					try {
						await vm.filesystem.mkdir(posix.dirname(upload.path), { recursive: true });
						const result = await vm.filesystem.writeFiles([{ path: upload.path, content: upload.bytes }]);
						if (result.length !== 1 || !result[0]?.success) throw failure("ERR_WORKER_FILE_WRITE", result[0]?.error ?? "dynamic Worker file write failed");
					} finally { this.#releaseUpload(entry, upload); }
				})();
				await upload.done; return {};
			}
			case "spawn": {
				if (entry.pid !== undefined || entry.starting) throw failure("EBUSY", "a dynamic Worker VM owns one runtime process");
				entry.starting = true;
				const child = await vm.process.spawn("node", ["/open-orange/runtime/worker-loader-child.mjs"], {
					cwd: workerPath(input.path), env: { HOME: "/home/orange", PATH: "/bin:/usr/bin" },
					onStdout: bytes => this.#push(entry, "stdout", bytes), onStderr: bytes => this.#push(entry, "stderr", bytes),
				});
				entry.pid = child.pid;
				void vm.process.wait(child.pid).then(exit => { entry.exit = exit; this.#wake(entry); }, error => { entry.failure = error instanceof Error ? error : new Error(String(error)); this.#wake(entry); });
				return { pid: child.pid };
			}
			case "stdin": {
				if (entry.pid === undefined) throw failure("ESRCH", "dynamic Worker process has not started");
				if (entry.writing) throw failure("EBUSY", "await the prior dynamic Worker stdin write");
				const bytes = decodeChunk(input.data); entry.writing = true;
				try { await vm.process.writeStdin(entry.pid, bytes); } finally { entry.writing = false; }
				return {};
			}
			case "signal": if (entry.pid !== undefined) await vm.process.signal(entry.pid, "SIGKILL"); return {};
			case "read": {
				if (entry.reader) throw failure("EBUSY", "await the prior dynamic Worker output read");
				const next = this.#next(entry); if (next) return next;
				entry.reader = Promise.withResolvers<Output>(); return entry.reader.promise;
			}
		}
	}

	#dispose(id: string, entry: Entry): Promise<void> {
		return entry.closing ??= (async () => {
			entry.reader?.reject(failure("ERR_WORKER_VM_CLOSED", "dynamic Worker VM was disposed")); entry.reader = undefined;
			try {
				// Boot failure has already reached create(); no VM then exists to dispose.
				const boot = await entry.vm.then(vm => ({ vm }), error => ({ error }));
				const results = await Promise.allSettled([
					...("vm" in boot ? [boot.vm.dispose()] : []),
					...(entry.upload?.done ? [entry.upload.done] : []),
				]);
				const errors = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
				if (errors.length) throw new AggregateError(errors, "Dynamic Worker cleanup operations failed");
			} finally {
				if (entry.upload) this.#releaseUpload(entry, entry.upload);
				this.#outputBytes -= entry.queuedBytes; this.#outputEntries -= entry.queue.length; entry.queuedBytes = 0; entry.queue = [];
				if (this.#entries.get(id) === entry) this.#entries.delete(id);
			}
		})();
	}
	async dispose(): Promise<void> {
		this.#closed = true;
		const results = await Promise.allSettled([...this.#entries].map(([id, entry]) => this.#dispose(id, entry)));
		const errors = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
		if (errors.length) throw new AggregateError(errors, "Dynamic Worker VM cleanup failed");
	}
}
