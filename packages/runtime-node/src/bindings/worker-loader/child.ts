// The process that hosts one dynamic Worker from a Worker Loader binding in an
// agentOS VM. It loads the Worker like the runtime process does, with only the
// env, modules, and outbound access that the parent passed.

import { writeSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

import { DurableObjectRpcTarget } from "../durable-objects/rpc/target.js";
import type { Request, Response } from "../../globals/http.js";
import { setGlobalOutbound } from "../../internal/global-outbound.js";
import { abortIsolateHook } from "../../modules/cloudflare-workers/abort-isolate.js";
import { loadWorkerEntrypoint, type LoadedWorkerEntrypoint } from "../../runtime.js";
import { isRecord } from "../unknown-values.js";
import {
	decodeLoaderValue,
	encodeLoaderError,
	FramedRpcTransport,
	LoaderCapabilityTarget,
	openLoaderSession,
	readFrames,
	writeFrame,
	type LoaderReply,
} from "./session.js";

export interface DynamicWorkerStart {
	// The modules as written, which node:fs reads at `/bundle`.
	bundleRoot: string;
	env: Record<string, unknown>;
	// The linked main module, relative to `moduleRoot`.
	mainFile: string;
	// The module name of each linked file.
	moduleNames: Record<string, string>;
	moduleRewrites: Record<string, string>;
	moduleRoot: string;
	// "network" inherits the parent's network access and "blocked" is
	// `globalOutbound: null`. Any other value is a Fetcher.
	outbound: unknown;
}

function isStringRecord(value: unknown): value is Record<string, string> {
	return isRecord(value) && Object.values(value).every((entry) => typeof entry === "string");
}

function parseDynamicWorkerStart(value: unknown): DynamicWorkerStart {
	if (!isRecord(value)) throw new TypeError("Dynamic Worker start message must be an object");
	const { bundleRoot, env, mainFile, moduleNames, moduleRewrites, moduleRoot, outbound } = value;
	if (
		typeof bundleRoot !== "string" ||
		!isRecord(env) ||
		typeof mainFile !== "string" ||
		!isStringRecord(moduleNames) ||
		!isStringRecord(moduleRewrites) ||
		typeof moduleRoot !== "string"
	) {
		throw new TypeError("Dynamic Worker start message has invalid fields");
	}
	return { bundleRoot, env, mainFile, moduleNames, moduleRewrites, moduleRoot, outbound };
}

// The parent passes a Fetcher capability as `outbound`, read on each call
// like a property access on the stub.
async function fetchThroughOutbound(outbound: unknown, request: Request): Promise<Response> {
	const fetch: unknown = Reflect.get(Object(outbound), "fetch");
	if (typeof fetch !== "function") {
		throw new TypeError("Dynamic Worker globalOutbound has no fetch() method");
	}
	// SAFETY: The parent's Fetcher capability resolves fetch() with a Response,
	// but the loader RPC returns call results as unknown.
	return (await Reflect.apply(fetch, outbound, [request])) as Response;
}

// A syntax error names the module and line, instead of the host file path.
function startupError(error: unknown, start: DynamicWorkerStart | undefined): unknown {
	if (!(error instanceof Error) || typeof error.stack !== "string" || start === undefined) {
		return error;
	}
	const rootUrl = pathToFileURL(`${start.moduleRoot}/`).href;
	for (const prefix of [rootUrl, `${start.moduleRoot}/`]) {
		const index = error.stack.indexOf(prefix);
		if (index === -1) continue;
		const where = /^[^\s)]+/.exec(error.stack.slice(index + prefix.length))?.[0];
		if (where === undefined || where.length === 0) continue;
		const file = Object.keys(start.moduleNames)
			.filter((candidate) => where.startsWith(`${candidate}:`) || where === candidate)
			.sort((left, right) => right.length - left.length)[0];
		const location =
			file === undefined ? where : `${start.moduleNames[file]}${where.slice(file.length)}`;
		return Reflect.construct(error.constructor, [`${error.message}\n    at ${location}`]);
	}
	return error;
}

class DynamicWorkerHost extends DurableObjectRpcTarget {
	#worker: LoadedWorkerEntrypoint | undefined;
	// The first `start`. The parent pipelines its entrypoint calls behind it.
	#started: Promise<LoaderReply | undefined> | undefined;

	start(envelope: unknown): Promise<LoaderReply | undefined> {
		if (this.#started !== undefined) {
			return Promise.resolve(encodeLoaderError(new Error("Dynamic Worker already started")));
		}
		this.#started = this.#load(envelope);
		return this.#started;
	}

