// Sandbox backends for the `@cloudflare/sandbox` module. On Cloudflare a
// Sandbox runs in a Container. On Orange it runs on the provider the user picks
// with ORANGE_SANDBOX_PROVIDER. Remote providers come from
// `@rivet-dev/sandbox-adapter` and load lazily, only when a sandbox starts.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, posix } from "node:path";

import type { AgentOs } from "@rivet-dev/agentos-core";
import {hostedAgentOsProvider,sandboxVmHostBridge} from "./host-provider.js";
import { onRuntimeClose } from "../../internal/close-hooks.js";
import { runtimeSettings } from "../../internal/runtime-settings.js";
import type {
	Sandbox as AdapterSandbox,
	SandboxActorContext,
	SandboxProvider as AdapterProvider,
} from "@rivet-dev/sandbox-adapter";

export const sandboxProviderVariable = "ORANGE_SANDBOX_PROVIDER";
export const sandboxDirectoryVariable = "ORANGE_SANDBOX_DIR";

export const sandboxProviderNames = ["local", "e2b", "daytona", "freestyle", "agentos"] as const;
export type SandboxProviderName = (typeof sandboxProviderNames)[number];

export interface ExecOptions {
	cwd: string;
	env?: Record<string, string>;
	timeoutMs?: number;
	signal?: AbortSignal;
	onStdout?: (chunk: string) => void;
	onStderr?: (chunk: string) => void;
}

export interface ExecOutput {
	exitCode: number;
	stdout: string;
	stderr: string;
}

export interface FileEntry {
	name: string;
	isDirectory: boolean;
	size: number;
	modifiedAt: string;
}

export interface FileStat {
	type: "file" | "directory" | "symlink";
	size: number;
	mode: number;
	uid: number;
	gid: number;
	atimeMs: number;
	mtimeMs: number;
	ctimeMs: number;
}

/** One connected sandbox. Paths are absolute paths inside the sandbox. */
export interface SandboxBackend {
	readonly cwd: string;
	exec(command: string, options: ExecOptions): Promise<ExecOutput>;
	readFile(path: string): Promise<Uint8Array>;
	writeFile(path: string, content: Uint8Array): Promise<void>;
	mkdir(path: string, recursive: boolean): Promise<void>;
	exists(path: string): Promise<boolean>;
	deleteFile(path: string): Promise<void>;
	rename(from: string, to: string): Promise<void>;
	list(path: string, recursive: boolean): Promise<FileEntry[]>;
	/** Metadata for a path. With `follow` false, a final symlink is not followed. */
	stat?(path: string, follow: boolean): Promise<FileStat>;
	/** The host-reachable origin for a port, when the provider can serve preview URLs. */
	previewOrigin?(port: number): string;
	/** Sends a preview request to a port, when the provider has no host-reachable origin. */
	previewFetch?(port: number, request: Request): Promise<Response>;
}

export interface SandboxProvider {
	readonly name: SandboxProviderName;
	create(owner: string): Promise<string>;
	connect(owner: string, id: string): Promise<SandboxBackend | undefined>;
	destroy(owner: string, id: string): Promise<void>;
}

export class SandboxConfigurationError extends Error {
	override name = "SandboxConfigurationError";
}

const requiredKeys: Partial<Record<SandboxProviderName, string>> = {
	daytona: "DAYTONA_API_KEY",
	e2b: "E2B_API_KEY",
	freestyle: "FREESTYLE_API_KEY",
};

const providerPackages: Partial<Record<SandboxProviderName, string>> = {
	daytona: "@daytonaio/sdk",
	e2b: "e2b",
	freestyle: "freestyle",
};

let sharedAgentOsProvider: SandboxProvider | undefined;

function isSandboxProviderName(value: string): value is SandboxProviderName {
	return sandboxProviderNames.some((name) => name === value);
}

