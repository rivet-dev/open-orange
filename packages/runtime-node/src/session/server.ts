import { Buffer } from "node:buffer";
import { readerOf } from "../internal/stream-methods.js";
import { timingSafeEqual } from "node:crypto";
import {
	createServer,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
import type { Duplex } from "node:stream";

import {
	connectEntrypoint,
	fetchEntrypoint,
	invokeEntrypointMethod,
	type LoopbackServices,
} from "../bindings/service.js";
import { DurableObjectRpcContinuationStore } from "../bindings/durable-objects/rpc/continuations.js";
import {
	DurableObjectRpcHttpTarget,
	handleDurableObjectRpcHttp,
} from "../bindings/durable-objects/rpc/http.js";
import { DurableObjectRpcSessionTarget } from "../bindings/durable-objects/rpc/session.js";
import { attachDurableObjectRpcSessionWebSocket } from "../bindings/durable-objects/rpc/websocket.js";
import { readDurableObjectRequestHead } from "../bindings/durable-objects/transport-head.js";
import { bodyChunkBytes, Headers, Request, type RequestInit } from "../globals/http.js";
import type { Response } from "../globals/http.js";
import {
	closeUncoupledWorkerWebSocket,
	NetworkWebSocketUpgrades,
	writeRejectedUpgrade,
	writeUpgradeFailure,
} from "../internal/network-websockets.js";
import type { RuntimeInternalAddress } from "../process-protocol.js";
import {
	readServiceTarget,
	serviceResponseHeadHeaders,
	serviceTargetHeader,
	connectTunnelProtocol,
	pipeSocketToTunnel,
	sessionRoutes,
	sessionTokenHeader,
	type ServiceTarget,
} from "./wire.js";

export interface SessionServer {
	readonly address: RuntimeInternalAddress;
	close(): Promise<void>;
}

export interface StartSessionServerOptions {
	host: string;
	reportError(error: unknown): void;
	services: LoopbackServices;
	token: string;
}

function headerValue(incoming: IncomingMessage, name: string): string | undefined {
	const value = incoming.headers[name];
	return typeof value === "string" ? value : undefined;
}

function authorized(incoming: IncomingMessage, token: string): boolean {
	const received = Buffer.from(headerValue(incoming, sessionTokenHeader) ?? "");
	const expected = Buffer.from(token);
	return received.byteLength === expected.byteLength && timingSafeEqual(received, expected);
}

function incomingHeaders(incoming: IncomingMessage): Headers {
	const headers = new Headers();
	for (const [name, value] of Object.entries(incoming.headers)) {
		for (const entry of Array.isArray(value) ? value : value === undefined ? [] : [value]) {
			headers.append(name, entry);
		}
	}
	return headers;
}

function incomingBody(incoming: IncomingMessage): ReadableStream<Uint8Array> {
	const iterator: AsyncIterator<unknown> = incoming.iterator({ destroyOnReturn: false });
	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			const result = await iterator.next();
			if (result.done === true) controller.close();
			else controller.enqueue(bodyChunkBytes(result.value));
		},
		cancel() {
			incoming.resume();
		},
	});
}

// Rebuilds the caller's request from the head it sent, as a Durable Object
// receives one from its stub.
function callerRequest(
	incoming: IncomingMessage,
	signal: AbortSignal | undefined,
	upgrade: boolean,
): Request {
	const url = new URL(incoming.url ?? "/", "http://session").searchParams.get("url");
	if (url === null) throw new TypeError("Service request is missing its original URL");
	const head = readDurableObjectRequestHead(
		new Request("http://session/", { headers: incomingHeaders(incoming) }),
	);
	const init: RequestInit = {
		body: head.body && !upgrade ? incomingBody(incoming) : null,
		headers: head.headers,
		method: head.method,
		// As on workerd, the callee gets redirect "manual", whatever the caller's request had.
		// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/global-scope.c%2B%2B#L355-L357
		redirect: "manual",
		...(signal === undefined ? {} : { signal }),
	};
	if (init.body !== null) Reflect.set(init, "duplex", "half");
	if (head.cf !== undefined) Reflect.set(init, "cf", head.cf);
	return new Request(url, init);
}

