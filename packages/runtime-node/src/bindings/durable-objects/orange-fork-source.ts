// The original object's side of `orange.fork()`. The fork runs inside the original's actor, as
// `ctx.facets.clone()` forks a facet inside its own actor (facet-clone.ts), so the original's
// actor and its facets are forked at one point: its facets take no calls from it until each of
// them is forked under the copy.
import { setTimeout as sleep } from "node:timers/promises";

import {
	isRivetStorageOverloaded,
	rivetActorErrorCode,
	type RivetSqliteDatabase,
} from "../../internal/rivetkit.js";
import { isRecord } from "../unknown-values.js";
import {
	cloneDurableObjectFacetActor,
	type DurableObjectFacetHost,
	durableObjectFacetIncarnationTable,
	durableObjectFacetKey,
	enqueueDurableObjectFacetWork,
} from "./facets.js";
import {
	durableObjectOrangeForkActions,
	finishOrangeForkFacets,
	isOrangeForkErrorCode,
	type OrangeForkOutcome,
	readPendingOrangeFork,
} from "./orange-fork.js";

/** The original object's actor, as the fork action sees it. */
export interface OrangeForkSource {
	readonly actorId: string;
	readonly actorName: string;
	readonly className: string;
	readonly database: RivetSqliteDatabase;
	readonly host: DurableObjectFacetHost;
	/** Runs `read` as an event of the original's object, after its open turn commits. */
	readInObject<Result>(read: () => Result): Promise<Result>;
}

interface OrangeForkActionRequest {
	readonly envelope: unknown;
	readonly key: readonly string[];
}

function requireRequest(value: unknown): OrangeForkActionRequest {
	if (
		!isRecord(value) ||
		!Array.isArray(value.key) ||
		!value.key.every((part) => typeof part === "string")
	) {
		throw new TypeError("Durable Object fork request is invalid");
	}
	return { envelope: value.envelope, key: value.key };
}

function readChildren(database: RivetSqliteDatabase): [name: string, incarnation: number][] {
	const exists = database.executeSync(
		"SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
		[durableObjectFacetIncarnationTable],
	).rows.length > 0;
	if (!exists) return [];
	return database
		.executeSync(`SELECT name, incarnation FROM ${durableObjectFacetIncarnationTable}`)
		.rows.map(([name, incarnation]) => [String(name), Number(incarnation)]);
}

// The Engine's storage refuses a fork while a volume changes, for example when many forks start
// at once, and asks for a retry after 100 ms. facet-clone.ts retries the same way.
const forkAttempts = 8;

/** Forks the original's actor to `request.key`, then its facets under the copy. */
export async function forkDurableObjectFromSource(
	source: OrangeForkSource,
	requestValue: unknown,
): Promise<OrangeForkOutcome> {
	const request = requireRequest(requestValue);
	const held: (() => void)[] = [];
	try {
		// Calls from the original to its facets wait from here until each facet is forked, so the
		// copy's facets hold what they held when the original was forked.
		const children = await source.readInObject(() => {
			const names = readChildren(source.database);
			for (const [name] of names) {
				const release = Promise.withResolvers<void>();
				void enqueueDurableObjectFacetWork(source.actorId, [name], new Set(), () => release.promise);
				held.push(release.resolve);
			}
			return names;
		});
		await source.database.whenDurable(source.database.commitTicket());
		const client = source.host.client();
		let copyActorId: string;
		try {
			for (let attempt = 1; ; attempt++) {
				try {
					copyActorId = await client.fork(source.actorName, source.actorId, request.key, request.envelope);
					break;
				} catch (error: unknown) {
					if (!isRivetStorageOverloaded(error) || attempt === forkAttempts) throw error;
					await sleep(100 * 2 ** (attempt - 1));
				}
			}
		} catch (error: unknown) {
			const code = rivetActorErrorCode(error);
			if (isOrangeForkErrorCode(code)) return code;
			throw error;
		}
		const parent = (actorId: string) => ({ actorId, className: source.className, depth: 0 });
		await Promise.all(
			children.map(([name, incarnation]) =>
				cloneDurableObjectFacetActor(source.host, {
					cloneId: orangeForkCloneId(copyActorId),
					depth: 1,
					dstKey: durableObjectFacetKey(source.host, parent(copyActorId), name, incarnation),
					srcKey: durableObjectFacetKey(source.host, parent(source.actorId), name, incarnation),
				}),
			),
		);
		if (children.length > 0) {
			// The copy would fork the facets again at its first call. Forks are idempotent by clone ID,
			// so this only saves that work; a failure here leaves it to the copy.
			try {
				await client
					.get(source.actorName, request.key)
					.action({ args: [], name: durableObjectOrangeForkActions.facetsCopied });
			} catch (error: unknown) {
				console.warn("[durable-object] fork could not mark the copy's facets as copied", error);
			}
		}
		return "forked";
	} finally {
		for (const release of held) release();
	}
}

/** The clone ID of every facet fork for the copy `copyActorId`, from either side. */
export function orangeForkCloneId(copyActorId: string): string {
	return `orange-fork:${copyActorId}`;
}

/**
 * Forks the original's facets under the copy at the copy's first call, unless the original already
 * did. That happens only when the original's fork stopped between forking its actor and its facets,
 * or when the fork was made with Rivet's own API.
 */
export async function copyForkedFacets(
	host: DurableObjectFacetHost | undefined,
	database: RivetSqliteDatabase,
	copyActorId: string,
	className: string,
): Promise<void> {
	const pending = readPendingOrangeFork(database);
	if (pending === undefined || !pending.facets) return;
	if (host === undefined) throw new Error("A forked Durable Object's facets have no host");
	const parent = (actorId: string) => ({ actorId, className, depth: 0 });
	await Promise.all(
		readChildren(database).map(([name, incarnation]) =>
			cloneDurableObjectFacetActor(host, {
				cloneId: orangeForkCloneId(copyActorId),
				depth: 1,
				dstKey: durableObjectFacetKey(host, parent(copyActorId), name, incarnation),
				srcKey: durableObjectFacetKey(host, parent(pending.sourceActorId), name, incarnation),
			}),
		),
	);
	finishOrangeForkFacets(database, pending);
	await database.whenDurable(database.commitTicket());
}

/** The copy's side of `facetsCopied`: its facets need no fork at its first call. */
export async function markOrangeForkFacetsCopied(database: RivetSqliteDatabase): Promise<void> {
	const pending = readPendingOrangeFork(database);
	if (pending === undefined || !pending.facets) return;
	finishOrangeForkFacets(database, pending);
	await database.whenDurable(database.commitTicket());
}
