import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { findAdditionalModules, type AdditionalModule } from "../build/additional-modules.js";
import { bundleWorker } from "../build/bundle-worker.js";
import { runtimeModuleRewrites } from "../build/rewrite-module-imports.js";
import { createTheme, type Theme } from "../cli/theme.js";
import {
	loadWranglerConfiguration,
	type CustomBuildConfiguration,
	type ResolvedWranglerConfiguration,
} from "../config/load-wrangler.js";
import type { RuntimeSessionWorker } from "../../packages/runtime-node/src/process-protocol.js";
import { resolveDeploymentStorages } from "../runtime/deployment.js";
import { spawnRuntime, type RuntimeProcess } from "../runtime/spawn.js";
import { runtimeKind, type RuntimeKind } from "../runtime/runtime-kind.js";
import { booleanValue, optionValue, splitOption } from "./arguments.js";
import {
	createJsonReporter,
	createTerminalReporter,
	type DevCommandIo,
	type DevReporter,
} from "./dev-reporter.js";
import {
	type Hotkeys,
	listenForHotkeys,
	listenForStopRequests,
	openInBrowser,
} from "./dev-session.js";
import { rivetMcpStatus } from "./mcp.js";

interface ParsedDevArguments {
	// Wrangler accepts `-c` more than once. The first Worker is the primary
	// Worker on --port, and the others run beside it for its bindings.
	configPaths: string[];
	cwd?: string;
	environment?: string;
	host: string;
	installSkills: boolean;
	json: boolean;
	logLevel?: string;
	port: number;
	remote: boolean;
	runtime: RuntimeKind;
	scriptPath?: string;
	testScheduled: boolean;
}

function portValue(value: string): number {
	const port = Number(value);
	if (!Number.isInteger(port) || port < 0 || port > 65_535) {
		throw new Error(`--port must be an integer from 0 through 65535; received ${value}`);
	}
	return port;
}

const acceptedIgnoredValueOptions = new Set([
	// Orange has no Worker debugger, so the DevTools inspector flags do nothing.
	"--inspector-ip",
	"--inspector-port",
	"--profile",
]);

// Wrangler's --log-level values, mapped to levels that both RivetKit's
// TypeScript and Rust loggers accept.
const rivetLogLevels: Record<string, string> = {
	debug: "debug",
	error: "error",
	info: "info",
	log: "info",
	none: "error",
	warn: "warn",
};

// RivetKit's internal warnings are about Orange's own use of RivetKit, which a
// Worker author cannot act on. --log-level or RIVET_LOG_LEVEL shows them.
function rivetLogLevel(logLevel: string | undefined): string | undefined {
	if (logLevel !== undefined) return rivetLogLevels[logLevel];
	return process.env.RIVET_LOG_LEVEL === undefined ? "error" : undefined;
}
const acceptedIgnoredBooleanOptions = new Set([
	"--latest",
	"--local",
	"--show-interactive-dev-session",
]);

