// Runs each dynamic Worker as a Node.js process in its own agentOS VM, so two
// dynamic Workers never share a filesystem, process table, or loopback. A pool
// sized to recent demand keeps VMs booted ahead of use, each with its child
// process started and Orange's runtime imported, so a new dynamic Worker only
// writes its own modules. A pooled VM serves one dynamic Worker and is never
// reused.
//
// agentOS sets a VM's network policy in `AgentOs.create()` and has no API to
// change it after boot. A Worker with the default `globalOutbound` gets a VM
// with network access. A Worker with `globalOutbound: null` or a Fetcher
// outbound gets a VM with no network, since its fetch() goes over RPC to the
// parent.

import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, posix, resolve } from "node:path";
import { PassThrough } from "node:stream";

import type { AgentOs } from "@rivet-dev/agentos-core";

import { onRuntimeClose } from "../../internal/close-hooks.js";
import { errorMessage, isRecord } from "../unknown-values.js";
import { positiveIntegerSetting, type WorkerChild, type WorkerHost, type WorkerLoaderBackend } from "./loader.js";
import type { VmGauges, WorkerLoaderMetrics } from "./metrics.js";

// Where the child and runtime modules live inside each VM.
const runtimeRoot = "/open-orange/runtime";
const workersRoot = "/open-orange/workers";
const exitWaitMs = 5_000;
// The most stdin bytes sent to a dynamic Worker process in one agentOS write.
const maxStdinWriteBytes = 1024 * 1024;

type NetworkMode = "deny" | "network";

interface BootedVm {
	moduleRewrites: Record<string, string>;
	vm: AgentOs;
}

// A VM that is booting or booted. `dispose` runs once.
interface OwnedVm {
	booted: Promise<BootedVm>;
	dispose(): Promise<void>;
}

function bootError(error: unknown): Error {
	const message = errorMessage(error);
	return new Error(
		`OpenOrange cannot boot the agentOS VM for a dynamic Worker: ${message}. Dynamic Workers never run on the host.`,
		{ cause: error },
	);
}


// agentOS writes one file into the VM as one message to its sidecar. In a test with agentOS 0.4.1,
// a 15 MiB file wrote and a 16.5 MiB file crashed the sidecar, which then failed every Dynamic
// Worker of the session. A larger file fails here with the limit instead. The VM filesystem
// itself holds 64 MiB by default.
const agentOsFileMessageBytes = 16 * 1024 * 1024;

function assertFitsAgentOsFileMessage(path: string, content: string | Uint8Array): void {
	const bytes = typeof content === "string" ? Buffer.byteLength(content) : content.byteLength;
	if (bytes <= agentOsFileMessageBytes) return;
	throw new RangeError(
		`Dynamic Worker file ${posix.basename(path)} is ${bytes} bytes. agentOS writes one file into its VM as one message of at most ${agentOsFileMessageBytes} bytes (16 MiB). Split the module.`,
	);
}

type VmChild = WorkerChild & { exited: Promise<void> };

type LoadHooks = Pick<WorkerHost, "loaded" | "settled">;

// A VM with the runtime bundle mounted and the child process started. The
// child has imported the runtime and waits for `start`. It has seen no user
// code or env.
interface ReadyVm {
	booted: BootedVm;
	child: VmChild;
	owned: OwnedVm;
	root: string;
}

// The ready VMs of one network mode. Its target size follows demand: the most
// Workers claimed within one prewarm time, from `size` to `max`, so a burst
// that drained the pool finds it full the next time. It falls back to `size`
// once `idleMs` passes without such a peak.
interface VmPool {
	mode: NetworkMode;
	ready: ReadyVm[];
	// Opens that wait for a prewarm in flight, at most one for each prewarm.
	// Every other open boots its own VM at once.
	waiting: ((ready: ReadyVm | undefined) => void)[];
	warming: number;
	// The latest claim times, oldest first, at most `max` of them.
	claims: number[];
	peak: number;
	shrink: NodeJS.Timeout | undefined;
	// Set when a prewarm fails. The pool refills again only after its next
	// claim, so a VM that cannot boot never loops in the background.
	failed: boolean;
}

