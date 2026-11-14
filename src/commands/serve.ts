import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { stop as stopEsbuild } from "esbuild";

import type { Theme } from "../cli/theme.js";
import { loadWranglerConfiguration } from "../config/load-wrangler.js";
import { resolveDeploymentStorage } from "../runtime/deployment.js";
import { spawnRuntime } from "../runtime/spawn.js";
import { runtimeKind } from "../runtime/runtime-kind.js";
import { bundleForServe, serveSession } from "../serve/session.js";

export interface ServeCommandIo {
	error(message: string): void;
	log(message: string): void;
}

const defaultPort = 8080;
/** Set in an `orange deploy` image whose custom build ran on the machine that deployed. */
export const customBuildDoneVariable = "ORANGE_CUSTOM_BUILD_DONE";

export function renderServeHelp(theme: Theme): string {
	const option = (flags: string, description: string): string =>
		`  ${theme.fg("orange", flags.padEnd(24))}${description}`;
	return [
		theme.bold("open-orange serve"),
		"",
		"Serve the Worker against the Rivet Engine in RIVET_ENDPOINT.",
		"This is what an `orange deploy` image runs.",
		`\n${theme.bold("Options")}`,
		option("-c, --config <path>", "Wrangler configuration file. Repeat it to serve several Workers."),
		`  ${" ".repeat(24)}\`routes\` pick the Worker, and the first one answers the rest.`,
		option("-e, --env <name>", "Environment from the configuration"),
		option("--port <port>", "Port to listen on. Default PORT, then 8080."),
		option("--ip <host>", "Host to listen on. Default 0.0.0.0."),
		option("--runtime <runtime>", "node or agentos. Default OPENORANGE_RUNTIME, then node."),
		`\n${theme.bold("Environment")}`,
		`  ${theme.dim("RIVET_ENDPOINT, RIVET_TOKEN, RIVET_NAMESPACE  Set by the Rivet cluster (RIVET_ENDPOINT required)")}`,
	].join("\n");
}

// The production entrypoint of an `orange deploy` image. It serves one Worker on a
// Rivet cluster: the runtime connects out to the Engine in RIVET_ENDPOINT, hosts the
// Worker's actors, and starts no local Engine.
export async function runServeCommand(
	args: readonly string[],
	io: ServeCommandIo,
): Promise<number> {
	try {
		return await executeServeCommand(args, io);
	} catch (error: unknown) {
		io.error(error instanceof Error ? error.message : String(error));
		return 1;
	}
}

async function executeServeCommand(
	args: readonly string[],
	io: ServeCommandIo,
): Promise<number> {
	const { values } = parseArgs({
		args: [...args.slice(1)],
		options: {
			config: { multiple: true, short: "c", type: "string" },
			env: { short: "e", type: "string" },
			ip: { type: "string" },
			port: { type: "string" },
			runtime: { type: "string" },
		},
		strict: true,
	});
	const selectedRuntime = runtimeKind(values.runtime);
	const endpoint = process.env.RIVET_ENDPOINT;
	if (endpoint === undefined || endpoint.length === 0) {
		throw new Error(
			"orange serve needs RIVET_ENDPOINT, such as https://<namespace>:<token>@api.rivet.dev",
		);
	}
	const port = Number(values.port ?? process.env.PORT ?? defaultPort);
	if (!Number.isInteger(port) || port < 0 || port > 65_535) {
		throw new Error(`orange serve received an invalid port: ${values.port ?? process.env.PORT}`);
	}
	const configPaths: (string | undefined)[] = values.config === undefined || values.config.length === 0 ? [undefined] : values.config;
	const configs = [];
	for (const configPath of configPaths) {
		const loaded = await loadWranglerConfiguration({
			deployed: true,
			runnerEnvironment: process.env,
			...(configPath === undefined ? {} : { configPath }),
			...(values.env === undefined ? {} : { environment: values.env }),
		});
		for (const warning of loaded.warnings) io.error(`! ${warning}`);
		if (loaded.build !== undefined && process.env[customBuildDoneVariable] !== "1") {
			throw new Error("orange serve does not run custom builds. Build the Worker before the image starts.");
		}
		configs.push(loaded);
	}
	if (configs.length > 1) {
		const directory = await mkdtemp(join(tmpdir(), "open-orange-serve-"));
		try {
			return await serveSession({
				runtime: selectedRuntime,
				configs,
				directory,
				endpoint,
				error: (message) => io.error(message),
				host: values.ip ?? "0.0.0.0",
				log: (message) => io.log(message),
				namespace: rivetNamespaceOf(endpoint),
				port,
			});
		} finally {
			await rm(directory, { force: true, recursive: true });
		}
	}
	const [config] = configs;
	if (config === undefined) throw new Error("orange serve received no Worker configuration");
	// The identity derives from the Worker name and environment only, so a
	// runner on an empty disk finds the same actors.
	const { deploymentIdentity, rivetStoragePath } = await resolveDeploymentStorage(config);
	const bundleDirectory = await mkdtemp(join(tmpdir(), "open-orange-serve-"));
	try {
		const { additionalModules, bundlePath } = await bundleForServe(config, bundleDirectory, selectedRuntime);
		await stopEsbuild();
		const runtime = await spawnRuntime({
			runtime: runtimeKind(values.runtime),
			...(additionalModules === undefined ? {} : { additionalModules }),
			...(config.assets === undefined ? {} : { assets: config.assets }),
			bindingConfigurations: config.bindings,
			builtAt: new Date(),
			bundlePath,
			crons: config.crons,
			deploymentIdentity,
			...(config.durableObjects === undefined
				? {}
				: { durableObjectManifest: config.durableObjects }),
			host: values.ip ?? "0.0.0.0",
			normalizedConfiguration: config.normalizedConfiguration,
			onDiagnostic: (diagnostic) => io.error(diagnostic.stack ?? diagnostic.message),
			onFatal: (error) => io.error(error.stack ?? error.message),
			onWarning: (warning) => io.error(warning.message),
			port,
			projectRoot: config.projectRoot,
			...(config.requestSignalPassthrough ? { requestSignalPassthrough: true } : {}),
		trustForwardedProto: true,
			queueConsumers: config.queueConsumers,
			tailConsumers: config.tailConsumers,
			...(config.workerName === undefined ? {} : { workerName: config.workerName }),
			rivetEndpoint: endpoint,
			rivetNamespace: rivetNamespaceOf(endpoint),
			rivetStoragePath,
			startupTimeoutMs: 60_000,
		});
		io.log(`orange serve listening on http://${runtime.host}:${runtime.port}`);
		const stop = (): void => {
			void runtime.stop();
		};
		process.once("SIGINT", stop);
		process.once("SIGTERM", stop);
		const exit = await runtime.waitForExit();
		process.off("SIGINT", stop);
		process.off("SIGTERM", stop);
		return exit.code ?? (exit.reason === undefined ? 1 : 0);
	} finally {
		await rm(bundleDirectory, { force: true, recursive: true });
	}
}

// The endpoint's user name names the namespace. Rivet 3 clusters set RIVET_NAMESPACE instead.
export function rivetNamespaceOf(endpoint: string): string {
	const user = new URL(endpoint).username;
	if (user.length > 0) return decodeURIComponent(user);
	return process.env.RIVET_NAMESPACE ?? "default";
}
