import { startOutboundWork } from "../internal/outbound-work.js";
import { readerOf } from "../internal/stream-methods.js";
import {
	FormData as UndiciFormData,
	Headers as UndiciHeaders,
	Request as UndiciRequest,
	Response as UndiciResponse,
	fetch as undiciFetch,
} from "undici";
import { parseFormDataBody } from "./form-data.js";
import { ReadableStream, structuredClone } from "./native.js";
import { expectedLengthOf } from "./web-compat.js";
import { markWorkerdClass } from "./workerd-class.js";
import { Blob as NodeBlob } from "node:buffer";
import {
	URLSearchParams as NodeURLSearchParams,
} from "node:url";
import { URL, URLSearchParams } from "./url.js";
import { coupleWebSocket, WebSocket, WebSocketPair } from "./websocket.js";
import { waitForOutputGate } from "../internal/output-gate.js";
import { isRequestSignalPassthrough } from "../internal/request-signal-passthrough.js";
import { currentGlobalOutbound, globalOutboundBlockedError } from "../internal/global-outbound.js";
import { connectNetworkWebSocket } from "../internal/network-websockets.js";
import type { IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import type {
	BodyInit as UndiciBodyInit,
	RequestInit as UndiciRequestInit,
	ResponseInit as UndiciResponseInit,
} from "undici";

export type HeadersInit =
	| Headers
	| Iterable<Iterable<string>>
	| Record<string, string>;

const headers = new WeakMap<Headers, UndiciHeaders>();

function headersFor(instance: Headers): UndiciHeaders {
	const value = headers.get(instance);
	if (value === undefined) {
		throw new TypeError("Illegal invocation");
	}
	return value;
}

function createHeaders(init?: HeadersInit): UndiciHeaders {
	const result = new UndiciHeaders();
	if (init === undefined) {
		return result;
	}
	if (init instanceof Headers) {
		return new UndiciHeaders(headersFor(init));
	}
	if (Symbol.iterator in init) {
		for (const entry of init) {
			const pair = [...entry];
			if (pair.length !== 2 || pair[0] === undefined || pair[1] === undefined) {
				throw new TypeError("Each header pair must contain exactly two items.");
			}
			result.append(pair[0], pair[1]);
		}
		return result;
	}
	for (const [name, value] of Object.entries(init)) {
		result.append(name, value);
	}
	return result;
}

function headersFromUndici(value: UndiciHeaders): Headers {
	const result = new Headers();
	headers.set(result, value);
	return result;
}

export class Headers {
	constructor(init?: HeadersInit) {
		headers.set(this, createHeaders(init));
	}

	get(name: string): string | null {
		return headersFor(this).get(name);
	}

	getAll(name: string): string[] {
		if (name.toLowerCase() !== "set-cookie") {
			throw new TypeError(
				'getAll() can only be used with the header name "Set-Cookie".',
			);
		}
		return this.getSetCookie();
	}

	getSetCookie(): string[] {
		return headersFor(this).getSetCookie();
	}

	has(name: string): boolean {
		return headersFor(this).has(name);
	}

	set(name: string, value: string): void {
		headersFor(this).set(name, value);
	}

	append(name: string, value: string): void {
		headersFor(this).append(name, value);
	}

	delete(name: string): void {
		headersFor(this).delete(name);
	}

	forEach<This = unknown>(
		callback: (this: This, value: string, key: string, parent: Headers) => void,
		thisArg?: This,
	): void {
		for (const [key, value] of this) {
			Reflect.apply(callback, thisArg, [value, key, this]);
		}
	}

	*entries(): IterableIterator<[key: string, value: string]> {
		for (const [key, value] of headersFor(this).entries()) {
			yield [key, value];
		}
	}

	*keys(): IterableIterator<string> {
		for (const [key] of this) {
			yield key;
		}
	}

	*values(): IterableIterator<string> {
		for (const [, value] of this) {
			yield value;
		}
	}

	[Symbol.iterator](): IterableIterator<[key: string, value: string]> {
		return this.entries();
	}
}

markWorkerdClass(Headers, "Headers");

export type BodyInit =
	| ReadableStream<Uint8Array>
	| string
	| ArrayBuffer
	| ArrayBufferView
	| Blob
	| URLSearchParams
	| FormData
	| Iterable<ArrayBuffer | ArrayBufferView>
	| AsyncIterable<ArrayBuffer | ArrayBufferView>;

interface Body {
	readonly body: ReadableStream | null;
	readonly bodyUsed: boolean;
	arrayBuffer(): Promise<ArrayBuffer>;
	bytes(): Promise<Uint8Array>;
	text(): Promise<string>;
	json<Value>(): Promise<Value>;
	formData(): Promise<FormData>;
	blob(): Promise<Blob>;
}

function unsupported(message: string): Error {
	const error = new Error(message);
	error.name = "NotSupportedError";
	return error;
}

function byteView(value: ArrayBufferView): Uint8Array {
	return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
}

const notBytesMessage = "This ReadableStream did not return bytes.";

// Workerd accepts any ArrayBuffer or ArrayBufferView chunk in a body stream and
// skips empty ones, including detached buffers.
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/streams/standard.c%2B%2B#L3420-L3445
function chunkBytes(chunk: unknown): Uint8Array | undefined {
	if (chunk instanceof ArrayBuffer || chunk instanceof SharedArrayBuffer) {
		return chunk.byteLength === 0 ? new Uint8Array(0) : new Uint8Array(chunk);
	}
	if (ArrayBuffer.isView(chunk)) {
		// A DataView over a detached buffer throws on byteLength.
		if (chunk.buffer instanceof ArrayBuffer && chunk.buffer.detached) return new Uint8Array(0);
		return chunk.byteLength === 0 ? new Uint8Array(0) : byteView(chunk);
	}
	return undefined;
}

// Views a body chunk as bytes, or throws as workerd does when a body stream
// yields something other than bytes.
export function bodyChunkBytes(chunk: unknown): Uint8Array {
	const bytes = chunkBytes(chunk);
	if (bytes === undefined) throw new TypeError(notBytesMessage);
	return bytes;
}

// Copies a body chunk into a new Uint8Array that the caller can transfer.
export function copyBodyChunk(chunk: unknown): Uint8Array {
	return bodyChunkBytes(chunk).slice();
}

// Captured so that a Worker patching the controller prototype cannot observe
// the streams Orange produces for iterable bodies.
const controllerPrototype: object = Reflect.get(
	Reflect.get(globalThis, "ReadableStreamDefaultController"),
	"prototype",
);
const controllerEnqueue: Function = Reflect.get(controllerPrototype, "enqueue");
const controllerClose: Function = Reflect.get(controllerPrototype, "close");
const readableStreamValues: Function = Reflect.get(ReadableStream.prototype, "values");

async function readAllBytes(stream: ReadableStream): Promise<Uint8Array> {
	const reader = readerOf(stream);
	const parts: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const result = await reader.read();
		if (result.done) break;
		let bytes: Uint8Array;
		try {
			bytes = bodyChunkBytes(result.value);
		} catch (error: unknown) {
			await reader.cancel(error);
			throw error;
		}
		if (bytes.byteLength === 0) continue;
		parts.push(bytes.slice());
		total += bytes.byteLength;
	}
	reader.releaseLock();
	const result = new Uint8Array(total);
	let offset = 0;
	for (const part of parts) {
		result.set(part, offset);
		offset += part.byteLength;
	}
	return result;
}

