// `orange.fork()`: an OpenOrange extension that forks a Durable Object's Rivet Actor. It follows
// RivetKit's actor fork API: `client.<actor>.fork(actorId, { key, input })`, `onFork(c, fork)`,
// and `c.forkChain`. Cloudflare has no such API, so it lives under `.orange` on Cloudflare's
// objects and `onOrangeFork` on the user's class.
import { Buffer } from "node:buffer";
import { deserialize } from "node:v8";

import { waitForOutputGate } from "../../internal/output-gate.js";
import {
	type RivetActorClient,
	type RivetActorFork,
	rivetActorErrorCode,
	type RivetSynchronousSqliteExecutor,
} from "../../internal/rivetkit.js";
import { serializeUnshared } from "../../internal/v8-serialize.js";
import { isRecord } from "../unknown-values.js";
import {
	deleteDurableObjectMetadata,
	readDurableObjectMetadata,
	writeDurableObjectMetadata,
} from "./metadata.js";

export type OrangeForkErrorCode =
	| "duplicate_key"
	| "fork_failed"
	| "fork_pending"
	| "fork_too_deep"
	| "fork_unavailable"
	| "not_found";

/** A fork that Rivet refused. `code` is the RivetKit `actor.*` code without its group. */
export class OrangeForkError extends Error {
	readonly code: OrangeForkErrorCode;

	constructor(code: OrangeForkErrorCode, message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "OrangeForkError";
		this.code = code;
	}
}

const forkErrorMessages: Record<OrangeForkErrorCode, string> = {
	duplicate_key: "An object with the copy's ID already exists.",
	fork_failed: "The source object has never run, so it has no storage to fork.",
	fork_pending: "The fork did not finish within 30 seconds. The copy appears once it does.",
	fork_too_deep: "The source object is already 16 forks deep.",
	fork_unavailable: "The Rivet Engine cannot fork actors.",
	not_found: "The source object has never run, so it has no storage to fork.",
};

export function isOrangeForkErrorCode(code: string | undefined): code is OrangeForkErrorCode {
	return code !== undefined && Object.hasOwn(forkErrorMessages, code);
}

/** What the original's fork action answers. Codes are returned, because RivetKit replaces a thrown error's message. */
export type OrangeForkOutcome = "forked" | OrangeForkErrorCode;

/** The private actions of a root object's actor that `orange.fork()` calls. */
export const durableObjectOrangeForkActions = {
	/** On the original: forks its actor and its facets. See orange-fork-source.ts. */
	fork: "__openorange_fork",
	/** On the copy: the original forked the copy's facets. */
	facetsCopied: "__openorange_fork_facets_copied",
} as const;

/** What `orange.fork()` sends to the copy's `onFork` as the Rivet fork input. */
interface OrangeForkEnvelope {
	readonly openorange: 1;
	/** The copy's name, so `ctx.id.name` names the copy and not the source. */
	readonly name?: string;
	/** The caller's input, V8-serialized and base64-encoded. */
	readonly input?: string;
}

/** The arguments of one fork. actor-routing.ts builds it from the namespace's descriptors. */
export interface DurableObjectForkRequest {
	readonly actorName: string;
	readonly input: unknown;
	/** The copy's name, when the caller named it. */
	readonly name: string | undefined;
	readonly sourceKey: readonly string[];
	readonly targetKey: readonly string[];
}

/**
 * Asks the original object's actor to fork itself to the copy's key, with its facets, and maps
 * Rivet's refusals to OrangeForkError. This wakes the original if it sleeps.
 */
export async function forkDurableObjectActor(
	client: RivetActorClient,
	request: DurableObjectForkRequest,
): Promise<void> {
	const envelope: OrangeForkEnvelope = {
		openorange: 1,
		...(request.name === undefined ? {} : { name: request.name }),
		...(request.input === undefined
			? {}
			: { input: Buffer.from(serializeInput(request.input)).toString("base64") }),
	};
	// A fork is an outgoing message, so it waits for the caller's earlier writes, as workerd's
	// output gate holds a fetch or an RPC call. An object that forks itself then forks the writes
	// of its current turn too.
	await waitForOutputGate();
	let outcome: unknown;
	try {
		// A call to a missing actor retries for seconds before it fails; this answers at once.
		if (!(await client.exists(request.actorName, request.sourceKey))) {
			outcome = "not_found";
		} else {
			outcome = await client
				.get(request.actorName, request.sourceKey)
				.action({ args: [{ envelope, key: [...request.targetKey] }], name: durableObjectOrangeForkActions.fork });
		}
	} catch (error: unknown) {
		const code = rivetActorErrorCode(error);
		if (isOrangeForkErrorCode(code)) {
			throw new OrangeForkError(code, forkErrorMessages[code], { cause: error });
		}
		throw error;
	}
	if (outcome === "forked") return;
	if (typeof outcome === "string" && isOrangeForkErrorCode(outcome)) {
		throw new OrangeForkError(outcome, forkErrorMessages[outcome]);
	}
	throw new Error(`Durable Object fork answered ${JSON.stringify(outcome)}`);
}

function serializeInput(value: unknown): Uint8Array {
	try {
		return serializeUnshared(value);
	} catch (error: unknown) {
		throw new DOMException(
			error instanceof Error ? error.message : "Value could not be cloned.",
			"DataCloneError",
		);
	}
}

