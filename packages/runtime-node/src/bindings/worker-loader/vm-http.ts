// node:http for the agentOS build of the dynamic Worker child. The VM's
// `http.Server` is a factory, so the host shim's `Server` subclass never runs
// its overrides, and the VM server does not parse HTTP from an emitted
// connection. This build patches each VM server instance instead, and hands
// requests to its "request" listeners as prebuilt request and response objects.

import { EventEmitter } from "node:events";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { PassThrough, Readable, Writable } from "node:stream";

import { ERR_SERVER_ALREADY_LISTEN } from "../../modules/node-internal/errors.js";
import { validatePort } from "../../modules/node-internal/validators.js";
import { ClientRequest, get, request } from "../../modules/node-http/index.js";
import {
	multipleForbiddenHeaders,
	nodeRequestHeaders,
	toFetchResponse,
} from "../../modules/node-http/fetch-conversion.js";
import {
	findSuitablePort,
	normalizeListenArgs,
	portMapper,
} from "../../modules/node-http/port-mapper.js";

export * from "node:http";
export { ClientRequest, get, request };

type HeaderValue = number | string | readonly string[];

// Array.isArray does not narrow a readonly array out of a union.
function isHeaderList(value: Record<string, HeaderValue> | readonly string[] | undefined): value is readonly string[] {
	return Array.isArray(value);
}

// Node.js 24's reason phrases. The VM's `http.STATUS_CODES` lacks some codes.
const STATUS_CODES: Readonly<Record<number, string>> = {
	100: "Continue",
	101: "Switching Protocols",
	102: "Processing",
	103: "Early Hints",
	200: "OK",
	201: "Created",
	202: "Accepted",
	203: "Non-Authoritative Information",
	204: "No Content",
	205: "Reset Content",
	206: "Partial Content",
	207: "Multi-Status",
	208: "Already Reported",
	226: "IM Used",
	300: "Multiple Choices",
	301: "Moved Permanently",
	302: "Found",
	303: "See Other",
	304: "Not Modified",
	305: "Use Proxy",
	307: "Temporary Redirect",
	308: "Permanent Redirect",
	400: "Bad Request",
	401: "Unauthorized",
	402: "Payment Required",
	403: "Forbidden",
	404: "Not Found",
	405: "Method Not Allowed",
	406: "Not Acceptable",
	407: "Proxy Authentication Required",
	408: "Request Timeout",
	409: "Conflict",
	410: "Gone",
	411: "Length Required",
	412: "Precondition Failed",
	413: "Payload Too Large",
	414: "URI Too Long",
	415: "Unsupported Media Type",
	416: "Range Not Satisfiable",
	417: "Expectation Failed",
	418: "I'm a Teapot",
	421: "Misdirected Request",
	422: "Unprocessable Entity",
	423: "Locked",
	424: "Failed Dependency",
	425: "Too Early",
	426: "Upgrade Required",
	428: "Precondition Required",
	429: "Too Many Requests",
	431: "Request Header Fields Too Large",
	451: "Unavailable For Legal Reasons",
	500: "Internal Server Error",
	501: "Not Implemented",
	502: "Bad Gateway",
	503: "Service Unavailable",
	504: "Gateway Timeout",
	505: "HTTP Version Not Supported",
	506: "Variant Also Negotiates",
	507: "Insufficient Storage",
	508: "Loop Detected",
	509: "Bandwidth Limit Exceeded",
	510: "Not Extended",
	511: "Network Authentication Required",
};

// Node.js' `IncomingMessage.headers`: lowercase names, `set-cookie` as an
// array, other repeated headers joined, and only the first value of headers
// that Node.js does not allow to repeat.
function headersObject(rawHeaders: readonly string[]): Record<string, string | string[]> {
	const headers: Record<string, string | string[]> = {};
	for (let i = 0; i < rawHeaders.length; i += 2) {
		const name = (rawHeaders[i] ?? "").toLowerCase();
		const value = rawHeaders[i + 1] ?? "";
		const existing = headers[name];
		if (name === "set-cookie") {
			headers[name] = Array.isArray(existing) ? [...existing, value] : [value];
		} else if (existing === undefined) {
			headers[name] = value;
		} else if (!multipleForbiddenHeaders.has(name)) {
			headers[name] = `${String(existing)}, ${value}`;
		}
	}
	return headers;
}

function socketStub(): EventEmitter {
	return Object.assign(new EventEmitter(), {
		destroy() {},
		encrypted: false,
		end() {},
		localAddress: "127.0.0.1",
		localPort: 0,
		// on-finished treats a request as finished when its socket is not
		// readable, so body parsers would skip the body.
		readable: true,
		ref() {},
		remoteAddress: "127.0.0.1",
		remoteFamily: "IPv4",
		remotePort: 0,
		setKeepAlive() {},
		setNoDelay() {},
		setTimeout() {},
		unref() {},
		writable: true,
	});
}