type UndiciBody = UndiciRequest | UndiciResponse;

// Reads a stream body with workerd's chunk rules. A used, locked or empty body
// goes through undici so its errors and empty results stay unchanged.
async function bodyBytes(target: UndiciBody): Promise<Uint8Array> {
	const stream = target.body;
	if (stream === null || target.bodyUsed || stream.locked) {
		return new Uint8Array(await target.arrayBuffer());
	}
	return readAllBytes(stream);
}

async function bodyArrayBuffer(target: UndiciBody): Promise<ArrayBuffer> {
	const bytes = await bodyBytes(target);
	return bytes.buffer instanceof ArrayBuffer && bytes.byteLength === bytes.buffer.byteLength
		? bytes.buffer
		: bytes.slice().buffer;
}

async function bodyText(target: UndiciBody): Promise<string> {
	return new TextDecoder().decode(await bodyBytes(target));
}

// Workerd turns an iterable body into a stream that awaits each value, as
// async-from-sync iteration does, and forwards cancel() to return().
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/tests/ts-webstreams-test.js#L218-L345
function iterableBodyStream(
	iterator: Iterator<unknown> | AsyncIterator<unknown>,
): ReadableStream<Uint8Array> {
	return new ReadableStream<Uint8Array>(
		{
			async pull(controller: ReadableStreamDefaultController<Uint8Array>) {
				const result = await iterator.next();
				if (result.done === true) {
					Reflect.apply(controllerClose, controller, []);
					return;
				}
				const bytes = copyBodyChunk(await result.value);
				if (bytes.byteLength > 0) Reflect.apply(controllerEnqueue, controller, [bytes]);
			},
			async cancel(reason: unknown) {
				await iterator.return?.(reason);
			},
		},
		{ highWaterMark: 0 },
	);
}

