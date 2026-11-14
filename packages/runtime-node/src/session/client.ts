import { Buffer } from "node:buffer";
import { request as httpRequest } from "node:http";
import { connect as netConnect } from "node:net";
import type { Duplex } from "node:stream";

import { fetch as undiciFetch } from "undici";

import {
	durableObjectRequestHead,
	durableObjectTransportRequestHeaders,
	readDurableObjectResponseHead,
} from "../bindings/durable-objects/transport-head.js";
import { createDurableObjectRpcPromise, createLazyDurableObjectRpcProperty } from "../bindings/durable-objects/rpc/promise.js";
import { callDurableObjectRpc } from "../bindings/durable-objects/rpc/session.js";
import type { ServiceStubBackend } from "../bindings/service.js";
import { Headers, Request, requestBodyLength, Response } from "../globals/http.js";
import { connectNetworkWebSocket } from "../internal/network-websockets.js";
import { waitForOutputGate } from "../internal/output-gate.js";
import { connectInProcess, type Socket, type SocketAddress, type SocketOptions } from "../modules/cloudflare-sockets/socket.js";
import {
	connectTunnelProtocol,
	encodeServiceTarget,
	pipeSocketToTunnel,
	serviceTargetHeader,
	sessionRoutes,
	sessionTokenHeader,
} from "./wire.js";
import { workerNotFoundMessage, type ReachableSessionWorker, type SessionWorkers } from "./workers.js";

export interface RemoteServiceOptions {
	entrypoint: string;
	// What a call to a Worker that is not running gets. A service binding
	// follows Wrangler's dev registry. A dispatch namespace follows Cloudflare.
	missing: "dispatch-namespace" | "service";
	service: string;
	workers: SessionWorkers;
}

function missingError(options: RemoteServiceOptions): Error {
	// https://github.com/cloudflare/cloudflare-docs/blob/371d22407a908dd996b81e83bce20d7493e2de70/src/content/docs/cloudflare-for-platforms/workers-for-platforms/configuration/dynamic-dispatch.mdx#L300-L309
	return new Error(
		options.missing === "dispatch-namespace"
			? `Worker not found. Worker "${options.service}" is not running in this orange dev session.`
			: workerNotFoundMessage(options.service),
	);
}

function origin(worker: ReachableSessionWorker): string {
	const { host, port } = worker.internalAddress;
	return `http://${host.includes(":") ? `[${host}]` : host}:${port}`;
}

function callHeaders(
	options: RemoteServiceOptions,
	props: unknown,
): Record<string, string> {
	return {
		[serviceTargetHeader]: encodeServiceTarget({
			worker: options.service,
			entrypoint: options.entrypoint,
			...(props === undefined ? {} : { props }),
		}),
		[sessionTokenHeader]: options.workers.token,
	};
}

async function remoteFetch(
	options: RemoteServiceOptions,
	request: Request,
	props: unknown,
): Promise<Response> {
	const worker = options.workers.reachable(options.service);
	if (worker === undefined) {
		if (options.missing === "dispatch-namespace") throw missingError(options);
		return new Response(workerNotFoundMessage(options.service), { status: 503 });
	}
	if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
		throw new Error(
			`OpenOrange does not yet forward WebSocket upgrades through a service binding to Worker "${options.service}". Connect to that Worker's own URL instead.`,
		);
	}
	const url = new URL(sessionRoutes.fetch, origin(worker));
	url.searchParams.set("url", request.url);
	const head = durableObjectRequestHead(request);
	// Workerd sends a stream's declared expectedLength as Content-Length.
	const bodyLength = requestBodyLength(request);
	if (bodyLength !== undefined && !request.headers.has("content-length")) {
		head.headers.push(["content-length", String(bodyLength)]);
	}
	const headers: Record<string, string> = { ...callHeaders(options, props) };
	for (const [name, value] of durableObjectTransportRequestHeaders(head)) headers[name] = value;
	const response = await undiciFetch(url, {
		body: request.body,
		headers,
		method: request.body === null ? "GET" : "POST",
		redirect: "manual",
		signal: request.signal,
		...(request.body === null ? {} : { duplex: "half" }),
	});
	const responseHead = readDurableObjectResponseHead(response);
	if (responseHead === undefined) {
		throw new Error(await response.text());
	}
	return new Response(response.body, {
		headers: new Headers(responseHead.headers),
		status: response.status,
		statusText: responseHead.statusText,
	});
}