// A mode's pool fills only after its first dynamic Worker, so an app without
// dynamic Workers boots no VM.
export const workerLoaderPoolSizeSetting = "ORANGE_WORKER_LOADER_POOL_SIZE";
export const workerLoaderPoolMaxSetting = "ORANGE_WORKER_LOADER_POOL_MAX";
const defaultPoolSize = 2;
const defaultPoolMax = 16;
const poolSettingLimit = 64;
// Prewarms in flight across both modes. They share one agentOS sidecar with
// the running Workers. A load that finds its pool empty never waits for this.
const maxParallelPrewarms = 4;
// The longest one Worker holds back the refill while it loads.
const maxRefillHoldMs = 1_000;
// How far back the claim rate looks when loads keep the refill held.
const claimRateWindowMs = 1_000;
// Enough claim times to show a rate that needs every parallel prewarm.
const maxRecentClaims = 512;
// The prewarm time before the first one is measured.
const initialPrewarmMs = 250;
const warnRatio = 0.8;

export interface WorkerLoaderPoolLimits {
	// Ready VMs kept per network mode when no burst is recent.
	size: number;
	// The most ready VMs per network mode. 0 boots every VM on demand.
	max: number;
}

// Every agentOS VM of dynamic Workers counts: running Workers, prewarmed VMs, VMs that boot,
// and VMs that are still stopping. A running Worker's slot frees as soon as it stops, before its
// VM is gone, so without this budget a churn of Workers could hold more VMs than the slots.
export const workerLoaderMaxVmsSetting = "ORANGE_WORKER_LOADER_MAX_VMS";

// Defaults to the slots plus one pool's most, so the pool has room beside full slots.
export function workerLoaderMaxVms(
	settings: Readonly<Record<string, string | undefined>>,
	maxWorkers: number,
	pool: WorkerLoaderPoolLimits,
): number {
	return positiveIntegerSetting(
		settings,
		workerLoaderMaxVmsSetting,
		maxWorkers + pool.max,
		Number.MAX_SAFE_INTEGER,
		maxWorkers,
	);
}

function poolSetting(settings: Readonly<Record<string, string | undefined>>, name: string, fallback: number): number {
	const value = settings[name];
	if (value === undefined || value === "") return fallback;
	const count = Number(value);
	if (!Number.isInteger(count) || count < 0 || count > poolSettingLimit) {
		throw new RangeError(
			`${name} must be an integer from 0 to ${poolSettingLimit}, got ${JSON.stringify(value)}. Set ${workerLoaderPoolMaxSetting} to 0 to boot every dynamic Worker's VM on demand.`,
		);
	}
	return count;
}

export function workerLoaderPoolLimits(settings: Readonly<Record<string, string | undefined>>): WorkerLoaderPoolLimits {
	const max = poolSetting(settings, workerLoaderPoolMaxSetting, defaultPoolMax);
	const size = poolSetting(settings, workerLoaderPoolSizeSetting, Math.min(defaultPoolSize, max));
	if (size > max) {
		throw new RangeError(
			`${workerLoaderPoolSizeSetting} (${size}) must not be larger than ${workerLoaderPoolMaxSetting} (${max}).`,
		);
	}
	return { max, size };
}

export interface AgentOsWorkerLoaderBackendOptions {
	// Resolves at boot, so a missing bundle fails the first dynamic Worker
	// instead of runtime startup.
	bundlePath(): string;
	// Reports a failure off the request path, such as a failed prewarm.
	onDiagnostic(message: string): void;
	onWarning(message: string): void;
	// At least the slots of the DynamicWorkerPool, so every Worker with a slot gets a VM.
	maxVms: number;
	metrics: WorkerLoaderMetrics;
	pool: WorkerLoaderPoolLimits & {
		// How long a pool keeps VMs above `size` after its last peak.
		idleMs: number;
	};
}

