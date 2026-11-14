import { readAgentOsSourceEngineBuild } from "./source-engine-build.js";
import type { ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { discoverInstalledRivetKitBuild, assertPinnedRivetKitBuild } from "../../packages/runtime-node/src/internal/rivetkit-build.js";
import { ensureRivetEngine, resolveRivetEnginePort, stopRivetEngineAfterSession, withRivetEngineStartLock } from "../../packages/runtime-node/src/internal/ports.js";
import type { SpawnRuntimeOptions } from "./spawn.js";
import {resolveServicesBinary,startServices,type ServicesProcess} from "../../packages/runtime-node/src/internal/services-process.js";

export async function portableRivetBuild() {
	const selected = process.env.OPENORANGE_AGENTOS_RIVETKIT_PACKAGE;
	if (!selected) throw new Error("agentOS requires a portable RivetKit package; set OPENORANGE_AGENTOS_RIVETKIT_PACKAGE to its package directory");
	const directory = resolve(selected), require = createRequire(join(directory, "package.json"));
	const paths = [join(directory, "package.json"), require.resolve("rivetkit"), require.resolve("rivetkit/client"), require.resolve("rivetkit/db"), require.resolve("@rivetkit/rivetkit-wasm"), join(dirname(require.resolve("@rivetkit/rivetkit-wasm")), "pkg/rivetkit_wasm.js"), require.resolve("@rivetkit/rivetkit-wasm/rivetkit_wasm_bg.wasm")];
	const files = Object.fromEntries(await Promise.all(paths.map(async path => [path, createHash("sha256").update(await readFile(path)).digest("hex")])));
	return { directory, files };
}

interface Backend {
	port: number;
	users: number;
	child?: ChildProcess;
	started?: Promise<void>;
	closing?: Promise<void>;
}
interface BackendLease {
	endpoint: string;
	host: string;
	port: number;
	ensure(): Promise<{ endpoint: string }>;
	release(): Promise<void>;
}
const backends = new Map<string, Promise<Backend>>();
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

// SQL executes in the existing host Rust remote backend. Worker and actor JS,
// RivetKit WASM and SDK callbacks execute in the guest with an explicit TCP grant.
export async function acquireAgentOsRivet(options: SpawnRuntimeOptions): Promise<BackendLease> {
	if (options.rivetEndpoint) {
		const url = new URL(options.rivetEndpoint);
		return { endpoint: options.rivetEndpoint, host: url.hostname, port: Number(url.port || (url.protocol === "https:" ? 443 : 80)), ensure: async () => ({ endpoint: options.rivetEndpoint! }), release: async () => {} };
	}
	const needsServices = ((options.tailConsumers?.length ?? 0) > 0 || options.session?.workers.some(worker => (worker.tailConsumers?.length ?? 0) > 0)) && (options.session === undefined || options.session.workers[0]?.name === options.session.self);
 // This is the CLI's fixed installed backend, never a command supplied by a guest.
 const servicesBinary = needsServices ? resolveServicesBinary(createRequire(import.meta.url).resolve("rivetkit")) : undefined;
 let services: ServicesProcess | undefined;
 let servicesStarted: Promise<void> | undefined;
	const storage = resolve(options.rivetStoragePath);
	let pending = backends.get(storage);
	if (!pending) {
		pending = resolveRivetEnginePort({ host: "127.0.0.1", portSeed: storage, storagePath: storage }).then(port => ({ port, users: 0 }));
		backends.set(storage, pending);
		pending.catch(() => { if (backends.get(storage) === pending) backends.delete(storage); });
	}
	const backend = await pending;
	if (backend.closing) { await backend.closing; return await acquireAgentOsRivet(options); }
	backend.users++;
	const endpoint = `http://127.0.0.1:${backend.port}`;
	let released = false;
	return {
		endpoint, host: "127.0.0.1", port: backend.port,
		async ensure() {
			if (released) throw new Error("agentOS Rivet backend lease is closed");
			backend.started ??= withRivetEngineStartLock(storage, async () => {
				const build = discoverInstalledRivetKitBuild(); assertPinnedRivetKitBuild(build);
				await ensureRivetEngine({ binaryPath: readAgentOsSourceEngineBuild()?.path ?? build.engineBinaryPath, host: "127.0.0.1", port: backend.port, storagePath: storage, onSpawn: child => { backend.child = child; } });
				await mkdir(join(storage, "dev-sessions"), { recursive: true });
				await writeFile(join(storage, "dev-sessions", String(process.pid)), "");
			});
			await backend.started;
   if (released) throw new Error("agentOS Rivet backend lease is closed");
   if (servicesBinary) {
    servicesStarted ??= (async () => {
     services = startServices({binaryPath:servicesBinary,endpoint,logDirectory:join(storage,".rivetkit","var","logs","rivet-services"),namespace:options.rivetNamespace,token:process.env.RIVET_TOKEN ?? "default"});
     try { await services.ready; } catch (error) { await services.stop(); throw error; }
    })();
    await servicesStarted;
   }
			return { endpoint };
		},
		async release() {
			if (released) return; released = true;
   // Services belongs to this runtime's lease, even when another Worker keeps
   // the shared Engine alive. Guest exit/failed startup releases the same lease.
   try { await servicesStarted; } catch (error) { process.stderr.write(`Rivet Services startup failed: ${String(error)}\n`); }
   await services?.stop();
			if (--backend.users) return;
			backend.closing = (async () => {
			let startupFailed = false;
			try { await backend.started; } catch { startupFailed = true; }
			await withRivetEngineStartLock(storage, async () => {
				if (!startupFailed) {
					// The last registered driver owns shutdown, even when another
					// CLI process originally spawned the recorded Engine.
					await stopRivetEngineAfterSession(storage, process.pid);
					return;
				}
				// A failed start can precede runtime.json and registration. Only
				// that exact child is eligible for this fallback cleanup.
				await rm(join(storage, "dev-sessions", String(process.pid)), { force: true });
				const sessions = await readdir(join(storage, "dev-sessions")).catch(() => []);
				const child = backend.child;
				if (child && child.exitCode === null && child.signalCode === null && !sessions.some(name => /^\d+$/.test(name) && alive(Number(name)))) {
					child.kill("SIGTERM");
					const deadline = Date.now() + 15000;
					while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) await delay(25);
					if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
				}
			});
			if (backends.get(storage) === pending) backends.delete(storage);
			})();
			await backend.closing;
		},
	};
}
