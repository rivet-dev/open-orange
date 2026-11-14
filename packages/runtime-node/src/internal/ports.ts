import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
	type FSWatcher,
	mkdirSync,
	openSync,
	lstatSync,
	readdirSync,
	readFileSync,
	rmSync,
	statfsSync,
	unlinkSync,
	watch,
	writeFileSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { get } from "node:http";
import { createServer, type Server } from "node:net";
import { basename, dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { isRecord } from "../bindings/unknown-values.js";

interface RivetEngineStamp {
	endpoint: string;
	pid: number;
}

export interface ResolveRivetEnginePortOptions {
	host: string;
	portSeed: string;
	storagePath: string;
}

// RivetKit keeps its local Engine's files under `$RIVETKIT_STORAGE_PATH/.rivetkit`.
function engineDirectory(storagePath: string): string {
	return join(storagePath, ".rivetkit", "var", "engine");
}

function engineStampPath(storagePath: string): string {
	return join(engineDirectory(storagePath), "runtime.json");
}

function parseEngineStamp(text: string): RivetEngineStamp | undefined {
	const value: unknown = JSON.parse(text);
	if (
		isRecord(value) &&
		typeof value.endpoint === "string" &&
		typeof value.pid === "number" &&
		Number.isInteger(value.pid) &&
		value.pid > 0
	) {
		return { endpoint: value.endpoint, pid: value.pid };
	}
	return undefined;
}

async function readEngineStamp(
	storagePath: string,
): Promise<RivetEngineStamp | undefined> {
	try {
		return parseEngineStamp(await readFile(engineStampPath(storagePath), "utf8"));
	} catch {
		return undefined;
	}
}

function engineIsHealthy(endpoint: URL): Promise<boolean> {
	return new Promise((resolveHealth) => {
		let resolved = false;
		const finish = (healthy: boolean): void => {
			if (!resolved) {
				resolved = true;
				resolveHealth(healthy);
			}
		};
		const request = get(new URL("/health", endpoint), (response) => {
			response.resume();
			finish(
				response.statusCode !== undefined &&
					response.statusCode >= 200 &&
					response.statusCode < 300,
			);
		});
		request.once("error", () => finish(false));
		request.setTimeout(500, () => {
			request.destroy();
			finish(false);
		});
	});
}

function processIsAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error: unknown) {
		return isRecord(error) && error.code === "EPERM";
	}
}

async function reusableEnginePort(
	options: ResolveRivetEnginePortOptions,
): Promise<number | undefined> {
	const stamp = await readEngineStamp(options.storagePath);
	if (stamp === undefined) {
		return undefined;
	}
	if (!processIsAlive(stamp.pid)) {
		return undefined;
	}
	let endpoint: URL;
	try {
		endpoint = new URL(stamp.endpoint);
	} catch {
		return undefined;
	}
	const port = Number(endpoint.port);
	if (
		endpoint.protocol !== "http:" ||
		endpoint.hostname !== options.host ||
		!Number.isInteger(port) ||
		port < 1 ||
		port > 65_525
	) {
		return undefined;
	}
	return (await engineIsHealthy(endpoint)) ? port : undefined;
}

function listen(server: Server, port: number, host: string): Promise<void> {
	return new Promise((resolveListen, rejectListen) => {
		server.once("error", rejectListen);
		server.listen(port, host, () => {
			server.off("error", rejectListen);
			resolveListen();
		});
	});
}

function close(server: Server): Promise<void> {
	return new Promise((resolveClose, rejectClose) => {
		server.close((error) =>
			error === undefined ? resolveClose() : rejectClose(error),
		);
	});
}

// Every `orange dev` that uses the Engine of a storage directory registers
// here by its pid. A pid that no longer runs is a stale entry.
const devSessionsDirectory = "dev-sessions";
let devSession: { pid: number; storagePath: string } | undefined;

