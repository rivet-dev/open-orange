import { startOutboundWork } from "../../internal/outbound-work.js";
import { portableRivetPackage } from "../../internal/portable-rivet.js";
import {
	type RivetActorHandle,
	type RivetWebSocket,
} from "../../internal/rivetkit.js";
import {
	Headers as OrangeHeaders,
	Response as OrangeResponse,
} from "../../globals/http.js";
import {
	coupleWebSocket,
	WebSocket,
	WebSocketPair,
} from "../../globals/websocket.js";
import type { DurableObjectGeneration } from "./state.js";
import {
	requireDurableObjectStubOrder,
	type DurableObjectStubOrder,
} from "./ordering.js";
import { durableObjectPrivateRoutes } from "./routes.js";
import {
	durableObjectRequestHead,
	durableObjectTransportResponseHeaders,
	type HeaderEntries,
	headerEntries,
	readDurableObjectCf,
	readDurableObjectResponseHead,
} from "./transport-head.js";
import {
	createDurableObjectClientWebSocketTransport,
	DurableObjectActorWebSocketTransport,
	type DurableObjectWebSocketClientClose,
} from "./websocket-transport.js";
import { isRecord } from "../unknown-values.js";

const webSocketUpgradeTokenParameter = "token";

interface WebSocketPreparationEnvelope {
	cf?: unknown;
	headers: HeaderEntries;
	method: string;
	order: DurableObjectStubOrder;
	url: string;
}

interface WebSocketPreparationResult {
	disconnectFrameVersion?: 1;
	headers: HeaderEntries;
	statusText: string;
	token: string;
}

interface WebSocketDisconnectEnvelope {
	close?: DurableObjectWebSocketClientClose;
	token: string;
}

function requirePreparationEnvelope(value: unknown): WebSocketPreparationEnvelope {
	if (!isRecord(value)) {
		throw new TypeError("Durable Object WebSocket preparation is invalid");
	}
	if (typeof value.url !== "string" || typeof value.method !== "string") {
		throw new TypeError("Durable Object WebSocket request metadata is invalid");
	}
	const cf = readDurableObjectCf(value.cf);
	return {
		...(cf === undefined ? {} : { cf }),
		headers: headerEntries(value.headers),
		method: value.method,
		order: requireDurableObjectStubOrder(value.order),
		url: value.url,
	};
}

function requirePreparationResult(value: unknown): WebSocketPreparationResult {
	if (
		!isRecord(value) ||
		typeof value.statusText !== "string" ||
		typeof value.token !== "string" ||
		value.token.length === 0
	) {
		throw new TypeError("Durable Object WebSocket preparation response is invalid");
	}
	return {
		headers: headerEntries(value.headers),
		statusText: value.statusText,
		token: value.token,
		...(value.disconnectFrameVersion === 1 ? { disconnectFrameVersion: 1 as const } : {}),
	};
}

function requireDisconnectEnvelope(value: unknown): WebSocketDisconnectEnvelope {
	if (!isRecord(value) || typeof value.token !== "string" || value.token.length === 0) {
		throw new TypeError("Durable Object WebSocket disconnect is invalid");
	}
	const close = value.close;
	if (close === undefined) return { token: value.token };
	if (
		!isRecord(close) ||
		typeof close.code !== "number" ||
		!Number.isInteger(close.code) ||
		typeof close.reason !== "string"
	) {
		throw new TypeError("Durable Object WebSocket close is invalid");
	}
	return { close: { code: close.code, reason: close.reason }, token: value.token };
}

function disconnectRequest(
	token: string,
	close?: DurableObjectWebSocketClientClose,
): Request {
	const envelope: WebSocketDisconnectEnvelope =
		close === undefined ? { token } : { close, token };
	return new Request(
		new URL(durableObjectPrivateRoutes.webSocketDisconnect, "http://actor"),
		{
			body: JSON.stringify(envelope),
			headers: { "content-type": "application/json" },
			method: "POST",
		},
	);
}

