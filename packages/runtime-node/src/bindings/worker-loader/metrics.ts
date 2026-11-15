// Prometheus metrics for dynamic Workers. The runtime appends them to the runner's
// metrics endpoint, so an autoscaler can scale on slot use and queue wait.

import { readdirSync, readFileSync } from "node:fs";

// Seconds. Covers a warm claim (about 10 ms) up to the default queue timeout.
const secondsBuckets = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30];

class Histogram {
	readonly #counts = secondsBuckets.map(() => 0);
	#count = 0;
	#sum = 0;

	observe(seconds: number): void {
		this.#count += 1;
		this.#sum += seconds;
		for (const [index, bound] of secondsBuckets.entries()) {
			if (seconds <= bound) this.#counts[index] = (this.#counts[index] ?? 0) + 1;
		}
	}

	render(name: string, labels = ""): string[] {
		const join = labels === "" ? "" : `${labels},`;
		const lines = secondsBuckets.map((bound, index) => `${name}_bucket{${join}le="${bound}"} ${this.#counts[index] ?? 0}`);
		lines.push(`${name}_bucket{${join}le="+Inf"} ${this.#count}`);
		const suffix = labels === "" ? "" : `{${labels}}`;
		lines.push(`${name}_sum${suffix} ${this.#sum}`, `${name}_count${suffix} ${this.#count}`);
		return lines;
	}
}

export interface SlotGauges {
	live: number;
	maxWorkers: number;
	queued: number;
}

export interface VmGauges {
	vms: { booting: number; live: number; pooled: number; stopping: number };
	maxVms: number;
	poolReady: Record<string, number>;
	// Loads that wait for room in the VM budget.
	waiting: number;
}

// One instance per runtime. The slot pool and the agentOS backend record into it.
export class WorkerLoaderMetrics {
	readonly queueWait = new Histogram();
	readonly workerStart = new Histogram();
	readonly vmBoot = new Histogram();
	readonly #claims = new Map<string, number>();
	readonly #rejections = new Map<string, number>();
	slotGauges: (() => SlotGauges) | undefined;
	vmGauges: (() => VmGauges) | undefined;

	// `warming` waited for a prewarm in flight, and `miss` booted a VM on demand.
	claim(mode: string, result: "hit" | "miss" | "warming"): void {
		const key = `mode="${mode}",result="${result}"`;
		this.#claims.set(key, (this.#claims.get(key) ?? 0) + 1);
	}

	reject(code: string): void {
		this.#rejections.set(code, (this.#rejections.get(code) ?? 0) + 1);
	}