	async #load(envelope: unknown): Promise<LoaderReply | undefined> {
		let start: DynamicWorkerStart | undefined;
		try {
			start = parseDynamicWorkerStart(decodeLoaderValue(envelope, true));
			const { bundleRoot, mainFile, moduleRoot, outbound } = start;
			// node:fs reads `/bundle` from the dynamic Worker's own modules.
			Reflect.set(globalThis, Symbol.for("open-orange.node-fs.bundle-root"), bundleRoot);
			for (const [name, value] of Object.entries(start.env)) {
				if (typeof value === "string") process.env[name] = value;
			}
			const mainUrl = new URL(mainFile, pathToFileURL(`${moduleRoot}/`)).href;
			this.#worker = await loadWorkerEntrypoint({
				bindings: Object.entries(start.env).map(([name, value]) => ({ name, value })),
				importWorker: () => {
					if (outbound === "blocked") {
						setGlobalOutbound(null);
					} else if (outbound !== "network") {
						setGlobalOutbound({ fetch: (request) => fetchThroughOutbound(outbound, request) });
					}
					return import(mainUrl);
				},
			});
			return undefined;
		} catch (error: unknown) {
			return encodeLoaderError(startupError(error, start));
		}
	}

	async entrypoint(name: unknown, props: unknown): Promise<LoaderCapabilityTarget> {
		if (this.#started === undefined) throw new Error("Dynamic Worker is not started");
		await this.#started;
		// The parent fails this call with the startup error.
		if (this.#worker === undefined) throw new Error("Dynamic Worker failed to start");
		if (name !== undefined && typeof name !== "string") {
			throw new TypeError("Entrypoint name must be a string");
		}
		const decodedProps = props === undefined ? undefined : decodeLoaderValue(props, true);
		return new LoaderCapabilityTarget(this.#worker.entrypoint(name, decodedProps));
	}
}

interface FrameWriter {
	send(message: object): void;
	// Returns the frames not yet written and forgets them.
	take(): string;
}

// Stdout carries the frames to the parent, so the Worker's own stdout writes
// travel as frames too. The parent writes them to its stdout. Frames sent in
// one microtask checkpoint leave in one write, so the messages of a call reach
// the parent together. Returns the writer for every other frame.
function frameStdoutWrites(): FrameWriter {
	const stdout = process.stdout;
	const write = stdout.write.bind(stdout);
	let pending = "";
	const buffer = {
		write(text: string): boolean {
			if (pending === "") {
				queueMicrotask(() => {
					const frames = pending;
					pending = "";
					if (frames !== "") write(frames);
				});
			}
			pending += text;
			return true;
		},
	};
	const sendFrame = (message: object): void => writeFrame(buffer, message);
	stdout.write = (
		chunk: string | Uint8Array,
		encoding?: BufferEncoding | ((error?: Error | null) => void),
		callback?: (error?: Error | null) => void,
	): boolean => {
		const text =
			typeof chunk === "string"
				? Buffer.from(chunk, typeof encoding === "string" ? encoding : "utf8").toString()
				: Buffer.from(chunk).toString();
		sendFrame({ openOrangeWorkerLoaderStdout: text });
		const done = typeof encoding === "function" ? encoding : callback;
		if (done !== undefined) process.nextTick(done);
		return true;
	};
	return {
		send: sendFrame,
		take(): string {
			const frames = pending;
			pending = "";
			return frames;
		},
	};
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const frames = frameStdoutWrites();
	const sendFrame = frames.send;
	const report = (error: unknown): void => {
		sendFrame({
			openOrangeWorkerLoaderDiagnostic:
				error instanceof Error ? (error.stack ?? error.message) : String(error),
		});
	};
	// Workerd logs an exception that escapes a task and keeps the Worker
	// running, as the runtime process does.
	process.on("uncaughtException", report);
	process.on("unhandledRejection", report);
	// The dynamic Worker never outlives the runtime process that loaded it.
	process.stdin.once("end", () => process.exit(0));
	process.stdout.on("error", () => process.exit(0));
	// Frames sent just before an exit still reach the parent.
	process.on("exit", () => {
		const unsent = frames.take();
		if (unsent !== "") writeSync(1, unsent);
	});
	// abortIsolate() reports its reason and ends this process at once, so nothing else from the
	// aborted isolate reaches the parent. The frame is written synchronously for that reason.
	Reflect.set(globalThis, abortIsolateHook, (reason: string): never => {
		writeSync(1, `${frames.take()}${JSON.stringify({ openOrangeWorkerLoaderAbort: reason })}\n`);
		process.exit(1);
	});
	const transport = new FramedRpcTransport(readFrames(process.stdin, () => undefined), sendFrame);
	openLoaderSession(transport, new DynamicWorkerHost());
}