function preparationRequest(
	request: Request,
	order: DurableObjectStubOrder,
	signal: AbortSignal,
): Request {
	if (request.body !== null) {
		throw new TypeError("A WebSocket upgrade request cannot have a body");
	}
	const endpoint = new URL(
		durableObjectPrivateRoutes.webSocketPrepare,
		"http://actor",
	);
	// Rivet's raw actor WebSocket API accepts a path and protocols but no request
	// headers, and the protocol parameter is currently ignored. Prepare the
	// application handshake over private HTTP and claim it once with an opaque
	// token so headers never enter the WebSocket URL or logs.
	// https://github.com/rivet-dev/actors/blob/3848076c011ad2f881bca9821e4d5c725aa9f15e/rivetkit-typescript/packages/rivetkit/src/client/actor-handle.ts#L861-L883
	// https://github.com/rivet-dev/actors/blob/3848076c011ad2f881bca9821e4d5c725aa9f15e/rivetkit-typescript/packages/rivetkit/src/client/raw-utils.ts#L113-L158
	const { cf, headers, method } = durableObjectRequestHead(request);
	const envelope: WebSocketPreparationEnvelope = {
		...(cf === undefined ? {} : { cf }),
		headers,
		method,
		order,
		url: request.url,
	};
	return new Request(endpoint, {
		body: JSON.stringify(envelope),
		headers: { "content-type": "application/json" },
		method: "POST",
		signal: AbortSignal.any([request.signal, signal]),
	});
}

export function isWebSocketUpgradeRequest(request: Request): boolean {
	return request.headers.get("upgrade")?.toLowerCase() === "websocket";
}

export async function fetchDurableObjectWebSocketStub(
	handle: () => RivetActorHandle,
	request: Request,
	order: DurableObjectStubOrder,
	signal: AbortSignal,
): Promise<OrangeResponse> {
	const actor = handle();
	const preparedResponse = await actor.fetch(preparationRequest(request, order, signal));
	// Only a rejected upgrade carries the object's own response head.
	const rejected = readDurableObjectResponseHead(preparedResponse);
	if (rejected !== undefined) {
		return new OrangeResponse(preparedResponse.body, {
			headers: new OrangeHeaders(rejected.headers),
			status: preparedResponse.status,
			statusText: rejected.statusText,
		});
	}
	if (!preparedResponse.ok) {
		throw new Error(
			`Durable Object WebSocket preparation failed with status ${preparedResponse.status}: ${await preparedResponse.text()}`,
		);
	}
	const preparedPayload: unknown = await preparedResponse.json();
	const prepared = requirePreparationResult(preparedPayload);
	const token = prepared.token;
	const path = new URL(durableObjectPrivateRoutes.webSocket, "http://actor");
	path.searchParams.set(webSocketUpgradeTokenParameter, token);
	const transport = await actor.webSocket(`${path.pathname}${path.search}`);
	// A WebSocket that one object opens to another keeps the first one running while it is open.
	const ended = startOutboundWork("outbound-websocket");
	if (ended !== undefined) transport.addEventListener("close", ended);
	const pair = new WebSocketPair();
	try {
		coupleWebSocket(
			pair[1],
			createDurableObjectClientWebSocketTransport(
				transport,
				async (close) => {
					const response = await actor.fetch(disconnectRequest(token, close));
					if (!response.ok) {
						throw new Error(
							`Durable Object WebSocket disconnect failed with status ${response.status}`,
						);
					}
				},
				prepared.disconnectFrameVersion === 1 ? token : undefined,
			),
		);
	} catch (error) {
		if (transport.readyState < WebSocket.READY_STATE_CLOSING) {
			transport.close(1011, "Durable Object WebSocket coupling failed");
		}
		throw error;
	}
	return new OrangeResponse(null, {
		headers: new OrangeHeaders(prepared.headers),
		status: 101,
		statusText: prepared.statusText,
		webSocket: pair[0],
	});
}