async function writeBody(
	outgoing: ServerResponse,
	body: ReadableStream<Uint8Array> | null,
): Promise<void> {
	if (body === null) {
		outgoing.end();
		return;
	}
	const reader = readerOf(body);
	let completed = false;
	const onClose = (): void => {
		if (!completed) void reader.cancel("Service caller disconnected");
	};
	outgoing.once("close", onClose);
	try {
		for (;;) {
			const result = await reader.read();
			if (result.done) break;
			const bytes = bodyChunkBytes(result.value);
			if (bytes.byteLength === 0) continue;
			if (!outgoing.write(bytes)) {
				const writable = await new Promise<boolean>((resolveWritable) => {
					const done = (value: boolean) => () => {
						outgoing.off("close", closed);
						outgoing.off("drain", drained);
						resolveWritable(value);
					};
					const closed = done(false);
					const drained = done(true);
					outgoing.once("close", closed);
					outgoing.once("drain", drained);
				});
				if (!writable) return;
			}
		}
		completed = true;
		outgoing.end();
	} finally {
		outgoing.off("close", onClose);
		reader.releaseLock();
	}
}

interface RpcCall {
	readonly args: readonly unknown[] | undefined;
	readonly methodName: string;
}

// The stub sends Durable Object RPC calls, so its call order is ignored here:
// calls to a stateless entrypoint have no order.
function requireRpcCall(value: unknown): RpcCall {
	if (typeof value !== "object" || value === null) {
		throw new TypeError("Service RPC call must be an object");
	}
	const methodName: unknown = Reflect.get(value, "methodName");
	const args: unknown = Reflect.get(value, "args");
	const operation: unknown = Reflect.get(value, "operation");
	if (typeof methodName !== "string" || methodName.length === 0 || !Array.isArray(args)) {
		throw new TypeError("Service RPC call is invalid");
	}
	if (operation !== "call" && operation !== "get") {
		throw new TypeError("Service RPC operation is invalid");
	}
	return { args: operation === "get" ? undefined : args, methodName };
}

