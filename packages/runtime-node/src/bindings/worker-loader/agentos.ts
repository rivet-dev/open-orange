// Runs each dynamic Worker as a Node.js process in its own agentOS VM, so two
// dynamic Workers never share a filesystem, process table, or loopback. A small
// pool keeps VMs booted ahead of use, each with its child process started and
// Orange's runtime imported, so a new dynamic Worker only writes its own modules.
// A pooled VM serves one dynamic Worker and is never reused.
//
// agentOS sets a VM's network policy in `AgentOs.create()` and has no API to
// change it after boot. A Worker with the default `globalOutbound` gets a VM
// with network access. A Worker with `globalOutbound: null` or a Fetcher
// outbound gets a VM with no network, since its fetch() goes over RPC to the
// parent.

import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, posix, resolve, sep } from "node:path";
import { PassThrough } from "node:stream";

import type { AgentOs } from "@rivet-dev/agentos-core";

import { onRuntimeClose } from "../../internal/close-hooks.js";
import { errorMessage, isRecord } from "../unknown-values.js";
import type { WorkerChild, WorkerFile, WorkerHost, WorkerLoaderBackend, WorkerMount, WorkerVmLimits } from "./loader.js";

// Where the child and runtime modules live inside each VM.
const runtimeRoot = "/open-orange/runtime";
const workersRoot = "/open-orange/workers";
// The Worker's modules as written. A VM serves one Worker, so the path is the same in every VM.
const bundleRoot = "/open-orange/bundle";
const exitWaitMs = 5_000;

type NetworkMode = "deny" | "network";

interface BootedVm {
	// The host directory that the VM mounts read-only at `bundleRoot`.
	bundleDirectory: string;
	moduleRewrites: Record<string, string>;
	vm: AgentOs;
}

// A VM that is booting or booted. `dispose` runs once.
interface OwnedVm {
	booted: Promise<BootedVm>;
	dispose(): Promise<void>;
}

// A writable mount is an empty host directory next to the bundle, so disposing the VM
// removes it with the bundle.
async function workerMountConfigs(bundleDirectory: string, mounts: readonly WorkerMount[]) {
	const { hostDirMount } = await import("@rivet-dev/agentos-core");
	return Promise.all(
		mounts.map(async (mount, index) => {
			if (mount.hostPath !== undefined) return hostDirMount(mount.guestPath, mount.hostPath, { readOnly: true });
			const scratch = join(dirname(bundleDirectory), `scratch-${index}`);
			await mkdir(scratch, { mode: 0o755 });
			return hostDirMount(mount.guestPath, scratch, { readOnly: false });
		}),
	);
}

function bootError(error: unknown): Error {
	const message = errorMessage(error);
	return new Error(
		`OpenOrange cannot boot the agentOS VM for a dynamic Worker: ${message}. Dynamic Workers never run on the host.`,
		{ cause: error },
	);
}


// Writes `files` into the host directory behind a VM's bundle mount.
async function writeHostFiles(directory: string, files: readonly WorkerFile[]): Promise<void> {
	for (const file of files) {
		const hostPath = resolve(directory, file.path);
		if (!hostPath.startsWith(`${directory}${sep}`)) {
			throw new TypeError(`Dynamic Worker file ${file.path} is outside its directory.`);
		}
		await mkdir(dirname(hostPath), { recursive: true });
		await writeFile(hostPath, file.content);
	}
}

// The VM's user must read the directory, so it is 0755, inside a 0700 parent
// that keeps other host users out.
async function createHostDirectory(): Promise<string> {
	const parent = await mkdtemp(join(tmpdir(), "open-orange-dynamic-worker-"));
	const directory = join(parent, "bundle");
	await mkdir(directory);
	await chmod(directory, 0o755);
	return directory;
}

async function removeHostDirectory(directory: string): Promise<void> {
	await rm(dirname(directory), { force: true, recursive: true });
}

type VmChild = WorkerChild & { exited: Promise<void> };

// A VM with the runtime bundle mounted and the child process started. The
// child has imported the runtime and waits for `start`. It has seen no user
// code or env.
interface ReadyVm {
	booted: BootedVm;
	child: VmChild;
	owned: OwnedVm;
	root: string;
}

interface VmPool {
	mode: NetworkMode;
	ready: ReadyVm[];
	// An open that waits for the prewarm in flight instead of booting its own VM.
	waiting: ((ready: ReadyVm | undefined) => void) | undefined;
	warming: boolean;
}