// The input comes from whoever forked the actor, which can be the Rivet API, so a value that is
// not Orange's envelope is ignored rather than thrown: a throw would fail the copy's every start.
function parseEnvelope(value: unknown): { input?: string; name?: string } {
	if (!isRecord(value) || value.openorange !== 1) return {};
	return {
		...(typeof value.input === "string" ? { input: value.input } : {}),
		...(typeof value.name === "string" ? { name: value.name } : {}),
	};
}

/** One fork behind an object, as `ctx.orange.forkChain` lists it with the source's ID. */
export interface StoredForkLink {
	readonly forkedAt: number;
	/** The source actor's key, which holds the source object's ID. */
	readonly key: readonly string[];
	readonly name?: string;
}

/** The fork that made an object, kept until the copy's facets and `onOrangeFork` finished. */
export interface PendingOrangeFork extends StoredForkLink {
	/** Whether the source's facets still need a copy under this actor. */
	readonly facets: boolean;
	readonly input?: string;
	readonly sourceActorId: string;
}

function isStoredForkLink(value: unknown): value is StoredForkLink {
	return (
		isRecord(value) &&
		typeof value.forkedAt === "number" &&
		Array.isArray(value.key) &&
		value.key.every((part) => typeof part === "string") &&
		(value.name === undefined || typeof value.name === "string")
	);
}

export function readDurableObjectForkChain(
	database: RivetSynchronousSqliteExecutor,
): StoredForkLink[] {
	const value = readDurableObjectMetadata(database, "forkChain");
	if (value === undefined) return [];
	if (!Array.isArray(value) || !value.every(isStoredForkLink)) {
		throw new TypeError("Durable Object fork chain metadata is invalid");
	}
	return value;
}

export function readPendingOrangeFork(
	database: RivetSynchronousSqliteExecutor,
): PendingOrangeFork | undefined {
	const value = readDurableObjectMetadata(database, "orangeFork");
	if (value === undefined) return undefined;
	if (
		!isStoredForkLink(value) ||
		!isRecord(value) ||
		typeof value.facets !== "boolean" ||
		typeof value.sourceActorId !== "string" ||
		(value.input !== undefined && typeof value.input !== "string")
	) {
		throw new TypeError("Durable Object fork metadata is invalid");
	}
	return {
		facets: value.facets,
		forkedAt: value.forkedAt,
		key: value.key,
		sourceActorId: value.sourceActorId,
		...(value.input === undefined ? {} : { input: value.input }),
		...(value.name === undefined ? {} : { name: value.name }),
	};
}

export function finishOrangeForkFacets(
	database: RivetSynchronousSqliteExecutor,
	pending: PendingOrangeFork,
): void {
	writeDurableObjectMetadata(database, "orangeFork", { ...pending, facets: false });
}

export function finishOrangeFork(database: RivetSynchronousSqliteExecutor): void {
	deleteDurableObjectMetadata(database, "orangeFork");
}

/** The caller's input for `onOrangeFork`, or undefined when it has none or it is unreadable. */
export function orangeForkInput(pending: PendingOrangeFork): unknown {
	if (pending.input === undefined) return undefined;
	try {
		return deserialize(Buffer.from(pending.input, "base64"));
	} catch {
		return undefined;
	}
}

const tableExistsSql = "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?";

function tableHasRows(database: RivetSynchronousSqliteExecutor, table: string): boolean {
	if (database.executeSync(tableExistsSql, [table]).rows.length === 0) return false;
	return database.executeSync(`SELECT 1 FROM ${table} LIMIT 1`).rows.length > 0;
}

function clearTable(database: RivetSynchronousSqliteExecutor, table: string): void {
	if (database.executeSync(tableExistsSql, [table]).rows.length > 0) {
		database.executeSync(`DELETE FROM ${table}`);
	}
}

/**
 * The copy's Rivet `onFork`, for any fork of an object's actor: `orange.fork()` or the Rivet API.
 * It runs once, before the copy's first start, on the copy's own storage:
 *
 * - The copy keeps its own name, so `ctx.id.name` names it. A fork made without `orange.fork()`
 *   has no name.
 * - The fork joins the chain that the source's storage brought along.
 * - The source's alarm stays with the source, as Cloudflare's snapshot restore does not carry
 *   alarms either. The scheduler then cancels the Rivet schedule that came with the storage.
 * - The source's unfinished facet clones stay with the source.
 */
export function storeForkedDurableObject(
	database: RivetSynchronousSqliteExecutor,
	fork: RivetActorFork,
	tables: { readonly alarm: string; readonly facetClones: string; readonly facets: string },
): void {
	const envelope = parseEnvelope(fork.input);
	const sourceName = readDurableObjectMetadata(database, "name");
	const link: StoredForkLink = {
		forkedAt: fork.forkedAt ?? Date.now(),
		key: [...(fork.key ?? [])],
		...(typeof sourceName === "string" ? { name: sourceName } : {}),
	};
	if (envelope.name === undefined) deleteDurableObjectMetadata(database, "name");
	else writeDurableObjectMetadata(database, "name", envelope.name);
	writeDurableObjectMetadata(database, "forkChain", [...readDurableObjectForkChain(database), link]);
	clearTable(database, tables.alarm);
	clearTable(database, tables.facetClones);
	const pending: PendingOrangeFork = {
		...link,
		facets: tableHasRows(database, tables.facets),
		...(envelope.input === undefined ? {} : { input: envelope.input }),
		sourceActorId: fork.actorId,
	};
	writeDurableObjectMetadata(database, "orangeFork", pending);
}
