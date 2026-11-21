// The exports of `ws` 8 that the agentOS build of node:http uses.
import type { Duplex } from "node:stream";

// Parses the WebSocket frames written to it. `write` returns false while it is behind.
export class Receiver {
	constructor(options: { isServer: boolean });
	write(chunk: Buffer): boolean;
	on(event: "conclude", listener: (code: number, reason: Buffer) => void): this;
	on(event: "message", listener: (data: Buffer, isBinary: boolean) => void): this;
	on(event: "ping", listener: (data: Buffer) => void): this;
	on(event: "error", listener: (error: Error) => void): this;
	on(event: "drain", listener: () => void): this;
}

// Writes WebSocket frames to `socket`. `generateMask` fills the 4-byte mask of each frame.
export class Sender {
	constructor(socket: Duplex, extensions: object, generateMask: (mask: Buffer) => void);
	close(code: number | undefined, reason: string | undefined, mask: boolean, callback?: (error?: Error) => void): void;
	pong(data: Buffer, mask: boolean, callback?: (error?: Error) => void): void;
	send(
		data: string | ArrayBuffer | ArrayBufferView,
		options: { binary: boolean; compress: boolean; fin: boolean; mask: boolean },
		callback?: (error?: Error) => void,
	): void;
}