/** Reads the provider choice. Throws before any sandbox work when it is invalid. */
export function sandboxProviderFromEnvironment(
	environment: Readonly<Record<string, string | undefined>>,
): SandboxProvider {
	const configured = environment[sandboxProviderVariable]?.trim() || "local";
	if (!isSandboxProviderName(configured)) {
		throw new SandboxConfigurationError(
			`${sandboxProviderVariable}=${JSON.stringify(configured)} is not a sandbox provider. Use one of: ${sandboxProviderNames.join(", ")}.`,
		);
	}
	const name = configured;
	switch (name) {
		case "local":
			return localProvider(localSandboxRoot(environment));
		case "agentos":
			// The VMs live in this provider, so a Sandbox object that sleeps and
			// wakes must get the same one back.
			sharedAgentOsProvider ??= agentOsProvider();
			return sharedAgentOsProvider;
		case "daytona":
		case "e2b":
		case "freestyle": {
			const key = requiredKeys[name];
			if (key !== undefined && !environment[key]) {
				throw new SandboxConfigurationError(
					`${sandboxProviderVariable}=${name} needs ${key}. Set ${key} in the environment of orange dev, or unset ${sandboxProviderVariable} to use the local provider.`,
				);
			}
			return adapterProvider(name);
		}
	}
}

/** The provider with this name, configured from the runtime settings. */
export function sandboxProviderNamed(name: string): SandboxProvider {
	return sandboxProviderFromEnvironment({ ...runtimeSettings(), [sandboxProviderVariable]: name });
}

function localSandboxRoot(environment: Readonly<Record<string, string | undefined>>): string {
	const configured = environment[sandboxDirectoryVariable];
	if (configured) return configured;
	const rivetStorage = environment.RIVETKIT_STORAGE_PATH;
	if (rivetStorage) return join(rivetStorage, "sandboxes");
	return join(process.cwd(), ".open-orange", "sandboxes");
}

// The local provider is not isolated. Each sandbox is a directory on the host,
// and commands run as host processes with that directory's `workspace` folder
// as the working directory. Sandbox paths map under the directory, so
// `/workspace/a.txt` is `<root>/<id>/workspace/a.txt`.
function localProvider(root: string): SandboxProvider {
	const sandboxRoot = (id: string) => join(root, id);
	return {
		name: "local",
		async create() {
			const id = randomUUID();
			await mkdir(join(sandboxRoot(id), "workspace"), { recursive: true });
			return id;
		},
		async connect(_owner, id) {
			const base = sandboxRoot(id);
			try {
				await stat(base);
			} catch {
				return undefined;
			}
			return localSandbox(base);
		},
		async destroy(_owner, id) {
			await rm(sandboxRoot(id), { force: true, recursive: true });
		},
	};
}

// Process groups of running local commands. They are killed when the Orange
// runtime exits, so no sandbox process outlives `orange dev`.
const runningGroups = new Set<number>();
process.once("exit", () => {
	for (const pid of runningGroups) {
		try {
			process.kill(-pid, "SIGKILL");
		} catch {}
	}
});

