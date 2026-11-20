import {forwardGuestHttpOnBun} from "./agentos-http-bun.js";
import { once } from "node:events";
import { request as httpRequest, type IncomingMessage, type Server } from "node:http";
import type { Duplex } from "node:stream";

export function agentOsSetting(name: string, fallback: number): number {
	const value = Number(process.env[name] ?? fallback);
	if (!Number.isSafeInteger(value) || value < 1 || value > 2147483647) throw new Error(`${name} must be an integer from 1 through 2147483647`);
	return value;
}

export class GuestHttpError extends Error {
	constructor(readonly statusCode: number, message: string) { super(message); }
}

export interface GuestHttpLimits {
	maxRequests: number;
	maxRequestBytes: number;
	requestTimeoutMs: number;
	webSocketIdleTimeoutMs: number;
}

/** Stream native HTTP parsing over bounded VM-local TCP connections. */
export function attachGuestHttpForwarder(server: Server, connect: (request: IncomingMessage) => Promise<Duplex>, limits: GuestHttpLimits, report: (error: unknown) => void): void {
	const { maxRequests, maxRequestBytes, requestTimeoutMs, webSocketIdleTimeoutMs } = limits;
	let activeRequests = 0;
	server.maxConnections = Math.min(2147483647, maxRequests * 2);
	server.headersTimeout = requestTimeoutMs;
	server.requestTimeout = requestTimeoutMs;
	server.on("request", (request, response) => {
		if (activeRequests >= maxRequests) {
			response.writeHead(503).end(`agentOS concurrent request limit ${maxRequests} reached; raise OPENORANGE_AGENTOS_MAX_CONCURRENT_REQUESTS`);
			request.resume();
			return;
		}
		activeRequests++;
		const deadline = setTimeout(() => response.destroy(new Error(`agentOS request exceeded ${requestTimeoutMs} ms; raise OPENORANGE_AGENTOS_REQUEST_TIMEOUT_MS`)), requestTimeoutMs);
		void (async () => {
			const stream = await connect(request);
			if (process.versions.bun !== undefined) { await forwardGuestHttpOnBun(request,response,stream,maxRequestBytes); return; }
			const upstream = httpRequest({
				method: request.method, path: request.url, headers: request.headers,
				createConnection: () => stream,
			});
			let bytes = 0;
			const finished = Promise.withResolvers<void>();
			const closed = () => {
				const error = new Error("Client closed the request");
				upstream.destroy(error); finished.reject(error);
			};
			response.once("close", closed);
			request.once("aborted", closed);
			upstream.once("error", finished.reject);
			upstream.once("response", reply => {
				response.writeHead(reply.statusCode ?? 502, reply.statusMessage, reply.rawHeaders);
				reply.once("error", finished.reject);
				response.once("finish", finished.resolve);
				reply.pipe(response);
			});
			try {
				// Concurrently await the response while each write waits for guest
				// capacity. This supports a response before the upload is complete.
				const upload = (async () => {
					for await (const chunk of request) {
						bytes += chunk.length;
						if (bytes > maxRequestBytes) {
							throw new Error(`agentOS request body exceeds ${maxRequestBytes} bytes; raise OPENORANGE_AGENTOS_MAX_REQUEST_BYTES`);
						}
						if (!upstream.write(chunk)) await once(upstream, "drain");
					}
					upstream.end();
				})();
				await Promise.all([upload, finished.promise]);
			} finally {
				response.off("close", closed); request.off("aborted", closed);
				upstream.destroy(); stream.destroy();
			}
		})().catch(error => {
			report(error);
			if (!response.destroyed) {
				if (error instanceof GuestHttpError && !response.headersSent) { response.writeHead(error.statusCode).end(error.message); request.resume(); }
				else response.destroy(error);
			}
		}).finally(() => { activeRequests--; clearTimeout(deadline); });
	});
	server.on("upgrade", (request, socket, head) => {
		if (activeRequests >= maxRequests) { socket.end("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n"); return; }
		activeRequests++;
		void connect(request).then(stream => {
			const failed = (error: Error) => { report(error); socket.destroy(); stream.destroy(); };
			socket.once("error", failed); stream.once("error", failed);
			const idle = setTimeout(() => failed(new Error(`agentOS WebSocket idle deadline ${webSocketIdleTimeoutMs} ms; raise OPENORANGE_AGENTOS_WEBSOCKET_IDLE_TIMEOUT_MS`)), webSocketIdleTimeoutMs);
			const progress = () => idle.refresh();
			socket.on("data", progress); stream.on("data", progress);
			socket.once("close", () => { activeRequests--; clearTimeout(idle); stream.destroy(); });
			stream.once("close", () => socket.destroy());
			const headers = request.rawHeaders.reduce((text, value, index) => text + value + (index % 2 ? "\r\n" : ": "), "");
			stream.write(`${request.method} ${request.url} HTTP/${request.httpVersion}\r\n${headers}\r\n`);
			if (head.byteLength) stream.write(head);
			socket.pipe(stream).pipe(socket);
		}, error => { activeRequests--; report(error); if (error instanceof GuestHttpError) socket.end(`HTTP/1.1 ${error.statusCode} Rejected\r\nConnection: close\r\n\r\n`); else socket.destroy(); });
	});

}
