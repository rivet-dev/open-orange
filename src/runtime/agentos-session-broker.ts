import { timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { Socket } from "node:net";
import type { Duplex } from "node:stream";
import { readServiceTarget, serviceTargetHeader, sessionTokenHeader } from "../../packages/runtime-node/src/session/wire.js";
import { workerNotFoundMessage } from "../../packages/runtime-node/src/session/workers.js";
import { agentOsSetting, attachGuestHttpForwarder, GuestHttpError } from "./agentos-http-forwarder.js";

type Connect = () => Promise<Duplex>;
export interface AgentOsSessionLease {
	address: { host: string; port: number };
	publish(name: string, connect: Connect): () => void;
	release(): Promise<void>;
}
interface Broker {
	port: number;
	server: Server;
	sockets: Set<Socket>;
	workers: Map<string, { owner: object; connect: Connect }>;
	users: number;
	closing?: Promise<void>;
}
const brokers = new Map<string, Promise<Broker>>();

async function createBroker(token: string): Promise<Broker> {
	const expected = Buffer.from(token);
	const workers: Broker["workers"] = new Map();
	const sockets = new Set<Socket>();
	const server = createServer();
	server.on("connection", socket => {
		sockets.add(socket);
		socket.once("close", () => sockets.delete(socket));
	});
	attachGuestHttpForwarder(server, async request => {
		const supplied = request.headers[sessionTokenHeader];
		const received = typeof supplied === "string" ? Buffer.from(supplied) : Buffer.alloc(0);
		if (received.length !== expected.length || !timingSafeEqual(received, expected)) throw new GuestHttpError(403, "Invalid session credentials");
		const encoded = request.headers[serviceTargetHeader];
		let worker: unknown;
		try { worker = readServiceTarget(typeof encoded === "string" ? encoded : undefined).worker; }
		catch { throw new GuestHttpError(400, "Invalid session target"); }
		if (typeof worker !== "string" || worker.length === 0 || Buffer.byteLength(worker) > 1024) throw new GuestHttpError(400, "Invalid session worker name (maximum1024 bytes)");
		const target = workers.get(worker);
		if (!target) throw new GuestHttpError(503, workerNotFoundMessage(worker));
		// The trusted driver registers this fixed VM-local listener. A guest
		// cannot select a host address, port, executable or filesystem mount.
		return target.connect();
	}, {
		maxRequests: agentOsSetting("OPENORANGE_AGENTOS_MAX_CONCURRENT_REQUESTS", 32),
		maxRequestBytes: agentOsSetting("OPENORANGE_AGENTOS_MAX_REQUEST_BYTES", 32 * 1024 * 1024),
		requestTimeoutMs: agentOsSetting("OPENORANGE_AGENTOS_REQUEST_TIMEOUT_MS", 30000),
		webSocketIdleTimeoutMs: agentOsSetting("OPENORANGE_AGENTOS_WEBSOCKET_IDLE_TIMEOUT_MS", 125000),
	}, error => process.stderr.write(`OpenOrange agentOS session: ${String(error)}\n`));
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Session broker did not return a TCP port");
	return { server, port: address.port, sockets, workers, users: 0 };
}

/** One authenticated publication port lets a session add Workers without changing VM policy. */
export async function acquireAgentOsSession(token: string): Promise<AgentOsSessionLease> {
	if (!token || Buffer.byteLength(token) > 4096) throw new Error("Session token must contain1 through4096 bytes");
	let pending = brokers.get(token);
	if (!pending) {
		const limit = agentOsSetting("OPENORANGE_AGENTOS_MAX_SESSIONS", 32);
		if (brokers.size >= limit) throw new Error(`OpenOrange agentOS session limit ${limit} reached; raise OPENORANGE_AGENTOS_MAX_SESSIONS`);
		if (brokers.size + 1 >= limit * 0.8) process.stderr.write(`WARN_OPENORANGE_AGENTOS_SESSIONS_NEAR_LIMIT: ${brokers.size + 1}/${limit}; raise OPENORANGE_AGENTOS_MAX_SESSIONS\n`);
		pending = createBroker(token);
		brokers.set(token, pending);
		void pending.catch(() => { if (brokers.get(token) === pending) brokers.delete(token); });
	}
	const broker = await pending;
	if (broker.closing) { await broker.closing; return acquireAgentOsSession(token); }
	broker.users++;
	const owner = {};
	const names = new Set<string>();
	let released = false;
	const unpublish = (name: string) => {
		if (broker.workers.get(name)?.owner === owner) broker.workers.delete(name);
		names.delete(name);
	};
	return {
		address: { host: "127.0.0.1", port: broker.port },
		publish(name: string, connect: Connect) {
			if (released) throw new Error("Session broker lease is closed");
			if (!name || Buffer.byteLength(name) > 1024) throw new Error("Session worker name must contain1 through1024 bytes");
			const limit = agentOsSetting("OPENORANGE_AGENTOS_MAX_SESSION_WORKERS", 128);
			if (!broker.workers.has(name)) {
				if (broker.workers.size >= limit) throw new Error(`OpenOrange agentOS session Worker limit ${limit} reached; raise OPENORANGE_AGENTOS_MAX_SESSION_WORKERS`);
				if (broker.workers.size + 1 >= limit * 0.8) process.stderr.write(`WARN_OPENORANGE_AGENTOS_SESSION_WORKERS_NEAR_LIMIT: ${broker.workers.size + 1}/${limit}; raise OPENORANGE_AGENTOS_MAX_SESSION_WORKERS\n`);
			}
			broker.workers.set(name, { owner, connect }); names.add(name);
			return () => unpublish(name);
		},
		async release() {
			if (released) return; released = true;
			for (const name of names) unpublish(name);
			if (--broker.users) return;
			broker.closing = (async () => {
				try {
					for (const socket of broker.sockets) socket.destroy();
					await new Promise<void>((resolve, reject) => broker.server.close(error => error ? reject(error) : resolve()));
				} finally { if (brokers.get(token) === pending) brokers.delete(token); }
			})();
			await broker.closing;
		},
	};
}