function objectTag(value: object): string {
	return Object.prototype.toString.call(value);
}

function isAsyncByteIterable(
	value: object,
): value is AsyncIterable<ArrayBuffer | ArrayBufferView> {
	return Symbol.asyncIterator in value;
}

function hasCustomStringification(value: object): boolean {
	return (
		Reflect.get(value, "toString") !== Object.prototype.toString ||
		Reflect.get(value, Symbol.toPrimitive) !== undefined
	);
}

function isByteIterable(
	value: object,
): value is Iterable<ArrayBuffer | ArrayBufferView> {
	return Symbol.iterator in value;
}

function toUndiciBody(value: BodyInit | null | undefined): UndiciBodyInit {
	if (value === null || value === undefined || typeof value === "string") {
		return value ?? null;
	}
	if (value instanceof ArrayBuffer) {
		return value;
	}
	if (ArrayBuffer.isView(value)) {
		return byteView(value);
	}
	if (value instanceof NodeURLSearchParams) {
		return value;
	}
	if (value instanceof URLSearchParams) {
		return new NodeURLSearchParams(value.toString());
	}
	if (value instanceof NodeBlob) {
		return value;
	}
	if (value instanceof UndiciFormData) {
		return validateFormDataNames(value);
	}
	if (objectTag(value) === "[object FormData]") {
		return validateFormDataNames(copyFormData(value));
	}
	// workerd never iterates a boxed string, and prefers a custom toString or
	// Symbol.toPrimitive over a sync iterator on anything but an array.
	// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/jsg/iterator.h#L552-L601
	if (value instanceof String) {
		return String(value);
	}
	// Undici reads a stream body as is, so the caller's stream is locked
	// and disturbed exactly when the body is consumed.
	if (value instanceof ReadableStream) {
		return value;
	}
	if (isAsyncByteIterable(value)) {
		return iterableBodyStream(value[Symbol.asyncIterator]());
	}
	if (
		isByteIterable(value) &&
		(Array.isArray(value) || !hasCustomStringification(value))
	) {
		return iterableBodyStream(value[Symbol.iterator]());
	}
	// Any other object body is converted to a string, as in workerd.
	// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/tests/ts-webstreams-test.js#L586-L590
	return String(value);
}

// workerd refuses to serialize a name or filename that ends with a
// backslash, which could escape the closing quote.
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/form-data.c%2B%2B#L106-L111
function validateFormDataNames(formData: UndiciFormData): UndiciFormData {
	for (const [name, value] of formData) {
		if (
			name.endsWith("\\") ||
			(typeof value !== "string" && value.name.endsWith("\\"))
		) {
			throw new TypeError("Name or filename can't end with backslash");
		}
	}
	return formData;
}

interface FormDataLike {
	entries(): IterableIterator<[string, string | Blob]>;
}

function isFormDataLike(value: object): value is FormDataLike {
	return typeof Reflect.get(value, "entries") === "function";
}

// The global FormData may come from a different undici copy than the one that
// backs Orange's Request and Response, so its entries cross by value.
function copyFormData(value: object): UndiciFormData {
	if (!isFormDataLike(value)) {
		throw unsupported("This HTTP body type is not implemented yet.");
	}
	const result = new UndiciFormData();
	for (const [name, entry] of value.entries()) {
		if (typeof entry === "string") {
			result.append(name, entry);
		} else {
			result.append(name, entry, Reflect.get(entry, "name"));
		}
	}
	return result;
}

async function bodyFormData(body: UndiciRequest | UndiciResponse): Promise<FormData> {
	if (body.bodyUsed) {
		throw new TypeError(
			"Body has already been used. It can only be used once. Use tee() first if you need to read it twice.",
		);
	}
	const contentType = body.headers.get("content-type");
	const bytes = await bodyBytes(body);
	return parseFormDataBody(bytes, contentType);
}

const nullBodyStatuses: ReadonlySet<number> = new Set([204, 205, 304]);

// workerd still accepts a zero-length buffer body with a null body status and
// treats it as no body. Any other body fails.
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/http.c%2B%2B#L1080-L1097
function nullStatusBody(body: BodyInit | null | undefined): null {
	if (body === null || body === undefined) return null;
	const length =
		typeof body === "string"
			? Buffer.byteLength(body)
			: body instanceof ArrayBuffer || ArrayBuffer.isView(body)
				? body.byteLength
				: body instanceof NodeBlob
					? body.size
					: undefined;
	if (length !== 0) {
		throw new TypeError(
			"Response with null body status (101, 204, 205, or 304) cannot have a body.",
		);
	}
	return null;
}