function localSandbox(base: string): SandboxBackend {
	const host = (path: string) => join(base, posix.resolve("/workspace", path));
	return {
		cwd: "/workspace",
		exec(command, options) {
			return new Promise((resolveExec, rejectExec) => {
				const cwd = host(options.cwd);
				const child = spawn("sh", ["-c", command], {
					cwd,
					detached: true,
					// Only PATH and locale pass through, so host secrets such as
					// E2B_API_KEY do not reach sandbox commands.
					env: {
						HOME: join(base, "workspace"),
						LANG: process.env.LANG ?? "C.UTF-8",
						PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
						...options.env,
					},
					stdio: ["ignore", "pipe", "pipe"],
				});
				if (child.pid !== undefined) runningGroups.add(child.pid);
				let stdout = "";
				let stderr = "";
				child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
					stdout += chunk;
					options.onStdout?.(chunk);
				});
				child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
					stderr += chunk;
					options.onStderr?.(chunk);
				});
				const killGroup = () => {
					if (child.pid !== undefined) {
						try {
							process.kill(-child.pid, "SIGKILL");
						} catch {}
					}
				};
				const timer =
					options.timeoutMs && options.timeoutMs > 0
						? setTimeout(killGroup, options.timeoutMs)
						: undefined;
				options.signal?.addEventListener("abort", killGroup, { once: true });
				child.once("error", (error) => {
					clearTimeout(timer);
					rejectExec(error);
				});
				child.once("close", (code, signal) => {
					if (child.pid !== undefined) runningGroups.delete(child.pid);
					clearTimeout(timer);
					options.signal?.removeEventListener("abort", killGroup);
					// A signal-killed process reports 128 + signal number, as a shell does.
					const exitCode = code ?? 128 + signalNumber(signal);
					resolveExec({ exitCode, stdout, stderr });
				});
			});
		},
		readFile: async (path) => new Uint8Array(await readFile(host(path))),
		async writeFile(path, content) {
			await mkdir(dirname(host(path)), { recursive: true });
			await writeFile(host(path), content);
		},
		async mkdir(path, recursive) {
			await mkdir(host(path), { recursive });
		},
		async exists(path) {
			try {
				await stat(host(path));
				return true;
			} catch {
				return false;
			}
		},
		deleteFile: (path) => rm(host(path)),
		async rename(from, to) {
			await mkdir(dirname(host(to)), { recursive: true });
			await rename(host(from), host(to));
		},
		async list(path, recursive) {
			const entries = await readdir(host(path), { recursive, withFileTypes: true });
			return Promise.all(
				entries.map(async (entry) => {
					const full = join(entry.parentPath, entry.name);
					const info = await stat(full);
					return {
						isDirectory: entry.isDirectory(),
						modifiedAt: info.mtime.toISOString(),
						name: posix.relative(host(path), full),
						size: info.size,
					};
				}),
			);
		},
		async stat(path, follow) {
			const info = await (follow ? stat : lstat)(host(path));
			return {
				atimeMs: info.atimeMs,
				ctimeMs: info.ctimeMs,
				gid: info.gid,
				mode: info.mode & 0o7777,
				mtimeMs: info.mtimeMs,
				size: info.size,
				type: info.isSymbolicLink() ? "symlink" : info.isDirectory() ? "directory" : "file",
				uid: info.uid,
			};
		},
		previewOrigin: (port) => `http://127.0.0.1:${port}`,
	};
}

function signalNumber(signal: NodeJS.Signals | null): number {
	switch (signal) {
		case "SIGKILL":
			return 9;
		case "SIGTERM":
			return 15;
		case "SIGINT":
			return 2;
		default:
			return 0;
	}
}

// The provider SDKs are optional peers of the adapter, so the subpath imports
// stay untyped here and load only when the provider is used.
type AdapterFactory = (options?: object) => AdapterProvider;
const adapterFactories = {
	daytona: ["@rivet-dev/sandbox-adapter/daytona", "daytonaProvider", {}],
	e2b: ["@rivet-dev/sandbox-adapter/e2b", "e2bProvider", {}],
	// Freestyle VMs get no network unless the create says so. A Cloudflare
	// Sandbox reaches the Internet by default, so allow all outbound traffic.
	freestyle: [
		"@rivet-dev/sandbox-adapter/freestyle",
		"freestyleProvider",
		{ create: { firewall: { rules: [{ action: "allow", destination: { public: true }, source: {} }] } } },
	],
} as const;

async function loadAdapterProvider(name: "daytona" | "e2b" | "freestyle"): Promise<AdapterProvider> {
	const [specifier, factory, options] = adapterFactories[name];
	try {
		const module: unknown = await import(specifier);
		const create: unknown = typeof module === "object" && module !== null ? Reflect.get(module, factory) : undefined;
		if (typeof create !== "function") throw new Error(`${specifier} has no ${factory} export`);
		// SAFETY: The adapter subpath declares `${factory}(options?): SandboxProvider`, but its optional provider SDK peers keep the import untyped here.
		return (create as AdapterFactory)(options);
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ERR_MODULE_NOT_FOUND") {
			throw new SandboxConfigurationError(
				`${sandboxProviderVariable}=${name} needs the ${providerPackages[name]} package. Install it next to Orange: pnpm add ${providerPackages[name]}`,
				{ cause: error },
			);
		}
		throw error;
	}
}