export function parseDevArguments(args: readonly string[]): ParsedDevArguments {
	const parsed: ParsedDevArguments = {
		configPaths: [],
		host: "127.0.0.1",
		installSkills: false,
		json: false,
		port: 8787,
		remote: false,
		runtime: "node",
		testScheduled: false,
	};
	const positionals: string[] = [];
	let runtimeSelected = false;
	let afterSeparator = false;

	for (let index = 0; index < args.length; index += 1) {
		const token = args[index];
		if (token === undefined || token === "dev") {
			continue;
		}
		if (token === "--") {
			afterSeparator = true;
			continue;
		}
		if (afterSeparator || !token.startsWith("-")) {
			positionals.push(token);
			continue;
		}

		const { name, value } = splitOption(token);
		if (name === "-c" || name === "--config") {
			const option = optionValue(args, index, name, value);
			parsed.configPaths.push(option.value);
			index = option.index;
		} else if (name === "-e" || name === "--env") {
			const option = optionValue(args, index, name, value);
			parsed.environment = option.value;
			index = option.index;
		} else if (name === "--cwd") {
			const option = optionValue(args, index, name, value);
			parsed.cwd = option.value;
			index = option.index;
		} else if (name === "--ip" || name === "--host") {
			const option = optionValue(args, index, name, value);
			parsed.host = option.value;
			index = option.index;
		} else if (name === "--runtime") {
			const option = optionValue(args, index, name, value);
			parsed.runtime = runtimeKind(option.value);
			runtimeSelected = true;
			index = option.index;
		} else if (name === "--port") {
			const option = optionValue(args, index, name, value);
			parsed.port = portValue(option.value);
			index = option.index;
		} else if (name === "--local-protocol") {
			const option = optionValue(args, index, name, value);
			if (option.value !== "http") {
				throw new Error("open-orange dev currently supports only HTTP");
			}
			index = option.index;
		} else if (name === "--json") {
			parsed.json = booleanValue(name, value);
		} else if (name === "--log-level") {
			const option = optionValue(args, index, name, value);
			if (rivetLogLevels[option.value] === undefined) {
				throw new Error(
					`--log-level must be one of ${Object.keys(rivetLogLevels).join(", ")}; received ${option.value}`,
				);
			}
			parsed.logLevel = option.value;
			index = option.index;
		} else if (acceptedIgnoredValueOptions.has(name)) {
			const option = optionValue(args, index, name, value);
			index = option.index;
		} else if (acceptedIgnoredBooleanOptions.has(name)) {
			booleanValue(name, value);
		} else if (name === "-r" || name === "--remote") {
			parsed.remote = booleanValue(name, value);
		} else if (name === "--install-skills") {
			parsed.installSkills = booleanValue(name, value);
		} else if (name === "--test-scheduled") {
			parsed.testScheduled = booleanValue(name, value);
		} else if (name !== "--help" && name !== "-h") {
			throw new Error(`open-orange dev option ${name} is not implemented`);
		}
	}

	if (positionals.length > 1) {
		throw new Error("open-orange dev accepts at most one Worker script");
	}
	if (positionals[0] !== undefined) {
		if (parsed.configPaths.length > 1) {
			throw new Error("open-orange dev accepts a Worker script only with one configuration");
		}
		parsed.scriptPath = positionals[0];
	}
	if (!runtimeSelected) parsed.runtime = runtimeKind();
	return parsed;
}