	render(): string {
		const out: string[] = [];
		const metric = (name: string, type: string, help: string): void => {
			out.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
		};
		const slots = this.slotGauges?.();
		if (slots !== undefined) {
			metric("orange_worker_loader_workers", "gauge", "Dynamic Workers that hold a slot.");
			out.push(`orange_worker_loader_workers ${slots.live}`);
			metric("orange_worker_loader_workers_max", "gauge", "Slots: ORANGE_WORKER_LOADER_MAX_WORKERS.");
			out.push(`orange_worker_loader_workers_max ${slots.maxWorkers}`);
			metric("orange_worker_loader_slot_utilization", "gauge", "Slots in use divided by slots.");
			out.push(`orange_worker_loader_slot_utilization ${slots.live / slots.maxWorkers}`);
			metric("orange_worker_loader_queue_depth", "gauge", "Dynamic Workers that wait for a slot.");
			out.push(`orange_worker_loader_queue_depth ${slots.queued}`);
		}
		const gauges = this.vmGauges?.();
		if (gauges !== undefined) {
			metric("orange_worker_loader_vms", "gauge", "agentOS VMs of dynamic Workers, by state.");
			for (const [state, count] of Object.entries(gauges.vms)) {
				out.push(`orange_worker_loader_vms{state="${state}"} ${count}`);
			}
			metric("orange_worker_loader_vms_max", "gauge", "VM budget: ORANGE_WORKER_LOADER_MAX_VMS.");
			out.push(`orange_worker_loader_vms_max ${gauges.maxVms}`);
			metric("orange_worker_loader_vm_queue_depth", "gauge", "Dynamic Workers with a slot that wait for room in the VM budget.");
			out.push(`orange_worker_loader_vm_queue_depth ${gauges.waiting}`);
			metric("orange_worker_loader_pool_ready", "gauge", "Prewarmed VMs ready to claim, by network mode.");
			for (const [mode, count] of Object.entries(gauges.poolReady)) {
				out.push(`orange_worker_loader_pool_ready{mode="${mode}"} ${count}`);
			}
		}
		metric("orange_worker_loader_queue_wait_seconds", "histogram", "Time a dynamic Worker waited for a slot.");
		out.push(...this.queueWait.render("orange_worker_loader_queue_wait_seconds"));
		metric("orange_worker_loader_start_seconds", "histogram", "Time from a slot to a loaded dynamic Worker.");
		out.push(...this.workerStart.render("orange_worker_loader_start_seconds"));
		metric("orange_worker_loader_vm_boot_seconds", "histogram", "Time to boot a VM and start its child process.");
		out.push(...this.vmBoot.render("orange_worker_loader_vm_boot_seconds"));
		metric("orange_worker_loader_pool_claims_total", "counter", "VM claims, by network mode and pool hit or miss.");
		for (const [labels, count] of this.#claims) out.push(`orange_worker_loader_pool_claims_total{${labels}} ${count}`);
		metric("orange_worker_loader_rejections_total", "counter", "Dynamic Workers refused with WorkerLoaderLimitError, by code.");
		for (const [code, count] of this.#rejections) out.push(`orange_worker_loader_rejections_total{code="${code}"} ${count}`);
		metric("orange_runtime_resident_memory_bytes", "gauge", "Resident memory of the runner and of its child processes, such as the agentOS sidecar.");
		const memory = residentMemory();
		out.push(`orange_runtime_resident_memory_bytes{process="runner"} ${memory.runner}`);
		if (memory.children !== undefined) {
			out.push(`orange_runtime_resident_memory_bytes{process="children"} ${memory.children}`);
		}
		const limit = memoryLimitBytes();
		if (limit !== undefined) {
			metric("orange_runtime_memory_limit_bytes", "gauge", "The cgroup memory limit of the runner.");
			out.push(`orange_runtime_memory_limit_bytes ${limit}`);
		}
		return `${out.join("\n")}\n`;
	}
}

// Linux only: the children's RSS comes from /proc, which other systems lack.
function residentMemory(): { children: number | undefined; runner: number } {
	const runner = process.memoryUsage.rss();
	if (process.platform !== "linux") return { children: undefined, runner };
	let children = 0;
	const pending = [process.pid];
	const seen = new Set<number>();
	while (pending.length > 0) {
		const pid = pending.pop();
		if (pid === undefined || seen.has(pid)) continue;
		seen.add(pid);
		if (pid !== process.pid) children += rssOf(pid);
		for (const child of childrenOf(pid)) pending.push(child);
	}
	return { children, runner };
}

// A process can exit while it is read, so a missing file counts as nothing.
function readProc(path: string): string {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return "";
	}
}

function childrenOf(pid: number): number[] {
	let tasks: string[];
	try {
		tasks = readdirSync(`/proc/${pid}/task`);
	} catch {
		return [];
	}
	return tasks.flatMap((task) =>
		readProc(`/proc/${pid}/task/${task}/children`)
			.split(" ")
			.filter((value) => value !== "")
			.map(Number),
	);
}

function rssOf(pid: number): number {
	const match = /^VmRSS:\s+(\d+) kB/m.exec(readProc(`/proc/${pid}/status`));
	return match?.[1] === undefined ? 0 : Number(match[1]) * 1024;
}

function memoryLimitBytes(): number | undefined {
	if (process.platform !== "linux") return undefined;
	const cgroup = /^0::(.*)$/m.exec(readProc("/proc/self/cgroup"))?.[1];
	if (cgroup === undefined) return undefined;
	const raw = readProc(`/sys/fs/cgroup${cgroup}/memory.max`).trim();
	const value = Number(raw);
	return raw === "" || raw === "max" || !Number.isFinite(value) ? undefined : value;
}