function headersToUndici(init?: HeadersInit): UndiciHeaders | undefined {
	return init === undefined ? undefined : createHeaders(init);
}

export type RequestInfo<
	CfHostMetadata = unknown,
	Cf = unknown,
> = { readonly cf?: Cf } | string;

export interface RequestInit<Cf = unknown> {
	method?: string;
	headers?: HeadersInit;
	body?: BodyInit | null;
	redirect?: string;
	fetcher?: object | null;
	cf?: Cf;
	cache?: "no-store" | "no-cache";
	integrity?: string;
	signal?: AbortSignal | null;
	encodeResponseBody?: "automatic" | "manual";
}

const requests = new WeakMap<object, UndiciRequest>();
const requestBodyLengths = new WeakMap<object, bigint>();

function copyDisconnectSignal(from: object, to: object): void {
	if (!isRequestSignalPassthrough()) return;
	const signal = Object.getOwnPropertyDescriptor(from, "signal");
	if (signal !== undefined) Object.defineProperty(to, "signal", signal);
}

// Returns the Content-Length that workerd would send for this request body,
// when the body is a stream with a declared expectedLength.
export function requestBodyLength(request: Request): bigint | undefined {
	return requestBodyLengths.get(request);
}

// Requests whose body came from a stream, so a redirect cannot send it again.
// Workerd calls a buffer-backed body rewindable.
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/http.c%2B%2B#L2117-L2124
const oneTimeBodyRequests = new WeakSet<object>();

export function requestBodyCanRewind(request: Request): boolean {
	return request.body === null || !oneTimeBodyRequests.has(request);
}

function requestFor(instance: object): UndiciRequest {
	const value = requests.get(instance);
	if (value === undefined) {
		throw new TypeError("Illegal invocation");
	}
	return value;
}

function requestRedirect(value: string | undefined): "error" | "follow" | "manual" | undefined {
	if (
		value === undefined ||
		value === "error" ||
		value === "follow" ||
		value === "manual"
	) {
		return value;
	}
	throw new TypeError(`Invalid redirect value: ${value}`);
}

// The methods kj::HttpMethod recognizes. With upper_case_all_http_methods,
// workerd upper-cases any of them and rejects every other method.
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/http.c%2B%2B#L418-L448
const httpMethods = new Set([
	"GET", "HEAD", "POST", "PUT", "DELETE", "PATCH", "PURGE", "OPTIONS",
	"TRACE", "COPY", "LOCK", "MKCOL", "MOVE", "PROPFIND", "PROPPATCH",
	"SEARCH", "UNLOCK", "ACL", "REPORT", "MKACTIVITY", "CHECKOUT", "MERGE",
	"M-SEARCH", "NOTIFY", "SUBSCRIBE", "UNSUBSCRIBE", "QUERY", "BAN",
]);

function requestMethod(value: string | undefined): string | undefined {
	if (value === undefined) return undefined;
	const method = String(value).toUpperCase();
	if (!httpMethods.has(method)) {
		throw new TypeError(`Invalid HTTP method string: ${value}`);
	}
	return method;
}

function requestInit<Cf>(init?: RequestInit<Cf>): UndiciRequestInit | undefined {
	if (init === undefined) {
		return undefined;
	}
	if (init.fetcher !== undefined && init.fetcher !== null) {
		throw unsupported("Custom request fetchers are not implemented yet.");
	}
	if (init.encodeResponseBody !== undefined) {
		throw unsupported("encodeResponseBody is not implemented yet.");
	}
	if (init.integrity !== undefined && init.integrity !== "") {
		throw new TypeError(
			"Subrequest integrity checking is not implemented. The integrity option must be either undefined or an empty string.",
		);
	}
	const body = init.body === undefined ? undefined : toUndiciBody(init.body);
	return {
		body,
		cache: init.cache,
		...(body === undefined || body === null ? {} : { duplex: "half" }),
		headers: headersToUndici(init.headers),
		integrity: init.integrity,
		method: requestMethod(init.method),
		redirect: requestRedirect(init.redirect),
		signal: init.signal,
	};
}

function requestInput<CfHostMetadata, Cf>(
	input: RequestInfo<CfHostMetadata, Cf> | URL,
): string | UndiciRequest {
	if (typeof input === "string") {
		return input;
	}
	if (input instanceof URL) {
		return input.href;
	}
	return requestFor(input);
}