function adapterProvider(name: "daytona" | "e2b" | "freestyle"): SandboxProvider {
	let loaded: Promise<AdapterProvider> | undefined;
	const provider = () => {
		loaded ??= loadAdapterProvider(name);
		return loaded;
	};
	const context = (owner: string): SandboxActorContext => ({
		actorId: owner,
		client: () => {
			throw new SandboxConfigurationError(`The ${name} sandbox provider does not use a Rivet client`);
		},
	});
	// Provider SDK errors such as "Invalid credentials" or "fetch failed" do not
	// say which provider failed or which setting to check.
	const named = async <T>(operation: Promise<T>): Promise<T> => {
		try {
			return await operation;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(
				`The ${name} sandbox provider failed: ${message}. Check ${requiredKeys[name]}, and that orange dev can reach ${name}.`,
				{ cause: error },
			);
		}
	};
	return {
		name,
		create: async (owner) => named((await provider()).create(context(owner))),
		async connect(owner, id) {
			const sandbox = await named((await provider()).connect(context(owner), id));
			if (sandbox === undefined) return undefined;
			await ensureWorkspace(sandbox);
			return adapterSandbox(sandbox);
		},
		async destroy(owner, id) {
			await named(Promise.resolve((await provider()).destroy?.(context(owner), id)));
		},
	};
}

export function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

const workspace = "/workspace";

// Cloudflare Sandbox code uses /workspace, but provider images start in a home
// directory, and on Daytona the user cannot create /workspace without sudo.
async function ensureWorkspace(sandbox: AdapterSandbox): Promise<void> {
	const result = await sandbox.exec(
		`[ -w ${workspace} ] || mkdir -p ${workspace} 2>/dev/null; [ -w ${workspace} ] || { sudo -n mkdir -p ${workspace} && sudo -n chown "$(id -u):$(id -g)" ${workspace}; }; [ -w ${workspace} ]`,
		{ cwd: sandbox.cwd },
	);
	if (result.exitCode !== 0) {
		throw new Error(`Cannot create a writable ${workspace} in the sandbox: ${result.stderr || result.stdout}`);
	}
}

// The adapter covers exec and basic file operations. Orange runs the rest as
// shell commands inside the sandbox. The adapter reports stdout and stderr as
// one stream, so streamed output arrives as stdout.
function adapterSandbox(sandbox: AdapterSandbox): SandboxBackend {
	const run = async (command: string) => {
		const result = await sandbox.exec(command, { cwd: sandbox.cwd });
		if (result.exitCode !== 0) {
			throw new Error(result.stderr || `Sandbox command failed: ${command}`);
		}
		return result.stdout;
	};
	const decoder = new TextDecoder();
	return {
		cwd: workspace,
		async exec(command, options) {
			const result = await sandbox.exec(command, {
				cwd: options.cwd,
				env: options.env,
				onData: options.onStdout && ((chunk) => options.onStdout?.(decoder.decode(chunk))),
				signal: options.signal,
				timeoutMs: options.timeoutMs,
			});
			return { exitCode: result.exitCode ?? 137, stderr: result.stderr, stdout: result.stdout };
		},
		readFile: (path) => sandbox.readFile(path),
		async writeFile(path, content) {
			await sandbox.mkdir(posix.dirname(path));
			const text = decoder.decode(content);
			if (new TextEncoder().encode(text).byteLength === content.byteLength) {
				await sandbox.writeFile(path, text);
				return;
			}
			await run(`printf %s ${shellQuote(Buffer.from(content).toString("base64"))} | base64 -d > ${shellQuote(path)}`);
		},
		mkdir: (path) => sandbox.mkdir(path),
		exists: (path) => sandbox.exists(path),
		deleteFile: async (path) => {
			await run(`rm -f -- ${shellQuote(path)}`);
		},
		rename: async (from, to) => {
			await run(`mkdir -p -- ${shellQuote(posix.dirname(to))} && mv -- ${shellQuote(from)} ${shellQuote(to)}`);
		},
		async list(path, recursive) {
			const depth = recursive ? "" : "-maxdepth 1";
			const output = await run(
				`cd ${shellQuote(path)} && find . -mindepth 1 ${depth} -printf '%y\\t%s\\t%T@\\t%P\\n'`,
			);
			return output
				.split("\n")
				.filter((line) => line.length > 0)
				.map((line) => {
					const [type, size, modified, name] = line.split("\t");
					return {
						isDirectory: type === "d",
						modifiedAt: new Date(Number(modified) * 1000).toISOString(),
						name: name ?? "",
						size: Number(size),
					};
				});
		},
	};
}

