import { setTimeout as delay } from "node:timers/promises";

/** The close that tells a WebSocket client to reconnect, because this runtime stops. */
export const webSocketDrainClose = { code: 1012, reason: "Service Restart" } as const;

// A Rivet actor WebSocket cannot send 1012, so the actor sends this close, and the Worker side of
// the socket gives its client `webSocketDrainClose` instead.
export const webSocketDrainTransportClose = {
	code: 1011,
	reason: "open-orange:service-restart",
} as const;

// A stopping runtime closes its accepted WebSockets at random times in a window, so their clients don't all
// reconnect at once. The window grows by 10 ms per socket, up to 10 seconds, so a runtime with few
// sockets still stops at once.
const drainSpacingMs = 10;
const maximumDrainWindowMs = 10_000;

/** Closes one WebSocket. Resolves when it is closed or given up on. */
export type WebSocketDrainCloser = (() => Promise<void>) & {
	/** A client may disconnect before its scheduled drain starts. */
	readonly closed?: Promise<void>;
};

export function webSocketDrainWindowMs(sockets: number): number {
	return Math.min(maximumDrainWindowMs, sockets * drainSpacingMs);
}

/** Runs each closer at a random time in the drain window, and resolves when all are done. */
export async function drainWebSockets(closers: readonly WebSocketDrainCloser[]): Promise<void> {
	const windowMs = webSocketDrainWindowMs(closers.length);
	await Promise.all(
		closers.map(async (close) => {
			if (close.closed === undefined) {
				await delay(Math.random() * windowMs);
				await close();
				return;
			}
			const waiting = new AbortController();
			try {
				const due = await Promise.race([
					delay(Math.random() * windowMs, undefined, { signal: waiting.signal }).then(() => true),
					close.closed.then(() => false),
				]);
				if (due) await close();
			} finally {
				waiting.abort();
			}
		}),
	);
}