function devSessionPath(session: { pid: number; storagePath: string }): string {
	return join(session.storagePath, devSessionsDirectory, String(session.pid));
}

export function registerDevSession(storagePath: string): void {
	if (devSession !== undefined) return;
	// The runner is a child of `orange dev`, so the parent pid names the session.
	devSession = { pid: process.ppid, storagePath };
	mkdirSync(join(storagePath, devSessionsDirectory), { recursive: true });
	writeFileSync(devSessionPath(devSession), "");
}

function otherDevSessionRuns(session: { pid: number; storagePath: string }): boolean {
	let entries: string[];
	try {
		entries = readdirSync(join(session.storagePath, devSessionsDirectory));
	} catch {
		return false;
	}
	return entries.some((entry) => {
		const other = Number(entry);
		return Number.isInteger(other) && other > 0 && other !== session.pid && processIsAlive(other);
	});
}

function recordedEnginePid(storagePath: string): number | undefined {
	try {
		return parseEngineStamp(readFileSync(engineStampPath(storagePath), "utf8"))?.pid;
	} catch {
		return undefined;
	}
}

function spawnedRivetEnginePids(): number[] {
	let table: string;
	try {
		table = execFileSync("ps", ["-A", "-o", "pid=,ppid=,comm="], { encoding: "utf8" });
	} catch {
		return [];
	}
	const pids: number[] = [];
	for (const line of table.split("\n")) {
		const [pid, ppid, ...command] = line.trim().split(/\s+/);
		if (Number(ppid) === process.pid && basename(command.join(" ")) === "rivet-engine") {
			pids.push(Number(pid));
		}
	}
	return pids;
}

// `ensureRivetEngine` starts the Engine in its own process group, so it outlives the
// `orange dev` that started it. The last `orange dev` of a storage directory stops
// it on exit. That is the Engine that runtime.json records, which this session
// started or reused. An exit during startup can come before runtime.json is
// written, so then only the Engine that this process spawned is stopped.
function leaveDevSession(): number[] {
	if (devSession === undefined) return [];
	const session = devSession;
	devSession = undefined;
	// The runtimes of a multi-Worker session share one entry, and only the one that removes it
	// stops the Engine. RivetKit also stops an Engine it spawned, and a third SIGTERM makes the
	// Engine force its shutdown, which leaves its storage lease for the next start to wait out.
	try {
		unlinkSync(devSessionPath(session));
	} catch (error: unknown) {
		if (isRecord(error) && error.code === "ENOENT") return [];
		throw error;
	}
	if (otherDevSessionRuns(session)) return [];
	const pid = recordedEnginePid(session.storagePath);
	if (pid !== undefined && processIsAlive(pid)) return [pid];
	return spawnedRivetEnginePids();
}

// Runs from the `exit` handler, which cannot await the Engine's exit.
export function signalRivetEngineStopAfterLastDevSession(): void {
	for (const pid of leaveDevSession()) {
		try {
			process.kill(pid, "SIGTERM");
		} catch {
			// The Engine exited on its own.
		}
	}
}

export async function stopRivetEngineAfterLastDevSession(): Promise<void> {
	await Promise.all(leaveDevSession().map(stopRivetEngineProcess));
}

// The Engine waits up to 6 seconds for its storage to stop and forces its own exit
// after 10. A SIGKILL before then leaves the storage lease held, and on macOS the
// next Engine start waits about 30 seconds for that lease. RivetKit's own Engine
// watcher waits 15 seconds too.
// https://github.com/rivet-dev/rivet/blob/a00b07f483aa3fb07ab403614bcb79d7a8be0322/rivetkit-rust/packages/engine-process/src/lib.rs#L537-L545
// https://github.com/rivet-dev/rivet/blob/a00b07f483aa3fb07ab403614bcb79d7a8be0322/rivetkit-rust/packages/engine-process/src/lib.rs#L916
const engineStopGraceMs = 15_000;

