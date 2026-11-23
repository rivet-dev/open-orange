// Orange calls each of its actors through Rivet's gateway with a JWT that grants `actor_gateway`
// on that one actor ID. The node's Rivet token only mints them, and never goes to the gateway.
// https://rivet.dev/docs/jwt
import { setTimeout as delay } from "node:timers/promises";

export const actorTokenDurationSetting = "ORANGE_ACTOR_TOKEN_DURATION_SECONDS";
// Rivet's default token lifetime. Rivet accepts 1 to 86,400 seconds.
const defaultDurationSeconds = 3_600;
const maxDurationSeconds = 86_400;
// Enough for every actor a busy node calls within one token lifetime.
const maxCachedTokens = 10_000;

export interface IssuedActorToken {
	token: string;
	/** Unix milliseconds. */
	expiresAt: number;
}

export type MintActorToken = (actorId: string, durationSeconds: number) => Promise<IssuedActorToken>;

export class ActorTokenError extends Error {
	override name = "ActorTokenError";
	constructor(actorId: string, cause: unknown) {
		super(
			`OpenOrange could not get a Rivet token to call actor ${actorId}: ${cause instanceof Error ? cause.message : String(cause)}`,
			{ cause },
		);
	}
}

interface CachedToken {
	token: string;
	expiresAt: number;
	// After this time, a call still uses the token and starts a renewal.
	renewAt: number;
}

// Tokens by actor ID. Actor IDs are unique, so every client in the process shares them. The
// WebSocket constructor is synchronous and reads them from here.
const tokens = new Map<string, CachedToken>();
const minting = new Map<string, Promise<CachedToken>>();

export function actorTokenDurationSeconds(): number {
	const raw = process.env[actorTokenDurationSetting];
	if (raw === undefined || raw === "") return defaultDurationSeconds;
	const value = Number(raw);
	if (!Number.isSafeInteger(value) || value < 1 || value > maxDurationSeconds) {
		throw new RangeError(
			`${actorTokenDurationSetting} must be a whole number of seconds from 1 to ${maxDurationSeconds}. Got: ${JSON.stringify(raw)}`,
		);
	}
	return value;
}

function remember(actorId: string, token: CachedToken): void {
	tokens.delete(actorId);
	tokens.set(actorId, token);
	if (tokens.size > maxCachedTokens) tokens.delete(tokens.keys().next().value!);
}

// Rivet answers these while it cannot sign a token for now, such as right after the Engine starts,
// and asks the caller to retry. https://rivet.dev/docs/api/tokens/create
const unavailableIssuanceCodes = new Set(["issuance_unavailable", "operation_unavailable"]);
const issuanceRetryMs = 15_000;

function isIssuanceUnavailable(error: unknown): boolean {
	const code: unknown = error instanceof Error ? Reflect.get(error, "code") : undefined;
	return (
		error instanceof Error &&
		Reflect.get(error, "group") === "auth" &&
		typeof code === "string" &&
		unavailableIssuanceCodes.has(code)
	);
}

async function mintWithRetry(actorId: string, mintToken: MintActorToken): Promise<IssuedActorToken> {
	const deadline = Date.now() + issuanceRetryMs;
	for (let attempt = 0; ; attempt++) {
		try {
			return await mintToken(actorId, actorTokenDurationSeconds());
		} catch (error: unknown) {
			if (!isIssuanceUnavailable(error) || Date.now() > deadline) throw error;
			await delay(Math.min(100 * 2 ** attempt, 1_000));
		}
	}
}

function mint(actorId: string, mintToken: MintActorToken): Promise<CachedToken> {
	let pending = minting.get(actorId);
	if (pending !== undefined) return pending;
	const issuedAt = Date.now();
	pending = mintWithRetry(actorId, mintToken)
		.then((issued) => {
			// Renew at half the lifetime, so a call never waits for a renewal while the token is fresh.
			const cached = { ...issued, renewAt: issuedAt + (issued.expiresAt - issuedAt) / 2 };
			remember(actorId, cached);
			return cached;
		}, (error: unknown) => {
			throw new ActorTokenError(actorId, error);
		})
		.finally(() => minting.delete(actorId));
	minting.set(actorId, pending);
	return pending;
}

