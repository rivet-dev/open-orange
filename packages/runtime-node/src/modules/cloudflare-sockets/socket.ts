// cloudflare:sockets over Node.js TCP and TLS sockets, and over in-process
// pipes for service bindings. The observable behavior mirrors workerd's Socket:
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/sockets.c++#L95-L800

import { Duplex } from "node:stream";
import { connect as tlsConnect, type ConnectionOptions } from "node:tls";

import { connectHappyEyeballs } from "../../internal/happy-eyeballs.js";
import { virtualHostFetcher } from "../../internal/virtual-hosts.js";
import { currentGlobalOutbound, globalOutboundBlockedError } from "../../internal/global-outbound.js";

// Node.js passes allowHalfOpen through to the underlying net.Socket.
type TlsOptionsWithHalfOpen = ConnectionOptions & { allowHalfOpen: boolean };

export interface SocketAddress {
	hostname: string;
	port: number;
}

export interface SocketOptions {
	secureTransport?: "off" | "on" | "starttls";
	allowHalfOpen?: boolean;
	highWaterMark?: number;
}

export interface SocketInfo {
	remoteAddress?: string;
	localAddress?: string;
}

export interface TlsOptions {
	expectedServerHostname?: string;
}

type SecureTransport = "off" | "on" | "starttls";

interface Deferred<T> {
	promise: Promise<T>;
	resolve(value: T): void;
	reject(reason: unknown): void;
}

function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	// workerd marks these promises as handled.
	promise.catch(() => {});
	return { promise, resolve, reject };
}

// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/sockets.c++#L101-L134
function isValidHost(host: string): boolean {
	return host.length > 0 && host.length <= 255 && /^[A-Za-z0-9\-._[\]:]*$/.test(host);
}

function parseSecureTransport(options: SocketOptions | undefined): SecureTransport {
	const value = options?.secureTransport;
	if (value === undefined) return "off";
	const text = String(value);
	if (text === "off" || text === "on" || text === "starttls") return text;
	throw new TypeError(
		`Unsupported value in secureTransport socket option: ${text}`,
	);
}

interface ParsedAddress {
	address: string;
	hostname: string;
	port: number;
	isDefaultFetchPort: boolean;
}

// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/sockets.c++#L366-L421
function parseAddress(address: string | SocketAddress): ParsedAddress {
	let hostname: string;
	let port: number;
	let text: string;
	if (typeof address === "string") {
		let url: URL;
		try {
			url = new URL(`fake://${address}`);
		} catch {
			throw new TypeError("Specified address could not be parsed.");
		}
		if (url.hostname === "") {
			throw new TypeError("Specified address is missing hostname.");
		}
		if (url.port === "") {
			throw new TypeError("Specified address is missing port.");
		}
		hostname = url.hostname;
		port = Number(url.port);
		text = address;
	} else {
		hostname = String(address.hostname);
		port = Number(address.port);
		text = `${hostname}:${port}`;
	}
	if (!isValidHost(text)) {
		throw new TypeError(
			"Specified address is empty string, contains unsupported characters or is too long.",
		);
	}
	return {
		address: text,
		hostname: hostname.replace(/^\[(.*)\]$/, "$1"),
		port,
		isDefaultFetchPort: port === 443 || port === 80,
	};
}

function toBytes(chunk: unknown): Uint8Array {
	if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk);
	if (ArrayBuffer.isView(chunk)) {
		return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
	}
	throw new TypeError("This WritableStream only supports writing byte types.");
}

function connectionError(parsed: ParsedAddress): Error {
	let message = "proxy request failed, cannot connect to the specified address";
	if (parsed.isDefaultFetchPort) {
		message +=
			". It looks like you might be trying to connect to a HTTP-based service — consider using fetch instead";
	}
	return new Error(message);
}

// One end of an in-process connection: bytes written to one end are read from
// the other. When an end is destroyed, the other end reads to EOF after the
// bytes already sent, drops later writes, and resolves `peerClosed`.
class SocketPipeEnd extends Duplex {
	#peer: SocketPipeEnd | undefined;
	#sentEnd = false;
	// A write waits here while the peer has a full buffer.
	#blockedWrite: (() => void) | undefined;
	readonly #peerClosed = Promise.withResolvers<void>();

