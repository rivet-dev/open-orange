import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

const bundleRootKey = Symbol.for("open-orange.node-fs.bundle-root");
let workerFilePrefixes: string[] | undefined;

/**
 * Whether Worker code called `method`: the bundle, or a module beside it. Host code is Orange and
 * the packages it runs on. Their timers and sockets run in the object's scope too, such as undici's
 * connection timers, agentOS's process polling, and RivetKit's gateway sockets, and they are not
 * the object's.
 */
export function calledByWorker(method: Function): boolean {
	if (workerFilePrefixes === undefined) {
		const root: unknown = Reflect.get(globalThis, bundleRootKey);
		if (typeof root !== "string") return false;
		// Node.js names a module by its real path.
		workerFilePrefixes = [...new Set([root, realpathSync(root)])].map(
			(directory) => `${pathToFileURL(directory).href}/`,
		);
	}
	// Call sites name the file that runs, also when source maps rewrite stack traces.
	const prepare = Error.prepareStackTrace;
	const limit = Error.stackTraceLimit;
	const holder: { stack?: unknown } = {};
	let sites: unknown;
	Error.prepareStackTrace = (_error, callSites) => callSites;
	// A built-in between them has no file, such as the next() that runs an async generator's body.
	Error.stackTraceLimit = 4;
	try {
		Error.captureStackTrace(holder, method);
		// V8 formats the stack at the first read, so the read must see the override.
		sites = holder.stack;
	} finally {
		Error.prepareStackTrace = prepare;
		Error.stackTraceLimit = limit;
	}
	const file = Array.isArray(sites)
		? (sites as NodeJS.CallSite[]).map((site) => site.getFileName()).find((name) => name != null)
		: undefined;
	// CJS and embedded V8 report absolute filenames; Node ESM reports file URLs.
	// Normalize both forms before testing the existing Worker directory boundary.
	const url = typeof file === "string" && file.startsWith("/") ? pathToFileURL(file).href : file;
	return typeof url === "string" && workerFilePrefixes.some((prefix) => url.startsWith(prefix));
}
