import { randomBytes } from "node:crypto";
import { join } from "node:path";

import { stop as stopEsbuild } from "esbuild";

import { findAdditionalModules } from "../build/additional-modules.js";
import { bundleWorker, packagedRuleModules } from "../build/bundle-worker.js";
import { runtimeModuleRewrites } from "../build/rewrite-module-imports.js";
import type { ResolvedWranglerConfiguration } from "../config/load-wrangler.js";
import { resolveDeploymentStorages } from "../runtime/deployment.js";
import { spawnRuntime, type RuntimeProcess } from "../runtime/spawn.js";
import type { RuntimeSessionWorker } from "../../packages/runtime-node/src/process-protocol.js";
import { primaryRivetPoolName } from "../../packages/runtime-node/src/session/workers.js";
import { forwardedHostSecretVariable, startFront, type FrontTarget, type RunningFront } from "./front.js";
import { compileRoutes } from "./routes.js";

export interface ServeBundle {
	additionalModules?: { name: string; path: string }[];
	bundlePath: string;
}

/** Bundles a Worker for production, as `wrangler deploy` builds it. */
export async function bundleForServe(config: ResolvedWranglerConfiguration, directory: string): Promise<ServeBundle> {
	if (config.entrypoint === undefined) throw new Error("orange serve needs a Worker entrypoint");
	const additionalModules =
		config.additionalModuleSearch === undefined
			? []
			: await findAdditionalModules(config.additionalModuleSearch, [
					config.entrypoint,
					...(config.configPath === undefined ? [] : [config.configPath]),
				]);
	const { outputPath, ruleModules } = await bundleWorker({
		additionalModules,
		entrypoint: config.entrypoint,
		moduleRewrites: runtimeModuleRewrites(),
		moduleRules: config.moduleRules,
		...(config.noBundle ? {} : { nodeEnv: process.env.NODE_ENV || "production" }),
		outputPath: join(directory, "worker.mjs"),
		preserveFileNames: config.preserveFileNames,
		sourcemap: false,
	});
	return {
		additionalModules: [...additionalModules, ...ruleModules, ...(await packagedRuleModules(config.entrypoint))],
		bundlePath: outputPath,
	};
}

export interface ServeSessionOptions {
	configs: readonly ResolvedWranglerConfiguration[];
	directory: string;
	endpoint: string;
	host: string;
	namespace: string;
	port: number;
	error(message: string): void;
	log(message: string): void;
}

/**
 * Serves several Workers as one deployment, as `orange dev` runs them: each Worker runs in its
 * own runtime with its own envoy in the cluster's pool, and they reach each other through service bindings,
 * Durable Objects, and queues. The serve port answers with the Worker whose `routes` match the
 * request, and with the first Worker otherwise.
 */