// The agentOS provider runs each sandbox in an embedded agentOS VM. VMs live in
// memory in the Orange runtime, so a sandbox lasts until destroy() or until
// `orange dev` exits. The library loads only when a sandbox starts.
function agentOsProvider(): SandboxProvider {
	const bridge=sandboxVmHostBridge();
	if(bridge)return hostedAgentOsProvider(bridge);
	const vms = new Map<string, Promise<AgentOs>>();
	const disposers = new Map<string, () => void>();
	const boot = async () => {
		const { AgentOs } = await import("@rivet-dev/agentos-core");
		const vm = await AgentOs.create();
		await vm.filesystem.mkdir("/workspace", { recursive: true });
		return vm;
	};
	return {
		name: "agentos",
		async create() {
			const id = randomUUID();
			const vm = boot();
			vms.set(id, vm);
			// Each VM owns a sidecar process, so dispose it when orange dev stops.
			const removeHook = onRuntimeClose(async () => {
				vms.delete(id);
				await (await vm.catch(() => undefined))?.dispose();
			});
			disposers.set(id, removeHook);
			vm.catch(() => {
				vms.delete(id);
				disposers.delete(id);
				removeHook();
			});
			await vm;
			return id;
		},
		async connect(_owner, id) {
			const vm = vms.get(id);
			return vm === undefined ? undefined : agentOsSandbox(await vm);
		},
		async destroy(_owner, id) {
			const vm = vms.get(id);
			vms.delete(id);
			disposers.get(id)?.();
			disposers.delete(id);
			await (await vm)?.dispose();
		},
	};
}

// agentOS `vm.fetch()` reaches only listeners in processes spawned directly
// with `vm.process.spawn()`, not in children of a shell, and Sandbox apps start
// servers through a shell. So each previewed port gets a small Node proxy,
// spawned directly, that forwards to the port over VM loopback.
/** Marks the agentOS preview proxy's own 502, sent when nothing listens on the port. */
export const previewUnreachableHeader = "x-orange-preview-unreachable";

const previewProxySource = `
const http = require("node:http");
const target = Number(process.argv[1]);
const server = http.createServer((req, res) => {
	const upstream = http.request({ host: "127.0.0.1", port: target, path: req.url, method: req.method, headers: req.headers }, (response) => {
		res.writeHead(response.statusCode, response.headers);
		response.pipe(res);
	});
	upstream.on("error", (error) => {
		res.writeHead(502, { "content-type": "text/plain", "${previewUnreachableHeader}": "1" });
		res.end("Nothing answered on port " + target + " in the sandbox: " + error.message);
	});
	req.pipe(upstream);
});
server.listen(0, "127.0.0.1", () => console.log("orange-preview-proxy " + server.address().port));
`;

const previewProxies = new WeakMap<AgentOs, Map<number, Promise<number>>>();