// Wrangler runs the custom build through the shell and stops when it fails.
// https://github.com/cloudflare/workers-sdk/blob/be87ff0382c53a294e948e49419d25d653c50e86/packages/wrangler/src/deployment-bundle/run-custom-build.ts#L22-L84
export async function runCustomBuild(
	build: CustomBuildConfiguration,
	output: NodeJS.WriteStream,
	theme: Theme,
): Promise<void> {
	output.write(`${theme.dim(`  Running custom build: ${build.command}`)}\n`);
	// The build's output goes where it cannot corrupt JSON events on standard output.
	const child = spawn(build.command, {
		cwd: build.cwd,
		shell: true,
		stdio: ["ignore", output, output],
	});
	const [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>(
		(resolve, reject) => {
			child.once("error", reject);
			child.once("exit", (exitCode, exitSignal) => resolve([exitCode, exitSignal]));
		},
	);
	if (code !== 0) {
		throw new Error(
			`Running custom build \`${build.command}\` failed with ${signal ?? `exit code ${code}`}`,
		);
	}
}

// Wrangler checks the assets directory when it resolves the assets options.
// https://github.com/cloudflare/workers-sdk/blob/be87ff0382c53a294e948e49419d25d653c50e86/packages/wrangler/src/assets.ts#L81-L108
function assertAssetsDirectory(directory: string): void {
	const stats = statSync(directory, { throwIfNoEntry: false });
	if (stats === undefined) {
		throw new Error(
			`The directory specified by the "assets.directory" field in your configuration file does not exist:\n${directory}`,
		);
	}
	if (!stats.isDirectory()) {
		throw new Error(
			`The path specified by the "assets.directory" field in your configuration file doesn't point to a directory:\n${directory}`,
		);
	}
}

interface PreparedWorker {
	additionalModules?: AdditionalModule[];
	bundlePath: string;
	config: ResolvedWranglerConfiguration;
	deploymentIdentity: string;
}

async function prepareWorker(
	config: ResolvedWranglerConfiguration,
	deploymentIdentity: string,
	directory: string,
	output: { buildOutput: NodeJS.WriteStream; reporter: DevReporter; theme: Theme; runtime: RuntimeKind },
): Promise<PreparedWorker> {
	const { reporter } = output;
	if (config.build !== undefined) {
		await runCustomBuild(config.build, output.buildOutput, output.theme);
	}
	if (config.assets !== undefined) {
		assertAssetsDirectory(config.assets.directory);
		for (const file of ["_headers", "_redirects"]) {
			if (existsSync(join(config.assets.directory, file))) {
				reporter.warning(
					`open-orange does not apply the assets ${file} file yet, so its rules have no effect.`,
				);
			}
		}
	}
	reporter.phase("Bundling Worker…");
	await mkdir(directory, { recursive: true });
	if (config.entrypoint === undefined) {
		// An assets-only Worker serves every request from assets, so its
		// Worker module never runs.
		const bundlePath = join(directory, "worker.mjs");
		await writeFile(bundlePath, "export default {};\n");
		return { bundlePath, config, deploymentIdentity };
	}
	const additionalModules =
		config.additionalModuleSearch === undefined
			? []
			: await findAdditionalModules(config.additionalModuleSearch, [
					config.entrypoint,
					...(config.configPath === undefined ? [] : [config.configPath]),
				]);
	const bundle = await bundleWorker({
		additionalModules,
		entrypoint: config.entrypoint,
		moduleRewrites: runtimeModuleRewrites(output.runtime),
		moduleRules: config.moduleRules,
		...(config.noBundle ? {} : { nodeEnv: process.env.NODE_ENV || "development" }),
		outputPath: join(directory, "worker.mjs"),
		preserveFileNames: config.preserveFileNames,
	});
	for (const warning of bundle.warnings) reporter.warning(warning);
	return {
		additionalModules: [...additionalModules, ...bundle.ruleModules],
		bundlePath: bundle.outputPath,
		config,
		deploymentIdentity,
	};
}

// The envoy pool of a Worker that is not the session's primary Worker.
function auxiliaryPoolName(deploymentIdentity: string): string {
	return `openorange-${deploymentIdentity.slice(0, 16)}`;
}

async function executeDevCommand(
	parsed: ParsedDevArguments,
	reporter: DevReporter,
	io: DevCommandIo,
	theme: Theme,
): Promise<number> {
	const startedAt = performance.now();
	if (parsed.remote) {
		throw new Error("open-orange dev --remote is not implemented");
	}
	if (parsed.installSkills) {
		throw new Error("open-orange dev --install-skills is not implemented");
	}
	const configPaths: (string | undefined)[] =
		parsed.configPaths.length === 0 ? [undefined] : parsed.configPaths;
	const configs: ResolvedWranglerConfiguration[] = [];
	for (const configPath of configPaths) {
		configs.push(
			await loadWranglerConfiguration({
				...(configPath === undefined ? {} : { configPath }),
				...(parsed.environment === undefined ? {} : { environment: parsed.environment }),
				...(parsed.scriptPath === undefined ? {} : { scriptPath: parsed.scriptPath }),
			}),
		);
	}
	const names = new Set<string>();
	for (const config of configs) {
		if (configs.length > 1 && config.workerName === undefined) {
			throw new Error(
				`${config.configPath ?? "The Worker configuration"} must set name, because open-orange dev runs more than one Worker and the others address it by name`,
			);
		}
		if (config.workerName !== undefined) {
			if (names.has(config.workerName)) {
				throw new Error(`open-orange dev received more than one Worker named ${config.workerName}`);
			}
			names.add(config.workerName);
		}
	}
	// Queues and Workflows are shared by name across the account on Cloudflare,
	// so a queue has one consumer and a Workflow name has one defining Worker.
	const queueConsumerOwners = new Map<string, string>();
	const workflowOwners = new Map<string, string>();
	for (const config of configs) {
		const owner = config.workerName ?? "the Worker";
		for (const { queueName } of config.queueConsumers) {
			const other = queueConsumerOwners.get(queueName);
			if (other !== undefined && other !== owner) {
				throw new Error(
					`Queue ${JSON.stringify(queueName)} has a consumer in both ${other} and ${owner}. A queue can have only one consumer.`,
				);
			}
			queueConsumerOwners.set(queueName, owner);
		}
		for (const binding of config.bindings) {
			if (binding.type !== "workflow" || binding.scriptName !== undefined) continue;
			const other = workflowOwners.get(binding.name);
			if (other !== undefined && other !== owner) {
				throw new Error(
					`Workflow ${JSON.stringify(binding.name)} is defined by both ${other} and ${owner}. A Workflow name must be unique.`,
				);
			}
			workflowOwners.set(binding.name, owner);
		}
	}
	for (const config of configs) {
		reporter.header(config);
		for (const warning of config.warnings) reporter.warning(warning);
	}
	// Every Worker of the session stores its actors in the primary Worker's
	// Rivet storage, so they share one Engine.
	const storages = await resolveDeploymentStorages(configs);
	const [primaryStorage] = storages;
	if (primaryStorage === undefined) throw new Error("open-orange dev received no Worker configuration");
	const { deploymentIdentity: storageIdentity, rivetStoragePath } = primaryStorage;
	const temporaryDirectory = await mkdtemp(join(tmpdir(), "open-orange-dev-"));
	const stops = listenForStopRequests();
	let hotkeys: Hotkeys | undefined;
	const runtimes: RuntimeProcess[] = [];
	try {
		const prepared: PreparedWorker[] = [];
		for (const [index, config] of configs.entries()) {
			const storage = storages[index];
			if (storage === undefined) throw new Error(`Worker ${index} has no deployment storage`);
			prepared.push(
				await prepareWorker(
					config,
					storage.deploymentIdentity,
					join(temporaryDirectory, String(index)),
					{
					buildOutput: parsed.json ? process.stderr : process.stdout,
						runtime: parsed.runtime,
					reporter,
					theme,
				}),
			);
		}
		const sessionWorkers: RuntimeSessionWorker[] = prepared.flatMap((worker, index) =>
			worker.config.workerName === undefined
				? []
				: [
						{
							deploymentIdentity: worker.deploymentIdentity,
							name: worker.config.workerName,
							poolName: index === 0 ? "default" : auxiliaryPoolName(worker.deploymentIdentity),
							queueConsumers: worker.config.queueConsumers.map((consumer) => consumer.queueName),
							tailConsumers: worker.config.tailConsumers,
						},
					],
		);
		const token = randomBytes(32).toString("base64url");
		const usesRivet = configs.some(
			(config) =>
				(config.durableObjects?.bindings.length ?? 0) > 0 ||
				config.bindings.some((binding) => binding.type === "d1" || binding.type === "kv_namespace"),
		);
		reporter.phase(usesRivet ? "Starting Rivet engine…" : "Starting Worker…");
        let stoppedDuringStartup = false;
        const startWorker = async (index: number, worker: PreparedWorker): Promise<void> => {
			const { config } = worker;
			const prefix = configs.length > 1 ? `[${config.workerName}] ` : "";
			if (index > 0) reporter.phase(`Starting Worker ${config.workerName}…`);
			let runtime: RuntimeProcess;
			try {
				runtime = await spawnRuntime({
					runtime: parsed.runtime,
					...(worker.additionalModules === undefined ? {} : { additionalModules: worker.additionalModules }),
					...(config.assets === undefined ? {} : { assets: config.assets }),
					bindingConfigurations: config.bindings,
					builtAt: new Date(),
					bundlePath: worker.bundlePath,
					crons: config.crons,
					deploymentIdentity: worker.deploymentIdentity,
					...(config.durableObjects === undefined
						? {}
						: { durableObjectManifest: config.durableObjects }),
					// Only the primary Worker serves the dev port. Wrangler also exposes
					// only the first Worker of a multi-config session.
					host: index === 0 ? parsed.host : "127.0.0.1",
					...(config.requestSignalPassthrough ? { requestSignalPassthrough: true } : {}),
					normalizedConfiguration: config.normalizedConfiguration,
					onDiagnostic: (diagnostic) =>
						reporter.error(`${prefix}${diagnostic.message}`, diagnostic.stack),
					onFatal: (error) => reporter.error(`${prefix}${error.message}`, error.stack),
					onOutput: (chunk, stream) => reporter.output(chunk, stream),
					onWarning: (warning) => reporter.warning(`${prefix}${warning.message}`),
					// Only requests to the dev port are the user's requests.
					...(index === 0 ? { onRequest: (request) => reporter.request(request) } : {}),
					port: index === 0 ? parsed.port : 0,
					projectRoot: config.projectRoot,
					queueConsumers: config.queueConsumers,
					tailConsumers: config.tailConsumers,
					...(config.workerName === undefined ? {} : { workerName: config.workerName }),
					...(rivetLogLevel(parsed.logLevel) === undefined
						? {}
						: { rivetLogLevel: rivetLogLevel(parsed.logLevel) }),
					rivetNamespace: "default",
					rivetStoragePath,
					session: {
						...(config.workerName === undefined ? {} : { self: config.workerName }),
						storageIdentity,
						token,
						workers: sessionWorkers,
					},
					// A first run creates the engine database, which can take several seconds.
					startupTimeoutMs: 60_000,
					testScheduled: parsed.testScheduled,
				});
			} catch (error: unknown) {
				// Ctrl-C reaches the runtime too, so it exits before readiness.
				if (stops.requested()) {
                    stoppedDuringStartup = true;
                    return;
				}
				throw error;
			}
			runtimes[index] = runtime;
			const entry = sessionWorkers.find((candidate) => candidate.name === config.workerName);
			if (entry !== undefined && runtime.internalAddress !== undefined) {
				entry.internalAddress = runtime.internalAddress;
			}
			for (const started of runtimes) started?.updateSessionWorkers(sessionWorkers);
        };
        // The agentOS backend coalesces the shared Engine start independently
        // of Worker readiness. Let two Workers recover their actors together;
        // serial readiness would repeat the Engine's dead-runner wait per pool.
        const startupConcurrency = parsed.runtime === "agentos" ? 2 : 1;
        for (let offset = 0; offset < prepared.length; offset += startupConcurrency) {
            const outcomes = await Promise.allSettled(
                prepared.slice(offset, offset + startupConcurrency).map((worker, index) => startWorker(offset + index, worker)),
            );
            const failure = outcomes.find((outcome) => outcome.status === "rejected");
            if (failure?.status === "rejected") throw failure.reason;
            if (stoppedDuringStartup) {
                reporter.stopping();
                return 130;
            }
        }

		const [primary] = runtimes;
		if (primary === undefined) throw new Error("open-orange dev started no Worker runtime");
		const mcp = rivetMcpStatus(configs[0]?.projectRoot ?? process.cwd());
		const displayHost =
			primary.host === "0.0.0.0" || primary.host === "::" ? "127.0.0.1" : primary.host;
		const origin = `http://${displayHost}:${primary.port}`;
		const open = (url: string): void => {
			void openInBrowser(url).then((opened) => {
				if (!opened) reporter.warning(`Could not open a browser. Open ${url} yourself.`);
			});
		};
		if (!parsed.json) {
			hotkeys = listenForHotkeys({
				clear: () => reporter.redraw(),
				open: () => open(origin),
				stop: () => stops.request("key"),
			});
		}
		reporter.ready(
			{
				...(primary.cronNextRuns.length === 0 ? {} : { cronNextRuns: primary.cronNextRuns }),
				elapsedMs: performance.now() - startedAt,
				mcp: { configured: mcp.configured, url: mcp.url },
				origin,
			},
			hotkeys !== undefined,
		);

		// One Worker of a session exiting ends the session.
		const outcome = await Promise.race([
			...runtimes.map((runtime) =>
				runtime.waitForExit().then((exit) => ({ exit, type: "exit" }) as const),
			),
			stops.first.then(() => ({ type: "stop" }) as const),
		]);
		if (outcome.type === "exit") {
			const exitCode = outcome.exit.code ?? (outcome.exit.signal === null ? 0 : 1);
			reporter.stopped(exitCode);
			return exitCode;
		}
		reporter.stopping();
		const exitCode = await Promise.race([
			Promise.all(runtimes.map((runtime) => runtime.stop())).then((exits) => exits[0]?.code ?? 0),
			// A second Ctrl-C or `x` stops the runtimes without waiting for them.
			stops.second.then(() => {
				for (const runtime of runtimes) runtime.signal("SIGKILL");
				return 130;
			}),
		]);
		reporter.stopped(exitCode);
		return exitCode;
	} finally {
		reporter.dispose();
		hotkeys?.dispose();
		stops.dispose();
		await Promise.all(runtimes.flatMap((runtime) => runtime === undefined ? [] : [runtime.stop()]));
		await rm(temporaryDirectory, { force: true, recursive: true });
	}
}

// Turns the failures people hit most into a plain statement and a next step.
function describeFailure(message: string): { hint?: string; message: string } {
	const portInUse = /EADDRINUSE.*:(\d+)\s*$/.exec(message);
	if (portInUse?.[1] !== undefined) {
		const port = Number(portInUse[1]);
		return {
			hint: `Stop the other server, or run orange dev --port ${port + 1}.`,
			message: `Port ${port} is already in use.`,
		};
	}
	if (message === "OpenOrange runtime startup timed out") {
		return {
			hint: "Run again with --log-level debug to see the RivetKit startup logs.",
			message: "The Worker did not start within 60 seconds.",
		};
	}
	return { message };
}

export async function runDevCommand(
	args: readonly string[],
	io: DevCommandIo,
): Promise<number> {
	const theme = createTheme(process.stdout);
	// Known before parsing, so a parse failure is reported in the requested format.
	const json = args.includes("--json");
	const reporter = json ? createJsonReporter(io) : createTerminalReporter(io, theme);
	try {
		const parsed = parseDevArguments(args);
		const workingDirectory = resolve(parsed.cwd ?? process.cwd());
		const originalWorkingDirectory = process.cwd();
		process.chdir(workingDirectory);
		try {
			return await executeDevCommand(parsed, reporter, io, theme);
		} finally {
			process.chdir(originalWorkingDirectory);
		}
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		const failure = describeFailure(message);
		reporter.failure(failure.message, failure.hint);
		return 1;
	}
}