	static pair(): [SocketPipeEnd, SocketPipeEnd] {
		const first = new SocketPipeEnd();
		const second = new SocketPipeEnd();
		first.#peer = second;
		second.#peer = first;
		return [first, second];
	}

	private constructor() {
		super({ allowHalfOpen: true });
	}

	get peerClosed(): Promise<void> {
		return this.#peerClosed.promise;
	}

	#unblockWrite(): void {
		const callback = this.#blockedWrite;
		this.#blockedWrite = undefined;
		callback?.();
	}

	#endPeerInput(): void {
		if (this.#sentEnd) return;
		this.#sentEnd = true;
		this.#peer?.push(null);
	}

	override _read(): void {
		const peer = this.#peer;
		if (peer !== undefined) peer.#unblockWrite();
	}

	override _write(
		chunk: Buffer,
		_encoding: BufferEncoding,
		callback: (error?: Error | null) => void,
	): void {
		const peer = this.#peer;
		// Copy, so the writer can reuse its buffer once the write completes.
		if (peer === undefined || peer.push(Buffer.from(chunk))) callback();
		else this.#blockedWrite = callback;
	}

	override _final(callback: (error?: Error | null) => void): void {
		this.#endPeerInput();
		callback();
	}

	override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
		const peer = this.#peer;
		this.#endPeerInput();
		this.#peer = undefined;
		this.#unblockWrite();
		if (peer !== undefined) {
			peer.#peer = undefined;
			peer.#unblockWrite();
			peer.#peerClosed.resolve();
		}
		callback(error);
	}
}

const kCreate = Symbol("open-orange.socket.create");

// An outbound connection that is still racing a hostname's addresses. `abort` stops every
// attempt, and closes a connection that wins anyway.
interface PendingConnection {
	connected: Promise<Duplex>;
	abort(): void;
}

interface SocketInit {
	connection: Duplex | PendingConnection;
	parsed: ParsedAddress;
	options: SocketOptions | undefined;
	secureTransport: SecureTransport;
	opened: Promise<void>;
	// What `opened` resolves with.
	info: SocketInfo;
	// A socket received over RPC is already open and cannot start TLS.
	transferred: boolean;
}

type ConnectionListener = Parameters<Duplex["on"]>[1];

let transferSocketInternal: (socket: Socket) => Socket;
let neuterSocketInternal: (socket: Socket, error: Error) => void;
let createSocket: (init: SocketInit) => Socket;

export class Socket {
	readonly #parsed: ParsedAddress;
	readonly #options: SocketOptions | undefined;
	readonly #secureTransport: SecureTransport;
	readonly #info: SocketInfo;
	readonly #opened = deferred<SocketInfo>();
	readonly #closed = deferred<void>();
	readonly #readable: ReadableStream<Uint8Array>;
	readonly #writable: WritableStream<unknown>;
	readonly #listeners: Array<[string, ConnectionListener]> = [];
	#connection: Duplex | undefined;
	#pending: PendingConnection | undefined;
	// A read waits for the pending connection.
	#resumeOnConnect = false;
	readonly #allowHalfOpen: boolean;
	#readController: ReadableByteStreamController | undefined;
	#writeController: WritableStreamDefaultController | undefined;
	#openedState: "pending" | "opened" | "failed" = "pending";
	#detached = false;
	#closing = false;
	#upgraded = false;
	#startedTls = false;

	static {
		transferSocketInternal = (socket) => socket.#transfer();
		neuterSocketInternal = (socket, error) => socket.#neuter(error);
		createSocket = (init) => new Socket(kCreate, init);
	}