export async function serveSession(options: ServeSessionOptions): Promise<number> {
	const names = new Set<string>();
	for (const config of options.configs) {
		if (config.workerName === undefined) {
			throw new Error(
				`${config.configPath ?? "A Worker configuration"} must set name, because orange serve runs more than one Worker and the others address it by name`,
			);
		}
		if (names.has(config.workerName)) throw new Error(`orange serve received more than one Worker named ${config.workerName}`);
		names.add(config.workerName);
	}
	// Every Worker stores its actors under the first Worker's storage, so they share one Engine namespace.
	const storages = await resolveDeploymentStorages(options.configs);
	const [primaryStorage] = storages;
	if (primaryStorage === undefined) throw new Error("orange serve received no Worker configuration");
	const bundles: ServeBundle[] = [];
	for (const [index, config] of options.configs.entries()) {
		bundles.push(await bundleForServe(config, join(options.directory, String(index))));
	}
	// esbuild's service process keeps the memory of the largest build, which a small runner
	// node needs for the Workers.
	await stopEsbuild();
	const sessionWorkers: RuntimeSessionWorker[] = options.configs.map((config, index) => ({
		deploymentIdentity: storages[index]?.deploymentIdentity ?? "",
		name: config.workerName ?? "",
		// A cluster's Engine knows only the pools its operator created, so every Worker joins the
		// one pool. The Engine sends an actor only to an envoy that serves the actor's name, and each
		// Worker's actors have their own names.
		poolName: primaryRivetPoolName,
		queueConsumers: config.queueConsumers.map((consumer) => consumer.queueName),
		tailConsumers: config.tailConsumers,
	}));
	const token = randomBytes(32).toString("base64url");
	const routed = options.configs.some((config) => config.routes.length > 0);
	const forwardedHostSecret = process.env[forwardedHostSecretVariable];
	// With routes or forwarded hosts, a front listens on the serve port and every runtime on loopback.
	const front = routed || (forwardedHostSecret !== undefined && forwardedHostSecret.length > 0);
	const runtimes: RuntimeProcess[] = [];
	const target = (index: number) => (): FrontTarget => ({ port: runtimes[index]?.port ?? 0 });
	const routes = compileRoutes(
		options.configs.flatMap((config, index) => config.routes.map((pattern) => ({ pattern, target: target(index) }))),
	);
	let running: RunningFront | undefined;
	try {
		for (const [index, config] of options.configs.entries()) {
			const bundle = bundles[index];
			const storage = storages[index];
			if (bundle === undefined || storage === undefined) throw new Error(`Worker ${index} was not prepared`);
			const prefix = `[${config.workerName}] `;
			const serving = index === 0 && !front;
			const runtime = await spawnRuntime({
				...(bundle.additionalModules === undefined ? {} : { additionalModules: bundle.additionalModules }),
				...(config.assets === undefined ? {} : { assets: config.assets }),
				bindingConfigurations: config.bindings,
				builtAt: new Date(),
				bundlePath: bundle.bundlePath,
				crons: config.crons,
				deploymentIdentity: storage.deploymentIdentity,
				...(config.durableObjects === undefined ? {} : { durableObjectManifest: config.durableObjects }),
				host: serving ? options.host : "127.0.0.1",
				normalizedConfiguration: config.normalizedConfiguration,
				onDiagnostic: (diagnostic) => options.error(`${prefix}${diagnostic.stack ?? diagnostic.message}`),
				onFatal: (error) => options.error(`${prefix}${error.stack ?? error.message}`),
				onWarning: (warning) => options.error(`${prefix}${warning.message}`),
				port: serving ? options.port : 0,
				projectRoot: config.projectRoot,
				...(config.requestSignalPassthrough ? { requestSignalPassthrough: true } : {}),
				trustForwardedProto: true,
				queueConsumers: config.queueConsumers,
				rivetEndpoint: options.endpoint,
				rivetNamespace: options.namespace,
				rivetStoragePath: primaryStorage.rivetStoragePath,
				// The cluster scrapes one metrics port, which the first Worker's runtime serves.
				serveMetrics: index === 0,
				session: {
					self: config.workerName ?? "",
					sharedPool: true,
					storageIdentity: primaryStorage.deploymentIdentity,
					token,
					workers: sessionWorkers,
				},
				startupTimeoutMs: 120_000,
				tailConsumers: config.tailConsumers,
				...(config.workerName === undefined ? {} : { workerName: config.workerName }),
			});
			runtimes.push(runtime);
			const entry = sessionWorkers[index];
			if (entry !== undefined && runtime.internalAddress !== undefined) entry.internalAddress = runtime.internalAddress;
			for (const started of runtimes) started.updateSessionWorkers(sessionWorkers);
		}
		if (front) {
			running = await startFront({
				fallback: target(0),
				...(forwardedHostSecret === undefined || forwardedHostSecret.length === 0 ? {} : { forwardedHostSecret }),
				host: options.host,
				port: options.port,
				routes,
			});
		}
		const host = running?.host ?? runtimes[0]?.host ?? options.host;
		const port = running?.port ?? runtimes[0]?.port ?? options.port;
		options.log(`orange serve listening on http://${host}:${port} with ${options.configs.length} Workers`);
		const stop = (): void => {
			for (const runtime of runtimes) void runtime.stop();
		};
		process.once("SIGINT", stop);
		process.once("SIGTERM", stop);
		// One Worker exiting ends the deployment, so the cluster restarts the whole image.
		const exit = await Promise.race(runtimes.map((runtime) => runtime.waitForExit()));
		process.off("SIGINT", stop);
		process.off("SIGTERM", stop);
		return exit.code ?? (exit.reason === undefined ? 1 : 0);
	} finally {
		await running?.close();
		await Promise.all(runtimes.map((runtime) => runtime.stop()));
	}
}
