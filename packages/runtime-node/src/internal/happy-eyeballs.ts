// Outbound TCP connects that race a hostname's addresses, as RFC 8305 (Happy Eyeballs v2) does.
// Node's own `autoSelectFamily` closes each attempt when its timer fires, so a working address
// that needs longer than the timer never connects. Here earlier attempts keep running, and the
// first to connect wins.
//
// workerd's kj tries one address at a time, and moves on only when a connect fails:
// https://github.com/capnproto/capnproto/blob/be8fbe7bc7ad6c5cc8106385a1919df7222b1e5e/c%2B%2B/src/kj/async-io-unix.c%2B%2B#L1636-L1671

import { ADDRCONFIG, lookup, type LookupAddress } from "node:dns";
import { connect, isIP, type Socket, type TcpNetConnectOpts } from "node:net";

// The wait before the next attempt starts. RFC 8305 recommends 250 ms; curl uses 200 ms.
// https://www.rfc-editor.org/rfc/rfc8305#section-5
// https://github.com/curl/curl/blob/a0a06bfe3d2243048b81b159e14fc8fcabb5dfc9/include/curl/curl.h#L975-L979
const connectionAttemptDelayMs = 250;

export interface HappyEyeballsOptions {
	host: string;
	port: number;
	allowHalfOpen?: boolean;
	highWaterMark?: number;
	signal?: AbortSignal;
}

/**
 * Connects to the first of `host`'s addresses that accepts. Resolves with the connected socket.
 * When every address fails, it rejects with the error Node's `net.connect()` gives: the single
 * error for one address, or an `AggregateError` with the first error's `code` for more.
 */
export async function connectHappyEyeballs(options: HappyEyeballsOptions): Promise<Socket> {
	const addresses = interleaveFamilies(await lookupAll(options.host));
	options.signal?.throwIfAborted();
	return raceAddresses(addresses, options);
}

function lookupAll(host: string): Promise<LookupAddress[]> {
	const family = isIP(host);
	if (family !== 0) return Promise.resolve([{ address: host, family }]);
	return new Promise((resolve, reject) => {
		// net.connect() passes the same hint, so a host without IPv6 gets no IPv6 addresses.
		const hints = process.platform === "win32" ? 0 : ADDRCONFIG;
		lookup(host, { all: true, hints }, (error, addresses) => (error ? reject(error) : resolve(addresses)));
	});
}

// RFC 8305 section 4: keep the resolver's first address first, then alternate families. Each
// address is tried once, as net.connect() does.
// https://www.rfc-editor.org/rfc/rfc8305#section-4
function interleaveFamilies(resolved: LookupAddress[]): LookupAddress[] {
	const seen = new Set<string>();
	const addresses = resolved.filter(({ address }) => !seen.has(address) && seen.add(address));
	const first = addresses[0]?.family;
	const preferred = addresses.filter((address) => address.family === first);
	const other = addresses.filter((address) => address.family !== first);
	const ordered: LookupAddress[] = [];
	for (let index = 0; index < Math.max(preferred.length, other.length); index++) {
		if (index < preferred.length) ordered.push(preferred[index]!);
		if (index < other.length) ordered.push(other[index]!);
	}
	return ordered;
}

function raceAddresses(addresses: LookupAddress[], options: HappyEyeballsOptions): Promise<Socket> {
	const { port, signal } = options;
	return new Promise((resolve, reject) => {
		const attempts = new Set<Socket>();
		const errors: Error[] = [];
		let next = 0;
		let timer: NodeJS.Timeout | undefined;
		let settled = false;

		const settle = (winner?: Socket): void => {
			settled = true;
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			for (const attempt of attempts) {
				if (attempt !== winner) attempt.destroy();
			}
			attempts.clear();
		};
		const onAbort = (): void => {
			settle();
			reject(signal?.reason);
		};
		const startNext = (): void => {
			clearTimeout(timer);
			const index = next++;
			const target = addresses[index];
			if (target === undefined) return;
			// net.connect() passes highWaterMark to the socket's streams; @types/node leaves it out.
			const connectOptions: TcpNetConnectOpts & { highWaterMark?: number } = {
				allowHalfOpen: options.allowHalfOpen,
				family: target.family,
				highWaterMark: options.highWaterMark,
				host: target.address,
				port,
			};
			const attempt = connect(connectOptions);
			attempts.add(attempt);
			attempt.once("connect", () => {
				attempt.removeListener("error", onError);
				settle(attempt);
				resolve(attempt);
			});
			const onError = (error: Error): void => {
				if (settled) return;
				attempts.delete(attempt);
				errors[index] = error;
				if (next < addresses.length) {
					startNext();
				} else if (attempts.size === 0) {
					settle();
					const failures = errors.filter((value) => value !== undefined);
					reject(failures.length === 1 ? failures[0] : aggregateError(failures));
				}
			};
			attempt.once("error", onError);
			if (next < addresses.length) timer = setTimeout(startNext, connectionAttemptDelayMs);
		};

		signal?.addEventListener("abort", onAbort, { once: true });
		startNext();
	});
}

// The error `net.connect()` gives when every address of a hostname fails.
function aggregateError(errors: Error[]): AggregateError {
	const error = new AggregateError(errors);
	const { code } = errors[0] as NodeJS.ErrnoException;
	return Object.assign(error, { code });
}
