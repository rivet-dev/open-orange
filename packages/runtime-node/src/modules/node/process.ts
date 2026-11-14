import { EventEmitter } from "node:events";
import nodeFs from "node:fs";
import { posix } from "node:path";
import nodeProcess from "node:process";
import { parseEnv } from "node:util";

import {
	ERR_EPERM,
	ERR_INVALID_ARG_TYPE,
	ERR_INVALID_ARG_VALUE,
	ERR_METHOD_NOT_IMPLEMENTED,
	ERR_OUT_OF_RANGE,
} from "../node-internal/errors.js";
import { validateObject, validateString } from "../node-internal/validators.js";
import { hostPathOf, workerCwdKey } from "../node-fs/bundle-paths.js";
import { workerEnvKey } from "./process-env.js";

// A Worker's `process`, after workerd's enable_nodejs_process_v2 process: fixed host fields, a
// virtual working directory that starts at /bundle, and an `env` that holds only the Worker's
// own vars and secrets. The runtime's real process, and its environment, stay out of reach of
// `process` in Worker code.
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/node/internal/public_process.ts
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/node/internal/internal_process.ts

function initialEnv(): Record<string, string> {
	const source: unknown = Reflect.get(globalThis, workerEnvKey);
	const values: Record<string, string> = {};
	if (typeof source !== "object" || source === null) return values;
	for (const [key, value] of Object.entries(source)) {
		if (typeof value === "string") values[key] = value;
	}
	return values;
}

export const env: Record<string, string> = new Proxy(initialEnv(), {
	set(target, property, value: unknown): boolean {
		if (typeof property === "symbol" || typeof value === "symbol") {
			throw new TypeError("Cannot convert a symbol value to a string");
		}
		return Reflect.set(target, property, `${String(value)}`);
	},
	defineProperty(target, property, descriptor): boolean {
		validateObject(descriptor, "descriptor");
		if (Reflect.has(descriptor, "get") || Reflect.has(descriptor, "set")) {
			throw new ERR_INVALID_ARG_VALUE("descriptor", descriptor, "process.env value must not have getter/setter");
		}
		if (!descriptor.configurable) {
			throw new ERR_INVALID_ARG_VALUE("descriptor.configurable", descriptor, "process.env value must be configurable");
		}
		if (!descriptor.enumerable) {
			throw new ERR_INVALID_ARG_VALUE("descriptor.enumerable", descriptor, "process.env value must be enumerable");
		}
		if (!descriptor.writable) {
			throw new ERR_INVALID_ARG_VALUE("descriptor.writable", descriptor, "process.env value must be writable");
		}
		if (!Reflect.has(descriptor, "value")) {
			throw new ERR_INVALID_ARG_VALUE("descriptor.value", descriptor, "process.env value must be specified explicitly");
		}
		if (typeof property === "symbol" || typeof descriptor.value === "symbol") {
			throw new TypeError("Cannot convert a symbol value to a string");
		}
		return Reflect.defineProperty(target, property, { ...descriptor, value: `${String(descriptor.value)}` });
	},
});

export const platform = "linux";
export const arch = "x64";
export const title = "workerd";
export const argv = ["workerd"];
export const argv0 = "workerd";
export const execArgv: string[] = [];
export const execPath = "";
export const pid = 1;
export const ppid = 0;
export const versions = nodeProcess.versions;
export const version = `v${nodeProcess.versions.node}`;
export const allowedNodeEnvironmentFlags = new Set<string>();
export const exitCode: number | undefined = undefined;
export const channel = null;
export const connected = false;
export const debugPort = 0;
export const noDeprecation = false;
export const traceDeprecation = false;
export const throwDeprecation = false;
export const sourceMapsEnabled = false;
export const domain = null;
export const _exiting = false;
export const moduleLoadList: string[] = [];
export const _preload_modules: string[] = [];
export const _disconnect = undefined;
export const _handleQueue = undefined;
export const _pendingMessage = undefined;
export const _channel = undefined;
export const _send = undefined;

export const features = Object.freeze({
	cached_builtins: true,
	debug: false,
	inspector: false,
	ipv6: true,
	openssl_is_boringssl: true,
	require_module: false,
	tls: true,
	tls_alpn: true,
	tls_ocsp: true,
	tls_sni: true,
	typescript: false,
	uv: true,
});

// The Node.js build configuration that workerd reports, reduced to the fields code reads.
export const config = Object.freeze({
	target_defaults: Object.freeze({ default_configuration: "Release" }),
	variables: Object.freeze({
		host_arch: "x64",
		napi_build_version: "9",
		node_byteorder: "little",
		node_module_version: 127,
		node_prefix: "/usr/local",
		node_shared_openssl: false,
		node_use_openssl: true,
		openssl_is_fips: false,
		shlib_suffix: "so",
		target_arch: "x64",
		v8_enable_i18n_support: 1,
		v8_enable_inspector: 0,
		v8_enable_pointer_compression: 1,
		v8_enable_webassembly: 1,
	}),
});