// Workerd rejects cf.cacheControl combined with cf.cacheTtl or the cache option.
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/http.c%2B%2B#L736-L762
function validateCacheControl(cf: unknown, cache: string | undefined): void {
	if (typeof cf !== "object" || cf === null) return;
	if (Reflect.get(cf, "cacheControl") === undefined) return;
	if (Reflect.get(cf, "cacheTtl") !== undefined) {
		throw new TypeError(
			"The 'cacheControl' and 'cacheTtl' options on cf are mutually exclusive. Use 'cacheControl' for explicit Cache-Control header directives, or 'cacheTtl' for a simplified TTL, but not both.",
		);
	}
	if (cache !== undefined) {
		throw new TypeError(
			"The 'cacheControl' option on cf cannot be used together with the 'cache' request option. The 'cache' option ('no-store'/'no-cache') maps to cache TTL behavior internally, which conflicts with explicit Cache-Control directives.",
		);
	}
}

export class Request<CfHostMetadata = unknown, Cf = unknown> implements Body {
	readonly cf?: Cf;
	readonly fetcher: null;

	constructor(
		input: RequestInfo | URL,
		init?: RequestInit<unknown>,
	) {
		requests.set(
			this,
			new UndiciRequest(requestInput(input), requestInit(init)),
		);
		if (
			init?.body !== undefined && init.body !== null
				? init.body instanceof ReadableStream
				: init?.body === undefined &&
					input instanceof Request &&
					oneTimeBodyRequests.has(input)
		) {
			oneTimeBodyRequests.add(this);
		}
		const bodyLength =
			init?.body !== undefined
				? init.body instanceof ReadableStream
					? expectedLengthOf(init.body)
					: undefined
				: input instanceof Request
					? requestBodyLengths.get(input)
					: undefined;
		if (bodyLength !== undefined) requestBodyLengths.set(this, bodyLength);
		if (input instanceof Request && init?.signal === undefined) copyDisconnectSignal(input, this);
		// Workerd deep-clones init.cf and otherwise keeps the input request's cf.
		// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/http.c%2B%2B#L469-L474
		const cf: unknown =
			init?.cf !== undefined
				? structuredClone(init.cf)
				: input instanceof Request
					? input.cf
					: undefined;
		validateCacheControl(cf, init?.cache);
		// SAFETY: Cf is a caller-declared type parameter for the cf object, and workerd
		// does not validate the cf shape at runtime, so TypeScript cannot relate it here.
		this.cf = cf as Cf | undefined;
		this.fetcher = null;
	}

	clone(): Request<CfHostMetadata, Cf> {
		const result = new Request<CfHostMetadata, Cf>(
			this.url,
			this.cf === undefined ? undefined : { cf: this.cf },
		);
		requests.set(result, requestFor(this).clone());
		if (oneTimeBodyRequests.has(this)) oneTimeBodyRequests.add(result);
		copyDisconnectSignal(this, result);
		return result;
	}

	get method(): string {
		return requestFor(this).method;
	}

	get url(): string {
		return requestFor(this).url;
	}

	get headers(): Headers {
		return headersFromUndici(requestFor(this).headers);
	}

	get redirect(): string {
		return requestFor(this).redirect;
	}

	get signal(): AbortSignal {
		return requestFor(this).signal;
	}

	get integrity(): string {
		return requestFor(this).integrity;
	}

	get keepalive(): boolean {
		return requestFor(this).keepalive;
	}

	get cache(): "no-store" | "no-cache" | undefined {
		const value = requestFor(this).cache;
		return value === "no-store" || value === "no-cache" ? value : undefined;
	}

	get body(): ReadableStream | null {
		return requestFor(this).body;
	}

	get bodyUsed(): boolean {
		return requestFor(this).bodyUsed;
	}

	arrayBuffer(): Promise<ArrayBuffer> {
		return bodyArrayBuffer(requestFor(this));
	}

	bytes(): Promise<Uint8Array> {
		return bodyBytes(requestFor(this));
	}

	text(): Promise<string> {
		return bodyText(requestFor(this));
	}

	async json<Value>(): Promise<Value> {
		return JSON.parse(await this.text());
	}

	formData(): Promise<FormData> {
		return bodyFormData(requestFor(this));
	}

	blob(): Promise<Blob> {
		return requestFor(this).blob();
	}
}

export interface ResponseInit {
	status?: number;
	statusText?: string;
	headers?: HeadersInit;
	cf?: unknown;
	webSocket?: object | null;
	encodeBody?: "automatic" | "manual";
}

const responses = new WeakMap<Response, UndiciResponse>();