// Sends SIGTERM, then SIGKILL after the grace period, and resolves after the
// Engine exits. The Engine still writes its database until it exits.
async function stopRivetEngineProcess(pid: number): Promise<void> {
	if (!processIsAlive(pid)) return;
	try {
		process.kill(pid, "SIGTERM");
	} catch {
		return;
	}
	// The Engine is not a child of this process when it was reused, so no
	// exit event exists for it. Probing the pid is the only signal.
	const deadline = Date.now() + engineStopGraceMs;
	while (processIsAlive(pid) && Date.now() < deadline) await delay(25);
	if (!processIsAlive(pid)) return;
	try {
		process.kill(pid, "SIGKILL");
	} catch {
		return;
	}
	while (processIsAlive(pid)) await delay(25);
}

// Waits for a change to the lock file, or for a second so that a holder that
// died without releasing the lock is noticed.
function engineStartLockChange(lockPath: string): Promise<void> {
	return new Promise((resolveChange) => {
		let watcher: FSWatcher | undefined;
		const done = (): void => {
			clearTimeout(timer);
			watcher?.close();
			resolveChange();
		};
		const timer = setTimeout(done, 1_000);
		try {
			watcher = watch(lockPath, done);
		} catch {
			done();
		}
	});
}

// The sessions of one storage directory share one Engine. A session holds this
// lock until its Engine is healthy and runtime.json records it, so the next
// session reuses that Engine instead of spawning a second one on the same port
// and database.
export async function withRivetEngineStartLock<T>(
	storagePath: string,
	start: () => Promise<T>,
): Promise<T> {
	const lockPath = join(storagePath, "engine-start.lock");
	mkdirSync(storagePath, { recursive: true });
	for (;;) {
		try {
			writeFileSync(lockPath, String(process.pid), { flag: "wx" });
			break;
		} catch (error: unknown) {
			if (!isRecord(error) || error.code !== "EEXIST") throw error;
		}
		let holder: string;
		try {
			holder = readFileSync(lockPath, "utf8");
		} catch {
			continue;
		}
		// An empty file is a lock whose holder is still writing its pid.
		if (holder !== "" && !processIsAlive(Number(holder))) {
			rmSync(lockPath, { force: true });
			continue;
		}
		await engineStartLockChange(lockPath);
	}
	try {
		return await start();
	} finally {
		rmSync(lockPath, { force: true });
	}
}

export async function resolveRivetEnginePort(
	options: ResolveRivetEnginePortOptions,
): Promise<number> {
	const reusablePort = await reusableEnginePort(options);
	if (reusablePort !== undefined) {
		return reusablePort;
	}
	const seed = createHash("sha256").update(options.portSeed).digest().readUInt32BE(0);
	for (let attempt = 0; attempt < 40; attempt += 1) {
		// The probe closes its sockets before the Engine binds them. Ports below Linux's ephemeral
		// range (32768 and up; 49152 and up on macOS) cannot go to an outgoing connection meanwhile.
		const enginePort = 20_000 + ((seed + attempt * 7_919) % 12_700);
		const servers = [createServer(), createServer(), createServer()];
		try {
			await listen(servers[0], enginePort, options.host);
			await listen(servers[1], enginePort + 1, options.host);
			await listen(servers[2], enginePort + 10, options.host);
			return enginePort;
		} catch {
			continue;
		} finally {
			await Promise.all(
				servers.map((server) =>
					server.listening ? close(server) : Promise.resolve(),
				),
			);
		}
	}
	throw new Error("Could not allocate an isolated Rivet Engine port set");
}

/** The Engine setting for the disk bytes its log may hold. A value in the shell wins over Orange's. */
export const engineLogDiskVariable = "RIVET__STORAGE__LOG_SHARD__MAX_DISK_BYTES";

