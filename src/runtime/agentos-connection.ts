import { Duplex } from "node:stream";

export interface GuestConnection {
	read(maxBytes?: number): Promise<{ body: Uint8Array; done: boolean }>;
	write(bytes: Uint8Array): Promise<void>;
	end(): Promise<void>;
	close(): Promise<void>;
}

/** Node HTTP and WebSocket parsers operate over the same bounded guest TCP stream. */
export function guestDuplex(connection: GuestConnection): Duplex {
	let reading = false;
	return new Duplex({
		allowHalfOpen: true,
		read() {
			if (reading) return;
			reading = true;
			void connection.read(65536).then(({ body, done }) => {
				reading = false;
				if (body.byteLength) this.push(body);
				if (done) this.push(null);
			}, error => { reading = false; this.destroy(error); });
		},
		write(chunk, _encoding, callback) {
			void connection.write(chunk).then(() => callback(), callback);
		},
		final(callback) { void connection.end().then(() => callback(), callback); },
		destroy(error, callback) { void connection.close().then(() => callback(error), closeError => callback(error ?? closeError)); },
	});
}
