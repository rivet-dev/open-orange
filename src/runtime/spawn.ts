import { fork, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { runtimeModuleRewrites } from "../build/rewrite-module-imports.js";
import {
	parseRuntimeChildMessage,
	type RuntimeAssetsConfiguration,
	type RuntimeChildMessage,
	type RuntimeBindingConfiguration,
	type RuntimeDiagnosticMessage,
	type RuntimeDurableObjectManifest,
	type RuntimeFatalMessage,
	type RuntimeRequestMessage,
	type RuntimeQueueConsumer,
	type RuntimeInternalAddress,
	type RuntimeSessionConfiguration,
	type RuntimeSessionWorker,
	type RuntimeSessionWorkersMessage,
	type RuntimeStartMessage,
	type RuntimeStoppedMessage,
	type RuntimeWarningMessage,
} from "../../packages/runtime-node/src/process-protocol.js";

export interface SpawnRuntimeOptions {
	additionalModules?: readonly { name: string; path: string }[];
	assets?: RuntimeAssetsConfiguration;
	bindingConfigurations: RuntimeBindingConfiguration[];
	builtAt: Date;
	bundlePath: string;
	crons?: string[];
	deploymentIdentity: string;
	durableObjectManifest?: RuntimeDurableObjectManifest;
	host: string;
	requestSignalPassthrough?: boolean;
	// `orange serve`: request.url takes its scheme from X-Forwarded-Proto.
	trustForwardedProto?: boolean;
	normalizedConfiguration: string;
	onDiagnostic?(diagnostic: RuntimeDiagnosticMessage): void;
	onFatal?(error: RuntimeFatalMessage): void;
	onRequest?(request: RuntimeRequestMessage): void;
	// Without onWarning, warnings go to standard error.
	onWarning?(warning: RuntimeWarningMessage): void;
	port: number;
	projectRoot: string;
	// RIVET_LOG_LEVEL for RivetKit inside the runtime. Unset keeps the
	// environment's value.
	rivetLogLevel?: string;
	queueConsumers?: RuntimeQueueConsumer[];
	// Workers that get this Worker's tail events.
	tailConsumers?: string[];
	workerName?: string;
	// Call actors on the Engine without hosting any.
	rivetClientOnly?: boolean;
	// An external Engine. Without it, the runtime starts a local Engine.
	rivetEndpoint?: string;
	rivetNamespace: string;
	rivetStoragePath: string;
	// False keeps the runtime from serving RIVETKIT_METRICS_PORT.
	serveMetrics?: boolean;
	session?: RuntimeSessionConfiguration;
	startupTimeoutMs?: number;
	// Where the runtime's standard output goes. Commands whose standard output
	// is data send runtime logs to standard error instead. With onOutput, both
	// streams go to the callback instead.
	stdout?: "inherit" | "stderr";
	onOutput?(chunk: Buffer, stream: "stderr" | "stdout"): void;
	testScheduled?: boolean;
}

export interface RuntimeExit {
	code: number | null;
	reason?: RuntimeStoppedMessage["reason"];
	signal: NodeJS.Signals | null;
}

export interface RuntimeProcess {
	cronNextRuns: { cron: string; nextRunAt: number }[];
	host: string;
	// Where the other Workers of the session call this Worker.
	internalAddress?: RuntimeInternalAddress;
	port: number;
	updateSessionWorkers(workers: RuntimeSessionWorker[]): void;
	signal(signal: "SIGINT" | "SIGKILL" | "SIGTERM"): boolean;
	stop(): Promise<RuntimeExit>;
	waitForExit(): Promise<RuntimeExit>;
}

function send(
	child: ChildProcess,
	message: RuntimeSessionWorkersMessage | RuntimeStartMessage | { type: "shutdown" },
): void {
	if (!child.connected) {
		throw new Error("OpenOrange runtime process is not connected");
	}
	child.send(message);
}

// An IPC message the CLI cannot parse means the runtime came from another build.
class RuntimeBuildMismatchError extends Error {
	readonly _tag = "RuntimeBuildMismatchError" as const;

	constructor(cause: unknown) {
		super(
			"open-orange runtime sent an invalid message; the runtime and CLI come from different builds. Reinstall open-orange.",
			{ cause },
		);
	}
}

function runtimeRunnerPath(): string {
	const packagedPath = fileURLToPath(new URL("./runtime/runner.js", import.meta.url));
	if (existsSync(packagedPath)) {
		return packagedPath;
	}
	const sourcePath = fileURLToPath(
		new URL("../../packages/runtime-node/src/runner.ts", import.meta.url),
	);
	if (existsSync(sourcePath)) {
		return sourcePath;
	}
	throw new Error("OpenOrange runtime runner artifact is missing");
}

export async function spawnRuntime(
	options: SpawnRuntimeOptions,
): Promise<RuntimeProcess> {
	const runnerPath = runtimeRunnerPath();
	const child = fork(runnerPath, [], {
		env: {
			...process.env,
			// RivetKit's native Engine spawner reads the storage path from the process
			// environment. Bun does not copy runtime `process.env` writes there.
			RIVETKIT_STORAGE_PATH: options.rivetStoragePath,
			...(options.rivetLogLevel === undefined ? {} : { RIVET_LOG_LEVEL: options.rivetLogLevel }),
			// One port can have one metrics server, so only one runtime of a deployment serves it.
			...(options.serveMetrics === false ? { RIVETKIT_METRICS_PORT: undefined } : {}),
			// A Worker on Cloudflare runs in UTC with the en-US locale, so
			// getHours(), new Date(y, m, d), and toLocaleString() do not depend
			// on the machine. Node.js takes both from the host's environment.
			// Measured on Cloudflare, in a Pages Function, on 2026-11-13.
			TZ: "UTC",
			LC_ALL: "en_US.UTF-8",
		},
		// The built package runs plain JavaScript. Only a source checkout needs tsx,
		// and it has tsx installed.
		execArgv: runnerPath.endsWith(".ts") ? ["--import", "tsx"] : [],
		stdio:
			options.onOutput === undefined
				? ["ignore", options.stdout === "stderr" ? 2 : "inherit", "inherit", "ipc"]
				: ["ignore", "pipe", "pipe", "ipc"],
	});
	if (options.onOutput !== undefined) {
		const onOutput = options.onOutput;
		child.stdout?.on("data", (chunk: Buffer) => onOutput(chunk, "stdout"));
		child.stderr?.on("data", (chunk: Buffer) => onOutput(chunk, "stderr"));
	}
	const readiness = Promise.withResolvers<{
		cronNextRuns: { cron: string; nextRunAt: number }[];
		host: string;
		internalAddress?: RuntimeInternalAddress;
		port: number;
	}>();
	const exit = Promise.withResolvers<RuntimeExit>();
	let ready = false;
	let stoppedReason: RuntimeStoppedMessage["reason"] | undefined;
	let buildMismatch: RuntimeBuildMismatchError | undefined;
	child.once("error", (error) => {
		if (!ready) {
			readiness.reject(error);
		}
	});
	child.once("exit", (code, signal) => {
		exit.resolve({
			code: buildMismatch === undefined ? code : 1,
			...(stoppedReason === undefined ? {} : { reason: stoppedReason }),
			signal,
		});
		if (!ready) {
			readiness.reject(
				new Error(
					`OpenOrange runtime exited before readiness (code ${code ?? "none"}, signal ${signal ?? "none"})`,
				),
			);
		}
	});
	child.on("message", (rawMessage: unknown) => {
		// Later messages from a mismatched runtime cannot be trusted either.
		if (buildMismatch !== undefined) return;
		let message: RuntimeChildMessage;
		try {
			message = parseRuntimeChildMessage(rawMessage);
		} catch (error: unknown) {
			buildMismatch = new RuntimeBuildMismatchError(error);
			if (!ready) {
				// The readiness failure below stops the runtime.
				readiness.reject(buildMismatch);
			} else {
				options.onFatal?.({ message: buildMismatch.message, type: "fatal" });
				child.kill("SIGTERM");
			}
			return;
		}
		if (message.type === "ready") {
			ready = true;
			readiness.resolve({
				cronNextRuns: message.cronNextRuns ?? [],
				host: message.host,
				...(message.internalAddress === undefined
					? {}
					: { internalAddress: message.internalAddress }),
				port: message.port,
			});
		} else if (message.type === "fatal") {
			if (!ready) {
				readiness.reject(new Error(message.message));
			} else {
				options.onFatal?.(message);
			}
		} else if (message.type === "request") {
			options.onRequest?.(message);
		} else if (message.type === "warning") {
			if (options.onWarning === undefined) process.stderr.write(`${message.message}\n`);
			else options.onWarning(message);
		} else if (message.type === "stopped") {
			stoppedReason = message.reason;
		} else if (
			message.type === "background-error" ||
			message.type === "request-error"
		) {
			options.onDiagnostic?.(message);
		}
	});

	const timeout = setTimeout(() => {
		readiness.reject(new Error("OpenOrange runtime startup timed out"));
	}, options.startupTimeoutMs ?? 10_000);
	send(child, {
		...(options.additionalModules === undefined ? {} : { additionalModules: [...options.additionalModules] }),
		...(options.assets === undefined ? {} : { assets: options.assets }),
		bindingConfigurations: options.bindingConfigurations,
		builtAt: options.builtAt.toISOString(),
		bundlePath: options.bundlePath,
		...(options.crons === undefined ? {} : { crons: options.crons }),
		deploymentIdentity: options.deploymentIdentity,
		...(options.durableObjectManifest === undefined
			? {}
			: { durableObjectManifest: options.durableObjectManifest }),
		host: options.host,
		...(options.requestSignalPassthrough === true ? { requestSignalPassthrough: true } : {}),
		...(options.trustForwardedProto === true ? { trustForwardedProto: true } : {}),
		moduleRewrites: { ...runtimeModuleRewrites() },
		normalizedConfiguration: options.normalizedConfiguration,
		port: options.port,
		projectRoot: options.projectRoot,
		...(options.queueConsumers === undefined || options.queueConsumers.length === 0
			? {}
			: { queueConsumers: options.queueConsumers }),
		...(options.rivetClientOnly === true ? { rivetClientOnly: true } : {}),
		...(options.rivetEndpoint === undefined ? {} : { rivetEndpoint: options.rivetEndpoint }),
		rivetNamespace: options.rivetNamespace,
		rivetStoragePath: options.rivetStoragePath,
		...(options.session === undefined ? {} : { session: options.session }),
		...(options.tailConsumers === undefined || options.tailConsumers.length === 0
			? {}
			: { tailConsumers: options.tailConsumers }),
		...(options.testScheduled === undefined ? {} : { testScheduled: options.testScheduled }),
		type: "start",
		...(options.workerName === undefined ? {} : { workerName: options.workerName }),
	});
	let address: Awaited<typeof readiness.promise>;
	try {
		address = await readiness.promise;
	} catch (error: unknown) {
		if (child.connected) {
			child.disconnect();
		}
		child.kill("SIGTERM");
		throw error;
	} finally {
		clearTimeout(timeout);
	}

	let stopPromise: Promise<RuntimeExit> | undefined;
	return {
		cronNextRuns: address.cronNextRuns,
		host: address.host,
		...(address.internalAddress === undefined
			? {}
			: { internalAddress: address.internalAddress }),
		port: address.port,
		updateSessionWorkers(workers): void {
			if (child.connected) send(child, { type: "session-workers", workers });
		},
		signal(signal): boolean {
			return child.kill(signal);
		},
		stop(): Promise<RuntimeExit> {
			if (stopPromise === undefined) {
				if (child.connected) {
					send(child, { type: "shutdown" });
				}
				stopPromise = exit.promise;
			}
			return stopPromise;
		},
		waitForExit(): Promise<RuntimeExit> {
			return exit.promise;
		},
	};
}