class VmIncomingMessage extends Readable {
	readonly aborted = false;
	readonly complete = false;
	readonly headers: Record<string, string | string[]>;
	readonly httpVersion = "1.1";
	readonly httpVersionMajor = 1;
	readonly httpVersionMinor = 1;
	readonly method: string;
	readonly rawHeaders: string[];
	readonly rawTrailers: string[] = [];
	readonly socket: EventEmitter;
	readonly trailers: Record<string, string> = {};
	url: string;
	#reader: ReadableStreamDefaultReader<Uint8Array> | null;

	constructor(request: Request | EventEmitter | undefined, socket?: EventEmitter) {
		super();
		if (!(request instanceof Request)) {
			// Node.js' own signature is `new IncomingMessage(socket)`; subclasses such
			// as OpenNext's build a request this way and fill in the fields themselves.
			this.method = null as unknown as string;
			this.url = "";
			this.rawHeaders = [];
			this.headers = {};
			this.socket = request ?? socketStub();
			this.#reader = null;
			return;
		}
		const url = new URL(request.url);
		this.method = request.method;
		this.url = url.pathname + url.search;
		this.rawHeaders = nodeRequestHeaders(request);
		// Node.js' client frames a body without a length as chunked, and body
		// parsers rely on one of the two headers to detect a body.
		if (request.body !== null && !request.headers.has("content-length")) {
			this.rawHeaders.push("transfer-encoding", "chunked");
		}
		this.headers = headersObject(this.rawHeaders);
		this.socket = socket ?? socketStub();
		this.#reader = request.body?.getReader() ?? null;
	}

	get connection(): EventEmitter {
		return this.socket;
	}

	setTimeout(): this {
		return this;
	}

	override _read(): void {
		const reader = this.#reader;
		if (reader === null) {
			Reflect.set(this, "complete", true);
			this.push(null);
			return;
		}
		reader.read().then(
			({ done, value }) => {
				if (done) {
					Reflect.set(this, "complete", true);
					this.push(null);
				} else {
					this.push(value);
				}
			},
			(error: unknown) => this.destroy(error instanceof Error ? error : new Error(String(error))),
		);
	}

	override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
		this.#reader?.cancel(error ?? undefined).catch(() => {});
		callback(error);
	}
}

type WriteCallback = (error?: Error | null) => void;

class VmServerResponse extends Writable {
	readonly req: VmIncomingMessage;
	readonly socket: EventEmitter;
	sendDate = true;
	statusCode = 200;
	statusMessage = "";
	#headers = new Map<string, { name: string; value: HeaderValue }>();
	#headersSent = false;
	#body = new PassThrough();
	#onHead: (response: Response) => void;
	#request: Request;

	constructor(req: VmIncomingMessage, request: Request, onHead: (response: Response) => void) {
		super();
		this.req = req;
		this.socket = req.socket;
		this.#request = request;
		this.#onHead = onHead;
		this.once("close", () => {
			if (!this.writableFinished) this.#body.destroy();
		});
	}

	get connection(): EventEmitter {
		return this.socket;
	}

	get headersSent(): boolean {
		return this.#headersSent;
	}

	get finished(): boolean {
		return this.writableEnded;
	}

	setHeader(name: string, value: HeaderValue): this {
		this.#headers.set(name.toLowerCase(), { name, value });
		return this;
	}

	appendHeader(name: string, value: HeaderValue): this {
		const existing = this.#headers.get(name.toLowerCase());
		if (existing === undefined) return this.setHeader(name, value);
		const values = [existing.value, value].flatMap((entry) =>
			Array.isArray(entry) ? entry : [String(entry)],
		);
		return this.setHeader(existing.name, values);
	}

	getHeader(name: string): HeaderValue | undefined {
		return this.#headers.get(name.toLowerCase())?.value;
	}