	// Private keeps SocketInit, which holds a Node Duplex, out of the public declarations.
	private constructor(badge: symbol, init: SocketInit) {
		if (badge !== kCreate) throw new TypeError("Illegal constructor");
		const { connection, parsed, options, secureTransport, opened, info, transferred } = init;
		this.#parsed = parsed;
		this.#options = options;
		this.#secureTransport = secureTransport;
		this.#info = info;
		this.#allowHalfOpen = options?.allowHalfOpen === true;

		this.#readable = new ReadableStream({
			type: "bytes",
			start: (controller) => {
				this.#readController = controller;
			},
			pull: () => {
				if (this.#connection === undefined) this.#resumeOnConnect = true;
				this.#connection?.resume();
			},
			cancel: () => {
				this.#destroyConnection();
			},
		});
		this.#writable = new WritableStream<unknown>(
			{
				start: (controller) => {
					this.#writeController = controller;
				},
				write: async (chunk) => {
					const bytes = toBytes(chunk);
					await this.#opened.promise;
					const target = this.#connection;
					if (target === undefined || this.#detached) {
						throw new TypeError("This WritableStream has been closed.");
					}
					if (bytes.byteLength === 0) return;
					await new Promise<void>((resolve, reject) => {
						target.write(bytes, (error) => (error ? reject(error) : resolve()));
					});
				},
				close: async () => {
					await this.#opened.promise;
					this.#connection?.end();
				},
				abort: () => {
					this.#destroyConnection();
				},
			},
			options?.highWaterMark === undefined
				? undefined
				: { highWaterMark: options.highWaterMark },
		);

		let ready = opened;
		if (connection instanceof Duplex) {
			this.#attach(connection);
		} else {
			// `opened` resolves only after the winning connection is attached, so a write that
			// waits for it has a connection.
			this.#pending = connection;
			ready = connection.connected.then(
				(connected) => {
					if (this.#pending !== connection) return opened;
					this.#pending = undefined;
					this.#attach(connected);
					return opened;
				},
				(error: unknown) => {
					if (this.#pending === connection) {
						this.#pending = undefined;
						this.#fail(connectionError(parsed));
					}
					throw error;
				},
			);
		}
		if (transferred) {
			this.#startedTls = true;
			this.#openedState = "opened";
			this.#opened.resolve(info);
			return;
		}
		ready.then(
			() => {
				this.#openedState = "opened";
				this.#opened.resolve(info);
			},
			() => {},
		);
	}

	#attach(connection: Duplex): void {
		this.#connection = connection;
		connection.pause();
		this.#listen(connection, "data", (data: Buffer) => {
			const controller = this.#readController;
			if (controller === undefined || this.#detached) return;
			controller.enqueue(new Uint8Array(data));
			if ((controller.desiredSize ?? 0) <= 0) connection.pause();
		});
		this.#listen(connection, "end", () => {
			if (this.#detached) return;
			try {
				this.#readController?.close();
			} catch {
				// The stream was already canceled.
			}
			// Without allowHalfOpen the write side closes once the peer sends EOF.
			// A writer the user holds, such as a pipeTo(), closes the stream itself.
			// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/sockets.c++#L763-L800
			if (!this.#allowHalfOpen && !this.#writable.locked) {
				const writer = this.#writable.getWriter();
				writer
					.close()
					.catch(() => {})
					.finally(() => writer.releaseLock());
			}
		});
		this.#listen(connection, "error", (error: Error) => {
			if (this.#detached) return;
			this.#fail(this.#openedState === "opened" ? error : connectionError(this.#parsed));
		});
		this.#listen(connection, "close", () => {
			if (this.#detached) return;
			this.#resolveClosed();
		});
		// `closed` resolves when the peer of an in-process connection disconnects,
		// even if this side never reads to EOF.
		if (connection instanceof SocketPipeEnd) {
			void connection.peerClosed.then(() => {
				if (!this.#detached) this.#resolveClosed();
			});
		}
		if (this.#resumeOnConnect) connection.resume();
	}

	// Closes the connection, or stops connecting. Stopping a pending connect resolves `closed`, as
	// destroying a connecting socket does.
	#destroyConnection(): void {
		this.#connection?.destroy();
		const pending = this.#pending;
		if (pending === undefined) return;
		this.#pending = undefined;
		pending.abort();
		if (!this.#detached) this.#resolveClosed();
	}

	#listen(connection: Duplex, event: string, listener: ConnectionListener): void {
		connection.on(event, listener);
		this.#listeners.push([event, listener]);
	}

	#resolveClosed(): void {
		this.#closed.resolve();
	}

	#fail(error: Error): void {
		if (this.#openedState === "pending") this.#openedState = "failed";
		this.#opened.reject(error);
		this.#closed.reject(error);
		try {
			this.#readController?.error(error);
		} catch {
			// The stream already finished.
		}
		this.#writable.abort(error).catch(() => {});
		this.#destroyConnection();
	}

	// Moves the connection to a new Socket for the receiver of an RPC call.
	// The transfer keeps `opened` info, secureTransport and allowHalfOpen.
	// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/sockets.c++#L804-L1044
	#transfer(): Socket {
		if (this.#openedState === "pending") {
			throw new DOMException(
				"A Socket can only be serialized after it has opened. Await `socket.opened` before transferring the socket over RPC.",
				"DataCloneError",
			);
		}
		if (this.#openedState === "failed") {
			throw new DOMException(
				"A Socket whose connection failed cannot be serialized.",
				"DataCloneError",
			);
		}
		if (this.#readable.locked) {
			throw new TypeError("The ReadableStream has been locked to a reader.");
		}
		if (this.#writable.locked) {
			throw new TypeError("The WritableStream has been locked to a writer.");
		}
		const connection = this.#connection;
		if (connection === undefined) {
			throw new TypeError("The socket was closed before it could be transferred.");
		}
		this.#detached = true;
		this.#connection = undefined;
		for (const [event, listener] of this.#listeners) {
			connection.removeListener(event, listener);
		}
		return createSocket({
			connection,
			info: this.#info,
			opened: Promise.resolve(),
			options: { allowHalfOpen: this.#options?.allowHalfOpen === true },
			parsed: this.#parsed,
			secureTransport: this.#secureTransport,
			transferred: true,
		});
	}

	// Ends an inbound socket when its connect() handler finishes: later reads
	// and writes fail with `error`, and the peer reads EOF.
	// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/global-scope.c%2B%2B#L229-L238
	#neuter(error: Error): void {
		this.#readController?.error(error);
		this.#writeController?.error(error);
		this.#connection?.destroy();
	}

	get readable(): ReadableStream<Uint8Array> {
		return this.#readable;
	}

	get writable(): WritableStream<unknown> {
		return this.#writable;
	}

	get opened(): Promise<SocketInfo> {
		return this.#opened.promise;
	}

	get closed(): Promise<void> {
		return this.#closed.promise;
	}

	get upgraded(): boolean {
		return this.#upgraded;
	}

	get secureTransport(): SecureTransport {
		return this.#secureTransport;
	}

	// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/sockets.c++#L478-L520
	async close(): Promise<void> {
		if (this.#closing) return this.#closed.promise;
		this.#closing = true;
		try {
			await this.#opened.promise.catch(() => {});
			await this.#readable.cancel().catch(() => {});
			await this.#writable.abort().catch(() => {});
			this.#connection?.destroy();
			this.#connection = undefined;
			this.#resolveClosed();
		} catch (error: unknown) {
			this.#closed.reject(error);
		}
		return this.#closed.promise;
	}

	// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/sockets.c++#L522-L627
	startTls(options?: TlsOptions): Socket {
		if (this.#secureTransport === "on") {
			throw new TypeError("Cannot startTls on a TLS socket.");
		}
		const connection = this.#connection;
		const pending = this.#pending;
		if (connection === undefined && pending === undefined) {
			throw new TypeError(
				"The connection was closed before startTls could be started.",
			);
		}
		if (this.#secureTransport !== "starttls") {
			throw new TypeError(
				"The `secureTransport` socket option must be set to 'starttls' for startTls to be used.",
			);
		}
		if (this.#startedTls) {
			throw new TypeError(
				"startTls has already been called on this socket, or the socket was transferred over RPC.",
			);
		}
		this.#startedTls = true;
		const servername = options?.expectedServerHostname ?? this.#parsed.hostname;
		// Detach the plain-text streams and hand the connection to TLS. Bytes
		// already passed to the connection are flushed before the handshake.
		this.#detached = true;
		this.#upgraded = true;
		this.#connection = undefined;
		this.#pending = undefined;
		connection?.removeAllListeners("data");
		connection?.removeAllListeners("end");
		try {
			this.#readController?.close();
		} catch {
			// The stream was already canceled.
		}
		this.#resolveClosed();
		const opened = deferred<void>();
		const upgrade = (plain: Duplex): Duplex => {
			const tlsOptions: TlsOptionsWithHalfOpen = {
				allowHalfOpen: true,
				servername,
				socket: plain,
			};
			const secure = tlsConnect(tlsOptions);
			secure.once("secureConnect", () => opened.resolve());
			secure.once("error", (error) => opened.reject(error));
			return secure;
		};
		return createSocket({
			connection:
				connection === undefined
					? { abort: pending!.abort, connected: pending!.connected.then(upgrade) }
					: upgrade(connection),
			info: this.#info,
			opened: opened.promise,
			options: this.#options,
			parsed: this.#parsed,
			secureTransport: "on",
			transferred: false,
		});
	}
}