const mib = 1024 ** 2;
// The log writes 64 MiB segments, and keeps the one it writes and one spare on disk, so a cap of
// 256 MiB still leaves room for two more segments of writes.
export const minimumEngineLogDiskBytes = 256 * mib;
// The log gets at most half the free disk, so the Engine's data and the app keep the other half.
const minimumFreeDiskBytes = 2 * minimumEngineLogDiskBytes;
const maximumEngineLogDiskBytes = 4 * 1024 * mib;

/** The log directory of the Engine that runs on this storage directory. */
export function engineLogDirectory(storagePath: string): string {
	return join(engineDirectory(storagePath), "depot", "log");
}

export interface EngineLogDiskBudget {
	/** Free bytes on the log's filesystem, plus the bytes that the log already holds. */
	availableBytes: number;
	capBytes: number;
	/** True when the cap comes from the shell's `RIVET__STORAGE__LOG_SHARD__MAX_DISK_BYTES`. */
	configured: boolean;
	/** Why the Engine cannot start with this cap. */
	problem?: string;
}

function directoryBytes(directory: string): number {
	try {
		return readdirSync(directory, { recursive: true, withFileTypes: true })
			.filter((entry) => entry.isFile())
			.reduce((total, entry) => total + lstatSync(join(entry.parentPath, entry.name)).size, 0);
	} catch {
		return 0;
	}
}

function freeBytes(path: string): number {
	for (let directory = path; ; directory = dirname(directory)) {
		try {
			const stats = statfsSync(directory);
			return stats.bavail * stats.bsize;
		} catch (error: unknown) {
			if (dirname(directory) === directory || !isRecord(error) || error.code !== "ENOENT") throw error;
		}
	}
}

const formatMib = (bytes: number): string => `${Math.floor(bytes / mib)} MiB`;

/**
 * Sizes the Engine's log for the free disk. The Engine refuses to start when its cap is more than
 * the free disk plus what its log already holds, and when the cap is unset it keeps at least 4 GiB
 * free, so neither a fixed 4 GiB cap nor the Engine's own sizing starts on a small disk. Orange
 * gives the log half of that space, from 256 MiB to 4 GiB, and needs at least 512 MiB. The Engine
 * counts only its own log, so `orange doctor` calls this with the same storage path. A dev Engine
 * writes its log to its object store after 5 seconds, so the log rarely holds more than a few
 * segments.
 * https://github.com/rivet-dev/rivet/blob/cf8679c670bc1e0e22252a6daf0523b9a1771ed6/engine/packages/depot-worker/src/disk_budget.rs#L49-L64
 */
export function engineLogDiskBudget(storagePath: string, environment: NodeJS.ProcessEnv = process.env): EngineLogDiskBudget {
	const logDirectory = engineLogDirectory(storagePath);
	const availableBytes = freeBytes(dirname(logDirectory)) + directoryBytes(logDirectory);
	const configuredText = environment[engineLogDiskVariable];
	if (configuredText !== undefined && configuredText !== "") {
		const capBytes = Number(configuredText);
		if (!Number.isSafeInteger(capBytes) || capBytes <= 0) {
			return { availableBytes, capBytes: 0, configured: true, problem: `${engineLogDiskVariable} must be a whole number of bytes, not ${configuredText}.` };
		}
		return capBytes > availableBytes
			? {
					availableBytes,
					capBytes,
					configured: true,
					problem: `${engineLogDiskVariable} is ${formatMib(capBytes)}, but only ${formatMib(availableBytes)} is free for the Rivet Engine's log, so the Engine would not start.`,
				}
			: { availableBytes, capBytes, configured: true };
	}
	if (availableBytes < minimumFreeDiskBytes) {
		return {
			availableBytes,
			capBytes: minimumEngineLogDiskBytes,
			configured: false,
			problem: `The Rivet Engine needs ${formatMib(minimumFreeDiskBytes)} of free disk, half of it for its log, and ${formatMib(availableBytes)} is free.`,
		};
	}
	const half = Math.floor(availableBytes / 2 / mib) * mib;
	return {
		availableBytes,
		capBytes: Math.min(maximumEngineLogDiskBytes, Math.max(minimumEngineLogDiskBytes, half)),
		configured: false,
	};
}