export class AgentOsWorkerLoaderBackend implements WorkerLoaderBackend {
	readonly #options: AgentOsWorkerLoaderBackendOptions;
	// Every VM from its boot until its disposal finishes.
	readonly #vms = new Set<OwnedVm>();
	readonly #stopping = new Set<OwnedVm>();
	// Opens that wait for room in the VM budget, first in line first. Each boots its VM in the
	// callback, so no prewarm takes the room first.
	readonly #vmWaiters: { boot(): void; fail(error: Error): void }[] = [];
	#warnedVms = false;
	readonly #children = new Set<{ exited: Promise<void>; kill(): void }>();
	readonly #pools = new Map<NetworkMode, VmPool>();
	readonly #warming = new Set<Promise<void>>();
	// Dynamic Workers that hold back the refill, since a prewarm that runs
	// beside them slows them about 3x. A Worker holds it while it loads. A
	// Worker that loads beside another holds it until its first calls finish
	// too, so a burst's first calls never share the sidecar with its refill.
	readonly #holds = new Set<{ beside: boolean }>();
	// A moving average of how long a prewarm takes.
	#prewarmMs = initialPrewarmMs;
	// Claim times across both modes, oldest first, within one prewarm time plus the rate window.
	readonly #recentClaims: number[] = [];
	// VMs that boot for a load that found no prewarmed VM.
	#bootingOnDemand = 0;
	#closed = false;

