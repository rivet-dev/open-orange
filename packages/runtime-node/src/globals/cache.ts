import CachePolicy from "http-cache-semantics";

import { bodyChunkBytes, Headers, Request, Response } from "./http.js";

// The Cache API. By default Orange stores entries in one internal Rivet Actor
// per cache name, like Miniflare's cache plugin, so entries survive `orange
// dev` restarts. With ORANGE_CACHE=off, or before the runtime configures a
// backend, it behaves as on workers.dev subdomains, where every operation
// succeeds and stores nothing.
// https://developers.cloudflare.com/workers/runtime-apis/cache/
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/cache.c%2B%2B#L66-L607

const constructionToken = Symbol("open-orange.cache");

// Cloudflare caps a cached object at 512 MB and a cache name at 1,024 characters. Those are
// Cloudflare quotas, which Orange does not copy. The cache stores an entry in chunks, one commit
// each, so Rivet's commit limit does not bound an entry either.

export interface CacheEntryMetadata {
	expiresAt: number;
	// Header pairs as stored, with lower-case names.
	headers: [string, string][];
	status: number;
}

export interface CacheBodyRange {
	length: number;
	offset: number;
}

export interface CacheStoredEntry {
	headers: [string, string][];
	read(range: CacheBodyRange): ReadableStream<Uint8Array>;
	size: number;
	status: number;
}

export interface CacheBackend {
	delete(key: string): Promise<boolean>;
	match(key: string): Promise<CacheStoredEntry | undefined>;
	put(key: string, metadata: CacheEntryMetadata, body: AsyncIterable<Uint8Array>): Promise<void>;
}

let openBackend: ((cacheName: string) => CacheBackend) | undefined;

// Called once by the runtime. `open` receives "default" or "named:<name>",
// the object names Miniflare uses.
// https://github.com/cloudflare/workers-sdk/blob/be87ff0382c53a294e948e49419d25d653c50e86/packages/miniflare/src/workers/cache/cache-entry.worker.ts#L10-L13
export function configureCacheStorage(
	open: ((cacheName: string) => CacheBackend) | undefined,
): void {
	openBackend = open;
}

interface CacheQueryOptions {
	ignoreMethod?: boolean;
}

// Public methods take the global request type, so Worker code typed against
// Cloudflare's Request can pass its requests in.
type CacheKeyInput = InstanceType<typeof globalThis.Request> | string | URL;

function coerceRequest(input: CacheKeyInput | Request): Request {
	return input instanceof Request ? input : new Request(String(input));
}

// Miniflare and Cloudflare Enterprise honour cf.cacheKey.
// https://github.com/cloudflare/workers-sdk/blob/be87ff0382c53a294e948e49419d25d653c50e86/packages/miniflare/src/workers/cache/cache.worker.ts#L40-L42
function cacheKey(request: Request): string {
	const key: unknown =
		typeof request.cf === "object" && request.cf !== null
			? Reflect.get(request.cf, "cacheKey")
			: undefined;
	return key === undefined || key === null || key === "" ? request.url : String(key);
}

function normaliseHeaders(headers: Headers): Record<string, string> {
	const result: Record<string, string> = {};
	for (const [name, value] of headers) result[name.toLowerCase()] = value;
	return result;
}

// Decides whether a response is storable and for how long, as Miniflare does
// with http-cache-semantics as a shared cache. Cloudflare ignores the request
// Cache-Control, never stores a response with Set-Cookie, and strips
// Set-Cookie when Cache-Control has private=Set-Cookie.
// https://github.com/cloudflare/workers-sdk/blob/be87ff0382c53a294e948e49419d25d653c50e86/packages/miniflare/src/workers/cache/cache.worker.ts#L44-L93
function cachePolicy(
	request: Request,
	response: Response,
): { headers: [string, string][]; storable: boolean; ttl: number } {
	const requestHeaders = normaliseHeaders(request.headers);
	delete requestHeaders["cache-control"];
	const responseHeaders = normaliseHeaders(response.headers);
	const cacheControl = responseHeaders["cache-control"];
	if (cacheControl?.toLowerCase().includes("private=set-cookie")) {
		responseHeaders["cache-control"] = cacheControl
			.toLowerCase()
			.replace(/private=set-cookie;?/i, "");
		delete responseHeaders["set-cookie"];
	}
	const policy = new CachePolicy(
		{ headers: requestHeaders, method: "GET", url: request.url },
		{ headers: responseHeaders, status: response.status },
		{ shared: true },
	);
	const headers: [string, string][] = [];
	for (const [name, value] of Object.entries(policy.responseHeaders())) {
		if (typeof value === "string") headers.push([name, value]);
		else if (Array.isArray(value)) for (const item of value) headers.push([name, item]);
	}
	return {
		headers,
		storable: policy.storable() && !("set-cookie" in responseHeaders),
		ttl: policy.timeToLive(),
	};
}