export async function disconnectDurableObjectWebSocket(
	generation: DurableObjectGeneration,
	request: Request,
): Promise<Response> {
	const payload: unknown = await request.json();
	const { close, token } = requireDisconnectEnvelope(payload);
	const delivered =
		close === undefined
			? await generation.webSocketHost.receiveDisconnect(token)
			: await generation.webSocketHost.receiveClientClose(token, close);
	return new Response(null, { status: delivered ? 204 : 404 });
}

export async function prepareDurableObjectWebSocket(
	generation: DurableObjectGeneration,
	request: Request,
): Promise<OrangeResponse> {
	const preparedPayload: unknown = await request.json();
	const prepared = requirePreparationEnvelope(preparedPayload);
	return await generation.orderCoordinator.run(prepared.order, async () => {
		return await generation.stateController.runEvent(async () => {
			const handler: unknown = Reflect.get(generation.instance, "fetch");
			if (typeof handler !== "function") {
				// workerd's errors for a missing handler and a non-Response result.
				throw new Error("Handler does not export a fetch() function.");
			}
			const init: RequestInit = {
				headers: prepared.headers,
				method: prepared.method,
			};
			if (prepared.cf !== undefined) Reflect.set(init, "cf", prepared.cf);
			const result: unknown = await Reflect.apply(handler, generation.instance, [
				new Request(prepared.url, init),
			]);
			if (!(result instanceof OrangeResponse)) {
				throw new TypeError(
					"Incorrect type for Promise: the Promise did not resolve to 'Response'.",
				);
			}
			if (result.status !== 101 || result.webSocket === null) {
				return new OrangeResponse(result.body, {
					headers: durableObjectTransportResponseHeaders(
						result.headers,
						result.statusText,
					),
					status: result.status,
					statusText: result.statusText,
				});
			}
			return OrangeResponse.json({
				...generation.webSocketUpgrades.retain(result),
				// The WASM registry uses the paired Rust remote backend's ordered Close.
				// Ordinary Node retains its pinned Engine and existing HTTP notification.
				...(portableRivetPackage() === undefined ? {} : { disconnectFrameVersion: 1 }),
			});
		});
	});
}

export function attachDurableObjectWebSocket(
	generation: DurableObjectGeneration,
	request: Request,
	transport: RivetWebSocket,
	keepAwake?: (promise: Promise<void>) => void,
): void {
	const token = new URL(request.url).searchParams.get(
		webSocketUpgradeTokenParameter,
	);
	if (token === null) {
		transport.close(1008, "Durable Object WebSocket token is missing");
		return;
	}
	try {
		const socket = generation.webSocketUpgrades.claim(token);
		const userSocket = generation.hibernatableWebSockets.getUserSocket(socket);
		const actorTransport = new DurableObjectActorWebSocketTransport(transport, token);
		const host = generation.webSocketHost;
		host.trackClientClose(token, actorTransport);
		if (userSocket === undefined) {
			coupleWebSocket(socket, actorTransport);
			// A standard socket keeps its object running while it is open, as an open request does in
			// workerd.
			if (transport.readyState < WebSocket.READY_STATE_CLOSING) {
				generation.hibernationLifecycle.preventSleepUntil(actorTransport.closed, "standard-websocket");
			}
		} else {
			// An accepted socket outlives this object, which can hibernate while the socket is open.
			host.adopt(generation, socket, userSocket, actorTransport);
		}
		host.bindIdleTimeout(generation);
		// Rivet has no WebSocket hibernation, so the actor stays awake while any socket is open. A
		// lifecycle task doesn't delay the connection callback.
		if (transport.readyState < WebSocket.READY_STATE_CLOSING) {
			keepAwake?.(actorTransport.closed);
		}
	} catch (error) {
		if (transport.readyState < WebSocket.READY_STATE_CLOSING) {
			transport.close(
				1008,
				error instanceof Error ? error.message : "WebSocket claim failed",
			);
		}
	}
}