export const release = { name: "node", lts: true, sourceUrl: "", headersUrl: "" };

export function nextTick(callback: (...args: unknown[]) => unknown, ...args: unknown[]): void {
	queueMicrotask(() => {
		callback(...args);
	});
}

// The working directory is virtual, as in workerd, and Orange's node:fs resolves relative paths
// against it.
function currentCwd(): string {
	const value: unknown = Reflect.get(globalThis, workerCwdKey);
	return typeof value === "string" ? value : "/bundle";
}

function fsError(code: "ENOENT" | "ENAMETOOLONG", syscall: string, path: string): NodeJS.ErrnoException {
	const description = code === "ENOENT" ? "no such file or directory" : "name too long";
	return Object.assign(new Error(`${code}: ${description}, ${syscall} '${path}'`), {
		code,
		errno: code === "ENOENT" ? -2 : -36,
		path,
		syscall,
	});
}

export function cwd(): string {
	return currentCwd();
}

export function chdir(directory: string): void {
	validateString(directory, "directory");
	if (directory.length > 4096) throw fsError("ENAMETOOLONG", "chdir", directory);
	if (directory === "") throw fsError("ENOENT", "chdir", directory);
	const target = posix.resolve(currentCwd(), directory);
	let isDirectory = false;
	try {
		isDirectory = nodeFs.statSync(hostPathOf(target)).isDirectory();
	} catch {
		isDirectory = false;
	}
	// workerd reports ENOENT for a file as well as for a missing path.
	if (!isDirectory) throw fsError("ENOENT", "chdir", directory);
	Reflect.set(globalThis, workerCwdKey, target);
}

export function umask(mask?: number | string): number {
	if (mask !== undefined) {
		let value: number;
		if (typeof mask === "string") {
			if (!/^[0-7]+$/.test(mask)) {
				throw new ERR_INVALID_ARG_VALUE("mask", mask, "must be a 32-bit unsigned integer or an octal string");
			}
			value = Number.parseInt(mask, 8);
		} else if (typeof mask === "number") {
			value = mask;
		} else {
			throw new ERR_INVALID_ARG_TYPE("mask", "number", mask);
		}
		if (value < 0 || value > 0xffffffff || !Number.isInteger(value)) {
			throw new ERR_INVALID_ARG_VALUE("mask", mask, "must be a 32-bit unsigned integer or an octal string");
		}
	}
	return 18;
}

export const hrtime = Object.assign(
	function hrtime(time?: [number, number]): [number, number] {
		if (time !== undefined) {
			if (!Array.isArray(time)) throw new ERR_INVALID_ARG_TYPE("time", "tuple of integers", time);
			if (time.length !== 2) throw new ERR_OUT_OF_RANGE("time", "2", time);
		}
		const nanoTime = BigInt(Date.now()) * 1_000_000n;
		const nanosBigint = nanoTime % 1_000_000_000n;
		let seconds = Number((nanoTime - nanosBigint) / 1_000_000_000n);
		let nanos = Number(nanosBigint);
		if (time !== undefined) {
			seconds -= time[0];
			nanos -= time[1];
			if (nanos < 0) {
				seconds -= 1;
				nanos += 1e9;
			}
		}
		return [seconds, nanos];
	},
	{
		bigint(): bigint {
			return BigInt(Date.now()) * 1_000_000n;
		},
	},
);

type WarningConstructor = new (message: string) => Error;