// Reads the body as bytes. The first read starts at once, so the response
// body is disturbed when put() returns, as in workerd.
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/cache.c%2B%2B#L334-L338
function startReading(body: ReadableStream | null): {
	cancel(): void;
	chunks: AsyncIterable<Uint8Array>;
	discard(): Promise<void>;
} {
	if (body === null) {
		return {
			cancel: () => undefined,
			chunks: (async function* () {})(),
			discard: async () => undefined,
		};
	}
	const reader = body.getReader();
	const first = reader.read();
	first.catch(() => undefined);
	// The cancel is not awaited. For a body from response.clone(), it only
	// settles once the other branch is read or canceled too, and the Worker
	// usually reads that branch after put() returns.
	const cancel = (): void => {
		reader.cancel().catch(() => undefined);
	};
	const chunks = (async function* () {
		let next = first;
		for (;;) {
			const { done, value } = await next;
			if (done) return;
			yield bodyChunkBytes(value);
			next = reader.read();
		}
	})();
	return {
		cancel,
		chunks,
		// workerd uploads the whole body even when the cache will not store it,
		// so a Worker that streams the body sees its writes succeed.
		// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/cache.c%2B%2B#L470-L484
		async discard(): Promise<void> {
			for await (const _chunk of chunks);
		},
	};
}

// https://github.com/cloudflare/workers-sdk/blob/be87ff0382c53a294e948e49419d25d653c50e86/packages/miniflare/src/workers/cache/cache.worker.ts#L107-L121
const etagPattern = /^(W\/)?"(.+)"$/;
function parseETag(value: string): string | undefined {
	return etagPattern.exec(value.trim())?.[2];
}