async function startPreviewProxy(vm: AgentOs, port: number): Promise<number> {
	const decoder = new TextDecoder();
	let output = "";
	let resolveProxy!: (port: number) => void;
	let rejectProxy!: (error: Error) => void;
	const ready = new Promise<number>((resolve, reject) => {
		resolveProxy = resolve;
		rejectProxy = reject;
	});
	const onOutput = (chunk: Uint8Array) => {
		output += decoder.decode(chunk, { stream: true });
		const match = /orange-preview-proxy (\d+)/.exec(output);
		if (match?.[1] !== undefined) resolveProxy(Number(match[1]));
	};
	const { pid } = await vm.process.spawn("node", ["-e", previewProxySource, String(port)], {
		onStderr: onOutput,
		onStdout: onOutput,
	});
	const failed = (exitCode: number | undefined) =>
		rejectProxy(new Error(`The preview proxy for port ${port} exited with code ${exitCode}: ${output}`));
	const stopExit = vm.onProcessExit(pid, (event) => failed(event.exitCode));
	// Arm the exit listener before checking, so an early exit is not missed.
	if ((await vm.process.get(pid)).state === "exited") failed(undefined);
	return ready.finally(stopExit);
}

function agentOsSandbox(vm: AgentOs): SandboxBackend {
	const resolve = (path: string) => posix.resolve("/workspace", path);
	const proxies = previewProxies.get(vm) ?? new Map<number, Promise<number>>();
	previewProxies.set(vm, proxies);
	return {
		async previewFetch(port, request) {
			let proxyPort = proxies.get(port);
			if (proxyPort === undefined) {
				proxyPort = startPreviewProxy(vm, port);
				proxies.set(port, proxyPort);
				proxyPort.catch(() => proxies.delete(port));
			}
			return vm.fetch(await proxyPort, request);
		},
		cwd: "/workspace",
		async exec(command, options) {
			const stdout = new TextDecoder();
			const stderr = new TextDecoder();
			const result = await vm.process.exec(command, {
				cwd: resolve(options.cwd),
				env: options.env,
				onStderr: options.onStderr && ((chunk) => options.onStderr?.(stderr.decode(chunk, { stream: true }))),
				onStdout: options.onStdout && ((chunk) => options.onStdout?.(stdout.decode(chunk, { stream: true }))),
				output: { capture: "all" },
				signal: options.signal,
				timeoutMs: options.timeoutMs,
			});
			// A killed, timed-out, or aborted command has no exit code. Report 137,
			// as a shell does for SIGKILL.
			return { exitCode: result.exitCode ?? 137, stderr: result.stderr ?? "", stdout: result.stdout ?? "" };
		},
		readFile: (path) => vm.filesystem.readFile(resolve(path)),
		async writeFile(path, content) {
			await vm.filesystem.mkdir(posix.dirname(resolve(path)), { recursive: true });
			await vm.filesystem.writeFile(resolve(path), content);
		},
		mkdir: (path, recursive) => vm.filesystem.mkdir(resolve(path), { recursive }),
		exists: (path) => vm.filesystem.exists(resolve(path)),
		deleteFile: (path) => vm.filesystem.remove(resolve(path)),
		async rename(from, to) {
			await vm.filesystem.mkdir(posix.dirname(resolve(to)), { recursive: true });
			await vm.filesystem.move(resolve(from), resolve(to));
		},
		// agentOS stat() follows symlinks, so lstat() reports the target too.
		async stat(path) {
			const info = await vm.filesystem.stat(resolve(path));
			return {
				atimeMs: info.atimeMs,
				ctimeMs: info.ctimeMs,
				gid: 0,
				mode: info.mode & 0o7777,
				mtimeMs: info.mtimeMs,
				size: info.size,
				type: info.isSymbolicLink ? "symlink" : info.isDirectory ? "directory" : "file",
				uid: 0,
			};
		},
		async list(path, recursive) {
			const root = resolve(path);
			const paths = recursive
				? (await vm.filesystem.readdirRecursive(root)).map((entry) => entry.path)
				: (await vm.filesystem.readdir(root)).filter((name) => name !== "." && name !== "..").map((name) => posix.join(root, name));
			return Promise.all(
				paths.map(async (full) => {
					const info = await vm.filesystem.stat(full);
					return {
						isDirectory: info.isDirectory,
						modifiedAt: new Date(info.mtimeMs).toISOString(),
						name: posix.relative(root, full),
						size: info.size,
					};
				}),
			);
		},
	};
}