function warningConstructor(value: unknown): WarningConstructor | undefined {
	if (typeof value !== "function") return undefined;
	// SAFETY: workerd and Node.js call any function given as a warning's ctor with `new`.
	return value as WarningConstructor;
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function emitWarning(warning: string | Error, options?: unknown, codeOrCtor?: unknown, maybeCtor?: unknown): void {
	let name = "Warning";
	let detail: string | undefined;
	let code: string | undefined;
	let ctor: WarningConstructor | undefined;
	if (typeof options === "object" && options !== null && !Array.isArray(options)) {
		name = optionalString(Reflect.get(options, "type")) ?? name;
		code = optionalString(Reflect.get(options, "code"));
		detail = optionalString(Reflect.get(options, "detail"));
		ctor = warningConstructor(Reflect.get(options, "ctor"));
	} else if (typeof options === "string") {
		name = options;
		if (typeof codeOrCtor === "string") {
			code = codeOrCtor;
			ctor = warningConstructor(maybeCtor);
			if (ctor === undefined && maybeCtor !== undefined) throw new ERR_INVALID_ARG_TYPE("ctor", "function", maybeCtor);
		} else if (typeof codeOrCtor === "function") {
			ctor = warningConstructor(codeOrCtor);
		} else if (codeOrCtor !== undefined) {
			throw new ERR_INVALID_ARG_TYPE("ctor", "function", codeOrCtor);
		}
	} else if (typeof options === "function") {
		ctor = warningConstructor(options);
	} else if (options !== undefined) {
		throw new ERR_INVALID_ARG_TYPE("options", "object", options);
	}
	let error: Error;
	if (typeof warning === "string") {
		error = new (ctor ?? Error)(warning);
		error.name = name;
	} else if (warning instanceof Error) {
		error = warning;
		if (name !== "Warning") error.name = name;
	} else {
		throw new ERR_INVALID_ARG_TYPE("warning", "string or Error", warning);
	}
	if (code) Reflect.set(error, "code", code);
	if (typeof detail === "string" && detail) Reflect.set(error, "detail", detail);
	Error.captureStackTrace(error, ctor ?? emitWarning);
	queueMicrotask(() => {
		process.emit("warning", error);
	});
}

const notImplemented = (name: string) => (): never => {
	throw new ERR_METHOD_NOT_IMPLEMENTED(name);
};
const noop = (): void => {};

export const kill = notImplemented("process.kill");
export const binding = notImplemented("process.binding");
export const dlopen = notImplemented("process.dlopen");
export const getActiveResourcesInfo = notImplemented("process.getActiveResourcesInfo");
export const addUncaughtExceptionCaptureCallback = notImplemented("process.addUncaughtExceptionCaptureCallback");
export const setUncaughtExceptionCaptureCallback = notImplemented("process.setUncaughtExceptionCaptureCallback");
export const hasUncaughtExceptionCaptureCallback = notImplemented("process.hasUncaughtExceptionCaptureCallback");
export const threadCpuUsage = notImplemented("process.threadCpuUsage");
export const cpuUsage = notImplemented("process.cpuUsage");
export const _linkedBinding = notImplemented("process._linkedBinding");
export const _kill = notImplemented("process._kill");
export const execve = notImplemented("process.execve");
export const ref = noop;
export const unref = noop;
export const _tickCallback = noop;
export const _debugProcess = noop;
export const _debugEnd = noop;
export const _startProfilerIdleNotifier = noop;
export const _stopProfilerIdleNotifier = noop;

export function setSourceMapsEnabled(): void {}
export function getSourceMapsSupport(): { enabled: boolean; generatedCode: boolean; nodeModules: boolean } {
	return { enabled: false, generatedCode: false, nodeModules: false };
}
export function memoryUsage(): Record<"arrayBuffers" | "external" | "heapTotal" | "heapUsed" | "rss", number> {
	// Key order follows Node.js and workerd.
	return { rss: 0, heapTotal: 0, heapUsed: 0, external: 0, arrayBuffers: 0 };
}
export function resourceUsage(): Record<string, number> {
	return Object.fromEntries(
		[
			"userCPUTime", "systemCPUTime", "maxRSS", "sharedMemorySize", "unsharedDataSize",
			"unsharedStackSize", "minorPageFault", "majorPageFault", "swappedOut", "fsRead", "fsWrite",
			"ipcSent", "ipcReceived", "signalsCount", "voluntaryContextSwitches", "involuntaryContextSwitches",
		].map((key) => [key, 0]),
	);
}
export const permission = { has: notImplemented("process.permission.has") };
export const report = {
	compact: false,
	directory: "",
	excludeEnv: false,
	excludeNetwork: false,
	filename: "",
	getReport: (): Record<string, unknown> => ({}),
	reportOnFatalError: false,
	reportOnSignal: false,
	reportOnUncaughtException: false,
	signal: "SIGUSR2",
	writeReport: notImplemented("process.report.writeReport"),
};
export const finalization = {
	register: notImplemented("process.finalization.register"),
	registerBeforeExit: notImplemented("process.finalization.registerBeforeExit"),
	unregister: notImplemented("process.finalization.unregister"),
};
export function _rawDebug(...args: unknown[]): void {
	console.log(...args);
}
export function _getActiveRequests(): unknown[] {
	return [];
}
export function _getActiveHandles(): unknown[] {
	return [];
}
export function _fatalException(): boolean {
	return false;
}
export function constrainedMemory(): number {
	return 0;
}
export function availableMemory(): number {
	return 0;
}
export function uptime(): number {
	return 0;
}
export function send(): boolean {
	return false;
}

// workerd ends the request when Worker code calls exit().
export function exit(code?: number): never {
	throw new Error(`process.exit(${code ?? 0}) called`);
}
export function reallyExit(code?: number): never {
	exit(code);
}
export function abort(): never {
	exit(1);
}

// workerd supports only user and group 0 on its virtual file system.
export function getegid(): number {
	return 0;
}
export function getgid(): number {
	return 0;
}
export function geteuid(): number {
	return 0;
}
export function getuid(): number {
	return 0;
}
export function getgroups(): number[] {
	return [0];
}
const onlyRoot = (syscall: string) => (id: number | string): void => {
	if (id !== 0) throw new ERR_EPERM({ syscall });
};
export const setegid = onlyRoot("setegid");
export const setgid = onlyRoot("setgid");
export const seteuid = onlyRoot("seteuid");
export const setuid = onlyRoot("setuid");
export function setgroups(): never {
	throw new ERR_EPERM({ syscall: "setgroups" });
}
export function initgroups(): never {
	throw new ERR_EPERM({ syscall: "initgroups" });
}

export function getBuiltinModule(id: string): unknown {
	return id === "process" || id === "node:process" ? process : nodeProcess.getBuiltinModule(id);
}

export function loadEnvFile(path: string | URL | Buffer = ".env"): void {
	const location = path instanceof URL ? path : posix.resolve(currentCwd(), path.toString());
	const text = nodeFs.readFileSync(typeof location === "string" ? hostPathOf(location) : location, "utf8");
	Object.assign(env, parseEnv(text));
}

// The runtime runs with stdin from /dev/null, so its stdin is the fs.ReadStream that workerd
// emulates with `node worker.js < /dev/null`. stdout and stderr write to the runtime's output.
export const stdin = nodeProcess.stdin;
export const stdout = nodeProcess.stdout;
export const stderr = nodeProcess.stderr;
export function openStdin(): typeof stdin {
	return stdin;
}

export const assert = (value: unknown, message?: string): void => {
	if (!value) throw new Error(message ?? "assertion error");
};

const members = {
	_channel, _debugEnd, _debugProcess, _disconnect, _exiting, _fatalException, _getActiveHandles,
	_getActiveRequests, _handleQueue, _kill, _linkedBinding, _pendingMessage, _preload_modules,
	_rawDebug, _send, _startProfilerIdleNotifier, _stopProfilerIdleNotifier, _tickCallback, abort,
	allowedNodeEnvironmentFlags, arch, argv, argv0, assert, availableMemory, binding, channel, chdir,
	config, connected, constrainedMemory, cpuUsage, cwd, debugPort, dlopen, domain, emitWarning, env,
	execArgv, execPath, execve, exit, exitCode, features, finalization, getActiveResourcesInfo,
	getBuiltinModule, getSourceMapsSupport, getegid, geteuid, getgid, getgroups, getuid,
	addUncaughtExceptionCaptureCallback, hasUncaughtExceptionCaptureCallback, hrtime, initgroups, kill, loadEnvFile, memoryUsage,
	moduleLoadList, nextTick, noDeprecation, openStdin, permission, pid, platform, ppid, reallyExit,
	ref, release, report, resourceUsage, send, setSourceMapsEnabled, setUncaughtExceptionCaptureCallback,
	setegid, seteuid, setgid, setgroups, setuid, sourceMapsEnabled, stderr, stdin, stdout,
	threadCpuUsage, throwDeprecation, title, traceDeprecation, umask, unref, uptime, version, versions,
};

// SAFETY: setPrototypeOf returns `members` with EventEmitter.prototype as its prototype, and the
// EventEmitter constructor runs on it next, so it is both.
const process = Object.setPrototypeOf(members, EventEmitter.prototype) as typeof members & EventEmitter;
Reflect.apply(EventEmitter, process, []);
Object.defineProperty(process, Symbol.toStringTag, { value: "process", configurable: true });

// Unhandled rejections reach the Worker's listeners, as workerd forwards its unhandledrejection
// and rejectionhandled events.
let forwardsUnhandled = false;
let forwardsHandled = false;
process.on("newListener", (name: string | symbol) => {
	if (name === "unhandledRejection" && !forwardsUnhandled) {
		forwardsUnhandled = true;
		nodeProcess.on("unhandledRejection", (reason, promise) => process.emit("unhandledRejection", reason, promise));
	}
	if (name === "rejectionHandled" && !forwardsHandled) {
		forwardsHandled = true;
		nodeProcess.on("rejectionHandled", (promise) => process.emit("rejectionHandled", promise));
	}
});

export const _events = Reflect.get(process, "_events");
export const _eventsCount = Reflect.get(process, "_eventsCount");
export const _maxListeners = Reflect.get(process, "_maxListeners");

export default process;
