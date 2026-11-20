import { randomUUID } from "node:crypto";
import { appendFileSync, closeSync, constants, mkdirSync, openSync, readdirSync, readFileSync, statSync } from "node:fs";
import { Server } from "node:net";
import { join } from "node:path";
import { fixturePolicyError, fixturePolicyLimit, processIdentity, readFixturePolicy } from "../../src/runtime/agentos-fixture-policy.js";

// Explicit comparison capacity is applied after isolated-env cleared shell settings.
const remoteResponseProfile = process.env.OPENORANGE_COMPARISON_REMOTE_SQLITE_RESPONSE_BYTES;
if (remoteResponseProfile !== undefined) {
 const bytes = Number(remoteResponseProfile);
 if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > 64 * 1024 * 1024)
  throw new Error("Remote SQLite comparison response capacity must be1 through64MiB");
 if (process.env.OPENORANGE_RUNTIME === "agentos")
  process.env.RIVET__PEGBOARD__SQLITE_REMOTE_MAX_RESPONSE_BYTES = String(bytes);
}

process.umask(0o022);
const receipt = process.env.OPENORANGE_COMPARISON_POLICY_LOG;
const controllerPid = Number(process.env.OPENORANGE_AGENTOS_POLICY_CONTROLLER_PID ?? process.pid);
process.env.OPENORANGE_AGENTOS_POLICY_CONTROLLER_PID = String(controllerPid);
const listeners = new WeakMap<Server, { id: string; port: number }>();
const ports = new Set<number>();
if (receipt) {
	const fd = openSync(receipt, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
	closeSync(fd);
	mkdirSync(`${receipt}.acks`, { recursive: true, mode: 0o700 });
	process.env.OPENORANGE_AGENTOS_HOST_LOOPBACK_POLICY_FILE = receipt;
}

function acknowledged(revision: number): boolean {
	if (!receipt) return true;
	const names = readdirSync(`${receipt}.acks`).filter(name => name.endsWith(".json"));
	const maxDrivers = fixturePolicyLimit("OPENORANGE_COMPARISON_MAX_POLICY_DRIVERS", 128);
	if (names.length > maxDrivers) throw fixturePolicyError(`Fixture policy has more than ${maxDrivers} drivers; raise OPENORANGE_COMPARISON_MAX_POLICY_DRIVERS`);
	for (const name of names) {
		let ack;
		try {
			const path = join(`${receipt}.acks`, name);
			if (statSync(path).size > 2048) throw fixturePolicyError("Fixture policy acknowledgement exceeds 2048 bytes");
			ack = JSON.parse(readFileSync(path, "utf8"));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
			throw error;
		}
		if (!Number.isSafeInteger(ack.pid) || ack.pid < 1 || ack.controllerPid !== controllerPid) throw fixturePolicyError("Invalid fixture policy acknowledgement");
		if (processIdentity(ack.pid) !== ack.identity) continue;
		if (ack.ready && ack.revision < revision) return false;
	}
	return true;
}

function publish(kind: "fixture-listener-granted" | "fixture-listener-retired", listener: { id: string; port: number }) {
	if (kind === "fixture-listener-granted") ports.add(listener.port); else ports.delete(listener.port);
	const maxPorts = fixturePolicyLimit("OPENORANGE_AGENTOS_MAX_HOST_LOOPBACK_PORTS", 128);
	if (ports.size > maxPorts) throw fixturePolicyError(`Fixture listener limit ${maxPorts}; raise OPENORANGE_AGENTOS_MAX_HOST_LOOPBACK_PORTS`);
	process.env.OPENORANGE_AGENTOS_HOST_LOOPBACK_PORTS = [...ports].join(",");
	if (!receipt) return;
	const line = JSON.stringify({ kind, ...listener, controllerPid, publisherPid: process.pid, time: Date.now() }) + "\n";
	const maxBytes = fixturePolicyLimit("OPENORANGE_COMPARISON_MAX_POLICY_BYTES", 1024 * 1024);
	if (statSync(receipt).size + Buffer.byteLength(line) > maxBytes) throw fixturePolicyError(`Fixture policy exceeds ${maxBytes} bytes; raise OPENORANGE_COMPARISON_MAX_POLICY_BYTES`);
	appendFileSync(receipt, line);
	const revision = readFixturePolicy(receipt, controllerPid).revision;
	const timeoutMs = fixturePolicyLimit("OPENORANGE_COMPARISON_POLICY_ACK_TIMEOUT_MS", 5000);
	const deadline = Date.now() + timeoutMs;
    // Driver and controller may share this process. Yield so native policy
    // updates can complete before publishing readiness or releasing the port.
    if (acknowledged(revision)) return;
    return (async()=>{
        while (!acknowledged(revision)) {
            if (Date.now() >= deadline) throw fixturePolicyError(`Fixture policy acknowledgement exceeded ${timeoutMs}ms; raise OPENORANGE_COMPARISON_POLICY_ACK_TIMEOUT_MS`);
            await new Promise(resolve=>setTimeout(resolve,10));
        }
    })();
}

const emit = Server.prototype.emit;
Server.prototype.emit = function(this: Server, event: string | symbol, ...args: unknown[]) {
	if (event === "listening") {
		const address = this.address();
		if (address && typeof address !== "string" && ["127.0.0.1", "::1", "0.0.0.0", "::"].includes(address.address)) {
			const listener = { id: randomUUID(), port: address.port };
			listeners.set(this, listener);
            const pending = publish("fixture-listener-granted", listener);
            if (pending) {
                void pending.then(()=>Reflect.apply(emit,this,[event,...args])).catch(error=>queueMicrotask(()=>{throw error;}));
                return true;
            }
		}
	}
	return Reflect.apply(emit, this, [event, ...args]);
};
const close = Server.prototype.close;
Server.prototype.close = function(this: Server, ...args: Parameters<typeof close>) {
	const listener = listeners.get(this);
	if (listener) {
		listeners.delete(this);
        try {
            const pending=publish("fixture-listener-retired",listener);
            if(pending){
                void pending.then(()=>Reflect.apply(close,this,args)).catch(error=>{Reflect.apply(close,this,args);queueMicrotask(()=>{throw error;});});
                return this;
            }
        } catch(error){Reflect.apply(close,this,args);throw error;}
	}
	return Reflect.apply(close, this, args);
};
