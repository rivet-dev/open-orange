import type { RivetActorHandle } from "../../internal/rivetkit.js";
import { fetchAdmittedDurableObjectCall } from "./admission.js";
import { encodeBody, outgoingBodyCoding } from "../../globals/content-encoding.js";
import { durableObjectPrivateRoutes } from "./routes.js";
import {
	deserializeThrownFetchError,
	markDurableObjectResetRpcError,
	serializeThrownFetchError,
} from "./rpc/codec.js";
import type { DurableObjectGeneration } from "./state.js";
import {
	requireDurableObjectStubOrder,
	type DurableObjectStubOrder,
} from "./ordering.js";
import {
	durableObjectRequestHead,
	durableObjectTransportRequestHeaders,
	durableObjectTransportResponseHeaders,
	openOrangeInternalHeaderPrefix,
	readDurableObjectRequestHead,
	readDurableObjectResponseHead,
} from "./transport-head.js";
import {
	fetchDurableObjectWebSocketStub,
	isWebSocketUpgradeRequest,
} from "./websocket.js";

const durableObjectFetchUrlParameter = "url";
const durableObjectFetchOrderKeyParameter = "order";
const durableObjectFetchOrderSequenceParameter = "sequence";
const durableObjectFetchOrderFloorParameter = "floor";
const thrownErrorHeader = `${openOrangeInternalHeaderPrefix}durable-object-thrown`;

// RequestInit is a WebIDL dictionary, so its members are read as properties,
// including getters inherited from a prototype. A Request passed as init, as in
// `stub.fetch(url, request)`, keeps its method, headers, and body this way. A
// spread would copy only own properties and drop them.
// https://webidl.spec.whatwg.org/#js-dictionary
const requestInitMembers = [
	"body",
	"cache",
	"cf",
	"encodeResponseBody",
	"fetcher",
	"headers",
	"integrity",
	"method",
	"redirect",
	"signal",
] as const;

function copyRequestInit(init: RequestInit): RequestInit {
	const copy: RequestInit = {};
	for (const member of requestInitMembers) {
		const value: unknown = Reflect.get(init, member);
		if (value !== undefined) Reflect.set(copy, member, value);
	}
	return copy;
}

function constructRequest(
	input: Request | string | URL,
	init?: RequestInit,
): Request {
	let constructorInit: RequestInit | undefined = init;
	if (init?.body !== undefined && init.body !== null) {
		constructorInit = copyRequestInit(init);
		Reflect.set(constructorInit, "duplex", "half");
	}
	return new Request(input, constructorInit);
}

function requestWithBody(
	url: string | URL,
	request: Request,
	init: RequestInit,
): Request {
	const requestInit: RequestInit = {
		body: request.body,
		method: request.method,
		redirect: request.redirect,
		signal: request.signal,
		...init,
	};
	if (requestInit.body !== null) {
		Reflect.set(requestInit, "duplex", "half");
	}
	return new Request(url, requestInit);
}

export function prepareDurableObjectFetch(
	input: Request | string | URL,
	init?: RequestInit,
): Request {
	// Like workerd's Fetcher, construct the request before starting I/O. This
	// validates the initializer and disturbs a transferred Request body at the
	// call boundary instead of after actor resolution.
	// https://github.com/cloudflare/workerd/blob/fb814ad10ea778820b5e24b82f21edfb8c0f6556/src/workerd/api/http.c%2B%2B#L2297-L2367
	return constructRequest(input, init);
}