// Ready VMs to keep per network mode. A mode's pool fills only after its first
// dynamic Worker, so an app without dynamic Workers boots no VM.
export const workerLoaderPoolSizeSetting = "ORANGE_WORKER_LOADER_POOL_SIZE";
const defaultPoolSize = 2;
const maxPoolSize = 16;
// The pool refills a moment after a Worker loads, so the prewarm does not slow
// the Worker's first calls.
const refillDelayMs = 250;

export function workerLoaderPoolSize(settings: Readonly<Record<string, string | undefined>>): number {
	const value = settings[workerLoaderPoolSizeSetting];
	if (value === undefined || value === "") return defaultPoolSize;
	const size = Number(value);
	if (!Number.isInteger(size) || size < 0 || size > maxPoolSize) {
		throw new RangeError(
			`${workerLoaderPoolSizeSetting} must be an integer from 0 to ${maxPoolSize}, got ${JSON.stringify(value)}. Set it to 0 to boot every dynamic Worker's VM on demand.`,
		);
	}
	return size;
}

export interface AgentOsWorkerLoaderBackendOptions {
	// Resolves at boot, so a missing bundle fails the first dynamic Worker
	// instead of runtime startup.
	bundlePath(): string;
	// Reports a failure off the request path, such as a failed prewarm.
	onDiagnostic(message: string): void;
	poolSize: number;
}

export class AgentOsWorkerLoaderBackend implements WorkerLoaderBackend {
	readonly #options: AgentOsWorkerLoaderBackendOptions;
	readonly #vms = new Set<OwnedVm>();
	readonly #children = new Set<{ exited: Promise<void>; kill(): void }>();
	readonly #pools = new Map<NetworkMode, VmPool>();
	// One booted VM per mode with no child yet, for the next Worker with mounts.
	// Its mounts are added before its child starts, so it boots before they are known.
	readonly #bare = new Map<NetworkMode, OwnedVm>();
	// The one prewarm in flight. Prewarms run one at a time, since every VM
	// shares one agentOS sidecar with the dynamic Workers that are running.
	#warming: Promise<void> | undefined;
	#closed = false;

