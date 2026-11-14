import {openAgentOsHeapInspection} from "./agentos-inspection.js";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { mkdir, readFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { agentOsSetting as setting, attachGuestHttpForwarder } from "./agentos-http-forwarder.js";
import { acquireAgentOsSession, type AgentOsSessionLease } from "./agentos-session-broker.js";
import { AgentOsWorkerVms, workerVmCommandSchema } from "./agentos-worker-vms.js";
import {AgentOsSandboxVms,sandboxVmCommandSchema} from "./agentos-sandbox-vms.js";
import { guestDuplex, type GuestConnection } from "./agentos-connection.js";
import { acquireAgentOsRivet, portableRivetBuild } from "./agentos-rivet-backend.js";
import { guestStackMapper } from "./agentos-stack.js";
import { agentOsRuntimeEnvironment, agentOsServiceNetwork, agentOsProjectIsWritable } from "./agentos-policy.js";
import { watchAgentOsFixturePolicy } from "./agentos-live-policy.js";
import { metricsPortFromEnvironment } from "../../packages/runtime-node/src/internal/metrics-server.js";

import { runtimeModuleRewrites } from "../build/rewrite-module-imports.js";
import { parseRuntimeChildMessage, type RuntimeSessionWorker } from "../../packages/runtime-node/src/process-protocol.js";
import { RuntimeBuildMismatchError, type RuntimeExit, type RuntimeProcess, type SpawnRuntimeOptions } from "./spawn.js";

// The integration deliberately consumes only this portion of the same-version
// agentOS API, including when a local unreleased module is selected.
interface GuestVm {
 configurePermissions(permissions: {network: {default: "deny"; rules: {mode: "allow"; patterns: string[]}[]};hostFunction: "allow"}, options: {loopbackExemptPorts: number[]}): Promise<void>;
	writeFile(path: string, content: string | Uint8Array): Promise<void>;
	dispose(): Promise<void>;
	network: { connect(port: number): Promise<GuestConnection> };
	process: {
		spawn(command: string, args: string[], options: { cwd: string; streamStdin: boolean; onStdout(bytes: Uint8Array): void; onStderr(bytes: Uint8Array): void }): Promise<{ pid: number }>;
		wait(pid: number): Promise<{ exitCode?: number }>;
		writeStdin(pid: number, data: string): Promise<void>;
		kill(pid: number): Promise<void>;
		signal(pid: number, signal: "SIGINT" | "SIGTERM" | "SIGKILL"): Promise<void>;
	};
}

// The client module and native sidecar must come from the same agentOS build.
// A local module override allows testing an unreleased checkout without publishing it.
export async function spawnAgentOsRuntime(options: SpawnRuntimeOptions, sourceRunner: string): Promise<RuntimeProcess> {
	const inspectionEnabled=process.env.OPENORANGE_AGENTOS_INSPECTION_FILE!==undefined;
 const heapWaiters=new Map<string,{resolve:(value:number)=>void;reject:(error:Error)=>void}>();
 let closeInspection:undefined|(()=>Promise<void>);
	const diagnosticsDirectory = process.env.OPENORANGE_AGENTOS_DIAGNOSTICS_DIR;
	const diagnosticsPath = diagnosticsDirectory ? join(diagnosticsDirectory, `${process.pid}-${randomUUID()}.jsonl`) : undefined;
	if (diagnosticsDirectory) mkdirSync(diagnosticsDirectory, { recursive: true });
	let diagnosticBytes = 0, diagnosticCapped = false;
	const diagnostic = (kind: string, detail: unknown) => {
		if (!diagnosticsPath || diagnosticCapped) return;
		const payload = JSON.stringify(detail) ?? "null";
		let line = JSON.stringify({ time: Date.now(), hostPid: process.pid, kind, detail: payload.slice(0, 16384), truncated: payload.length > 16384 }) + "\n";
		if (diagnosticBytes + Buffer.byteLength(line) > 2 * 1024 * 1024) {
			line = JSON.stringify({ time: Date.now(), kind: "diagnostic-cap", limit: 2 * 1024 * 1024 }) + "\n";
			diagnosticCapped = true;
		}
		appendFileSync(diagnosticsPath, line); diagnosticBytes += Buffer.byteLength(line);
	};
	diagnostic("start", { bundlePath: options.bundlePath, projectRoot: options.projectRoot, rivetNamespace: options.rivetNamespace, native: process.env.AGENTOS_SIDECAR_BIN });
	const metricsPort = options.rivetEndpoint !== undefined && options.serveMetrics !== false ? metricsPortFromEnvironment(process.env) : undefined;
	const workerCode = await readFile(options.bundlePath);
	const mapStack = guestStackMapper(workerCode.toString(), options.bundlePath);
	const maxRequestBytes = setting("OPENORANGE_AGENTOS_MAX_REQUEST_BYTES", 8 * 1024 * 1024);
	const maxRequests = setting("OPENORANGE_AGENTOS_MAX_CONCURRENT_REQUESTS", 32);
	const requestTimeoutMs = setting("OPENORANGE_AGENTOS_REQUEST_TIMEOUT_MS", 30000);
	const webSocketIdleTimeoutMs = setting("OPENORANGE_AGENTOS_WEBSOCKET_IDLE_TIMEOUT_MS", 125000);
	const heapMb = setting("OPENORANGE_AGENTOS_V8_HEAP_MB", 256);
 const cpuTimeLimitMs = process.env.OPENORANGE_AGENTOS_CPU_TIME_MS === undefined ? undefined : setting("OPENORANGE_AGENTOS_CPU_TIME_MS",30000);
	const needsPosixSoftware = options.durableObjectManifest?.classes.some(entry => entry.container !== undefined) === true;
	const specifier = process.env.OPENORANGE_AGENTOS_MODULE ?? "@rivet-dev/agentos";
	const rivetBuild = await portableRivetBuild();
	const { AgentOs, createHostDirBackend } = await import(specifier).catch((cause: unknown) => {
		throw new Error("agentOS runtime requires @rivet-dev/agentos and its matching native sidecar. Set OPENORANGE_AGENTOS_MODULE for a local client build.", { cause });
	});
	// Guest Node cannot load tsx's native esbuild service. Use the package's ordinary
	// built runtime; this is the same artifact Node uses in an installed package.
	const runner = sourceRunner.endsWith(".ts") ? resolve(dirname(sourceRunner), "../../../dist/runtime/runner.js") : sourceRunner;
	const maxChildVms = setting("OPENORANGE_AGENTOS_MAX_CHILD_VMS", 64);
	const childVms = new AgentOsWorkerVms(network => AgentOs.create({
		sidecar: { kind: "explicit", handle: sidecar }, defaultSoftware: false,
		user: { uid: process.getuid?.() ?? 1000, gid: process.getgid?.() ?? 1000, username: "orange", homedir: "/home/orange" },
		environment: { HOME: "/home/orange", TMPDIR: "/tmp", PATH: "/bin:/usr/bin" },
		limits: { jsRuntime: { v8HeapLimitMb: setting("OPENORANGE_AGENTOS_CHILD_V8_HEAP_MB", 128) } },
		permissions: { network: network ? "allow" : "deny" },
		mounts: [{ path: "/open-orange/runtime", readOnly: true, plugin: createHostDirBackend({ hostPath: join(dirname(runner), "worker-loader-vm"), readOnly: true }) }],
	}));
	const sandboxVms=needsPosixSoftware?new AgentOsSandboxVms(()=>AgentOs.create({
        sidecar:{kind:"explicit",handle:sidecar},defaultSoftware:true,
        user:{uid:0,gid:0,username:"root",homedir:"/workspace"},
        environment:{HOME:"/workspace",TMPDIR:"/tmp",PATH:"/opt/agentos/bin:/bin:/usr/bin",LANG:"C.UTF-8"},
        permissions:{network:"deny"},
        limits:{jsRuntime:{v8HeapLimitMb:setting("OPENORANGE_AGENTOS_SANDBOX_V8_HEAP_MB",128)},reactor:{maxBridgeResponseBytes:16*1024*1024},resources:{maxFilesystemBytes:setting("OPENORANGE_AGENTOS_SANDBOX_FILESYSTEM_BYTES",64*1024*1024)}},
    })):undefined;
	const sidecar = await AgentOs.createSidecar({ runtime: {
  ...(process.env.OPENORANGE_AGENTOS_EXECUTOR_BYTES===undefined?{}:{blocking:{maxQueuedBytes:setting("OPENORANGE_AGENTOS_EXECUTOR_BYTES",64*1024*1024)}}),
  protocol: {
  ...(process.env.OPENORANGE_AGENTOS_MAX_IN_FLIGHT_REQUESTS===undefined?{}:{maxInFlightRequests:setting("OPENORANGE_AGENTOS_MAX_IN_FLIGHT_REQUESTS",128)}),
  ...(process.env.OPENORANGE_AGENTOS_MAX_TERMINAL_FRAMES===undefined?{}:{maxTerminalFrames:setting("OPENORANGE_AGENTOS_MAX_TERMINAL_FRAMES",128)}),
  ...(process.env.OPENORANGE_AGENTOS_MAX_TERMINAL_BYTES===undefined?{}:{maxTerminalBytes:setting("OPENORANGE_AGENTOS_MAX_TERMINAL_BYTES",8*1024*1024)}),
  ...(process.env.OPENORANGE_AGENTOS_MAX_CONTROL_FRAMES===undefined?{}:{maxControlFrames:setting("OPENORANGE_AGENTOS_MAX_CONTROL_FRAMES",1024)}),
  ...(process.env.OPENORANGE_AGENTOS_MAX_CONTROL_BYTES===undefined?{}:{maxControlBytes:setting("OPENORANGE_AGENTOS_MAX_CONTROL_BYTES",64*1024*1024)})
 }, executor: { maxActiveVms: Math.min(2147483647, maxChildVms + (needsPosixSoftware ? setting("OPENORANGE_AGENTOS_MAX_SANDBOX_VMS",16) : 0) + 1) } } });
	let backend: Awaited<ReturnType<typeof acquireAgentOsRivet>> | undefined;
	let sessionBroker: AgentOsSessionLease | undefined;
	let unpublishSession: (() => void) | undefined;
	let vm!: GuestVm;
	let processId: number | undefined;
	const ready = Promise.withResolvers<{ host: string; port: number; internalAddress?: { host: string; port: number }; cronNextRuns?: { cron: string; nextRunAt: number }[] }>();
	// Observe early startup failures while VM input is still being copied.
	const readiness = ready.promise.then(value => ({ value }), error => ({ error }));
	const exited = Promise.withResolvers<RuntimeExit>();
	let reason: RuntimeExit["reason"], isReady = false, hasExited = false;
 let buildMismatch: RuntimeBuildMismatchError | undefined;
	const timeout = setTimeout(() => ready.reject(new Error("OpenOrange agentOS runtime startup timed out")), options.startupTimeoutMs ?? 10000);
	const front = createServer();
	let metricsFront: ReturnType<typeof createTcpServer> | undefined;
	front.maxConnections = Math.min(2147483647, maxRequests * 2);
	front.headersTimeout = requestTimeoutMs;
	front.requestTimeout = requestTimeoutMs;
	const connections = new Set<ReturnType<typeof guestDuplex>>();
	let disposal: Promise<void> | undefined;
 let stopPolicy: (()=>Promise<void>) | undefined;
	const dispose = () => disposal ??= (async () => {
		clearTimeout(timeout);
        for(const waiter of heapWaiters.values())waiter.reject(new Error("The runtime stopped during inspection"));
        heapWaiters.clear();await closeInspection?.();
        await stopPolicy?.();
		unpublishSession?.();
		for (const connection of connections) connection.destroy();
		front.closeAllConnections();
		if (front.listening) await new Promise<void>((done, reject) => front.close(error => error ? reject(error) : done()));
		if (metricsFront?.listening) await new Promise<void>((done, reject) => metricsFront!.close(error => error ? reject(error) : done()));
		try { await sandboxVms?.dispose(); } finally { try { await childVms.dispose(); } finally { try { await vm?.dispose(); } finally { try { await sidecar.dispose(); } finally { try { await backend?.release(); } finally { await sessionBroker?.release(); } } } } }
	})();
	try {
		backend = await acquireAgentOsRivet(options);
		const runtimeEnvironment = agentOsRuntimeEnvironment();
		const network = agentOsServiceNetwork(options, runtimeEnvironment, backend, process.env.OPENORANGE_AGENTOS_HOST_LOOPBACK_POLICY_FILE ? [] : undefined);
		if (options.session?.self !== undefined) {
			sessionBroker = await acquireAgentOsSession(options.session.token);
			network.patterns.push(`tcp://127.0.0.1:${sessionBroker.address.port}`);
			network.loopbackExemptPorts.push(sessionBroker.address.port);
		}
        if(sandboxVms){await sandboxVms.listen();network.patterns.push(`tcp://127.0.0.1:${sandboxVms.port}`);network.loopbackExemptPorts.push(sandboxVms.port);}
		const ensureRivet = backend.ensure;
		const roots = [...new Set([options.projectRoot, dirname(options.bundlePath), resolve(dirname(runner), "../.."), rivetBuild.directory])];
        // A packed installation keeps declared runtime dependencies beside the
        // package. Include its node_modules tree, read-only, so the guest loader
        // can follow npm/pnpm's normal dependency links.
        let modulesRoot: string | undefined;
        for (let parent = resolve(dirname(runner), "../.."); dirname(parent) !== parent; parent = dirname(parent)) {
            if (basename(parent) === "node_modules") modulesRoot = parent;
        }
        if (modulesRoot !== undefined && !roots.includes(modulesRoot)) roots.push(modulesRoot);
		await mkdir(options.rivetStoragePath, { recursive: true });
        const writableProject = await agentOsProjectIsWritable(options.projectRoot);
        const engineState = join(options.rivetStoragePath,".rivetkit");
        if(writableProject)await mkdir(engineState,{recursive:true});

		const secretEnvironment = Object.fromEntries(options.bindingConfigurations
			.filter(binding => binding.type === "secrets_store_secret" && process.env[binding.binding] !== undefined)
			.map(binding => [binding.binding, process.env[binding.binding]!]));
		vm = await AgentOs.create({
			sidecar: { kind: "explicit", handle: sidecar }, defaultSoftware: needsPosixSoftware,
            // Local Sandbox POSIX commands have a supervised guest executor
            // process. JavaScript remains V8, and all IO stays kernel-backed.
            ...(needsPosixSoftware ? {wasmBackend:"wasmtime-threads" as const} : {}),
			// Orange supports bundled Node applications beyond a single small
			// Worker. Keep an explicit, enforced application heap budget.
			limits: { ...(process.env.OPENORANGE_AGENTOS_VM_BLOCKING_BYTES===undefined?{}:{reactor:{maxBlockingBytes:setting("OPENORANGE_AGENTOS_VM_BLOCKING_BYTES",64*1024*1024)}}), ...(needsPosixSoftware ? {wasm:{maxThreads:1,maxConcurrentThreads:setting("OPENORANGE_AGENTOS_SANDBOX_MAX_CONCURRENT_THREADS",16)}} : {}), jsRuntime: { v8HeapLimitMb: heapMb, ...(process.env.OPENORANGE_AGENTOS_MAX_BLOB_BYTES===undefined?{}:{maxBlobBytes:setting("OPENORANGE_AGENTOS_MAX_BLOB_BYTES",64*1024*1024)}), ...(process.env.OPENORANGE_AGENTOS_V8_SERIALIZATION_BYTES === undefined ? {} : {v8SerializationLimitBytes:setting("OPENORANGE_AGENTOS_V8_SERIALIZATION_BYTES",16*1024*1024)}), ...(cpuTimeLimitMs === undefined ? {} : {cpuTimeLimitMs}), ...(process.env.OPENORANGE_AGENTOS_MAX_TIMERS === undefined ? {} : {maxTimers:setting("OPENORANGE_AGENTOS_MAX_TIMERS",4096)}) }, resources: {
                maxFilesystemBytes:setting("OPENORANGE_AGENTOS_FILESYSTEM_BYTES",512*1024*1024),
                ...(process.env.OPENORANGE_AGENTOS_MAX_SOCKETS === undefined ? {} : {maxSockets:setting("OPENORANGE_AGENTOS_MAX_SOCKETS",256)}),
                ...(process.env.OPENORANGE_AGENTOS_MAX_CONNECTIONS === undefined ? {} : {maxConnections:setting("OPENORANGE_AGENTOS_MAX_CONNECTIONS",256)}),
                ...(process.env.OPENORANGE_AGENTOS_MAX_SOCKET_BUFFERED_BYTES === undefined ? {} : {maxSocketBufferedBytes:setting("OPENORANGE_AGENTOS_MAX_SOCKET_BUFFERED_BYTES",4*1024*1024)})
            } },
			user: { uid: process.getuid?.() ?? 1000, gid: process.getgid?.() ?? 1000, username: "orange", homedir: "/home/orange" },
			// No ambient host env, external network grant, or host process execution.
			// VM-local listeners and calls stay behind agentOS loopback confinement.
			// Only the backend port is exempted to reach the host service.
			permissions: { network: { default: "deny", rules: [{ mode: "allow", patterns: network.patterns }] }, hostFunction: "allow" },
			loopbackExemptPorts: network.loopbackExemptPorts,
			environment: { HOME: "/home/orange", TMPDIR: "/tmp", PATH: "/opt/agentos/bin:/bin:/usr/bin", NODE_ENV: "production",
                // The controller's explicit project grant makes the local
                // provider persistent across VM restarts. Engine state stays RO.
                ...(writableProject && needsPosixSoftware ? {ORANGE_SANDBOX_DIR:join(options.rivetStoragePath,"sandboxes")} : {}),
				...runtimeEnvironment,
				...(metricsPort === undefined ? {} : { RIVETKIT_METRICS_PORT: String(metricsPort) }),
                OPENORANGE_RIVETKIT_PACKAGE: rivetBuild.directory, OPENORANGE_RIVETKIT_BUILD: JSON.stringify(rivetBuild),
				...((options.rivetLogLevel ?? process.env.RIVET_LOG_LEVEL) === undefined ? {} : { RIVET_LOG_LEVEL: options.rivetLogLevel ?? process.env.RIVET_LOG_LEVEL }), ...secretEnvironment },
			mounts: [
                ...roots.map(hostPath => { const readOnly = !writableProject || hostPath !== options.projectRoot; return {path:hostPath,readOnly,plugin:createHostDirBackend({hostPath,readOnly})}; }),
                ...(writableProject ? [{path:engineState,readOnly:true,plugin:createHostDirBackend({hostPath:engineState,readOnly:true})}] : []),
            ],
			hostFunctions: { orangeRuntime: {
                ...(inspectionEnabled?{heapInspection:{inputSchema:z.object({id:z.string().uuid(),heapUsed:z.number().safe().nonnegative()}).strict(),execute:({id,heapUsed}:{id:string;heapUsed:number})=>{const waiter=heapWaiters.get(id);if(!waiter)throw Error("Heap inspection request is no longer active");heapWaiters.delete(id);diagnostic("heap-inspection",{heapUsed});waiter.resolve(heapUsed);return{received:true};}}}:{}),
                ...(sandboxVms?{sandboxVmCommand:{inputSchema:sandboxVmCommandSchema,execute:(input:z.infer<typeof sandboxVmCommandSchema>)=>sandboxVms.command(input)}}:{}),
				...(options.bindingConfigurations.some(binding => binding.type === "worker_loader") ? {
					createWorkerVm: { inputSchema: z.object({ network: z.boolean() }).strict(), execute: ({ network }: { network: boolean }) => childVms.create(network) },
					workerVmCommand: { inputSchema: workerVmCommandSchema, execute: (input: z.infer<typeof workerVmCommandSchema>) => childVms.command(input) },
				} : {}),
				ensureRivet: { inputSchema: z.object({}).strict(), execute: () => ensureRivet() },
				event: {
				inputSchema: z.object({ json: z.string().max(1024 * 1024) }),
				execute: ({ json }: { json: string }) => {
					if (buildMismatch) return { received: true };
     let message;
     try { message = parseRuntimeChildMessage(JSON.parse(json)); }
     catch (cause) {
      buildMismatch = new RuntimeBuildMismatchError(cause);
      diagnostic("build-mismatch", buildMismatch.message);
      if (!isReady) ready.reject(buildMismatch);
      else {
       options.onFatal?.({ type: "fatal", message: buildMismatch.message });
       if (processId !== undefined) void vm.process.signal(processId, "SIGTERM").catch((error: Error) => process.stderr.write(`agentOS mismatch shutdown failed: ${error.message}\n`));
      }
      return { received: true };
     }
					diagnostic("event", message);
					if ("stack" in message && typeof message.stack === "string") message.stack = mapStack(message.stack);
					if (message.type === "ready") { isReady = true; ready.resolve(message); }
					else if (message.type === "fatal") {
						if (!isReady) ready.reject(new Error(message.stack ?? message.message)); else options.onFatal?.(message);
					} else if (message.type === "stopped") reason = message.reason;
					else if (message.type === "request") options.onRequest?.(message);
					else if (message.type === "warning") {
						if (options.onWarning) options.onWarning(message); else process.stderr.write(message.message + "\n");
					} else options.onDiagnostic?.(message);
					return { received: true };
				},
			} } },
		});
		// Keep generated output private while reading the already mounted input.
		// A guest symlink avoids copying a large bundle through one protocol frame.
		const guestBundle = "/tmp/orange-worker.mjs";
		// A dedicated stdin lane carries parent control. Validated host-function
		// calls carry guest events; stdout/stderr remain application output only.
		await vm.writeFile("/tmp/orange-runtime.mjs", `
import {runRuntimeProcess} from ${JSON.stringify(pathToFileURL(runner).href)};
import {symlinkSync} from 'node:fs';
symlinkSync(${JSON.stringify(resolve(options.bundlePath))}, ${JSON.stringify(guestBundle)});
let buffered='';const pending=new Set();
const nativeHeapUsage=process.memoryUsage.bind(process),collectHeap=globalThis.gc;
function sendRuntimeEvent(message, callback) {
 if (pending.size >= 1024) throw new Error('OpenOrange runtime event limit 1024 exceeded');
 const event=orangeRuntime.event({json:JSON.stringify(message)});pending.add(event);
 event.then(()=>{pending.delete(event);callback?.(null);},error=>{pending.delete(event);if(callback)callback(error);else{console.error(error);process.exit(1);}});
 return pending.size < 1024;
}
// This process has an actual runtime control channel. Expose the same endpoint
// that a forked Node runtime provides to global process.send callers.
process.connected=true;
process.send=(message,...args)=>sendRuntimeEvent(message,typeof args.at(-1)==='function'?args.at(-1):undefined);
await runRuntimeProcess({
 send:sendRuntimeEvent,
 subscribe(listener) {
  process.stdin.setEncoding('utf8');
  process.stdin.on('data',chunk=>{
   buffered+=chunk;
   if(buffered.length>1048576) throw new Error('OpenOrange runtime control limit 1MiB exceeded');
   let index;while((index=buffered.indexOf('\\n'))!==-1){const line=buffered.slice(0,index);buffered=buffered.slice(index+1);const input=JSON.parse(line);if(${inspectionEnabled}&&input.type==='__agentos-inspect-heap'){if(typeof collectHeap!=='function')throw Error('Guest collector unavailable');const reply=(async()=>{for(let round=0;round<2;round++){collectHeap();await new Promise(resolve=>setImmediate(resolve));}return orangeRuntime.heapInspection({id:input.id,heapUsed:nativeHeapUsage().heapUsed});})();pending.add(reply);reply.then(()=>pending.delete(reply),error=>{pending.delete(reply);console.error('ERR_OPENORANGE_HEAP_INSPECTION',error);});}else listener(input);}
  });
  process.stdin.on('end',()=>{process.connected=false;process.emit('disconnect');});
 }
});
await Promise.all(pending);
process.exit(process.exitCode??0);
`);
		const output = (bytes: Uint8Array, stream: "stdout" | "stderr") => {
			diagnostic(stream, { text: Buffer.from(bytes).toString(), bytes: bytes.byteLength });
			if (options.onOutput) options.onOutput(Buffer.from(bytes), stream);
			else (stream === "stderr" || options.stdout === "stderr" ? process.stderr : process.stdout).write(bytes);
		};
        stopPolicy = await watchAgentOsFixturePolicy(async ports => {
            const fixtures = agentOsServiceNetwork(options, runtimeEnvironment, backend!, ports);
            await vm.configurePermissions({network: {default: "deny", rules: [{mode: "allow", patterns: [...new Set([...network.patterns, ...fixtures.patterns])]}]}, hostFunction: "allow"}, {loopbackExemptPorts: [...new Set([...network.loopbackExemptPorts, ...fixtures.loopbackExemptPorts])]});
        }, error => { diagnostic("policy-error", error.message); ready.reject(error); process.stderr.write(`${error.stack ?? error.message}\n`); void dispose().catch(failure => process.stderr.write(`Policy cleanup failed: ${failure}\n`)); });
		const proc = await vm.process.spawn("node", [...(inspectionEnabled?["--expose-gc"]:[]),"/tmp/orange-runtime.mjs"], {
			cwd: options.projectRoot, streamStdin: true,
			onStdout: (bytes: Uint8Array) => output(bytes, "stdout"), onStderr: (bytes: Uint8Array) => output(bytes, "stderr"),
		});
		processId = proc.pid;
		diagnostic("guest-process", { pid: proc.pid });
		void vm.process.wait(proc.pid).then(async (exit: { exitCode?: number }) => {
			diagnostic("exit", exit);
			hasExited = true;
			if (!isReady) ready.reject(new Error(`OpenOrange agentOS guest exited before readiness (code ${exit.exitCode ?? "none"})`));
			await dispose();
			exited.resolve({ code: buildMismatch ? 1 : exit.exitCode ?? 1, signal: null, ...(reason === undefined ? {} : { reason }) });
		}).catch((error: Error) => { ready.reject(error); exited.resolve({ code: 1, signal: null });
			if (options.onFatal) options.onFatal({ type: "fatal", message: error.message }); else process.stderr.write(error.stack ?? error.message);
		});
		// Keep the published port in the VM's own network namespace too. A
		// Worker's fetch(new URL('/path', request.url)) then stays VM-local.
		front.listen(options.port, options.host);
		await once(front, "listening");
		const published = front.address();
		if (!published || typeof published === "string") throw new Error("agentOS listener did not return a TCP port");
		const { runtime: _runtime, onOutput: _output, onDiagnostic: _diagnostic, onFatal: _fatal, onRequest: _request, onWarning: _warning, ...start } = options;
		await vm.process.writeStdin(proc.pid, JSON.stringify({ ...start, rivetStoragePath: "/tmp/open-orange-storage", bundlePath: guestBundle, builtAt: options.builtAt.toISOString(), host: "127.0.0.1", port: published.port, moduleRewrites: runtimeModuleRewrites("agentos"), type: "start" }) + "\n");
		const outcome = await readiness;
		if ("error" in outcome) throw outcome.error;
		const address = outcome.value;
		clearTimeout(timeout);
        closeInspection=await openAgentOsHeapInspection(async()=>{
            if(heapWaiters.size)throw Error("Heap inspection already in progress");
            const id=randomUUID(),reply=Promise.withResolvers<number>();heapWaiters.set(id,reply);
            const timer=setTimeout(()=>reply.reject(new Error("Guest heap inspection timed out")),10000);
            try{return(await Promise.all([vm.process.writeStdin(proc.pid,JSON.stringify({type:"__agentos-inspect-heap",id})+"\n"),reply.promise]))[1];}
            finally{clearTimeout(timer);heapWaiters.delete(id);}
        });
		const connect = async (port = address.port) => {
			const stream = guestDuplex(await vm.network.connect(port));
			if (disposal) { stream.destroy(); throw new Error("The OpenOrange runtime stopped"); }
			connections.add(stream); stream.once("close", () => connections.delete(stream));
			return stream;
		};
		if (sessionBroker) {
			const internal = address.internalAddress;
			if (internal) unpublishSession = sessionBroker.publish(options.session!.self!, () => connect(internal.port));
			else if (options.session!.workers.length > 1) throw new Error("The guest did not publish its session listener");
		}
		if (metricsPort !== undefined) {
			metricsFront = createTcpServer(socket => {
				void connect(metricsPort).then(stream => {
					socket.once("error", () => stream.destroy()); stream.once("error", () => socket.destroy());
					socket.once("close", () => stream.destroy()); stream.once("close", () => socket.destroy());
					socket.setTimeout(requestTimeoutMs, () => socket.destroy());
					socket.pipe(stream).pipe(socket);
				}, () => socket.destroy());
			});
			metricsFront.maxConnections = maxRequests;
			metricsFront.listen(metricsPort, "127.0.0.1");
			await once(metricsFront, "listening");
		}
		attachGuestHttpForwarder(front, () => connect(), { maxRequests, maxRequestBytes, requestTimeoutMs, webSocketIdleTimeoutMs }, error => {
			diagnostic("forwarding-error", String(error));
			if (options.onDiagnostic) options.onDiagnostic({ type: "request-error", message: String(error) });
			else process.stderr.write(`OpenOrange agentOS forwarding: ${String(error)}\n`);
		});
		const control = (message: unknown) => vm.process.writeStdin(proc.pid, JSON.stringify(message) + "\n");
		let stopping: Promise<RuntimeExit> | undefined;
		return {
			host: options.host, port: published.port, cronNextRuns: address.cronNextRuns ?? [],
			...(sessionBroker === undefined || unpublishSession === undefined ? {} : { internalAddress: sessionBroker.address }),
			updateSessionWorkers(workers: RuntimeSessionWorker[]) { void control({ type: "session-workers", workers }).catch((error: Error) => options.onFatal?.({ type: "fatal", message: error.message })); },
			signal(signal) { void vm.process.signal(proc.pid, signal).catch((error: Error) => options.onFatal?.({ type: "fatal", message: error.message })); return true; },
			stop() { return stopping ??= (async () => {
				if (hasExited) return exited.promise;
				await control({ type: "shutdown" });
				// Match the CLI grace budget, allowing the accepted-socket drain and remote storage acknowledgements.
				const deadline = setTimeout(() => { void vm.process.kill(proc.pid).catch((error: Error) => process.stderr.write(`agentOS shutdown failed: ${error.message}\n`)); }, 10_000);
				try { return await exited.promise; } finally { clearTimeout(deadline); }
			})(); },
			waitForExit() { return exited.promise; },
		};
	} catch (cause) {
		diagnostic("startup-error", String(cause));
		if (processId !== undefined) await vm.process.kill(processId).catch((error: unknown) => process.stderr.write(`agentOS cleanup failed: ${String(error)}\n`));
		await dispose();
		if (cause instanceof RuntimeBuildMismatchError) throw cause;
		throw new Error(`OpenOrange agentOS runtime could not start: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
	}
}
