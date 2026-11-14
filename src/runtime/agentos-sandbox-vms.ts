import { randomUUID, timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import type { Socket } from "node:net";
import { posix } from "node:path";
import { z } from "zod";
import type {
	SandboxVmCommand,
	SandboxVmReply,
	SandboxFileInfo,
} from "../../packages/runtime-node/src/modules/cloudflare-sandbox/host-protocol.js";
import {
	agentOsSetting,
	attachGuestHttpForwarder,
	GuestHttpError,
} from "./agentos-http-forwarder.js";
import { guestDuplex, type GuestConnection } from "./agentos-connection.js";

interface Vm {
	dispose(): Promise<void>;
	network: { connect(port: number): Promise<GuestConnection> };
	process: {
		exec(
			command: string,
			options: {
				cwd: string;
				env?: Record<string, string>;
				timeoutMs: number;
				signal: AbortSignal;
				output: { capture: "none"; retainEvents: false };
				onStdout(b: Uint8Array): void;
				onStderr(b: Uint8Array): void;
			},
		): Promise<{
			outcome: string;
			exitCode?: number;
			exitSignal?: number;
			error?: { code: string; message: string };
		}>;
	};
	filesystem: {
		mkdir(p: string, o: { recursive: boolean }): Promise<void>;
		readFileRange(p: string, offset: number, length: number): Promise<Uint8Array>;
		writeFile(p: string, b: Uint8Array): Promise<void>;
		exists(p: string): Promise<boolean>;
		remove(p: string): Promise<void>;
		move(a: string, b: string): Promise<void>;
		stat(p: string): Promise<{
			isDirectory: boolean;
			isSymbolicLink: boolean;
			size: number;
			mode: number;
			uid?: number;
			gid?: number;
			atimeMs: number;
			mtimeMs: number;
			ctimeMs: number;
		}>;
		readdir(p: string): Promise<string[]>;
	};
}
interface Job {
	id: string;
	abort: AbortController;
	queue: { stream: "stdout" | "stderr"; bytes: Buffer }[];
	bytes: number;
	total: number;
	run?: Promise<void>;
	terminal?: SandboxVmReply;
	reader?: ReturnType<typeof Promise.withResolvers<SandboxVmReply>>;
	reading: boolean;
	retired: boolean;
}
interface Entry {
	owner: string;
	vm: Promise<Vm>;
	jobs: Map<string, Job>;
	closing?: Promise<void>;
	fileBusy: boolean;
	fileIdle?: ReturnType<typeof Promise.withResolvers<void>>;
	upload?: { path: string; bytes: Buffer; offset: number; writing: boolean };
	download?: Buffer;
}
const fail = (code: string, message: string) =>
	Object.assign(new Error(`${code}: ${message}`), { code });
const text = z.string().max(4096);
const integer = z.number().int().nonnegative();
export const sandboxVmCommandSchema = z
	.object({
		operation: z.enum([
			"create",
			"connect",
			"destroy",
			"exec-start",
			"exec-read",
			"exec-cancel",
			"read-start",
			"read-chunk",
			"read-close",
			"write-start",
			"write-chunk",
			"write-finish",
			"write-close",
			"mkdir",
			"exists",
			"remove",
			"move",
			"stat",
			"list",
			"preview",
		]),
		owner: z.string().min(1).max(256),
		id: z.string().uuid().optional(),
		job: z.string().uuid().optional(),
		path: text.optional(),
		to: text.optional(),
		data: z.string().max(87384).optional(),
		offset: integer.optional(),
		size: integer.optional(),
		recursive: z.boolean().optional(),
		follow: z.boolean().optional(),
		command: z.string().max(65536).optional(),
		cwd: text.optional(),
		env: z.record(z.string(), z.string().max(65536)).optional(),
		timeoutMs: integer.max(3600000).optional(),
		port: z.number().int().min(1).max(65535).optional(),
	})
	.strict();
const pathOf = (p: string | undefined) => {
	if (!p || p.includes("\0")) throw fail("EINVAL", "a VM path is required");
	return posix.resolve("/workspace", p);
};
const decode = (data: string | undefined) => {
	if (data === undefined) throw fail("EINVAL", "a chunk is required");
	const b = Buffer.from(data, "base64");
	if (b.length > 65536 || b.toString("base64") !== data)
		throw fail("EINVAL", "chunk must be canonical base64, at most65536 bytes");
	return b;
};

/** Trusted orchestration only: commands and files belong to fresh VMs with no host mounts. */
export class AgentOsSandboxVms {
	readonly #entries = new Map<string, Entry>();
	readonly #factory: () => Promise<Vm>;
	readonly #maxVms = agentOsSetting("OPENORANGE_AGENTOS_MAX_SANDBOX_VMS", 16);
	readonly #maxJobs = agentOsSetting("OPENORANGE_AGENTOS_MAX_SANDBOX_JOBS", 64);
	readonly #maxOutput = agentOsSetting(
		"OPENORANGE_AGENTOS_MAX_SANDBOX_OUTPUT_BYTES",
		32 * 1024 * 1024,
	);
	readonly #maxJobOutput = agentOsSetting(
		"OPENORANGE_AGENTOS_MAX_SANDBOX_JOB_OUTPUT_BYTES",
		2 * 1024 * 1024,
	);
	readonly #maxOutputEntries = agentOsSetting(
		"OPENORANGE_AGENTOS_MAX_SANDBOX_OUTPUT_ENTRIES",
		8192,
	);
	readonly #maxJobTotal = agentOsSetting(
		"OPENORANGE_AGENTOS_MAX_SANDBOX_COMMAND_OUTPUT_BYTES",
		16 * 1024 * 1024,
	);
	readonly #maxFiles = agentOsSetting(
		"OPENORANGE_AGENTOS_MAX_SANDBOX_TRANSFER_BYTES",
		32 * 1024 * 1024,
	);
	readonly #maxFile = agentOsSetting("OPENORANGE_AGENTOS_MAX_SANDBOX_FILE_BYTES", 2 * 1024 * 1024);
	readonly #maxList = agentOsSetting("OPENORANGE_AGENTOS_MAX_SANDBOX_LIST_ENTRIES", 1024);
	readonly #maxIo = agentOsSetting("OPENORANGE_AGENTOS_MAX_SANDBOX_FILE_OPERATIONS", 2);
	readonly #maxEnvNameBytes = agentOsSetting("OPENORANGE_AGENTOS_MAX_SANDBOX_ENV_NAME_BYTES", 256);
	readonly #maxEnvEntries = agentOsSetting("OPENORANGE_AGENTOS_MAX_SANDBOX_ENV_ENTRIES", 128);
	readonly #maxEnvBytes = agentOsSetting("OPENORANGE_AGENTOS_MAX_SANDBOX_ENV_BYTES", 65536);
	readonly #maxPorts = agentOsSetting("OPENORANGE_AGENTOS_MAX_SANDBOX_PREVIEW_PORTS", 128);
	readonly #token = randomUUID();
	readonly #front = createServer();
	readonly #sockets = new Set<Socket>();
	readonly #connections = new Set<ReturnType<typeof guestDuplex>>();
	readonly #ports = new Set<string>();
	#jobs = 0;
	#outputBytes = 0;
	#outputEntries = 0;
	#fileBytes = 0;
	#io = 0;
	#closed = false;
	#origin = "";
	#listening?: Promise<void>;
	constructor(factory: () => Promise<Vm>) {
		this.#factory = factory;
	}
	get port() {
		return Number(new URL(this.#origin).port);
	}
	listen(): Promise<void> {
		return (this.#listening ??= this.#listen());
	}
	async #listen() {
		if (this.#closed) throw fail("ERR_SANDBOX_CLOSED", "Sandbox VM manager is closed");
		this.#front.on("connection", (socket) => {
			this.#sockets.add(socket);
			socket.once("close", () => this.#sockets.delete(socket));
		});
		attachGuestHttpForwarder(
			this.#front,
			async (request) => {
				const supplied = request.headers["x-orange-sandbox-token"];
				const actual = Buffer.from(typeof supplied === "string" ? supplied : "");
				const expected = Buffer.from(this.#token);
				if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
					throw new GuestHttpError(403, "Invalid sandbox preview credentials");
				const id = request.headers["x-orange-sandbox-id"],
					raw = request.headers["x-orange-sandbox-port"];
				if (
					typeof id !== "string" ||
					typeof raw !== "string" ||
					!/^\d{1,5}$/.test(raw) ||
					!this.#ports.has(`${id}:${raw}`)
				)
					throw new GuestHttpError(404, "Unknown sandbox preview port");
				const entry = this.#entries.get(id);
				if (!entry || entry.closing) throw new GuestHttpError(410, "Sandbox VM is closed");
				for (const key of [
					"x-orange-sandbox-token",
					"x-orange-sandbox-id",
					"x-orange-sandbox-port",
				])
					delete request.headers[key];
				request.rawHeaders = request.rawHeaders.reduce<string[]>((all, value, index, source) => {
					if (index % 2 === 0 && !value.toLowerCase().startsWith("x-orange-sandbox-"))
						all.push(value, source[index + 1]!);
					return all;
				}, []);
				const connection = await (await entry.vm).network.connect(Number(raw));
				if (this.#closed || entry.closing) {
					await connection.close();
					throw new GuestHttpError(410, "Sandbox VM closed during connection");
				}
				const stream = guestDuplex(connection);
				this.#connections.add(stream);
				stream.once("close", () => this.#connections.delete(stream));
				return stream;
			},
			{
				maxRequests: agentOsSetting("OPENORANGE_AGENTOS_MAX_CONCURRENT_REQUESTS", 32),
				maxRequestBytes: agentOsSetting("OPENORANGE_AGENTOS_MAX_REQUEST_BYTES", 8 * 1024 * 1024),
				requestTimeoutMs: agentOsSetting("OPENORANGE_AGENTOS_REQUEST_TIMEOUT_MS", 30000),
				webSocketIdleTimeoutMs: agentOsSetting(
					"OPENORANGE_AGENTOS_WEBSOCKET_IDLE_TIMEOUT_MS",
					125000,
				),
			},
			(error) => process.stderr.write(`OpenOrange Sandbox preview: ${String(error)}\n`),
		);
		this.#front.listen(0, "127.0.0.1");
		await once(this.#front, "listening");
		if (this.#closed) {
			if (this.#front.listening)
				await new Promise<void>((resolve, reject) =>
					this.#front.close((error) => (error ? reject(error) : resolve())),
				);
			throw fail("ERR_SANDBOX_CLOSED", "Sandbox manager closed during listener startup");
		}

		const address = this.#front.address();
		if (!address || typeof address === "string")
			throw fail("EIO", "Sandbox preview has no listener");
		this.#origin = `http://127.0.0.1:${address.port}`;
	}
	#limit(observed: number, maximum: number, name: string) {
		if (observed > maximum)
			throw fail("ERR_SANDBOX_LIMIT", `${name} limit ${maximum} exceeded; raise ${name}`);
		if (observed >= maximum * 0.8)
			process.stderr.write(`WARN_OPENORANGE_SANDBOX_NEAR_LIMIT: ${name} ${observed}/${maximum}\n`);
	}
	#entry(input: SandboxVmCommand) {
		const entry = input.id && this.#entries.get(input.id);
		if (!entry || entry.owner !== input.owner || entry.closing)
			throw fail("ERR_SANDBOX_CLOSED", "unknown or closed Sandbox VM");
		return entry;
	}
	#next(job: Job): SandboxVmReply | undefined {
		const event = job.queue.shift();
		if (event) {
			job.bytes -= event.bytes.length;
			this.#outputBytes -= event.bytes.length;
			this.#outputEntries--;
			return { stream: event.stream, data: event.bytes.toString("base64") };
		}
		return job.terminal;
	}
	#wake(job: Job) {
		if (!job.reader) return;
		const next = this.#next(job);
		if (next) {
			const reader = job.reader;
			job.reader = undefined;
			reader.resolve(next);
		}
	}
	#push(job: Job, stream: "stdout" | "stderr", bytes: Uint8Array) {
		if (job.retired || job.terminal || bytes.length === 0) return;
		try {
			this.#limit(
				job.total + bytes.length,
				this.#maxJobTotal,
				"OPENORANGE_AGENTOS_MAX_SANDBOX_COMMAND_OUTPUT_BYTES",
			);
			this.#limit(
				job.bytes + bytes.length,
				this.#maxJobOutput,
				"OPENORANGE_AGENTOS_MAX_SANDBOX_JOB_OUTPUT_BYTES",
			);
			this.#limit(
				this.#outputBytes + bytes.length,
				this.#maxOutput,
				"OPENORANGE_AGENTOS_MAX_SANDBOX_OUTPUT_BYTES",
			);
			this.#limit(
				this.#outputEntries + Math.ceil(bytes.length / 65536),
				this.#maxOutputEntries,
				"OPENORANGE_AGENTOS_MAX_SANDBOX_OUTPUT_ENTRIES",
			);
		} catch (error) {
			job.terminal = { error: { code: "ERR_SANDBOX_LIMIT", message: String(error) } };
			job.abort.abort(error);
			this.#wake(job);
			return;
		}
		job.total += bytes.length;
		for (let offset = 0; offset < bytes.length; offset += 65536) {
			const b = Buffer.from(bytes.subarray(offset, offset + 65536));
			job.queue.push({ stream, bytes: b });
			job.bytes += b.length;
			this.#outputBytes += b.length;
			this.#outputEntries++;
		}
		this.#wake(job);
	}
	#retire(entry: Entry, job: Job) {
		if (job.retired) return;
		job.retired = true;
		this.#outputBytes -= job.bytes;
		this.#outputEntries -= job.queue.length;
		job.queue = [];
		job.bytes = 0;
		entry.jobs.delete(job.id);
		this.#jobs--;
		job.terminal ??= {
			error: { code: "ERR_SANDBOX_CLOSED", message: "Sandbox command was retired" },
		};
		this.#wake(job);
	}
	async command(input: SandboxVmCommand): Promise<SandboxVmReply> {
		if (input.env) {
			for (const name of Object.keys(input.env))
				this.#limit(
					Buffer.byteLength(name),
					this.#maxEnvNameBytes,
					"OPENORANGE_AGENTOS_MAX_SANDBOX_ENV_NAME_BYTES",
				);
			this.#limit(
				Object.keys(input.env).length,
				this.#maxEnvEntries,
				"OPENORANGE_AGENTOS_MAX_SANDBOX_ENV_ENTRIES",
			);
			this.#limit(
				Buffer.byteLength(JSON.stringify(input.env)),
				this.#maxEnvBytes,
				"OPENORANGE_AGENTOS_MAX_SANDBOX_ENV_BYTES",
			);
		}
		if (this.#closed) throw fail("ERR_SANDBOX_CLOSED", "Sandbox VM manager is closed");
		if (input.operation === "create") {
			this.#limit(this.#entries.size + 1, this.#maxVms, "OPENORANGE_AGENTOS_MAX_SANDBOX_VMS");
			const id = randomUUID();
			const entry: Entry = {
				owner: input.owner,
				vm: Promise.resolve().then(() => this.#factory()),
				jobs: new Map(),
				fileBusy: false,
			};
			this.#entries.set(id, entry);
			try {
				const vm = await entry.vm;
				await vm.filesystem.mkdir("/workspace", { recursive: true });
				if (this.#closed || entry.closing)
					throw fail("ERR_SANDBOX_CLOSED", "Sandbox closed during boot");
				return { id };
			} catch (error) {
				await this.#dispose(id, entry);
				throw error;
			}
		}
		if (input.operation === "connect") {
			const entry = input.id && this.#entries.get(input.id);
			return { exists: !!entry && entry.owner === input.owner && !entry.closing };
		}
		if (input.operation === "destroy") {
			const entry = input.id && this.#entries.get(input.id);
			if (entry && entry.owner === input.owner) await this.#dispose(input.id!, entry);
			return {};
		}
		const entry = this.#entry(input);
		const vm = await entry.vm;
		if (this.#closed || entry.closing)
			throw fail("ERR_SANDBOX_CLOSED", "Sandbox closed during operation admission");
		if (input.operation === "exec-start") {
			if (input.command === undefined) throw fail("EINVAL", "Sandbox command is required");
			this.#limit(this.#jobs + 1, this.#maxJobs, "OPENORANGE_AGENTOS_MAX_SANDBOX_JOBS");
			const id = randomUUID();
			const job: Job = {
				id,
				abort: new AbortController(),
				queue: [],
				bytes: 0,
				total: 0,
				reading: false,
				retired: false,
			};
			entry.jobs.set(id, job);
			this.#jobs++;
			job.run = Promise.resolve()
				.then(() =>
					vm.process.exec(input.command!, {
						cwd: pathOf(input.cwd ?? "/workspace"),
						env: input.env,
						timeoutMs: input.timeoutMs ?? 300000,
						signal: job.abort.signal,
						output: { capture: "none", retainEvents: false },
						onStdout: (b) => this.#push(job, "stdout", b),
						onStderr: (b) => this.#push(job, "stderr", b),
					}),
				)
				.then(
					(result) => {
						if (job.terminal) return;
						if (result.exitCode !== undefined) job.terminal = { exitCode: result.exitCode };
						else if (result.exitSignal !== undefined)
							job.terminal = { exitCode: 128 + result.exitSignal };
						else
							job.terminal = {
								error: result.error ?? {
									code: "ERR_SANDBOX_EXECUTION",
									message: `Sandbox execution ${result.outcome} without a terminal exit status`,
								},
							};
					},
					(error) => {
						job.terminal ??= { error: { code: "ERR_SANDBOX_EXECUTION", message: String(error) } };
					},
				)
				.finally(() => this.#wake(job));
			return { job: id };
		}
		if (input.operation === "exec-read" || input.operation === "exec-cancel") {
			const job = input.job && entry.jobs.get(input.job);
			if (!job) throw fail("ERR_SANDBOX_CLOSED", "unknown Sandbox command");
			if (input.operation === "exec-cancel") {
				job.abort.abort(fail("ECANCELED", "Sandbox command cancelled"));
				await job.run;
				this.#retire(entry, job);
				return {};
			}
			if (job.reading) throw fail("EBUSY", "one Sandbox output read is allowed per command");
			job.reading = true;
			let timer: ReturnType<typeof setTimeout> | undefined;
			try {
				let next = this.#next(job);
				if (!next) {
					const reader = Promise.withResolvers<SandboxVmReply>();
					job.reader = reader;
					timer = setTimeout(() => {
						if (job.reader === reader) {
							job.reader = undefined;
							reader.resolve({ pending: true });
						}
					}, 20000);
					next = await reader.promise;
				}
				if (next.exitCode !== undefined || next.error) this.#retire(entry, job);
				return next;
			} finally {
				clearTimeout(timer);
				job.reading = false;
			}
		}
		if (input.operation === "preview") {
			if (!input.port) throw fail("EINVAL", "preview port is required");
			const key = `${input.id}:${input.port}`;
			if (!this.#ports.has(key)) {
				this.#limit(
					this.#ports.size + 1,
					this.#maxPorts,
					"OPENORANGE_AGENTOS_MAX_SANDBOX_PREVIEW_PORTS",
				);
				this.#ports.add(key);
			}
			return {
				preview: { origin: this.#origin, token: this.#token, id: input.id!, port: input.port },
			};
		}
		if (input.operation === "read-chunk") {
			const bytes = entry.download;
			if (!bytes || input.offset === undefined || input.offset > bytes.length)
				throw fail("EINVAL", "unknown Sandbox download or invalid offset");
			return { data: bytes.subarray(input.offset, input.offset + 65536).toString("base64") };
		}
		if (input.operation === "read-close") {
			if (entry.download) {
				this.#fileBytes -= entry.download.length;
				entry.download = undefined;
			}
			return {};
		}
		if (input.operation === "write-close") {
			if (entry.upload?.writing) throw fail("EBUSY", "Sandbox file write is in progress");
			if (entry.upload) {
				this.#fileBytes -= entry.upload.bytes.length;
				entry.upload = undefined;
			}
			return {};
		}
		if (input.operation === "write-chunk") {
			const upload = entry.upload;
			if (!upload || upload.writing || input.offset !== upload.offset)
				throw fail("EINVAL", "Sandbox upload must be sequential");
			const bytes = decode(input.data);
			if (upload.offset + bytes.length > upload.bytes.length)
				throw fail("EINVAL", "Sandbox upload exceeds declared size");
			bytes.copy(upload.bytes, upload.offset);
			upload.offset += bytes.length;
			return {};
		}
		if (entry.fileBusy) throw fail("EBUSY", "await the previous Sandbox file operation");
		this.#limit(this.#io + 1, this.#maxIo, "OPENORANGE_AGENTOS_MAX_SANDBOX_FILE_OPERATIONS");
		entry.fileBusy = true;
		entry.fileIdle = Promise.withResolvers<void>();
		this.#io++;
		try {
			switch (input.operation) {
				case "read-start": {
					if (entry.download) throw fail("EBUSY", "close the prior Sandbox download");
					const path = pathOf(input.path);
					const info = await vm.filesystem.stat(path);
					if (!Number.isSafeInteger(info.size) || info.size < 0)
						throw fail("EIO", "invalid Sandbox file size");
					this.#limit(info.size, this.#maxFile, "OPENORANGE_AGENTOS_MAX_SANDBOX_FILE_BYTES");
					this.#limit(
						this.#fileBytes + info.size,
						this.#maxFiles,
						"OPENORANGE_AGENTOS_MAX_SANDBOX_TRANSFER_BYTES",
					);
					this.#fileBytes += info.size;
					let retained = false;
					try {
						const bytes = Buffer.alloc(info.size);
						for (let offset = 0; offset < bytes.length; ) {
							const part = await vm.filesystem.readFileRange(
								path,
								offset,
								Math.min(65536, bytes.length - offset),
							);
							if (!part.length || part.length > bytes.length - offset)
								throw fail("EIO", "Sandbox file changed during download");
							bytes.set(part, offset);
							offset += part.length;
						}
						if (entry.closing) throw fail("ERR_SANDBOX_CLOSED", "Sandbox closed during read");
						entry.download = bytes;
						retained = true;
						return { size: bytes.length };
					} finally {
						if (!retained) this.#fileBytes -= info.size;
					}
				}
				case "write-start": {
					if (entry.upload) throw fail("EBUSY", "finish the prior Sandbox upload");
					if (input.size === undefined) throw fail("EINVAL", "Sandbox file size is required");
					this.#limit(input.size, this.#maxFile, "OPENORANGE_AGENTOS_MAX_SANDBOX_FILE_BYTES");
					this.#limit(
						this.#fileBytes + input.size,
						this.#maxFiles,
						"OPENORANGE_AGENTOS_MAX_SANDBOX_TRANSFER_BYTES",
					);
					entry.upload = {
						path: pathOf(input.path),
						bytes: Buffer.alloc(input.size),
						offset: 0,
						writing: false,
					};
					this.#fileBytes += input.size;
					return {};
				}
				case "write-finish": {
					const upload = entry.upload;
					if (!upload || upload.offset !== upload.bytes.length)
						throw fail("EINVAL", "Sandbox file upload is incomplete");
					upload.writing = true;
					try {
						await vm.filesystem.mkdir(posix.dirname(upload.path), { recursive: true });
						await vm.filesystem.writeFile(upload.path, upload.bytes);
						return {};
					} finally {
						if (entry.upload === upload) {
							this.#fileBytes -= upload.bytes.length;
							entry.upload = undefined;
						}
					}
				}
				case "mkdir":
					await vm.filesystem.mkdir(pathOf(input.path), { recursive: input.recursive ?? false });
					return {};
				case "exists":
					return { exists: await vm.filesystem.exists(pathOf(input.path)) };
				case "remove":
					await vm.filesystem.remove(pathOf(input.path));
					return {};
				case "move":
					await vm.filesystem.mkdir(posix.dirname(pathOf(input.to)), { recursive: true });
					await vm.filesystem.move(pathOf(input.path), pathOf(input.to));
					return {};
				case "stat": {
					const info = await vm.filesystem.stat(pathOf(input.path));
					const result: SandboxFileInfo = {
						type: info.isSymbolicLink ? "symlink" : info.isDirectory ? "directory" : "file",
						size: info.size,
						mode: info.mode & 0o7777,
						uid: info.uid ?? 0,
						gid: info.gid ?? 0,
						atimeMs: info.atimeMs,
						mtimeMs: info.mtimeMs,
						ctimeMs: info.ctimeMs,
					};
					return { info: result };
				}
				case "list": {
					const root = pathOf(input.path);
					const todo = [root];
					const entries: NonNullable<SandboxVmReply["entries"]> = [];
					while (todo.length) {
						const directory = todo.shift()!;
						const names = await vm.filesystem.readdir(directory);
						this.#limit(
							entries.length + names.length,
							this.#maxList,
							"OPENORANGE_AGENTOS_MAX_SANDBOX_LIST_ENTRIES",
						);
						for (const name of names) {
							if (name === "." || name === "..") continue;
							const full = posix.join(directory, name);
							const info = await vm.filesystem.stat(full);
							entries.push({
								name: posix.relative(root, full),
								isDirectory: info.isDirectory,
								size: info.size,
								modifiedAt: new Date(info.mtimeMs).toISOString(),
							});
							if (input.recursive && info.isDirectory) todo.push(full);
						}
					}
					return { entries };
				}
				default:
					throw fail("EINVAL", "unsupported Sandbox operation");
			}
		} finally {
			entry.fileBusy = false;
			entry.fileIdle!.resolve();
			entry.fileIdle = undefined;
			this.#io--;
		}
	}
	async #dispose(id: string, entry: Entry) {
		return (entry.closing ??= (async () => {
			for (const job of entry.jobs.values())
				job.abort.abort(fail("ERR_SANDBOX_CLOSED", "Sandbox VM disposed"));
			const fileIdle = entry.fileIdle?.promise;
			try {
				await (await entry.vm).dispose();
			} finally {
				await fileIdle;
				for (const job of [...entry.jobs.values()]) {
					await job.run;
					this.#retire(entry, job);
				}
				if (entry.upload) this.#fileBytes -= entry.upload.bytes.length;
				if (entry.download) this.#fileBytes -= entry.download.length;
				entry.upload = undefined;
				entry.download = undefined;
				for (const key of this.#ports) if (key.startsWith(`${id}:`)) this.#ports.delete(key);
				this.#entries.delete(id);
			}
		})());
	}
	async dispose() {
		if (this.#closed) return;
		this.#closed = true;
		for (const connection of this.#connections) connection.destroy();
		for (const socket of this.#sockets) socket.destroy();
		if (this.#front.listening)
			await new Promise<void>((resolve, reject) =>
				this.#front.close((error) => (error ? reject(error) : resolve())),
			);
		const results = await Promise.allSettled(
			[...this.#entries].map(([id, entry]) => this.#dispose(id, entry)),
		);
		const errors = results
			.filter((r): r is PromiseRejectedResult => r.status === "rejected")
			.map((r) => r.reason);
		if (errors.length) throw new AggregateError(errors, "Sandbox VM disposal failed");
	}
}
