import { Buffer } from "node:buffer";
import { once } from "node:events";
import type { Duplex } from "node:stream";

import { openOrangeInternalHeaderPrefix } from "../bindings/durable-objects/transport-head.js";
import { durableObjectTransportResponseHeaders } from "../bindings/durable-objects/transport-head.js";
import type { Response } from "../globals/http.js";
import { closeWriter, readerOf, writeTo, writerOf } from "../internal/stream-methods.js";
import type { Socket, SocketAddress, SocketOptions } from "../modules/cloudflare-sockets/socket.js";

// Calls between the Workers of an `orange dev` session go over loopback HTTP
// to the callee runtime's session server.
export const sessionRoutes = {
	connect: "/connect",
	fetch: "/fetch",
	rpc: "/rpc",
} as const;

// The `upgrade` value of a connect() tunnel, which carries raw bytes.
export const connectTunnelProtocol = "open-orange-connect";

// Pumps a Socket and a tunnel both ways. An end travels as a half-close, so one direction ending doesn't
// close the other, and `destroyOnReturn: false` keeps the tunnel open after its reading side ends. The
// tunnel lasts until the socket closes with its handler, or the other side drops it, as a connect()
// in one process ends when its handler returns. A close from the far side looks like a half-close here,
// so the caller's side passes `endsWithInbound` for a socket without `allowHalfOpen`.
export async function pipeSocketToTunnel(socket: Socket, tunnel: Duplex, endsWithInbound = false): Promise<void> {
	const tunnelClosed = once(tunnel, "close").catch(() => undefined);
	const inbound = (async (): Promise<void> => {
		const writer = writerOf(socket.writable as unknown as WritableStream<Uint8Array>);
		for await (const chunk of tunnel.iterator({ destroyOnReturn: false })) {
			await writeTo(writer, new Uint8Array(chunk as Buffer));
		}
		await closeWriter(writer);
	})().catch(() => undefined);
	const outbound = (async (): Promise<void> => {
		const reader = readerOf(socket.readable as unknown as ReadableStream<Uint8Array>);
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!tunnel.write(value)) await once(tunnel, "drain");
		}
		// Flushed before a close below can drop it.
		await new Promise<void>((resolve) => tunnel.end(resolve));
	})().catch(() => undefined);
	try {
		await Promise.race([
			Promise.all([inbound, outbound]),
			tunnelClosed.then(() => inbound),
			...(endsWithInbound ? [inbound] : []),
			socket.closed.then(
				() => outbound,
				() => outbound,
			),
		]);
	} finally {
		tunnel.destroy();
	}
}

export const sessionTokenHeader = `${openOrangeInternalHeaderPrefix}session-token`;
export const serviceTargetHeader = `${openOrangeInternalHeaderPrefix}service-target`;

// Which entrypoint a call reaches, with the binding's props. A connect() call
// also carries the address and options the caller passed.
export interface ServiceTarget {
	worker?: string;
	address?: string | SocketAddress;
	entrypoint: string;
	props?: unknown;
	socketOptions?: SocketOptions;
}

export function encodeServiceTarget(target: ServiceTarget): string {
	return Buffer.from(JSON.stringify(target), "utf8").toString("base64");
}

export function readServiceTarget(value: string | undefined): ServiceTarget {
	if (value === undefined) throw new TypeError("Service request is missing its target");
	const target: unknown = JSON.parse(Buffer.from(value, "base64").toString("utf8"));
	if (
		typeof target !== "object" ||
		target === null ||
		typeof Reflect.get(target, "entrypoint") !== "string"
	) {
		throw new TypeError("Service request target is invalid");
	}
	// SAFETY: Only an authenticated session peer sends this header, and it encodes it with
	// encodeServiceTarget. The required `entrypoint` field was checked above.
	return target as ServiceTarget;
}

// The callee's response head travels in one header, so the HTTP hop between
// runtimes cannot change it. The body is already decoded, so the hop never
// declares a content coding.
export function serviceResponseHeadHeaders(response: Response): [string, string][] {
	return durableObjectTransportResponseHeaders(response.headers, response.statusText).filter(
		([name]) => name !== "content-encoding",
	);
}
