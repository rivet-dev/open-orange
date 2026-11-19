// The undici dispatcher for a Worker's outbound fetch(). It connects with Happy Eyeballs, then
// hands https sockets to undici's own connector, which adds TLS with the same SNI, ALPN, session
// cache and keep-alive as undici's default dispatcher.

import type { Socket } from "node:net";
import { Agent, buildConnector, errors } from "undici";

import { connectHappyEyeballs } from "./happy-eyeballs.js";

// undici's default `connectTimeout`. This one timer covers DNS, every attempt and the TLS
// handshake, so undici's own connector timer is off.
const connectTimeoutMs = 10_000;
// undici's default for plain-text sockets.
const plainTextHighWaterMark = 64 * 1024;
const keepAliveInitialDelayMs = 60_000;

const tlsConnector = buildConnector({ timeout: 0 });

function connectWorkerFetch(options: buildConnector.Options, callback: buildConnector.Callback): void {
	const { hostname, protocol } = options;
	const secure = protocol === "https:";
	const port = Number(options.port) || (secure ? 443 : 80);
	const abort = new AbortController();
	let connected: Socket | undefined;
	let finished = false;
	const finish = (...result: Parameters<buildConnector.Callback>): void => {
		if (finished) {
			result[1]?.destroy();
			return;
		}
		finished = true;
		clearTimeout(timer);
		callback(...result);
	};
	// The same error undici's connector gives when its timer fires.
	const timer = setTimeout(() => {
		const error = new errors.ConnectTimeoutError(
			`Connect Timeout Error (attempted address: ${hostname}:${port}, timeout: ${connectTimeoutMs}ms)`,
		);
		abort.abort(error);
		connected?.destroy(error);
		finish(error, null);
	}, connectTimeoutMs);
	connectHappyEyeballs({
		host: hostname,
		highWaterMark: secure ? undefined : plainTextHighWaterMark,
		port,
		signal: abort.signal,
	}).then(
		(socket) => {
			if (finished) {
				socket.destroy();
				return;
			}
			connected = socket;
			if (secure) {
				tlsConnector({ ...options, httpSocket: socket }, finish);
				return;
			}
			socket.setKeepAlive(true, keepAliveInitialDelayMs).setNoDelay(true);
			finish(null, socket);
		},
		(error: Error) => finish(error, null),
	);
}

export const workerFetchDispatcher = new Agent({ connect: connectWorkerFetch });