const utcDatePattern =
	/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d\d (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d\d\d\d \d\d:\d\d:\d\d GMT$/;
function parseUTCDate(value: string): number {
	return utcDatePattern.test(value) ? Date.parse(value) : Number.NaN;
}

interface InclusiveRange {
	end: number;
	start: number;
}

// Miniflare's Range parser: undefined is unsatisfiable, an empty array means
// the whole body.
// https://github.com/cloudflare/workers-sdk/blob/be87ff0382c53a294e948e49419d25d653c50e86/packages/miniflare/src/workers/shared/range.ts#L26-L86
function parseRanges(header: string, length: number): InclusiveRange[] | undefined {
	const prefix = /^ *bytes *=/i.exec(header);
	if (prefix === null) return undefined;
	const rest = header.substring(prefix[0].length);
	if (rest.trimStart() === "") return [];
	const result: InclusiveRange[] = [];
	for (const range of rest.split(",")) {
		const match = /^ *(?<start>\d+)? *- *(?<end>\d+)? *$/.exec(range);
		if (match === null) return undefined;
		const start = match.groups?.["start"];
		const end = match.groups?.["end"];
		if (start !== undefined && end !== undefined) {
			const rangeStart = Number.parseInt(start, 10);
			const rangeEnd = Math.min(Number.parseInt(end, 10), length - 1);
			if (rangeStart > Number.parseInt(end, 10) || rangeStart >= length) return undefined;
			result.push({ end: rangeEnd, start: rangeStart });
		} else if (start !== undefined) {
			const rangeStart = Number.parseInt(start, 10);
			if (rangeStart >= length) return undefined;
			result.push({ end: length - 1, start: rangeStart });
		} else if (end !== undefined) {
			const suffix = Number.parseInt(end, 10);
			if (suffix >= length) return [];
			if (suffix === 0) continue;
			result.push({ end: length - 1, start: length - suffix });
		} else {
			return undefined;
		}
	}
	return result;
}

// Builds the match() response: 416, 304, 206, or the full entry, in
// Miniflare's order.
// https://github.com/cloudflare/workers-sdk/blob/be87ff0382c53a294e948e49419d25d653c50e86/packages/miniflare/src/workers/cache/cache.worker.ts#L130-L183
// https://github.com/cloudflare/workers-sdk/blob/be87ff0382c53a294e948e49419d25d653c50e86/packages/miniflare/src/workers/cache/cache.worker.ts#L290-L326
function matchResponse(request: Request, entry: CacheStoredEntry): Response {
	const headers = new Headers(entry.headers);
	headers.set("cf-cache-status", "HIT");
	const rangeHeader = request.headers.get("range");
	const ranges = rangeHeader === null ? [] : parseRanges(rangeHeader, entry.size);
	if (ranges === undefined) {
		return new Response(null, {
			headers: { "content-range": `bytes */${entry.size}`, "cf-cache-status": "HIT" },
			status: 416,
		});
	}
	const ifNoneMatch = request.headers.get("if-none-match");
	const etagHeader = headers.get("etag");
	const etag = etagHeader === null ? undefined : parseETag(etagHeader);
	if (ifNoneMatch !== null && etag !== undefined) {
		if (
			ifNoneMatch.trim() === "*" ||
			ifNoneMatch.split(",").some((candidate) => parseETag(candidate) === etag)
		) {
			return new Response(null, { headers, status: 304 });
		}
	}
	const ifModifiedSince = request.headers.get("if-modified-since");
	const lastModified = headers.get("last-modified");
	if (
		ifModifiedSince !== null &&
		lastModified !== null &&
		parseUTCDate(lastModified) <= parseUTCDate(ifModifiedSince)
	) {
		return new Response(null, { headers, status: 304 });
	}
	// Orange serves one range. A request for several ranges gets the whole
	// body with 200, which HTTP allows. Miniflare sends multipart/byteranges.
	const range = ranges.length === 1 ? ranges[0] : undefined;
	if (range !== undefined) {
		const length = range.end - range.start + 1;
		headers.set("content-range", `bytes ${range.start}-${range.end}/${entry.size}`);
		headers.set("content-length", String(length));
		return new Response(entry.read({ length, offset: range.start }), { headers, status: 206 });
	}
	const nullBody = entry.status === 204 || entry.status === 205 || entry.status === 304;
	return new Response(nullBody ? null : entry.read({ length: entry.size, offset: 0 }), {
		headers,
		status: entry.status,
	});
}

export class Cache {
	readonly #cacheName: string;

	constructor(token?: symbol, cacheName = "default") {
		if (token !== constructionToken) throw new TypeError("Illegal constructor");
		this.#cacheName = cacheName;
	}

	async delete(requestOrUrl: CacheKeyInput, options?: CacheQueryOptions): Promise<boolean> {
		const request = coerceRequest(requestOrUrl);
		if (options?.ignoreMethod !== true && request.method !== "GET") return false;
		const backend = openBackend?.(this.#cacheName);
		if (backend === undefined) return false;
		return await backend.delete(cacheKey(request));
	}

	async match(
		requestOrUrl: CacheKeyInput,
		options?: CacheQueryOptions,
	): Promise<Response | undefined> {
		const request = coerceRequest(requestOrUrl);
		if (options?.ignoreMethod !== true && request.method !== "GET") return undefined;
		const backend = openBackend?.(this.#cacheName);
		if (backend === undefined) return undefined;
		// The key alone picks the entry. Like Cloudflare's cache and Miniflare,
		// match() does not read Vary, so a response stored with
		// `Vary: Accept-Language` answers a request with any Accept-Language.
		// Measured on Cloudflare, in a Pages Function on pages.dev, and on
		// wrangler dev 4.129.0, on 2026-11-13.
		const entry = await backend.match(cacheKey(request));
		return entry === undefined ? undefined : matchResponse(request, entry);
	}

	// Validation and its error text follow workerd's Cache::put().
	// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/cache.c%2B%2B#L182-L332
	async put(requestOrUrl: CacheKeyInput, response: Response): Promise<void> {
		if (!(response instanceof Response)) {
			throw new TypeError("Failed to execute 'put' on 'Cache': parameter 2 is not of type 'Response'.");
		}
		if (response.type === "error") {
			throw new TypeError("Cache is unable to store an error response");
		}
		const request = coerceRequest(requestOrUrl);
		if (request.method !== "GET") {
			throw new TypeError("Cannot cache response to non-GET request.");
		}
		if (response.status === 206) {
			throw new TypeError("Cannot cache response to a range request (206 Partial Content).");
		}
		if (response.headers.get("vary")?.includes("*") === true) {
			throw new TypeError("Cannot cache response with 'Vary: *' header.");
		}
		// Workerd silently discards a 304 and leaves its body alone.
		if (response.status === 304) return;
		if (response.webSocket !== null) {
			throw new TypeError("Cannot cache WebSocket upgrade response.");
		}
		const body = startReading(response.body);
		const backend = openBackend?.(this.#cacheName);
		const { headers, storable, ttl } = cachePolicy(request, response);
		// Cloudflare answers an uncacheable or oversized put with 413, and
		// workerd resolves put() anyway. An entry with no freshness left would
		// only ever miss, so it is not stored either.
		if (backend === undefined || !storable || ttl <= 0) {
			await body.discard();
			return;
		}
		const metadata: CacheEntryMetadata = {
			expiresAt: Date.now() + ttl,
			headers,
			status: response.status,
		};
		try {
			await backend.put(cacheKey(request), metadata, body.chunks);
		} catch (error: unknown) {
			body.cancel();
			throw error;
		}
	}
}

export class CacheStorage {
	readonly default: Cache = new Cache(constructionToken);

	constructor(token?: symbol) {
		if (token !== constructionToken) throw new TypeError("Illegal constructor");
	}

	// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/cache.c%2B%2B#L614-L621
	async open(cacheName: string): Promise<Cache> {
		const name = String(cacheName);
		return new Cache(constructionToken, `named:${name}`);
	}
}

export const caches: CacheStorage = new CacheStorage(constructionToken);