// Responses created with `encodeBody: "manual"`, whose body is already encoded
// as their Content-Encoding header says. Workerd copies the mode from a Response
// passed as the init, and clone() resets it to "automatic".
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/http.c%2B%2B#L1012-L1019
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/http.c%2B%2B#L1041-L1047
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/http.c%2B%2B#L1214-L1228
const manualBodyEncodings = new WeakSet<Response>();

function bodyEncodingIsManual(init: ResponseInit | Response | undefined): boolean {
	if (init === undefined) return false;
	if (init instanceof Response) return manualBodyEncodings.has(init);
	const value = init.encodeBody;
	if (value === undefined || value === "automatic") return false;
	if (value === "manual") return true;
	throw new TypeError(`encodeBody: unexpected value: ${String(value)}`);
}

// Whether the runtime must send the response body as it is instead of
// applying its Content-Encoding.
export function responseEncodesBodyManually(response: object): boolean {
	return response instanceof Response && manualBodyEncodings.has(response);
}

interface WebSocketResponseState {
	statusText: string;
	webSocket: WebSocket;
}

const webSocketResponses = new WeakMap<Response, WebSocketResponseState>();

function responseFor(instance: Response): UndiciResponse {
	const value = responses.get(instance);
	if (value === undefined) {
		throw new TypeError("Illegal invocation");
	}
	return value;
}

function responseInit(init?: ResponseInit): UndiciResponseInit | undefined {
	if (init === undefined) {
		return undefined;
	}
	if (init.webSocket !== undefined && init.webSocket !== null) {
		throw unsupported("WebSocket response upgrades are not implemented yet.");
	}
	return {
		headers: headersToUndici(init.headers),
		status: init.status,
		statusText: init.statusText,
	};
}

function isEmptyNullStatusBody(body: BodyInit | null | undefined): boolean {
	if (body === null || body === undefined) return true;
	if (typeof body === "string") return new TextEncoder().encode(body).byteLength === 0;
	if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
		return body.byteLength === 0;
	}
	return false;
}

function validateStatusText(statusText: string | undefined): void {
	if (statusText === undefined) return;
	for (const character of statusText) {
		const codePoint = character.codePointAt(0);
		if (codePoint !== undefined && codePoint < 0x20) {
			throw new TypeError("Invalid statusText");
		}
	}
}

function createWebSocketResponse(
	response: Response,
	body: BodyInit | null | undefined,
	init: ResponseInit,
	webSocket: WebSocket,
): UndiciResponse {
	if ((init.status ?? 200) !== 101) {
		throw new RangeError("Responses with a WebSocket must have status code 101.");
	}
	if (!isEmptyNullStatusBody(body)) {
		throw new TypeError(
			"Response with null body status (101, 204, 205, or 304) cannot have a body.",
		);
	}
	validateStatusText(init.statusText);
	webSocketResponses.set(response, {
		statusText: init.statusText ?? "Switching Protocols",
		webSocket,
	});
	return new UndiciResponse(null, {
		headers: headersToUndici(init.headers),
		status: 200,
	});
}

function responseFromUndici(value: UndiciResponse): Response {
	const result = new Response();
	responses.set(result, value);
	return result;
}

// The URLs a fetch() visited to produce a Response, for responses Orange builds
// itself, such as service binding results. Workerd derives `url` and
// `redirected` from the same list.
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/http.c%2B%2B#L1331-L1341
const responseUrlLists = new WeakMap<Response, readonly string[]>();

export function setResponseUrlList(response: Response, urls: readonly string[]): void {
	responseUrlLists.set(
		response,
		urls.map((url) => {
			const parsed = new URL(url);
			parsed.hash = "";
			return parsed.href;
		}),
	);
}

// The WebSocket client writes these headers of the opening handshake itself.
const webSocketHandshakeHeaders: ReadonlySet<string> = new Set([
	"connection",
	"content-length",
	"host",
	"keep-alive",
	"sec-websocket-accept",
	"sec-websocket-extensions",
	"sec-websocket-key",
	"sec-websocket-protocol",
	"sec-websocket-version",
	"transfer-encoding",
	"upgrade",
]);

const redirectStatuses: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);
// Undici's limit for an ordinary fetch().
const maxWebSocketRedirects = 20;

function isWebSocketUpgrade(request: Request): boolean {
	return request.headers.get("upgrade")?.toLowerCase() === "websocket";
}

