import type { DurableObjectActorRegistration } from "./registry.js";
import {
	createRivetActorClient,
	createRivetRegistry,
	type CreateRivetActorClientOptions,
	type CreateRivetRegistryOptions,
	type RivetActorClient,
	type RivetInternalActorDefinition,
	type RivetRegistry,
} from "../../internal/rivetkit.js";
import { startLocalRivetEngine, withRivetEngineStartLock } from "../../internal/ports.js";
import { discoverInstalledRivetKitBuild } from "../../internal/rivetkit-build.js";

export interface DurableObjectRegistryLifecycle {
	client: RivetActorClient;
	// A client that creates actors in another envoy pool of the same Engine,
	// such as another Worker's pool in a multi-Worker `orange dev` session.
	clientForPool?(poolName: string): RivetActorClient;
	close(): Promise<void>;
	prometheusMetrics(): Promise<Response>;
}

export interface StartDurableObjectRegistryOptions {
	createRegistry?(options: CreateRivetRegistryOptions): RivetRegistry;
	createClient?(options: CreateRivetActorClientOptions): RivetActorClient;
	engineHost?: string;
	enginePort?: number;
	// Call actors without hosting any. `orange d1 --remote` uses it to reach a deployed
	// Worker's database actor without taking that Worker's actors.
	clientOnly?: boolean;
	// An external Engine with the namespace and token in the URL. With it, no local
	// Engine starts.
	endpoint?: string;
	// OpenOrange's own Rivet Actors by actor name, such as the cron, queue,
	// Workflow, and Durable Object facet actors. They share the Worker's registry.
	internalActors?: CreateRivetRegistryOptions["use"];
	namespace: string;
	poolName?: string;
	portSeed?: string;
	registrations: ReadonlyMap<string, DurableObjectActorRegistration>;
	// Start Rivet Services, which hosts Durable Streams, beside the local Engine.
	services?: CreateRivetRegistryOptions["services"];
	storagePath?: string;
}

export async function startDurableObjectRegistry(
	options: StartDurableObjectRegistryOptions,
): Promise<DurableObjectRegistryLifecycle> {
	if (options.endpoint !== undefined) {
		return await startDurableObjectRegistryOnPort(options, 0);
	}
	const configuredPort = options.enginePort;
	if (configuredPort !== undefined) {
		return await startDurableObjectRegistryOnPort(options, configuredPort);
	}
	const { portSeed, storagePath } = options;
	if (portSeed === undefined || storagePath === undefined) {
		throw new Error(
			"Rivet Engine port resolution requires a port seed and storage path",
		);
	}
	return await withRivetEngineStartLock(storagePath, async () => {
		const host = options.engineHost ?? "127.0.0.1";
		const port = await startLocalRivetEngine({
			binaryPath: discoverInstalledRivetKitBuild().engineBinaryPath,
			host,
			portSeed,
			storagePath,
		});
		return await startDurableObjectRegistryOnPort(options, port);
	});
}

async function startDurableObjectRegistryOnPort(
	options: StartDurableObjectRegistryOptions,
	enginePort: number,
): Promise<DurableObjectRegistryLifecycle> {
	const use: Record<
		string,
		DurableObjectActorRegistration["definition"] | RivetInternalActorDefinition
	> = { ...options.internalActors };
	const endpointHost = (options.engineHost ?? "127.0.0.1").includes(":")
		? `[${options.engineHost ?? "127.0.0.1"}]`
		: options.engineHost ?? "127.0.0.1";
	const clientEndpoint = options.endpoint ?? `http://${endpointHost}:${enginePort}`;
	for (const registration of options.registrations.values()) {
		use[registration.actorName] = registration.definition;
	}
	const registry = (options.createRegistry ?? createRivetRegistry)({
		engineHost: options.engineHost ?? "127.0.0.1",
		enginePort,
		...(options.endpoint === undefined ? {} : { endpoint: options.endpoint }),
		namespace: options.namespace,
		...(options.poolName === undefined ? {} : { poolName: options.poolName }),
		...(options.services === undefined ? {} : { services: options.services }),
		use,
	});
	if (options.clientOnly !== true) {
		try {
			await registry.startAndWait();
		} catch (error: unknown) {
			await registry.shutdown();
			throw error;
		}
	}
	const poolClients = new Map<string, RivetActorClient>();
	let client: RivetActorClient;
	try {
		client = (options.createClient ?? createRivetActorClient)({
			endpoint: clientEndpoint,
			namespace: options.namespace,
			...(options.poolName === undefined ? {} : { poolName: options.poolName }),
		});
	} catch (error: unknown) {
		await registry.shutdown();
		throw error;
	}
	let closePromise: Promise<void> | undefined;
	return {
		client,
		clientForPool(poolName): RivetActorClient {
			let poolClient = poolClients.get(poolName);
			if (poolClient === undefined) {
				poolClient = (options.createClient ?? createRivetActorClient)({
					endpoint: clientEndpoint,
					namespace: options.namespace,
					poolName,
				});
				poolClients.set(poolName, poolClient);
			}
			return poolClient;
		},
		close(): Promise<void> {
			closePromise ??= (async () => {
				// Actors drain first, so calls that the drain waits for still reach them. Disposing
				// the clients then fails the calls that outlive it.
				await registry.shutdown();
				await Promise.all([
					client.dispose(),
					...[...poolClients.values()].map((poolClient) => poolClient.dispose()),
				]);
			})();
			return closePromise;
		},
		prometheusMetrics: () => registry.prometheusMetrics(),
	};
}