	constructor(options: AgentOsWorkerLoaderBackendOptions) {
		this.#options = options;
		options.metrics.vmGauges = () => this.#gauges();
		// Each VM owns a sidecar process, so stop every child and dispose the
		// VMs when the runtime stops.
		onRuntimeClose(() => this.#close());
	}

	#gauges(): VmGauges {
		let pooled = 0;
		const poolReady: Record<string, number> = {};
		for (const pool of this.#pools.values()) {
			pooled += pool.ready.length;
			poolReady[pool.mode] = pool.ready.length;
		}
		const booting = this.#warming.size + this.#bootingOnDemand;
		const stopping = this.#stopping.size;
		return {
			maxVms: this.#options.maxVms,
			poolReady,
			waiting: this.#vmWaiters.length,
			vms: { booting, live: Math.max(0, this.#vms.size - pooled - booting - stopping), pooled, stopping },
		};
	}

	async open(network: boolean): Promise<WorkerHost> {
		if (this.#closed) throw new Error("The Worker Loader has stopped.");
		const mode: NetworkMode = network ? "network" : "deny";
		let pool = this.#pools.get(mode);
		if (pool === undefined) {
			pool = { claims: [], failed: false, mode, peak: 0, ready: [], shrink: undefined, waiting: [], warming: 0 };
			this.#pools.set(mode, pool);
		}
		const hold = { beside: this.#holds.size > 0 };
		for (const other of this.#holds) other.beside = true;
		this.#holds.add(hold);
		const release = (): void => {
			if (!this.#holds.delete(hold)) return;
			clearTimeout(timer);
			this.#refill();
		};
		// A Worker whose load hangs must not stop the refill for good.
		const timer = setTimeout(release, maxRefillHoldMs);
		timer.unref();
		const hooks: LoadHooks = {
			loaded: () => {
				if (!hold.beside) release();
			},
			settled: release,
		};
		try {
			return await this.#openVm(pool, hooks);
		} catch (error: unknown) {
			release();
			throw error;
		}
	}

	async #openVm(pool: VmPool, hooks: LoadHooks): Promise<WorkerHost> {
		// A ready VM serves exactly one dynamic Worker and is disposed with it.
		const claim = this.#claim(pool);
		this.#refill();
		const ready = await claim;
		this.#options.metrics.claim(
			pool.mode,
			ready === undefined ? "miss" : claim instanceof Promise ? "warming" : "hit",
		);
		if (this.#closed) {
			if (ready !== undefined) await this.#discard(ready);
			throw new Error("The Worker Loader has stopped.");
		}
		if (ready !== undefined) {
			const child = Promise.resolve(ready.child);
			// The child is running even if the Worker fails before it is used.
			return this.#host(() => this.#discard(ready), ready.booted, ready.root, () => child, hooks);
		}
		let owned: OwnedVm | undefined;
		let booted: BootedVm;
		try {
			owned = await this.#bootWithinBudget(pool.mode);
			this.#bootingOnDemand += 1;
			try {
				booted = await owned.booted;
			} finally {
				this.#bootingOnDemand -= 1;
			}
		} catch (error: unknown) {
			await owned?.dispose();
			throw bootError(error);
		}
		const bootedVm = owned;
		const root = posix.join(workersRoot, randomUUID());
		return this.#host(() => bootedVm.dispose(), booted, root, () => this.#spawn(booted.vm, root, bootedVm), hooks);
	}

	// Boots a VM for a load once the VM budget has room. At the budget, prewarmed VMs stop to
	// make room, and the load waits for a VM that stops.
	#bootWithinBudget(mode: NetworkMode): Promise<OwnedVm> {
		if (this.#closed) return Promise.reject(new Error("The Worker Loader has stopped."));
		if (this.#vmWaiters.length === 0 && this.#vms.size < this.#options.maxVms) {
			return Promise.resolve(this.#boot(mode));
		}
		return new Promise((resolveBoot, rejectBoot) => {
			this.#vmWaiters.push({ boot: () => resolveBoot(this.#boot(mode)), fail: rejectBoot });
			this.#makeRoom();
		});
	}

	// Stops prewarmed VMs, from the fullest pool first, while more loads wait for room than the
	// VMs that already stop will free.
	#makeRoom(): void {
		let short = this.#vmWaiters.length - this.#stopping.size;
		while (short > 0) {
			let fullest: VmPool | undefined;
			for (const pool of this.#pools.values()) {
				if (pool.ready.length > (fullest?.ready.length ?? 0)) fullest = pool;
			}
			const ready = fullest?.ready.shift();
			if (ready === undefined) return;
			void this.#discard(ready);
			short -= 1;
		}
	}

	// A VM finished stopping, so a load that waits for room may boot.
	#vmFreed(): void {
		if (this.#closed) {
			for (const waiter of this.#vmWaiters.splice(0)) waiter.fail(new Error("The Worker Loader has stopped."));
		}
		while (this.#vmWaiters.length > 0 && this.#vms.size < this.#options.maxVms) {
			this.#vmWaiters.shift()?.boot();
		}
		if (this.#vms.size < Math.ceil(this.#options.maxVms * warnRatio)) this.#warnedVms = false;
		this.#refill();
	}

	// A ready VM, or a prewarm in flight that no other open waits for, since it
	// finishes sooner than a new boot. Otherwise the open boots its own VM at
	// once, beside any other boot.
	#claim(pool: VmPool): ReadyVm | Promise<ReadyVm | undefined> | undefined {
		this.#recordClaim(pool);
		const ready = pool.ready.shift();
		if (ready !== undefined || pool.warming <= pool.waiting.length) return ready;
		return new Promise((resolveReady) => pool.waiting.push(resolveReady));
	}

	// Raises the pool's target to the claims seen within one prewarm time, so
	// the refill keeps up with a steady stream of loads and the next burst of
	// the same size finds its VMs ready.
	#recordClaim(pool: VmPool): void {
		const { idleMs, max } = this.#options.pool;
		pool.failed = false;
		if (max === 0) return;
		const now = performance.now();
		this.#recentClaims.push(now);
		const oldest = now - this.#prewarmMs - claimRateWindowMs;
		while (this.#recentClaims.length > maxRecentClaims || (this.#recentClaims[0] ?? now) < oldest) {
			this.#recentClaims.shift();
		}
		pool.claims.push(now);
		if (pool.claims.length > max) pool.claims.shift();
		const recent = pool.claims.filter((at) => now - at <= this.#prewarmMs).length;
		if (recent < pool.peak) return;
		pool.peak = recent;
		clearTimeout(pool.shrink);
		pool.shrink = setTimeout(() => {
			pool.peak = 0;
			pool.shrink = undefined;
			const excess = pool.ready.splice(0, Math.max(0, pool.ready.length - this.#target(pool)));
			for (const ready of excess) void this.#discard(ready);
		}, idleMs).unref();
	}

	#target(pool: VmPool): number {
		const { max, size } = this.#options.pool;
		return Math.min(max, Math.max(size, pool.peak));
	}

	// Ready VMs, plus prewarms in flight that no open waits for.
	#supply(pool: VmPool): number {
		return pool.ready.length + pool.warming - pool.waiting.length;
	}

	// How many prewarms may run now. With no dynamic Worker loading, `maxParallelPrewarms`. While
	// Workers load, a prewarm beside them slows them, so only a steady stream of claims earns
	// prewarms: as many as keep up with its rate. A steady stream claims VMs both within the last
	// prewarm time and in the second before it; a burst does only once, so it never refills
	// beside its own loads.
	#refillLimit(): number {
		if (this.#holds.size === 0) return maxParallelPrewarms;
		const now = performance.now();
		let recent = 0;
		let earlier = 0;
		for (const at of this.#recentClaims) {
			const age = now - at;
			if (age <= this.#prewarmMs) recent += 1;
			else if (age <= this.#prewarmMs + claimRateWindowMs) earlier += 1;
		}
		const ratePerMs = Math.min(recent / this.#prewarmMs, earlier / claimRateWindowMs);
		return Math.min(maxParallelPrewarms, Math.ceil(ratePerMs * this.#prewarmMs));
	}

	// Starts prewarms for the pools furthest below their target, up to the refill limit at once,
	// while the VM budget has room and no load waits for it.
	#refill(): void {
		while (
			!this.#closed &&
			this.#warming.size < this.#refillLimit() &&
			this.#vmWaiters.length === 0 &&
			this.#vms.size < this.#options.maxVms
		) {
			let neediest: VmPool | undefined;
			let missing = 0;
			for (const pool of this.#pools.values()) {
				const gap = this.#target(pool) - this.#supply(pool);
				if (!pool.failed && gap > missing) {
					neediest = pool;
					missing = gap;
				}
			}
			if (neediest === undefined) return;
			this.#startPrewarm(neediest);
		}
	}

	#startPrewarm(pool: VmPool): void {
		pool.warming += 1;
		const started = performance.now();
		const warming = this.#prewarm(pool.mode)
			.then(
				(ready) => {
					pool.warming -= 1;
					this.#prewarmMs += (performance.now() - started - this.#prewarmMs) / 4;
					this.#offer(pool, ready);
				},
				(error: unknown) => {
					pool.warming -= 1;
					// An open that waited for this prewarm boots its own VM.
					if (pool.waiting.length > pool.warming) pool.waiting.pop()?.(undefined);
					// Closing disposes a booting VM, which fails its prewarm on purpose.
					if (this.#closed || pool.failed) return;
					pool.failed = true;
					this.#options.onDiagnostic(
						`OpenOrange cannot prewarm an agentOS VM for dynamic Workers (${pool.mode}): ${errorMessage(error)}. Dynamic Workers boot their VM on demand instead.`,
					);
				},
			)
			.finally(() => {
				this.#warming.delete(warming);
				this.#refill();
			});
		this.#warming.add(warming);
	}

	#offer(pool: VmPool, ready: ReadyVm): void {
		const waiting = pool.waiting.shift();
		if (waiting !== undefined) {
			waiting(ready);
			return;
		}
		// The target may have shrunk while the VM booted, or a load may wait for its room.
		if (this.#closed || pool.ready.length >= this.#target(pool) || this.#vmWaiters.length > this.#stopping.size) {
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
		hooks: LoadHooks,
	): WorkerHost {
		const { moduleRewrites, vm } = booted;
		return {
			...hooks,
			moduleRewrites,
			remove,
			root,
			spawn,
			async writeFiles(files): Promise<void> {
				for (const file of files) assertFitsAgentOsFileMessage(file.path, file.content);
				const results = await vm.filesystem.writeFiles(
					files.map((file) => ({ content: file.content, path: file.path })),
				);
				const failed = results.find((result) => !result.success);
				if (failed !== undefined) {
					throw new Error(`Failed to write ${failed.path} into the agentOS VM: ${failed.error ?? "unknown error"}`);
				}
			},
		};
	}

	async #spawn(vm: AgentOs, root: string, owned: OwnedVm): Promise<VmChild> {
		const spawned = await spawnVmChild(vm, root, {
			dispose: () => owned.dispose(),
			report: (message) => this.#options.onDiagnostic(message),
		});
		// A VM counts as stopping from the kill on, so room that it will free is not made twice.
		const child: VmChild = {
			...spawned,
			kill: () => {
				this.#stopping.add(owned);
				spawned.kill();
			},
		};
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

	#boot(mode: NetworkMode): OwnedVm {
		const startedAt = performance.now();
		const booted = this.#create(mode);
		void booted.then(
			() => this.#options.metrics.vmBoot.observe((performance.now() - startedAt) / 1_000),
			() => undefined,
		);
		let disposed: Promise<void> | undefined;
		const owned: OwnedVm = {
			booted,
			dispose: () => {
				disposed ??= (async () => {
					this.#stopping.add(owned);
					// A VM that failed to boot has nothing to dispose, and its boot error reaches the
					// caller that booted it.
					const vm = await booted.then(({ vm: value }) => value).catch(() => undefined);
					await vm?.dispose().catch((error: unknown) => {
						this.#options.onDiagnostic(
							`OpenOrange cannot dispose the agentOS VM of a dynamic Worker: ${errorMessage(error)}`,
						);
					});
					this.#stopping.delete(owned);
					this.#vms.delete(owned);
					this.#vmFreed();
				})();
				return disposed;
			},
		};
		this.#vms.add(owned);
		const { maxVms } = this.#options;
		if (!this.#warnedVms && this.#vms.size >= Math.ceil(maxVms * warnRatio)) {
			this.#warnedVms = true;
			this.#options.onWarning(
				`${this.#vms.size} of ${maxVms} agentOS VMs for dynamic Workers are in use, counting running Workers, prewarmed VMs, and VMs that boot or stop. At the limit, prewarmed VMs stop first, and a new Worker waits for a VM to stop. Raise ${workerLoaderMaxVmsSetting} to allow more.`,
			);
		}
		return owned;
	}

	async #create(mode: NetworkMode): Promise<BootedVm> {
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
		// The guest reads Orange's runtime from the host, read-only, so a VM
		// boots without a copy of it. The mount shows only the bundle directory.
		const vm = await AgentOs.create({
			mounts: [hostDirMount(runtimeRoot, bundlePath, { readOnly: true })],
			permissions: { network: mode === "network" ? "allow" : "deny" },
		});
		return { moduleRewrites, vm };
	}

	async #close(): Promise<void> {
		this.#closed = true;
		// A prewarm that is booting finishes or fails first, so none starts a
		// child after the children below are stopped.
		await Promise.race([
			Promise.all(this.#warming),
			new Promise((resolveWait) => setTimeout(resolveWait, exitWaitMs).unref()),
		]);
		for (const pool of this.#pools.values()) {
			clearTimeout(pool.shrink);
			for (const waiting of pool.waiting.splice(0)) waiting(undefined);
		}
		for (const waiter of this.#vmWaiters.splice(0)) waiter.fail(new Error("The Worker Loader has stopped."));
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
	// The VM takes stdin writes in order only if each waits for the last. Frames written in one
	// turn of the event loop, or while the last write is in flight, go in one write of at most
	// `maxStdinWriteBytes`.
	let unsent: string[] = [];
	let writing = false;
	const writeUnsent = async (): Promise<void> => {
		while (unsent.length > 0 && exitReason === undefined) {
			let bytes = 0;
			let count = 0;
			for (const frame of unsent) {
				const frameBytes = Buffer.byteLength(frame);
				if (count > 0 && bytes + frameBytes > maxStdinWriteBytes) break;
				bytes += frameBytes;
				count += 1;
			}
			try {
				await vm.process.writeStdin(pid, unsent.splice(0, count).join(""));
			} catch (error: unknown) {
				// Writes fail once the process exits, and its exit fails its calls.
				if (exitReason === undefined && !killing) {
					options.report(`OpenOrange cannot write to dynamic Worker process ${pid}: ${errorMessage(error)}`);
				}
			}
		}
		unsent = [];
		writing = false;
	};
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
			unsent.push(text);
			if (writing) return;
			writing = true;
			setImmediate(() => void writeUnsent());
		},
	};
}