// The response of an origin that did not upgrade, which fetch() returns as it is.
function refusedUpgradeResponse(refused: IncomingMessage): Response {
	const status = refused.statusCode ?? 502;
	const headers = new Headers();
	for (let index = 0; index + 1 < refused.rawHeaders.length; index += 2) {
		headers.append(refused.rawHeaders[index] ?? "", refused.rawHeaders[index + 1] ?? "");
	}
	const init = { headers, status, statusText: refused.statusMessage ?? "" };
	if (nullBodyStatuses.has(status)) {
		refused.resume();
		return new Response(null, init);
	}
	const body: ReadableStream<Uint8Array> = Readable.toWeb(refused);
	return new Response(body, init);
}

// fetch() with `Upgrade: websocket` opens a client WebSocket, as workerd does.
// The 101 response carries it in `webSocket`, for the Worker to accept() or to
// return to its own client. An origin that does not upgrade answers with its
// own response, and a redirect is followed unless the request says otherwise.
// The request's method and body are not sent, and a ws: or wss: URL is
// refused. Measured on Cloudflare on 2026-11-13.
// https://developers.cloudflare.com/workers/examples/websockets/#write-a-websocket-client
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/http.c%2B%2B#L1624-L1655
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/http.c%2B%2B#L1833-L1840
async function fetchWebSocket(request: Request): Promise<Response> {
	const { signal } = request;
	if (signal.aborted) throw signal.reason;
	const headers: Record<string, string> = {};
	for (const [name, value] of request.headers) {
		// A proxied request carries the CF-Connecting-IP that Orange set, and an
		// origin behind Cloudflare answers a request that has it with 403.
		if (!webSocketHandshakeHeaders.has(name) && name !== "cf-connecting-ip") headers[name] = value;
	}
	const protocols = (request.headers.get("sec-websocket-protocol") ?? "")
		.split(",")
		.map((protocol) => protocol.trim())
		.filter((protocol) => protocol !== "");
	const urls = [request.url];
	for (;;) {
		const url = new URL(urls.at(-1) ?? request.url);
		if (url.protocol !== "http:" && url.protocol !== "https:") {
			throw new TypeError(`Fetch API cannot load: ${url.href}`);
		}
		url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
		const pair = new WebSocketPair();
		const connection = await connectNetworkWebSocket(url.href, {
			headers,
			// The origin can send at once, so the pair must take messages before this function continues.
			onOpen(networkSocket) {
				networkSocket.binaryType = "arraybuffer";
				coupleWebSocket(pair[1], networkSocket);
			},
			protocols,
		});
		if (connection.kind === "rejected") {
			const refused = connection.response;
			const location = refused.headers.location;
			const redirect = redirectStatuses.has(refused.statusCode ?? 0) && location !== undefined;
			if (!redirect || request.redirect === "manual") return refusedUpgradeResponse(refused);
			refused.resume();
			if (request.redirect === "error" || urls.length > maxWebSocketRedirects) {
				throw new TypeError("fetch failed");
			}
			urls.push(new URL(location, urls.at(-1)).href);
			continue;
		}
		const networkSocket = connection.webSocket;
		if (signal.aborted) {
			networkSocket.terminate();
			throw signal.reason;
		}
		// An abort after the response ends the connection, like workerd's AbortableWebSocket.
		const abort = (): void => networkSocket.terminate();
		signal.addEventListener("abort", abort, { once: true });
		// Workerd does not hibernate an object while a WebSocket that it opened is open.
		const ended = startOutboundWork("outbound-websocket");
		networkSocket.addEventListener("close", () => {
			signal.removeEventListener("abort", abort);
			ended?.();
		});
		const response = new Response(null, {
			headers: connection.headers,
			status: 101,
			webSocket: pair[0],
		});
		if (urls.length > 1) setResponseUrlList(response, urls);
		return response;
	}
}

export async function fetch<Cf = unknown>(
	input: RequestInfo<unknown, Cf> | URL,
	init?: RequestInit<Cf>,
): Promise<Response> {
	const request = new Request(input, init);
	const outbound = currentGlobalOutbound();
	if (outbound === null) throw globalOutboundBlockedError();
	// Workerd does not hibernate an object while a request that it sent has no response, also
	// when nothing awaits the request. Measured on `wrangler dev` 4.129.
	const ended = startOutboundWork("fetch");
	try {
		// A Durable Object sends the request only after its earlier writes are durable.
		// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/http.c%2B%2B#L1969-L1986
		const outputLock = waitForOutputGate();
		if (outputLock !== undefined) await outputLock;
		if (outbound !== undefined) return await outbound.fetch(request);
		if (isWebSocketUpgrade(request)) return await fetchWebSocket(request);
		let outgoing = requestFor(request);
		const body = outgoing.body;
		// Undici sends only Uint8Array chunks, so a Worker stream body is read
		// through a stream that converts its chunks.
		if (oneTimeBodyRequests.has(request) && body !== null) {
			outgoing = new UndiciRequest(outgoing, {
				body: iterableBodyStream(Reflect.apply(readableStreamValues, body, [])),
				duplex: "half",
			});
		}
		return responseFromUndici(await undiciFetch(outgoing));
	} finally {
		ended?.();
	}
}