/** An unexpired token for `actorId`. Past half its lifetime, it comes back while a renewal runs. */
export async function actorGatewayToken(actorId: string, mintToken: MintActorToken): Promise<string> {
	const cached = tokens.get(actorId);
	const now = Date.now();
	if (cached !== undefined && now < cached.renewAt) return cached.token;
	if (cached !== undefined && now < cached.expiresAt) {
		// A failed renewal leaves the current token, and a call after it expires reports the failure.
		void mint(actorId, mintToken).catch(() => {});
		return cached.token;
	}
	return (await mint(actorId, mintToken)).token;
}

/** The cached token for `actorId`, for a caller that got one from actorGatewayToken() first. */
export function cachedActorGatewayToken(actorId: string): string | undefined {
	const cached = tokens.get(actorId);
	return cached !== undefined && Date.now() < cached.expiresAt ? cached.token : undefined;
}

const gatewayPathPattern = /^\/gateway\/([^/?]+)/;

/**
 * The actor ID that a gateway URL addresses, without any token in the path. Undefined for a URL
 * outside the gateway. RivetKit puts a configured token in the path as `/gateway/<id>@<token>`.
 * https://github.com/rivet-dev/rivet/blob/7d2fda3749f785619883c46aed963fb7b48994e6/rivetkit-typescript/packages/rivetkit/src/engine-client/actor-websocket-client.ts#L203-L227
 */
function gatewayTarget(url: URL): { actorId: string; path: string } | undefined {
	const match = gatewayPathPattern.exec(url.pathname);
	if (match === null) return undefined;
	const segment = decodeURIComponent(match[1]!);
	const at = segment.indexOf("@");
	const actorId = at < 0 ? segment : segment.slice(0, at);
	return { actorId, path: `/gateway/${encodeURIComponent(actorId)}${url.pathname.slice(match[0].length)}` };
}

/**
 * The gateway URL for a call to one actor, with every other credential removed: the path token and
 * the `rvt-token` query parameter. Throws for a gateway URL that names no actor ID.
 */
export function actorGatewayRequest(input: string | URL): { actorId: string; url: URL } | undefined {
	const url = new URL(input);
	const target = gatewayTarget(url);
	if (target === undefined) return undefined;
	url.pathname = target.path;
	url.searchParams.delete("rvt-token");
	// RivetKit addresses a key query by actor name with `rvt-method`. Orange resolves keys to IDs
	// first, so a query here means a call that no scoped token could authorize.
	if (url.searchParams.has("rvt-method")) {
		throw new Error(`OpenOrange calls Rivet actors only by actor ID, not by the query ${target.actorId}`);
	}
	return { actorId: target.actorId, url };
}

const webSocketTokenProtocol = "rivet_token.";

/**
 * The URL and subprotocols that open a gateway WebSocket with the actor's cached token. Rivet reads a
 * WebSocket's token from the `rivet_token.<token>` subprotocol, which keeps it out of the URL.
 * https://rivet.dev/docs/api/authentication#websocket-requests
 */
export function actorGatewayWebSocket(
	input: string | URL,
	protocols: string | string[] | undefined,
): { protocols: string | string[] | undefined; url: string | URL } {
	const request = actorGatewayRequest(input);
	if (request === undefined) return { protocols, url: input };
	const token = cachedActorGatewayToken(request.actorId);
	if (token === undefined) {
		throw new Error(`OpenOrange has no Rivet token for actor ${request.actorId}`);
	}
	const others = (protocols === undefined ? [] : typeof protocols === "string" ? [protocols] : protocols)
		.filter((protocol) => !protocol.startsWith(webSocketTokenProtocol));
	return { protocols: [...others, `${webSocketTokenProtocol}${token}`], url: request.url.href };
}