export interface StartRivetEngineOptions {
	binaryPath: string;
	host: string;
	port: number;
	storagePath: string;
}

// The longest a fresh Engine takes to answer /health, which includes recovering its storage.
const engineStartTimeoutMs = 60_000;

/**
 * Starts the local Engine the way RivetKit starts it, unless one is already healthy on the port.
 * RivetKit stops an Engine that it spawned when its registry shuts down, even while another
 * `orange dev` of the same storage directory still uses it, and it never stops an Engine that it
 * reused. So Orange spawns the Engine, detached so it outlives this process, and RivetKit reuses
 * it. The last `orange dev` of the storage directory stops it, through the stamp written here.
 * https://github.com/rivet-dev/rivet/blob/a00b07f483aa3fb07ab403614bcb79d7a8be0322/rivetkit-rust/packages/engine-process/src/lib.rs#L150-L260
 * https://github.com/rivet-dev/rivet/blob/a00b07f483aa3fb07ab403614bcb79d7a8be0322/rivetkit-rust/packages/engine-process/src/lib.rs#L502-L617
 */
export async function ensureRivetEngine(options: StartRivetEngineOptions): Promise<void> {
	const endpoint = `http://${options.host.includes(":") ? `[${options.host}]` : options.host}:${options.port}`;
	if (await engineIsHealthy(new URL(endpoint))) return;
	// An Engine of an earlier session can still be stopping. It holds the storage lock until it
	// exits, so a second Engine would fail with "already in use". Wait for it to exit, or to
	// answer again if it was only busy.
	const earlierPid = recordedEnginePid(options.storagePath);
	if (earlierPid !== undefined && processIsAlive(earlierPid)) {
		const deadline = Date.now() + engineStopGraceMs;
		while (processIsAlive(earlierPid) && Date.now() < deadline) {
			if (await engineIsHealthy(new URL(endpoint))) return;
			await delay(100);
		}
		if (processIsAlive(earlierPid)) {
			throw new Error(
				`An earlier Rivet Engine (pid ${earlierPid}) still runs on this project's storage and does not answer. Stop it and start again.`,
			);
		}
	}
	const root = join(options.storagePath, ".rivetkit");
	const engineDir = engineDirectory(options.storagePath);
	const dataPath = join(engineDir, "depot");
	const logsDir = join(root, "var", "logs", "rivet-engine");
	for (const directory of [engineDir, join(dataPath, "log"), logsDir]) mkdirSync(directory, { recursive: true });
	const logBudget = engineLogDiskBudget(options.storagePath);
	if (logBudget.problem !== undefined) {
		throw new Error(`${logBudget.problem} Free disk space, or set ${engineLogDiskVariable} to fewer bytes. Run orange doctor to check.`);
	}
	const peerPort = options.port + 1;
	const configPath = join(engineDir, "config.json");
	writeFileSync(
		configPath,
		JSON.stringify({
			topology: {
				datacenter_label: 1,
				datacenters: {
					default: {
						datacenter_label: 1,
						is_leader: true,
						peer_url: `http://127.0.0.1:${peerPort}`,
						public_url: endpoint,
					},
				},
			},
		}),
	);
	const timestamp = new Date().toISOString().replaceAll(":", "-");
	const stderrPath = join(logsDir, `engine-${timestamp}-stderr.log`);
	const stdoutPath = join(logsDir, `engine-${timestamp}-stdout.log`);
	const child = spawn(options.binaryPath, ["--config", configPath], {
		// Its own process group, so it outlives this process and terminal signals do not reach it.
		detached: true,
		env: {
			...process.env,
			[engineLogDiskVariable]: String(logBudget.capBytes),
			RIVET__AUTH__ADMIN_TOKEN: process.env.RIVET__AUTH__ADMIN_TOKEN ?? "default",
			RIVET__GUARD__HOST: options.host,
			RIVET__GUARD__PORT: String(options.port),
			RIVET__API_PEER__HOST: "127.0.0.1",
			RIVET__API_PEER__PORT: String(peerPort),
			RIVET__METRICS__HOST: options.host,
			RIVET__METRICS__PORT: String(options.port + 10),
			RIVET__STORAGE__LOG_DIRECTORY: join(dataPath, "log"),
			RIVET__OBJECT_STORAGE__PRIMARY__FILE_SYSTEM__PATH: join(dataPath, "objects"),
			RIVET__STORAGE__BALANCING__ENABLED: "false",
			RIVET__STORAGE__AUTO_PROVISION_PARTITIONS: "1",
			RIVET__STORAGE__COLD_STORE__DISK_CACHE_BYTES: "0",
			RIVET__STORAGE__WRITE_TO_COLD_AFTER_MS: "5000",
			RIVET__STORAGE__STOP_TIMEOUT_MS: "6000",
			RIVET__STORAGE__STOP_TEARDOWN_MS: "2000",
			RIVET__PEGBOARD__NODE_LOST_THRESHOLD: "7000",
			RIVET__RUNTIME__WORKER_SHUTDOWN_DURATION: "1",
			RIVET__RUNTIME__GUARD_SHUTDOWN_DURATION: "1",
			RIVET__RUNTIME__FORCE_SHUTDOWN_DURATION: "10",
		},
		stdio: [
			"ignore",
			openSync(stdoutPath, "a"),
			openSync(stderrPath, "a"),
		],
	});
	const pid = child.pid;
	if (pid === undefined) throw new Error(`Could not start the Rivet Engine at ${options.binaryPath}`);
	child.unref();
	// The Engine logs through tracing to stdout, and a signal such as the OOM killer's leaves no log,
	// so a startup error names how the Engine exited and shows both logs.
	const exit = new Promise<string>((resolveExit) =>
		child.once("exit", (code, signal) => resolveExit(signal === null ? `with code ${code}` : `on ${signal}`)),
	);
	writeFileSync(
		engineStampPath(options.storagePath),
		JSON.stringify({ bind_host: options.host, endpoint, pid, public_url: null }),
	);
	// /health answers before the Engine's storage partition is placed, and until then a storage
	// command such as RivetKit's node pool setup fails with `routing_unavailable`. A read that
	// reaches storage is the readiness signal. The Engine sends no event, so the start polls it.
	const adminToken = process.env.RIVET__AUTH__ADMIN_TOKEN ?? "default";
	const deadline = Date.now() + engineStartTimeoutMs;
	for (;;) {
		if (!processIsAlive(pid)) {
			throw new Error(
				`The Rivet Engine exited during startup ${await Promise.race([exit, delay(1_000).then(() => "for an unknown reason")])}. Its logs are in ${logsDir}.\n${logTail(stdoutPath)}\n${logTail(stderrPath)}`,
			);
		}
		if (await engineStorageIsReady(endpoint, adminToken)) return;
		if (Date.now() > deadline) {
			throw new Error(`The Rivet Engine did not become healthy within ${engineStartTimeoutMs / 1_000} s. Its logs are in ${logsDir}.`);
		}
		await delay(100);
	}
}

async function engineStorageIsReady(endpoint: string, adminToken: string): Promise<boolean> {
	try {
		const response = await fetch(new URL("/actors/names?namespace=default", endpoint), {
			headers: { authorization: `Bearer ${adminToken}` },
			signal: AbortSignal.timeout(2_000),
		});
		await response.arrayBuffer();
		return response.status === 200;
	} catch {
		return false;
	}
}

// The last lines of an Engine log, for a startup error that names the cause.
function logTail(path: string): string {
	try {
		return readFileSync(path, "utf8").trimEnd().split("\n").slice(-15).join("\n");
	} catch {
		return "";
	}
}