function redirectStatus(
	status: number | undefined,
): 301 | 302 | 303 | 307 | 308 | undefined {
	if (
		status === undefined ||
		status === 301 ||
		status === 302 ||
		status === 303 ||
		status === 307 ||
		status === 308
	) {
		return status;
	}
	throw new RangeError(`Invalid redirect status: ${status}`);
}

export class Response implements Body {
	readonly cf: undefined;
	readonly webSocket: WebSocket | null;

	constructor(body?: BodyInit | null, init?: ResponseInit) {
		const manualBodyEncoding = bodyEncodingIsManual(init);
		if (init?.webSocket !== undefined && init.webSocket !== null) {
			if (!(init.webSocket instanceof WebSocket)) {
				throw new TypeError("Response webSocket must be a WebSocket");
			}
			responses.set(
				this,
				createWebSocketResponse(this, body, init, init.webSocket),
			);
			this.webSocket = init.webSocket;
		} else {
			const status = init?.status ?? 200;
			if (status < 200 || status > 599) {
				throw new RangeError(
					"Responses may only be constructed with status codes in the range 200 to 599, inclusive.",
				);
			}
			responses.set(
				this,
				new UndiciResponse(
					nullBodyStatuses.has(status)
						? nullStatusBody(body)
						: toUndiciBody(body),
					responseInit(init),
				),
			);
			this.webSocket = null;
		}
		if (manualBodyEncoding) manualBodyEncodings.add(this);
		this.cf = undefined;
	}

	static error(): Response {
		return responseFromUndici(UndiciResponse.error());
	}

	static redirect(url: string, status?: number): Response {
		return responseFromUndici(UndiciResponse.redirect(url, redirectStatus(status)));
	}

	static json(value: unknown, maybeInit?: ResponseInit | Response): Response {
		const manualBodyEncoding = bodyEncodingIsManual(maybeInit);
		const init =
			maybeInit instanceof Response
				? {
					headers: maybeInit.headers,
					status: maybeInit.status,
					statusText: maybeInit.statusText,
				}
				: maybeInit;
		const response = responseFromUndici(
			UndiciResponse.json(value, responseInit(init)),
		);
		if (manualBodyEncoding) manualBodyEncodings.add(response);
		return response;
	}

	clone(): Response {
		if (webSocketResponses.has(this)) {
			throw new TypeError("Cannot clone a response to a WebSocket handshake.");
		}
		const clone = responseFromUndici(responseFor(this).clone());
		const urls = responseUrlLists.get(this);
		if (urls !== undefined) responseUrlLists.set(clone, urls);
		return clone;
	}

	get status(): number {
		return webSocketResponses.has(this) ? 101 : responseFor(this).status;
	}

	get statusText(): string {
		return webSocketResponses.get(this)?.statusText ?? responseFor(this).statusText;
	}

	get headers(): Headers {
		return headersFromUndici(responseFor(this).headers);
	}

	get ok(): boolean {
		return webSocketResponses.has(this) ? false : responseFor(this).ok;
	}

	get redirected(): boolean {
		const urls = responseUrlLists.get(this);
		return urls === undefined ? responseFor(this).redirected : urls.length > 1;
	}

	get url(): string {
		return responseUrlLists.get(this)?.at(-1) ?? responseFor(this).url;
	}

	get type(): "default" | "error" {
		return responseFor(this).type === "error" ? "error" : "default";
	}

	get body(): ReadableStream | null {
		return webSocketResponses.has(this) ? null : responseFor(this).body;
	}

	get bodyUsed(): boolean {
		return responseFor(this).bodyUsed;
	}

	arrayBuffer(): Promise<ArrayBuffer> {
		return bodyArrayBuffer(responseFor(this));
	}

	bytes(): Promise<Uint8Array> {
		return bodyBytes(responseFor(this));
	}

	text(): Promise<string> {
		return bodyText(responseFor(this));
	}

	async json<Value>(): Promise<Value> {
		return JSON.parse(await this.text());
	}

	formData(): Promise<FormData> {
		return bodyFormData(responseFor(this));
	}

	blob(): Promise<Blob> {
		return responseFor(this).blob();
	}
}

markWorkerdClass(Request, "Request");
markWorkerdClass(Response, "Response");