	getHeaders(): Record<string, HeaderValue> {
		const headers: Record<string, HeaderValue> = Object.create(null);
		for (const [key, { value }] of this.#headers) headers[key] = value;
		return headers;
	}

	getHeaderNames(): string[] {
		return [...this.#headers.keys()];
	}

	hasHeader(name: string): boolean {
		return this.#headers.has(name.toLowerCase());
	}

	removeHeader(name: string): void {
		this.#headers.delete(name.toLowerCase());
	}

	writeHead(
		statusCode: number,
		message?: string | Record<string, HeaderValue> | readonly string[],
		headers?: Record<string, HeaderValue> | readonly string[],
	): this {
		this.statusCode = statusCode;
		if (typeof message === "string") this.statusMessage = message;
		else headers = message;
		if (isHeaderList(headers)) {
			for (let i = 0; i < headers.length; i += 2) {
				this.appendHeader(String(headers[i]), String(headers[i + 1]));
			}
		} else if (headers !== undefined) {
			for (const [name, value] of Object.entries(headers)) {
				if (value !== undefined) this.setHeader(name, value);
			}
		}
		this.#sendHead();
		return this;
	}

	flushHeaders(): void {
		this.#sendHead();
	}

	// Node calls this when a write or end() comes before writeHead(). Next.js calls it directly.
	_implicitHeader(): void {
		this.#sendHead();
	}

	// workerd has no informational responses, so 103 Early Hints are dropped.
	writeEarlyHints(_hints: Record<string, HeaderValue>, callback?: () => void): void {
		if (callback !== undefined) queueMicrotask(callback);
	}

	writeContinue(): void {}

	setTimeout(): this {
		return this;
	}

	#sendHead(): void {
		if (this.#headersSent) return;
		this.#headersSent = true;
		if (this.statusMessage === "") {
			this.statusMessage = STATUS_CODES[this.statusCode] ?? "unknown";
		}
		const rawHeaders: string[] = [];
		for (const { name, value } of this.#headers.values()) {
			for (const entry of Array.isArray(value) ? value : [value]) {
				rawHeaders.push(name, String(entry));
			}
		}
		this.#onHead(
			toFetchResponse(
				this.#request,
				{ rawHeaders, statusCode: this.statusCode, statusMessage: this.statusMessage },
				this.#body,
			),
		);
	}

	override _write(chunk: Buffer, _encoding: BufferEncoding, callback: WriteCallback): void {
		this.#sendHead();
		if (this.#body.write(chunk)) callback();
		else this.#body.once("drain", () => callback());
	}

	override _final(callback: WriteCallback): void {
		this.#sendHead();
		this.#body.end(callback);
	}
}

function dispatchToServer(
	server: http.Server,
	request: Request,
	env: unknown,
	ctx: unknown,
): Promise<Response> {
	return new Promise<Response>((resolve, reject) => {
		const req = new VmIncomingMessage(request, socketStub());
		// workerd exposes the Worker env, ctx, and cf on the request.
		const cloudflare: Record<string, unknown> = { ctx, env };
		if ("cf" in request) cloudflare.cf = request.cf;
		Reflect.set(req, "cloudflare", cloudflare);
		const res = new VmServerResponse(req, request, resolve);
		res.once("close", () => {
			if (!res.headersSent) reject(new Error("The response closed before it sent headers."));
		});
		try {
			server.emit("request", req, res);
		} catch (error: unknown) {
			// Errors thrown by a request listener reject the fetch, like workerd's
			// synchronous emit.
			reject(error);
			res.destroy();
		}
	});
}

const servers = new WeakSet<object>();

// Gives a VM server instance the host shim's virtual-port listen().
function patchServer(server: http.Server): http.Server {
	let virtualPort: number | null = null;
	const address = (): AddressInfo | null =>
		virtualPort == null ? null : { address: "127.0.0.1", family: "IPv4", port: virtualPort };
	const methods = {
		address,
		close(callback?: (error?: Error) => void) {
			if (virtualPort != null) {
				portMapper.delete(virtualPort);
				virtualPort = null;
			}
			if (typeof callback === "function") server.once("close", callback);
			queueMicrotask(() => server.emit("close"));
			return server;
		},
		closeAllConnections() {},
		closeIdleConnections() {},
		getConnections(callback?: (error: Error | null, count: number) => void) {
			if (callback !== undefined) queueMicrotask(() => callback(null, 0));
			return server;
		},
		listen(...args: unknown[]) {
			const normalized = normalizeListenArgs(args);
			let port = 0;
			if (typeof normalized.port === "number" || typeof normalized.port === "string") {
				port = validatePort(normalized.port, "options.port");
			}
			if (virtualPort != null || portMapper.has(port)) {
				throw new ERR_SERVER_ALREADY_LISTEN();
			}
			if (normalized.callback !== undefined) server.once("listening", normalized.callback);
			virtualPort = findSuitablePort(port);
			portMapper.set(virtualPort, {
				fetch: (request: Request, env?: unknown, ctx?: unknown) =>
					dispatchToServer(server, request, env, ctx),
			});
			queueMicrotask(() => server.emit("listening"));
			return server;
		},
		ref() {
			return server;
		},
		unref() {
			return server;
		},
	};
	for (const [name, value] of Object.entries(methods)) {
		Object.defineProperty(server, name, { configurable: true, value, writable: true });
	}
	Object.defineProperty(server, "listening", {
		configurable: true,
		get: () => virtualPort != null,
	});
	servers.add(server);
	return server;
}

export function createServer(
	options?: http.ServerOptions | http.RequestListener,
	requestListener?: http.RequestListener,
): http.Server {
	const server =
		typeof options === "function" ? http.createServer(options) : http.createServer(options ?? {}, requestListener);
	return patchServer(server);
}

// Works with and without `new`, since a constructor that returns an object
// yields that object.
export const Server = function Server(
	this: unknown,
	options?: http.ServerOptions | http.RequestListener,
	requestListener?: http.RequestListener,
): http.Server {
	return createServer(options, requestListener);
};
Object.defineProperty(Server, Symbol.hasInstance, {
	value: (value: unknown): boolean =>
		typeof value === "object" && value !== null && servers.has(value),
});

// Frameworks such as Express build their request and response prototypes
// from these classes, so they must be the classes that requests use.
export { VmIncomingMessage as IncomingMessage, VmServerResponse as ServerResponse };

export { STATUS_CODES };

export default {
	...http,
	ClientRequest,
	IncomingMessage: VmIncomingMessage,
	STATUS_CODES,
	Server,
	ServerResponse: VmServerResponse,
	createServer,
	get,
	request,
};