// Moves a Socket into the receiver of an RPC call. The sender's copy stops
// reading and writing.
export function transferSocket(socket: Socket): Socket {
	return transferSocketInternal(socket);
}

// Connects to an in-process connect() handler, as a service binding's
// connect() does. `serve` runs after the caller's turn, like a network
// connection. It calls `accept` to get the handler's socket, which also opens
// the caller's socket. When `serve` settles the handler's socket is neutered.
// If `serve` rejects before `accept`, the caller's socket fails to open.
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/global-scope.c%2B%2B#L220-L262
export function connectInProcess(
	address: string | SocketAddress,
	options: SocketOptions | undefined,
	serve: (accept: () => Socket) => Promise<void>,
): Socket {
	const parsed = parseAddress(address);
	const secureTransport = parseSecureTransport(options);
	const [clientEnd, serverEnd] = SocketPipeEnd.pair();
	const opened = deferred<void>();
	const client = createSocket({
		connection: clientEnd,
		info: { remoteAddress: parsed.address },
		opened: opened.promise,
		options,
		parsed,
		secureTransport,
		transferred: false,
	});
	let server: Socket | undefined;
	const accept = (): Socket => {
		// The handler's socket sees the address the caller connected to.
		server = createSocket({
			connection: serverEnd,
			info: { localAddress: parsed.address },
			opened: Promise.resolve(),
			options: undefined,
			parsed,
			secureTransport: "off",
			transferred: false,
		});
		opened.resolve();
		return server;
	};
	const finish = (error?: unknown): void => {
		if (server !== undefined) {
			neuterSocketInternal(
				server,
				new TypeError("Can't read from request stream because client disconnected."),
			);
			return;
		}
		const failure =
			error instanceof Error ? error : new Error("The connection was not accepted.");
		opened.reject(failure);
		serverEnd.destroy();
		clientEnd.destroy(failure);
	};
	setImmediate(() => {
		serve(accept).then(() => finish(), finish);
	});
	return client;
}

// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/sockets.c++#L366-L476
export function connect(
	address: string | SocketAddress,
	options?: SocketOptions,
): Socket {
	const parsed = parseAddress(address);
	const outbound = currentGlobalOutbound();
	if (outbound === null) throw globalOutboundBlockedError();
	if (outbound !== undefined) {
		throw new Error(
			"OpenOrange does not support connect() through a dynamic Worker's globalOutbound fetcher. Use fetch() instead.",
		);
	}
	// Hosts from ctx.mapVirtualHost() connect through their fetcher, ignoring
	// the options.
	// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/sockets.c++#L425-L438
	const fetcher = virtualHostFetcher(parsed.address);
	if (fetcher !== undefined) {
		const connectVia: unknown = Reflect.get(fetcher, "connect");
		const socket: unknown =
			typeof connectVia === "function"
				? Reflect.apply(connectVia, fetcher, [parsed.address])
				: undefined;
		if (!(socket instanceof Socket)) {
			throw new TypeError(`${parsed.address} is not mapped to a fetcher that supports connect().`);
		}
		return socket;
	}
	const secureTransport = parseSecureTransport(options);
	const opened = deferred<void>();
	const abort = new AbortController();
	// Node.js keeps both directions open so this module can apply allowHalfOpen.
	const connected = connectHappyEyeballs({
		allowHalfOpen: true,
		host: parsed.hostname,
		port: parsed.port,
		signal: abort.signal,
	}).then((plain): Duplex => {
		if (secureTransport !== "on") {
			opened.resolve();
			return plain;
		}
		const tlsOptions: TlsOptionsWithHalfOpen = {
			allowHalfOpen: true,
			servername: parsed.hostname,
			socket: plain,
		};
		const secure = tlsConnect(tlsOptions);
		secure.once("secureConnect", () => opened.resolve());
		secure.once("error", (error) => opened.reject(error));
		return secure;
	});
	connected.catch((error: unknown) => opened.reject(error));
	return createSocket({
		connection: {
			abort: () => {
				abort.abort();
				// The race can win just before the abort.
				connected.then((connection) => connection.destroy(), () => {});
			},
			connected,
		},
		info: { remoteAddress: parsed.address },
		opened: opened.promise,
		options,
		parsed,
		secureTransport,
		transferred: false,
	});
}
