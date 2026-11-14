import { FormData as UndiciFormData } from "undici";

import { atob, btoa } from "./base64.js";
import { Cache, caches, CacheStorage } from "./cache.js";
import { Cloudflare } from "./cloudflare.js";
import { TextDecoder, TextEncoder } from "./encoding.js";
import { fetch, Headers, Request, Response } from "./http.js";
import {
	AbortController,
	AbortSignal,
	Blob,
	console,
	DOMException,
	performance,
	queueMicrotask,
	ReadableStream,
	TransformStream,
	WritableStream,
} from "./native.js";
import { structuredClone } from "./structured-clone.js";
import { Event } from "./event.js";
import { EventSource } from "./eventsource.js";
import {
	addEventListener,
	dispatchEvent,
	ErrorEvent,
	PromiseRejectionEvent,
	removeEventListener,
	reportError,
} from "./global-scope.js";
import { HTMLRewriter } from "./html-rewriter.js";
import { MessageChannel, MessageEvent, MessagePort } from "./messagechannel.js";
import {
	FixedLengthStream,
	IdentityTransformStream,
} from "./identity-transform-stream.js";
import { Navigator, navigator } from "./navigator.js";
import { nodeWebGlobals } from "./node-web.js";
import { scheduler } from "./scheduler.js";
import { nativeWebAssembly } from "./webassembly.js";
import {
	WebSocket,
	WebSocketPair,
	WebSocketRequestResponsePair,
} from "./websocket.js";
import { URL, URLSearchParams } from "./url.js";
import { URLPattern } from "./url-pattern.js";
import { WorkerGlobalScope } from "./worker-global-scope.js";
import { crypto } from "./crypto.js";
import {
	clearInterval,
	clearTimeout,
	setInterval,
	setTimeout,
} from "./timers.js";

// Typed through the global FormData interface so the emitted registry declarations do
// not depend on the undici package.
interface FormDataConstructor {
	readonly prototype: FormData;
	new (): FormData;
}

const FormData: FormDataConstructor = UndiciFormData;

export type GlobalImplementationStatus = "partial" | "implemented";

const scopeGlobals = {
	...nodeWebGlobals,
	AbortController,
	AbortSignal,
	Blob,
	Cache,
	CacheStorage,
	Cloudflare,
	DOMException,
	ErrorEvent,
	Event,
	EventSource,
	FixedLengthStream,
	FormData,
	HTMLRewriter,
	Headers,
	IdentityTransformStream,
	MessageChannel,
	MessageEvent,
	MessagePort,
	Navigator,
	PromiseRejectionEvent,
	ReadableStream,
	Request,
	Response,
	TextDecoder,
	TextEncoder,
	TransformStream,
	URL,
	URLPattern,
	URLSearchParams,
	// A getter, so loading this module never reads WebAssembly. See nativeWebAssembly().
	get WebAssembly() {
		return nativeWebAssembly();
	},
	WebSocket,
	WebSocketPair,
	WebSocketRequestResponsePair,
	WritableStream,
	addEventListener,
	atob,
	btoa,
	caches,
	clearInterval,
	clearTimeout,
	console,
	crypto,
	dispatchEvent,
	fetch,
	navigator,
	performance,
	queueMicrotask,
	removeEventListener,
	reportError,
	scheduler,
	setInterval,
	setTimeout,
	structuredClone,
	WorkerGlobalScope,
};

/**
 * Orange's global scope: Node's global object with every Cloudflare global
 * installed on it.
 *
 * It lacks workerd's ServiceWorkerGlobalScope prototype chain and the globals
 * that Orange does not implement yet, such as FetchEvent and origin.
 */
export interface GlobalScope extends ScopeGlobals {
	readonly self: GlobalScope;
}

type ScopeGlobals = typeof scopeGlobals;

// SAFETY: installCloudflareGlobals defines every scopeGlobals entry on
// globalThis before Worker code runs. TypeScript types globalThis with Node's
// globals, which do not overlap enough with the installed ones for a direct
// assertion. The global-scope differential fixture reads these globals from self.
const self = globalThis as unknown as GlobalScope;

// Copies the descriptors, so the WebAssembly getter is not called here.
// SAFETY: defineProperties adds every scopeGlobals property to the object,
// but TypeScript types its result as the first argument.
export const globalImplementations = Object.defineProperties(
	{ self },
	Object.getOwnPropertyDescriptors(scopeGlobals),
) as ScopeGlobals & { self: GlobalScope };

export const globalImplementationStatuses: Record<
	keyof typeof globalImplementations,
	GlobalImplementationStatus
> = {
	ByteLengthQueuingStrategy: "implemented",
	CloseEvent: "partial",
	CompressionStream: "partial",
	CountQueuingStrategy: "implemented",
	Crypto: "partial",
	CryptoKey: "partial",
	CustomEvent: "implemented",
	DecompressionStream: "partial",
	EventTarget: "partial",
	File: "partial",
	MessageChannel: "partial",
	MessageEvent: "partial",
	MessagePort: "partial",
	Performance: "partial",
	ReadableByteStreamController: "partial",
	ReadableStreamBYOBReader: "partial",
	ReadableStreamBYOBRequest: "partial",
	ReadableStreamDefaultController: "partial",
	ReadableStreamDefaultReader: "partial",
	SubtleCrypto: "partial",
	TextDecoderStream: "partial",
	TextEncoderStream: "partial",
	TransformStreamDefaultController: "partial",
	URLPattern: "partial",
	WritableStreamDefaultController: "partial",
	WritableStreamDefaultWriter: "partial",
	AbortController: "partial",
	AbortSignal: "partial",
	Blob: "partial",
	Cache: "partial",
	CacheStorage: "partial",
	Cloudflare: "partial",
	DOMException: "partial",
	ErrorEvent: "partial",
	Event: "partial",
	EventSource: "partial",
	FixedLengthStream: "partial",
	FormData: "partial",
	HTMLRewriter: "partial",
	Headers: "partial",
	IdentityTransformStream: "partial",
	Navigator: "partial",
	PromiseRejectionEvent: "partial",
	ReadableStream: "partial",
	Request: "partial",
	Response: "partial",
	TextDecoder: "implemented",
	TextEncoder: "implemented",
	TransformStream: "partial",
	URL: "partial",
	URLSearchParams: "partial",
	WebAssembly: "partial",
	WebSocket: "partial",
	WebSocketPair: "partial",
	WebSocketRequestResponsePair: "implemented",
	WorkerGlobalScope: "partial",
	WritableStream: "partial",
	addEventListener: "partial",
	atob: "implemented",
	btoa: "implemented",
	caches: "partial",
	clearInterval: "partial",
	clearTimeout: "partial",
	console: "partial",
	crypto: "partial",
	dispatchEvent: "partial",
	fetch: "partial",
	navigator: "partial",
	performance: "partial",
	queueMicrotask: "implemented",
	removeEventListener: "partial",
	reportError: "partial",
	scheduler: "partial",
	self: "partial",
	setInterval: "partial",
	setTimeout: "partial",
	structuredClone: "partial",
};