	constructor(options: AgentOsWorkerLoaderBackendOptions) {
		this.#options = options;
		// Each VM owns a sidecar process, so stop every child and dispose the
		// VMs when the runtime stops.
		onRuntimeClose(() => this.#close());
	}

	async open(network: boolean, mounts: readonly WorkerMount[], vmLimits?: WorkerVmLimits): Promise<WorkerHost> {
		if (this.#closed) throw new Error("The Worker Loader has stopped.");
		const mode: NetworkMode = network ? "network" : "deny";
		// agentOS sets limits only in `AgentOs.create()`, so a pooled VM cannot take them.
		if (vmLimits !== undefined) return this.#openOwn(mode, mounts, undefined, vmLimits);
		if (mounts.length > 0) {
			const refill = (): void => {
				setTimeout(() => this.prewarmMounted(network), refillDelayMs).unref();
			};
			const bare = this.#bare.get(mode);
			if (bare === undefined) return this.#openOwn(mode, mounts, refill);
			this.#bare.delete(mode);
			return this.#openBare(bare, mounts, refill);
		}
		let pool = this.#pools.get(mode);
		if (pool === undefined) {
			pool = { mode, ready: [], waiting: undefined, warming: false };
			this.#pools.set(mode, pool);
		}
		// A ready VM serves exactly one dynamic Worker and is disposed with it.
		const ready = await this.#claim(pool);
		if (this.#closed) {
			if (ready !== undefined) await this.#discard(ready);
			throw new Error("The Worker Loader has stopped.");
		}
		const loaded = (): void => {
			setTimeout(() => this.#refill(), refillDelayMs).unref();
		};
		if (ready !== undefined) {
			const child = Promise.resolve(ready.child);
			// The child is running even if the Worker fails before it is used.
			return this.#host(() => this.#discard(ready), ready.booted, ready.root, () => child, loaded);
		}
		return this.#openOwn(mode, [], loaded);
	}

	async #openOwn(
		mode: NetworkMode,
		mounts: readonly WorkerMount[],
		loaded = (): void => undefined,
		vmLimits?: WorkerVmLimits,
	): Promise<WorkerHost> {
		const owned = this.#boot(mode, mounts, vmLimits);
		let booted: BootedVm;
		try {
			booted = await owned.booted;
		} catch (error: unknown) {
			await owned.dispose();
			throw bootError(error);
		}
		const root = posix.join(workersRoot, randomUUID());
		// The child starts in the Worker's root, as in a prewarmed VM.
		try {
			await booted.vm.filesystem.mkdir(root, { recursive: true });
		} catch (error: unknown) {
			await owned.dispose();
			throw bootError(error);
		}
		return this.#host(() => owned.dispose(), booted, root, () => this.#spawn(booted.vm, root, owned), loaded);
	}

	// Boots a VM ahead of the next Worker with mounts in this mode. The runtime
	// calls it when it creates a Worker Loader binding, so the first such Worker
	// does not wait for a VM boot.
	prewarmMounted(network: boolean): void {
		const mode: NetworkMode = network ? "network" : "deny";
		if (this.#closed || this.#options.poolSize === 0 || this.#bare.has(mode)) return;
		const owned = this.#boot(mode);
		this.#bare.set(mode, owned);
		owned.booted.catch((error: unknown) => {
			if (this.#bare.get(mode) === owned) this.#bare.delete(mode);
			void owned.dispose();
			if (this.#closed) return;
			this.#options.onDiagnostic(
				`OpenOrange cannot prewarm an agentOS VM for dynamic Workers with mounts (${mode}): ${errorMessage(error)}. They boot their VM on demand instead.`,
			);
		});
	}

	async #openBare(owned: OwnedVm, mounts: readonly WorkerMount[], loaded: () => void): Promise<WorkerHost> {
		let booted: BootedVm;
		try {
			booted = await owned.booted;
			// In order, so a mount inside another mount lands on top of it.
			for (const mount of await workerMountConfigs(booted.bundleDirectory, mounts)) {
				await booted.vm.filesystem.mount(mount);
			}
		} catch (error: unknown) {
			await owned.dispose();
			throw bootError(error);
		}
		const root = posix.join(workersRoot, randomUUID());
		// The child starts in the Worker's root, as in a prewarmed VM.
		try {
			await booted.vm.filesystem.mkdir(root, { recursive: true });
		} catch (error: unknown) {
			await owned.dispose();
			throw bootError(error);
		}
		return this.#host(() => owned.dispose(), booted, root, () => this.#spawn(booted.vm, root, owned), loaded);
	}

	// A ready VM, or the prewarm in flight if no other open waits for it, since
	// it finishes sooner than a new boot. Otherwise the open boots its own VM.
	#claim(pool: VmPool): ReadyVm | Promise<ReadyVm | undefined> | undefined {
		const ready = pool.ready.shift();
		if (ready !== undefined || !pool.warming || pool.waiting !== undefined) return ready;
		return new Promise((resolveReady) => {
			pool.waiting = resolveReady;
		});
	}

	// Prewarms one VM for the first pool below its size, then the next. A
	// failed prewarm is reported and stops the refill until the next Worker
	// loads, so a VM that cannot boot never loops in the background.
	#refill(): void {
		if (this.#closed || this.#warming !== undefined) return;
		const pool = [...this.#pools.values()].find((entry) => entry.ready.length < this.#options.poolSize);
		if (pool === undefined) return;
		pool.warming = true;
		this.#warming = this.#prewarm(pool.mode).then(
			(ready) => {
				this.#warming = undefined;
				pool.warming = false;
				this.#offer(pool, ready);
				this.#refill();
			},
			(error: unknown) => {
				this.#warming = undefined;
				pool.warming = false;
				this.#takeWaiting(pool)?.(undefined);
				// Closing disposes a booting VM, which fails its prewarm on purpose.
				if (this.#closed) return;
				this.#options.onDiagnostic(
					`OpenOrange cannot prewarm an agentOS VM for dynamic Workers (${pool.mode}): ${errorMessage(error)}. Dynamic Workers boot their VM on demand instead.`,
				);
			},
		);
	}

	#takeWaiting(pool: VmPool): ((ready: ReadyVm | undefined) => void) | undefined {
		const waiting = pool.waiting;
		pool.waiting = undefined;
		return waiting;
	}

	#offer(pool: VmPool, ready: ReadyVm): void {
		const waiting = this.#takeWaiting(pool);
		if (waiting !== undefined) {
			waiting(ready);
			return;
		}
		if (this.#closed) {
			void this.#discard(ready);
			return;
		}
		pool.ready.push(ready);
		// A child that exits while it waits leaves the pool with its VM.
		void ready.child.exited.then(() => {
			const index = pool.ready.indexOf(ready);
			if (index === -1) return;
			pool.ready.splice(index, 1);
			void ready.owned.dispose();
			if (!this.#closed) {
				this.#options.onDiagnostic(
					`A prewarmed dynamic Worker VM (${pool.mode}) exited before use. The next dynamic Worker boots a new one.`,
				);
			}
		});
	}

	#host(
		remove: () => Promise<void>,
		booted: BootedVm,
		root: string,
		spawn: () => Promise<VmChild>,
		loaded: () => void,
	): WorkerHost {
		const { bundleDirectory, moduleRewrites } = booted;
		return {
			bundleRoot,
			loaded,
			moduleRewrites,
			remove,
			root,
			spawn,
			// The bytes reach the VM through its bundle mount, so no file is one sidecar message.
			writeBundle: (files) => writeHostFiles(bundleDirectory, files),
		};
	}

	async #spawn(vm: AgentOs, root: string, owned: OwnedVm): Promise<VmChild> {
		const child = await spawnVmChild(vm, root, {
			dispose: () => owned.dispose(),
			report: (message) => this.#options.onDiagnostic(message),
		});
		const entry = { exited: child.exited, kill: () => child.kill() };
		this.#children.add(entry);
		void child.exited.then(() => this.#children.delete(entry));
		if (this.#closed) child.kill();
		return child;
	}

	async #prewarm(mode: NetworkMode): Promise<ReadyVm> {
		const owned = this.#boot(mode);
		try {
			const booted = await owned.booted;
			const root = posix.join(workersRoot, randomUUID());
			// The child starts in the Worker's root, before any file is in it.
			await booted.vm.filesystem.mkdir(root, { recursive: true });
			const child = await this.#spawn(booted.vm, root, owned);
			return { booted, child, owned, root };
		} catch (error: unknown) {
			await owned.dispose();
			throw error;
		}
	}

	// `kill()` bounds the wait for the exit.
	async #discard(ready: ReadyVm): Promise<void> {
		ready.child.kill();
		await ready.child.exited;
		await ready.owned.dispose();
	}

	#boot(mode: NetworkMode, mounts: readonly WorkerMount[] = [], vmLimits?: WorkerVmLimits): OwnedVm {
		const booted = this.#create(mode, mounts, vmLimits);
		let disposed: Promise<void> | undefined;
		const owned: OwnedVm = {
			booted,
			dispose: () => {
				disposed ??= (async () => {
					this.#vms.delete(owned);
					// A VM that failed to boot has nothing to dispose, and its boot error reaches the
					// caller that booted it.
					const value = await booted.catch(() => undefined);
					await value?.vm.dispose().catch((error: unknown) => {
						this.#options.onDiagnostic(
							`OpenOrange cannot dispose the agentOS VM of a dynamic Worker: ${errorMessage(error)}`,
						);
					});
					if (value !== undefined) await removeHostDirectory(value.bundleDirectory);
				})();
				return disposed;
			},
		};
		this.#vms.add(owned);
		return owned;
	}

	async #create(mode: NetworkMode, mounts: readonly WorkerMount[], vmLimits?: WorkerVmLimits): Promise<BootedVm> {
		const bundlePath = resolve(this.#options.bundlePath());
		const manifest: unknown = JSON.parse(await readFile(join(bundlePath, "manifest.json"), "utf8"));
		if (!isRecord(manifest)) throw new Error("The agentOS runtime bundle manifest must be an object");
		const moduleRewrites = Object.fromEntries(
			Object.entries(manifest).map(([specifier, file]) => {
				if (typeof file !== "string") {
					throw new Error(`The agentOS runtime bundle manifest maps ${specifier} to a non-string file`);
				}
				return [specifier, posix.join(runtimeRoot, file)];
			}),
		);
		const { AgentOs, hostDirMount } = await import("@rivet-dev/agentos-core");
		const bundleDirectory = await createHostDirectory();
		try {
			const workerMounts = await workerMountConfigs(bundleDirectory, mounts);
			// The guest reads Orange's runtime from the host, read-only, so a VM
			// boots without a copy of it. The mount shows only the bundle directory.
			// The Worker's bundle is mounted at boot too: agentOS fails the running
			// child's wait() while a later mount() is in flight.
			const vm = await AgentOs.create({
				mounts: [
					hostDirMount(runtimeRoot, bundlePath, { readOnly: true }),
					hostDirMount(bundleRoot, bundleDirectory, { readOnly: true }),
					...workerMounts,
				],
				permissions: { network: mode === "network" ? "allow" : "deny" },
				...(vmLimits === undefined
					? {}
					: { limits: { jsRuntime: { cpuTimeLimitMs: vmLimits.cpuTimeMs, v8HeapLimitMb: vmLimits.heapMb } } }),
			});
			return { bundleDirectory, moduleRewrites, vm };
		} catch (error: unknown) {
			await removeHostDirectory(bundleDirectory);
			throw error;
		}
	}

	async #close(): Promise<void> {
		this.#closed = true;
		// A prewarm that is booting finishes or fails first, so none starts a
		// child after the children below are stopped.
		await Promise.race([
			this.#warming,
			new Promise((resolveWait) => setTimeout(resolveWait, exitWaitMs).unref()),
		]);
		for (const pool of this.#pools.values()) this.#takeWaiting(pool)?.(undefined);
		// Disposing a VM with a running process fails to observe its exit, so
		// stop the children first.
		const children = [...this.#children];
		for (const child of children) child.kill();
		await Promise.race([
			Promise.all(children.map((child) => child.exited)),
			new Promise((resolveWait) => setTimeout(resolveWait, exitWaitMs).unref()),
		]);
		await Promise.all([...this.#vms].map((owned) => owned.dispose()));
	}
}

interface VmChildOptions {
	// Disposes the child's VM. Runs when the child does not stop after SIGKILL.
	dispose(): Promise<void>;
	report(message: string): void;
}

async function spawnVmChild(vm: AgentOs, root: string, options: VmChildOptions): Promise<VmChild> {
	const stdout = new PassThrough();
	const exitListeners: ((reason: string) => void)[] = [];
	let exitReason: string | undefined;
	let killing = false;
	let forceExit: (reason: string) => void = () => undefined;
	const descriptor = await vm.process.spawn("node", [posix.join(runtimeRoot, "worker-loader-child.mjs")], {
		cwd: root,
		env: { HOME: "/home/user", PATH: "/usr/local/bin:/usr/bin:/bin" },
		onStderr: (chunk) => process.stderr.write(chunk),
		onStdout: (chunk) => stdout.write(chunk),
	});
	const pid = descriptor.pid;
	const exited = new Promise<void>((resolveExit) => {
		// A disposed VM may never report the exit of its process, so a forced stop ends the wait.
		forceExit = (reason) => {
			exitReason ??= reason;
			resolveExit();
		};
		vm.process.wait(pid).then(
			(exit) => {
				forceExit(
					exit.outcome === "signalled"
						? `signal ${exit.signal ?? "unknown"}`
						: exit.outcome === "timed_out"
							? "timed out"
							: `code ${exit.exitCode ?? "none"}`,
				);
			},
			(error: unknown) => forceExit(`lost: ${errorMessage(error)}`),
		);
	});
	// Disposes the VM of a child that SIGKILL did not stop, so it never runs outside the limit.
	const stopVm = (why: string): void => {
		if (exitReason !== undefined) return;
		options.report(`Dynamic Worker process ${pid} ${why}. OpenOrange disposes its agentOS VM.`);
		void options.dispose().finally(() => forceExit(`lost: ${why}`));
	};
	const done = exited.then(() => {
		stdout.end();
		for (const listener of exitListeners.splice(0)) listener(exitReason ?? "unknown");
	});
	// The VM takes stdin writes in order only if each waits for the last.
	let writes = Promise.resolve();
	return {
		exited: done,
		kill(): void {
			if (exitReason !== undefined || killing) return;
			killing = true;
			// A process that exits on its own as it is killed fails the signal, so only an exit
			// that does not follow is a failure.
			let signalError = "";
			const timer = setTimeout(
				() => stopVm(`did not exit ${exitWaitMs} ms after SIGKILL${signalError}`),
				exitWaitMs,
			);
			timer.unref();
			void done.then(() => clearTimeout(timer));
			vm.process.signal(pid, "SIGKILL").catch((error: unknown) => {
				signalError = ` (the signal failed: ${errorMessage(error)})`;
			});
		},
		onExit(listener): void {
			if (exitReason !== undefined) listener(exitReason);
			else exitListeners.push(listener);
		},
		stdout,
		write(text): void {
			if (exitReason !== undefined) return;
			writes = writes
				.then(() => vm.process.writeStdin(pid, text))
				.catch((error: unknown) => {
					// Writes fail once the process exits, and its exit fails its calls.
					if (exitReason === undefined && !killing) {
						options.report(`OpenOrange cannot write to dynamic Worker process ${pid}: ${errorMessage(error)}`);
					}
				});
		},
	};
}