export async function fetchDurableObjectStub(
	handle: () => RivetActorHandle,
	request: Request,
	order: DurableObjectStubOrder,
	signal: AbortSignal,
): Promise<Response> {
	if (isWebSocketUpgradeRequest(request)) {
		return await fetchDurableObjectWebSocketStub(
			handle,
			request,
			order,
			signal,
		);
	}
	const endpoint = new URL(durableObjectPrivateRoutes.fetch, "http://actor");
	endpoint.searchParams.set(durableObjectFetchUrlParameter, request.url);
	endpoint.searchParams.set(durableObjectFetchOrderKeyParameter, order.key);
	endpoint.searchParams.set(
		durableObjectFetchOrderSequenceParameter,
		String(order.sequence),
	);
	endpoint.searchParams.set(durableObjectFetchOrderFloorParameter, String(order.floor ?? 0));
	// Keep the body as a stream across RivetKit's actor HTTP client boundary;
	// Orange must not introduce a whole-body copy before actor dispatch.
	// https://github.com/rivet-dev/actors/blob/527e186c6f643d2c64021ee8fcba5233c04905b1/rivetkit-typescript/packages/rivetkit/src/engine-client/actor-http-client.ts#L14-L44
	const callerSignal = AbortSignal.any([request.signal, signal]);
	const transportRequest = requestWithBody(endpoint, request, {
		headers: durableObjectTransportRequestHeaders(
			durableObjectRequestHead(request),
		),
		// The gateway answers OPTIONS itself, so the real method travels in the head.
		method: request.method === "OPTIONS" ? "POST" : request.method,
		signal: callerSignal,
	});
	// A fetch without a body that reaches a generation that ctx.abort() retired goes out again, to
	// the next one, as a call after abort() reaches a new instance in workerd.
	const response =
		transportRequest.body === null
			? await fetchAdmittedDurableObjectCall(handle(), transportRequest)
			: await handle().fetch(transportRequest);
	if (response.headers.has(thrownErrorHeader)) {
		const error = deserializeThrownFetchError(await response.text());
		// An error the object threw because the caller aborted is the caller's own
		// abort, which breaks the stub.
		callerSignal.throwIfAborted();
		Reflect.set(error, "remote", true);
		throw error;
	}
	const head = readDurableObjectResponseHead(response);
	if (head === undefined) return response;
	return new Response(response.body, {
		headers: head.headers,
		status: response.status,
		statusText: head.statusText,
	});
}

function readDurableObjectFetchOrder(url: URL): DurableObjectStubOrder {
	const key = url.searchParams.get(durableObjectFetchOrderKeyParameter);
	const sequence = url.searchParams.get(
		durableObjectFetchOrderSequenceParameter,
	);
	const floor = url.searchParams.get(durableObjectFetchOrderFloorParameter);
	return requireDurableObjectStubOrder({
		floor: floor === null ? undefined : Number(floor),
		key,
		sequence: sequence === null ? undefined : Number(sequence),
	});
}

export async function handleDurableObjectFetch(
	generation: DurableObjectGeneration,
	request: Request,
): Promise<Response> {
	const privateUrl = new URL(request.url);
	const url = privateUrl.searchParams.get(durableObjectFetchUrlParameter);
	if (url === null) {
		throw new TypeError("Durable Object fetch request is missing its original URL");
	}
	const order = readDurableObjectFetchOrder(privateUrl);
	const head = readDurableObjectRequestHead(request);
	const init: RequestInit = {
		body: head.body ? (request.body ?? new Uint8Array()) : null,
		headers: head.headers,
		method: head.method,
	};
	if (head.cf !== undefined) Reflect.set(init, "cf", head.cf);
	try {
		return await runDurableObjectFetch(generation, order, url, request, init);
	} catch (error) {
		// A reset breaks the caller's stub, as in workerd. Errors that the
		// object's own code throws leave the stub usable.
		if (generation.stateController.resetSignal.aborted) markDurableObjectResetRpcError(error);
		return new Response(serializeThrownFetchError(error), {
			headers: { "content-type": "application/json", [thrownErrorHeader]: "1" },
			status: 500,
		});
	}
}

async function runDurableObjectFetch(
	generation: DurableObjectGeneration,
	order: DurableObjectStubOrder,
	url: string,
	request: Request,
	init: RequestInit,
): Promise<Response> {
	return await generation.orderCoordinator.run(order, async () => {
		return await generation.stateController.runEvent(async () => {
			const handler: unknown = Reflect.get(generation.instance, "fetch");
			if (typeof handler !== "function") {
				// workerd's errors for a missing handler and a non-Response result.
				throw new Error("Handler does not export a fetch() function.");
			}
			const result: unknown = await Reflect.apply(handler, generation.instance, [
				requestWithBody(url, request, init),
			]);
			if (!(result instanceof Response)) {
				throw new TypeError(
					"Incorrect type for Promise: the Promise did not resolve to 'Response'.",
				);
			}
			const headers = new Headers(result.headers);
			// Workerd encodes the object's response as it sends it to the caller,
			// whose fetch() decodes it again.
			const coding = outgoingBodyCoding(result);
			if (coding !== undefined) headers.delete("content-length");
			const body =
				coding === undefined || result.body === null
					? result.body
					: encodeBody(result.body, coding);
			return new Response(body, {
				headers: durableObjectTransportResponseHeaders(
					headers,
					result.statusText,
				),
				status: result.status,
				statusText: result.statusText,
			});
		});
	});
}