// Serves calls from the other Workers of the session to this Worker's
// entrypoints. It listens on loopback and accepts only the session's token.
export async function startSessionServer(
	options: StartSessionServerOptions,
): Promise<SessionServer> {
	const { services } = options;
	const continuations = new DurableObjectRpcContinuationStore();
	const upgrades = new NetworkWebSocketUpgrades();
	const rpcHandler = (target: ServiceTarget) => (value: unknown) => {
		const call = requireRpcCall(value);
		return invokeEntrypointMethod(
			services,
			target.entrypoint,
			target.props,
			call.methodName,
			call.args,
		);
	};

	const server = createServer((incoming, outgoing) => {
		void (async () => {
			try {
				if (!authorized(incoming, options.token)) {
					outgoing.statusCode = 403;
					outgoing.end();
					return;
				}
				const target = readServiceTarget(headerValue(incoming, serviceTargetHeader));
				const path = new URL(incoming.url ?? "/", "http://session").pathname;
				if (path === sessionRoutes.fetch) {
					const abort = new AbortController();
					incoming.once("aborted", () => abort.abort());
					outgoing.once("close", () => {
						if (!outgoing.writableEnded) abort.abort();
					});
					const response = await fetchEntrypoint(
						services,
						target.entrypoint,
						target.props,
						callerRequest(incoming, abort.signal, false),
					);
					outgoing.statusCode = response.status;
					for (const [name, value] of serviceResponseHeadHeaders(response)) {
						outgoing.setHeader(name, value);
					}
					await writeBody(outgoing, response.body);
					return;
				}
				if (path === sessionRoutes.rpc) {
					const rpcRequest = new Request("http://session/rpc", {
						body: incomingBody(incoming),
						method: "POST",
					});
					const response = await handleDurableObjectRpcHttp(
						// SAFETY: The runtime Request implements the Fetch Request members that the RPC
						// handler reads, but its class does not declare lib.dom-only members such as `mode`.
						rpcRequest as unknown as globalThis.Request,
						new DurableObjectRpcHttpTarget(rpcHandler(target), { continuations }),
					);
					outgoing.statusCode = response.status;
					response.headers.forEach((value, name) => outgoing.setHeader(name, value));
					await writeBody(outgoing, response.body);
					return;
				}
				outgoing.statusCode = 404;
				outgoing.end();
			} catch (error: unknown) {
				options.reportError(error);
				if (!outgoing.headersSent) {
					outgoing.statusCode = 500;
					outgoing.end(error instanceof Error ? error.message : String(error));
				} else {
					outgoing.destroy();
				}
			}
		})();
	});

	server.on("upgrade", (incoming: IncomingMessage, socket: Duplex, head: Buffer) => {
		void (async () => {
			let workerResponse: Response | undefined;
			try {
				if (!authorized(incoming, options.token)) {
					socket.end("HTTP/1.1 403 Forbidden\r\nconnection: close\r\ncontent-length: 0\r\n\r\n");
					return;
				}
				const target = readServiceTarget(headerValue(incoming, serviceTargetHeader));
				const url = new URL(incoming.url ?? "/", "http://session");
				if (url.pathname === sessionRoutes.fetch) {
					workerResponse = await fetchEntrypoint(
						services,
						target.entrypoint,
						target.props,
						callerRequest(incoming, undefined, true),
					);
					if (workerResponse.status !== 101 || workerResponse.webSocket === null) {
						await writeRejectedUpgrade(socket, workerResponse, serviceResponseHeadHeaders(workerResponse));
						return;
					}
					upgrades.coupleResponse(
						incoming,
						socket,
						head,
						workerResponse,
						workerResponse.webSocket,
						options.reportError,
					);
					return;
				}
				if (url.pathname === sessionRoutes.connect) {
					const peer = connectEntrypoint(
						services,
						target.entrypoint,
						target.props,
						target.address ?? "",
						target.socketOptions,
					);
					try {
						await peer.opened;
					} catch (error: unknown) {
						const message = Buffer.from(error instanceof Error ? error.message : String(error));
						socket.end(
							`HTTP/1.1 502 Bad Gateway\r\nconnection: close\r\ncontent-length: ${message.byteLength}\r\n\r\n${message.toString()}`,
						);
						return;
					}
					socket.write(`HTTP/1.1 101 Switching Protocols\r\nconnection: upgrade\r\nupgrade: ${connectTunnelProtocol}\r\n\r\n`);
					if (head.byteLength > 0) socket.unshift(head);
					await pipeSocketToTunnel(peer, socket).catch((error: unknown) => options.reportError(error));
					return;
				}
				if (url.pathname === sessionRoutes.rpc) {
					const webSocket = await upgrades.accept(incoming, socket, head);
					webSocket.binaryType = "arraybuffer";
					const token = url.searchParams.get("continuation");
					await attachDurableObjectRpcSessionWebSocket(
						webSocket,
						new DurableObjectRpcSessionTarget(
							rpcHandler(target),
							continuations,
							token === null ? undefined : { expiresAt: 0, token },
						),
					);
					return;
				}
				socket.end("HTTP/1.1 404 Not Found\r\nconnection: close\r\ncontent-length: 0\r\n\r\n");
			} catch (error: unknown) {
				if (workerResponse?.webSocket != null) closeUncoupledWorkerWebSocket(workerResponse.webSocket);
				options.reportError(error);
				writeUpgradeFailure(socket);
			}
		})();
	});

	await new Promise<void>((resolveListen, rejectListen) => {
		server.once("error", rejectListen);
		server.listen(0, options.host, () => {
			server.off("error", rejectListen);
			resolveListen();
		});
	});
	const address = server.address();
	if (address === null || typeof address === "string") {
		throw new Error("Session server did not expose a TCP address");
	}
	return {
		address: { host: options.host, port: address.port },
		async close(): Promise<void> {
			server.closeAllConnections();
			await Promise.all([
				new Promise<void>((resolveClose) => server.close(() => resolveClose())),
				upgrades.close(),
			]);
		},
	};
}