// An RPC call to another Worker's entrypoint. It uses the Durable Object RPC
// transport, so values, stubs, streams, and errors cross like they do for a
// Durable Object in another process. Unlike a Durable Object stub, a failed
// call does not break the service stub.
function startRemoteCall(
	options: RemoteServiceOptions,
	props: unknown,
	methodName: string,
	args: readonly unknown[],
	operation: "call" | "get",
): object {
	const abortController = new AbortController();
	const result = (async () => {
		await waitForOutputGate();
		const worker = options.workers.reachable(options.service);
		if (worker === undefined) throw missingError(options);
		const base = origin(worker);
		const headers = callHeaders(options, props);
		return await callDurableObjectRpc(
			{ args: [...args], methodName, operation },
			{
				connector: {
					async open(continuation) {
						const url = new URL(sessionRoutes.rpc, base.replace(/^http/, "ws"));
						if (continuation !== undefined) url.searchParams.set("continuation", continuation.token);
						const connection = await connectNetworkWebSocket(url.href, { headers, protocols: [] });
						if (connection.kind === "rejected") {
							connection.response.resume();
							throw new Error(
								`Service RPC session to Worker "${options.service}" failed with status ${connection.response.statusCode}`,
							);
						}
						const webSocket = connection.webSocket;
						webSocket.binaryType = "arraybuffer";
						return {
							release(): void {
								if (webSocket.readyState < 2) webSocket.close(1000, "Service RPC complete");
							},
							webSocket,
						};
					},
				},
				endpoint: `${base}${sessionRoutes.rpc}`,
				fetch: async (request) =>
					await undiciFetch(`${base}${sessionRoutes.rpc}`, {
						body: await request.text(),
						headers,
						method: "POST",
						signal: abortController.signal,
					}),
				signal: abortController.signal,
			},
		);
	})();
	return createDurableObjectRpcPromise(result, abortController);
}

function remoteRoot(options: RemoteServiceOptions, props: unknown): object {
	return new Proxy(
		{},
		{
			get(_target, property): unknown {
				if (typeof property !== "string" || property === "then") return undefined;
				if (property === "dup") return () => remoteRoot(options, props);
				return createLazyDurableObjectRpcProperty(
					() => startRemoteCall(options, props, property, [], "get"),
					(args) => startRemoteCall(options, props, property, args, "call"),
				);
			},
		},
	);
}

// A raw tunnel to the callee's handler, so TCP half-close and backpressure carry over unframed.
function openConnectTunnel(worker: ReachableSessionWorker, headers: Record<string, string>): Promise<Duplex> {
	const { host, port } = worker.internalAddress;
	return new Promise((resolveTunnel, rejectTunnel) => {
		const request = httpRequest({
			// A caller may keep writing after the callee finishes, so this side doesn't end with it.
			createConnection: () => netConnect({ allowHalfOpen: true, host, port }),
			headers: { ...headers, connection: "upgrade", upgrade: connectTunnelProtocol },
			path: sessionRoutes.connect,
		});
		request.once("upgrade", (_response, socket, head) => {
			if (head.byteLength > 0) socket.unshift(head);
			resolveTunnel(socket);
		});
		request.once("response", (response) => {
			const chunks: Buffer[] = [];
			response.on("data", (chunk: Buffer) => chunks.push(chunk));
			response.once("end", () => rejectTunnel(new Error(Buffer.concat(chunks).toString("utf8"))));
		});
		request.once("error", rejectTunnel);
		request.end();
	});
}

function connectRemote(
	options: RemoteServiceOptions,
	address: string | SocketAddress,
	socketOptions: SocketOptions | undefined,
	props: unknown,
): Socket {
	const outputLock = waitForOutputGate();
	return connectInProcess(address, socketOptions, async (accept) => {
		await outputLock;
		const worker = options.workers.reachable(options.service);
		if (worker === undefined) throw missingError(options);
		const tunnel = await openConnectTunnel(worker, {
			[serviceTargetHeader]: encodeServiceTarget({
				worker: options.service,
				address,
				entrypoint: options.entrypoint,
				...(props === undefined ? {} : { props }),
				...(socketOptions === undefined ? {} : { socketOptions }),
			}),
			[sessionTokenHeader]: options.workers.token,
		});
		await pipeSocketToTunnel(accept(), tunnel, socketOptions?.allowHalfOpen !== true);
	});
}

export function remoteServiceBackend(options: RemoteServiceOptions): ServiceStubBackend {
	return {
		connect: (address, socketOptions, props) => connectRemote(options, address, socketOptions, props),
		fetch: (request, props) => remoteFetch(options, request, props),
		root: (props) => remoteRoot(options, props),
	};
}
