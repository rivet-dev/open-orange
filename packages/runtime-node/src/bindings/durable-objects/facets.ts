import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";

import {
	type RivetActorClient,
	type RivetActorHandle,
	type RivetSynchronousSqliteExecutor,
} from "../../internal/rivetkit.js";
import { runOutsideOutputGate } from "../../internal/output-gate.js";
import type { DurableObjectFacets } from "../../modules/cloudflare-workers/durable-object.js";
import type { DurableObjectAlarmController } from "./alarm-storage.js";
import {
	decodeDurableObjectProps,
	durableObjectClassTarget,
	type DurableObjectClassTarget,
} from "./durable-object-class.js";
import {
	type ConfiguredDurableObjectClass,
	isDurableObjectClass,
} from "./classes.js";
import { fetchDurableObjectStub, prepareDurableObjectFetch } from "./fetch.js";
import type { DurableObjectTurnDatabase } from "./gates.js";
import {
	type DurableObjectId,
	type DurableObjectIdSnapshot,
	requireDurableObjectIdSnapshot,
	restoreDurableObjectId,
	snapshotDurableObjectId,
} from "./id.js";
import {
	readDurableObjectMetadata,
	writeDurableObjectMetadata,
} from "./metadata.js";
import { durableObjectNamespaceClassName } from "./namespace.js";
import { DurableObjectStubLifecycle } from "./ordering.js";
import {
	createDurableObjectStubRpcProperty,
	isDurableObjectReservedRpcMethod,
} from "./rpc/methods.js";

// `#` cannot start a JavaScript export name, so this never names a Worker class.
export const durableObjectFacetClassName = "#facet";

export const durableObjectFacetActions = {
	bind: "__openorange_facet_bind",
	clonedBy: "__openorange_facet_cloned_by",
	destroy: "__openorange_facet_destroy",
	export: "__openorange_facet_export",
	exportChunk: "__openorange_facet_export_chunk",
	exportRelease: "__openorange_facet_export_release",
	fork: "__openorange_facet_fork",
	import: "__openorange_facet_import",
	reset: "__openorange_facet_reset",
} as const;

// Workerd caps a facet name at 256 characters, a Cloudflare quota that Orange does not copy.
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/actor-state.c%2B%2B#L966-L976
export const maximumFacetTreeDepth = 4;
// Rivet Engine actor keys are limited to 1024 bytes, so long names are hashed.
const maximumEncodedNameLength = 512;

/** One row per facet name the object used: the incarnation of its current facet. */
export const durableObjectFacetIncarnationTable = "_rivet_openorange_facets";
const incarnationTable = durableObjectFacetIncarnationTable;
const incarnationTableExistsSql = `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '${incarnationTable}'`;
export const createDurableObjectFacetIncarnationTableSql = `CREATE TABLE IF NOT EXISTS ${incarnationTable} (name TEXT PRIMARY KEY, incarnation INTEGER NOT NULL) WITHOUT ROWID`;
const selectIncarnationSql = `SELECT incarnation FROM ${incarnationTable} WHERE name = ?`;
// Incarnations only move forward, so a clone and a delete() in one turn both get new keys.
const advanceIncarnationSql = `INSERT INTO ${incarnationTable} (name, incarnation) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET incarnation = max(incarnation, excluded.incarnation)`;
const registerIncarnationSql = `INSERT INTO ${incarnationTable} (name, incarnation) VALUES (?, ?) ON CONFLICT(name) DO NOTHING`;

/** Clones whose copy has not finished. A parent that restarts runs them again before facet calls. */
export const durableObjectFacetCloneTable = "_rivet_openorange_facet_clones";
const cloneTableExistsSql = `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '${durableObjectFacetCloneTable}'`;
const createCloneTableSql = `CREATE TABLE IF NOT EXISTS ${durableObjectFacetCloneTable} (id TEXT PRIMARY KEY, src TEXT NOT NULL, dst TEXT NOT NULL, src_key TEXT NOT NULL, dst_key TEXT NOT NULL)`;
const selectClonesSql = `SELECT id, src, dst, src_key, dst_key FROM ${durableObjectFacetCloneTable} ORDER BY rowid`;
const insertCloneSql = `INSERT INTO ${durableObjectFacetCloneTable} (id, src, dst, src_key, dst_key) VALUES (?, ?, ?, ?, ?)`;
const deleteCloneSql = `DELETE FROM ${durableObjectFacetCloneTable} WHERE id = ?`;

function notSupported(message: string): Error {
	const error = new Error(message);
	error.name = "NotSupportedError";
	return error;
}

/** What the generic facet actor needs from the loaded Worker and the Rivet client. */
export interface DurableObjectFacetHost {
	readonly actorName: string;
	readonly deploymentIdentity: string;
	client(): RivetActorClient;
	/** The exported class that a facet actor constructs. */
	classByName(className: string): ConfiguredDurableObjectClass;
	/** The export name and props of a startup `class` value. */
	classTarget(value: unknown): DurableObjectClassTarget;
}

export interface CreateDurableObjectFacetHostOptions {
	actorName: string;
	client(): RivetActorClient;
	deploymentIdentity: string;
	workerExports: Readonly<Record<string, unknown>>;
}

export function createDurableObjectFacetHost(
	options: CreateDurableObjectFacetHostOptions,
): DurableObjectFacetHost {
	const exports = options.workerExports;
	return {
		actorName: options.actorName,
		client: options.client,
		deploymentIdentity: options.deploymentIdentity,
		classByName(className): ConfiguredDurableObjectClass {
			const exported = exports[className];
			if (!isDurableObjectClass(exported)) {
				throw new Error(
					`Durable Object facet class ${className} is not exported by this Worker`,
				);
			}
			return exported;
		},
		// Workerd accepts a class from `ctx.exports`, with or without props, or a namespace.
		// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/actor-state.c%2B%2B#L1076-L1090
		classTarget(value): DurableObjectClassTarget {
			const target = durableObjectClassTarget(value);
			if (target !== undefined && isDurableObjectClass(exports[target.className])) return target;
			for (const [name, exported] of Object.entries(exports)) {
				if (exported === value && isDurableObjectClass(exported)) return { className: name, props: undefined };
			}
			const name = durableObjectNamespaceClassName(value);
			if (name !== undefined && isDurableObjectClass(exports[name])) return { className: name, props: undefined };
			throw new TypeError(
				"Facet startup option `class` must be a Durable Object class that this Worker exports",
			);
		},
	};
}

/** The facet actor's create input and stored metadata. */
interface BoundFacetRecord {
	readonly className: string;
	readonly depth: number;
	/** A string when the parent passed a string `id`. */
	readonly id: DurableObjectIdSnapshot | string;
	/** See DurableObjectClassTarget.props. */
	readonly props?: string;
}

/**
 * A clone destination: it has storage but no class until its parent's next get() binds one, as
 * workerd starts a cloned facet only when the parent calls it.
 */
interface UnboundFacetRecord {
	readonly depth: number;
}

type DurableObjectFacetRecord = BoundFacetRecord | UnboundFacetRecord;

function requireFacetRecord(value: unknown): DurableObjectFacetRecord {
	const field = (key: string): unknown =>
		typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
	const className = field("className");
	const depth = field("depth");
	const id = field("id");
	const props = field("props");
	if (
		typeof depth !== "number" ||
		!Number.isSafeInteger(depth) ||
		depth < 1 ||
		depth >= maximumFacetTreeDepth
	) {
		throw new TypeError("Durable Object facet record is invalid");
	}
	if (className === undefined && id === undefined) return { depth };
	if (typeof className !== "string" || className.length === 0) {
		throw new TypeError("Durable Object facet record is invalid");
	}
	if (props !== undefined && typeof props !== "string") {
		throw new TypeError("Durable Object facet record is invalid");
	}
	return {
		className,
		depth,
		id: typeof id === "string" ? id : requireDurableObjectIdSnapshot(id),
		...(props === undefined ? {} : { props }),
	};
}

function isBoundFacetRecord(record: DurableObjectFacetRecord): record is BoundFacetRecord {
	return "className" in record;
}

/** The record of a facet that a clone filled. Its parent's next get() binds a class. */
export function unboundDurableObjectFacetRecord(depth: number): UnboundFacetRecord {
	return requireFacetRecord({ depth });
}

/** What a clone asks its destination facet to copy. `manifest` is set for a clone's children. */
export interface DurableObjectFacetImportRequest {
	readonly cloneId: string;
	readonly source: {
		readonly key: string[];
		readonly manifest?: DurableObjectFacetExportManifest;
	};
}

/** What a clone asks its source facet to fork: a new actor at `key`, with the facet's children. */
export interface DurableObjectFacetForkRequest {
	readonly cloneId: string;
	readonly key: string[];
}

/** The input of a facet actor fork. The new actor's `onFork` reads it. */
export interface DurableObjectFacetForkInput {
	readonly cloneId: string;
	readonly depth: number;
}

/**
 * What a source facet's fork did. The fork errors name an engine that cannot fork this source, so
 * the clone copies rows instead.
 */
export type DurableObjectFacetForkOutcome =
	| "forked"
	| "fork_error"
	| "fork_failed"
	| "fork_too_deep"
	| "fork_unavailable";

/** A snapshot that a facet holds for a clone, and its children's snapshots. */
export interface DurableObjectFacetExportManifest {
	readonly chunks: number;
	readonly children: readonly {
		readonly key: string[];
		readonly manifest: DurableObjectFacetExportManifest;
		readonly name: string;
	}[];
	readonly snapshotId: string;
}

function parseFacetKey(value: string): string[] {
	const key: unknown = JSON.parse(value);
	if (!Array.isArray(key) || !key.every((part) => typeof part === "string")) {
		throw new Error("Durable Object facet clone record is invalid");
	}
	return key;
}

export interface DurableObjectFacetObject {
	readonly className: string;
	readonly depth: number;
	readonly id: DurableObjectId | string;
	readonly props: unknown;
}

/** Stores the facet's create input, so the facet actor constructs it after every wake. */
export function storeDurableObjectFacet(
	database: RivetSynchronousSqliteExecutor,
	input: unknown,
): void {
	writeDurableObjectMetadata(database, "facet", requireFacetRecord(input));
}

/** Returns undefined for a clone destination that has no class yet. */
export function readDurableObjectFacet(
	database: RivetSynchronousSqliteExecutor | undefined,
): DurableObjectFacetObject | undefined {
	if (database === undefined) {
		throw new Error("The pinned RivetKit runtime did not provide the facet database");
	}
	const record = requireFacetRecord(readDurableObjectMetadata(database, "facet"));
	if (!isBoundFacetRecord(record)) return undefined;
	return {
		className: record.className,
		depth: record.depth,
		id: typeof record.id === "string" ? record.id : restoreDurableObjectId(record.id),
		props: decodeDurableObjectProps(record.props),
	};
}

export function requireDurableObjectFacetDepth(database: RivetSynchronousSqliteExecutor): number {
	return requireFacetRecord(readDurableObjectMetadata(database, "facet")).depth;
}

/**
 * Returns true when the class, props, or ID from the parent's startup options differ from the stored
 * ones, so the caller must store them and construct the new class.
 */
export function durableObjectFacetChanged(
	database: RivetSynchronousSqliteExecutor,
	input: unknown,
): boolean {
	const stored = requireFacetRecord(readDurableObjectMetadata(database, "facet"));
	const record = requireFacetRecord(input);
	if (!isBoundFacetRecord(stored) || !isBoundFacetRecord(record)) return true;
	return (
		stored.className !== record.className ||
		stored.props !== record.props ||
		!sameFacetId(stored.id, record.id)
	);
}

function sameFacetId(
	a: DurableObjectIdSnapshot | string,
	b: DurableObjectIdSnapshot | string,
): boolean {
	if (typeof a === "string" || typeof b === "string") return a === b;
	return a.hex === b.hex && a.name === b.name;
}

// Workerd gives facets no alarm scheduler, so setting one fails.
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/server/server.c%2B%2B#L1737-L1748
const facetAlarmMessage = "Facets currently cannot set alarms.";

export const durableObjectFacetAlarmController: DurableObjectAlarmController = {
	assertSupported(): void {
		throw new Error(facetAlarmMessage);
	},
	dispatch(): Promise<void> {
		return Promise.reject(new Error(facetAlarmMessage));
	},
	finishConstruction(): void {},
	restore(): Promise<void> {
		return Promise.resolve();
	},
	synchronize(): Promise<void> {
		return Promise.resolve();
	},
};

function requireFacetName(value: unknown): string {
	return String(value);
}

// `encodeURIComponent` output never contains `:`, so the two forms never collide.
// NUL, which the agents SDK puts in facet names, round-trips as `%00`.
export function encodeFacetName(name: string): string {
	let encoded: string | undefined;
	try {
		encoded = encodeURIComponent(name);
	} catch {
		// A lone surrogate cannot be URI-encoded, so the name is hashed instead.
	}
	if (encoded !== undefined && encoded.length <= maximumEncodedNameLength) {
		return encoded;
	}
	const digest = createHash("sha256")
		.update(Buffer.from(name, "utf16le"))
		.digest("hex");
	return `sha256:${digest}`;
}

/**
 * The Rivet actor key of a facet. A root parent's children include its class. A facet parent's
 * class can change while its storage stays, so its children are keyed by the parent actor alone,
 * as workerd keys facet storage by name.
 * https://github.com/cloudflare/workerd/blob/7236b3650b6c0951484a4d170f17fb6f800b5662/src/workerd/server/factory/worker-factory-actor.c%2B%2B#L76-L103
 */
export function durableObjectFacetKey(
	host: Pick<DurableObjectFacetHost, "deploymentIdentity">,
	parent: { readonly actorId: string; readonly className: string; readonly depth: number },
	encodedName: string,
	incarnation: number,
): string[] {
	return [
		host.deploymentIdentity,
		"facet",
		parent.depth === 0 ? parent.className : durableObjectFacetClassName,
		parent.actorId,
		encodedName,
		String(incarnation),
	];
}

const settled = (): undefined => undefined;

/**
 * Facet work that later calls to a facet name must wait for, per parent actor and encoded name.
 * It lives outside the parent's object, so a parent that `ctx.abort()` resets in this process
 * still waits for the copies its old object started.
 */
const facetWork = new Map<string, Map<string, Promise<void>>>();

/** The work that calls to the facet must wait for. It rejects when a clone into it failed. */
export function pendingDurableObjectFacetWork(
	parentActorId: string,
	encodedName: string,
): Promise<void> | undefined {
	return facetWork.get(parentActorId)?.get(encodedName);
}

/**
 * Runs `operation` after earlier work on every name in `names`. Calls to names in `failOn` reject
 * while the operation's failure is the latest work, and calls to the others continue either way.
 */
export function enqueueDurableObjectFacetWork<Result>(
	parentActorId: string,
	names: readonly string[],
	failOn: ReadonlySet<string>,
	operation: () => Promise<Result>,
): Promise<Result> {
	let work = facetWork.get(parentActorId);
	if (work === undefined) {
		work = new Map();
		facetWork.set(parentActorId, work);
	}
	const parentWork = work;
	const previous = Promise.all(
		names.map((name) => parentWork.get(name)?.then(settled, settled)),
	);
	const job = previous.then(operation);
	for (const name of new Set(names)) {
		const tail = failOn.has(name) ? job.then(settled) : job.then(settled, settled);
		parentWork.set(name, tail);
		const forget = (): void => {
			if (parentWork.get(name) !== tail) return;
			parentWork.delete(name);
			if (parentWork.size === 0 && facetWork.get(parentActorId) === parentWork) {
				facetWork.delete(parentActorId);
			}
		};
		// A failed clone stays, so the destination keeps failing until the next clone or restart.
		tail.then(forget, settled);
	}
	return job;
}

// An operator can set `ORANGE_FACET_CLONE=copy` to copy rows instead of forking, for example
// to compare the two.
function facetClonesFork(): boolean {
	return process.env.ORANGE_FACET_CLONE !== "copy";
}

/**
 * Copies the facet actor at `srcKey`, with its children, to a new actor at `dstKey`. It forks the
 * source actor when the engine can, and copies rows otherwise. A missing source leaves `dstKey`
 * empty. Running it again after a crash finishes the
 * same copy, because both paths recognize their own `cloneId`.
 */
export async function cloneDurableObjectFacetActor(
	host: DurableObjectFacetHost,
	clone: {
		readonly cloneId: string;
		readonly depth: number;
		readonly dstKey: readonly string[];
		readonly srcKey: readonly string[];
	},
): Promise<void> {
	const client = host.client();
	if (!(await client.exists(host.actorName, clone.srcKey))) {
		// A record from a release before forks names dst's existing key. The row copy empties it.
		if (!(await client.exists(host.actorName, clone.dstKey))) return;
	} else if (facetClonesFork()) {
		const request: DurableObjectFacetForkRequest = { cloneId: clone.cloneId, key: [...clone.dstKey] };
		const outcome = await client
			.get(host.actorName, clone.srcKey)
			.action({ args: [request], name: durableObjectFacetActions.fork });
		if (outcome === "forked") return;
		// A source that never started has no storage to fork; the row copy then finds it empty.
		console.warn(
			`[durable-object] facet clone copies rows instead of forking: actor.${String(outcome)} clone_id=${clone.cloneId}`,
		);
	}
	const request: DurableObjectFacetImportRequest = { cloneId: clone.cloneId, source: { key: [...clone.srcKey] } };
	await client
		.getOrCreate(host.actorName, clone.dstKey, unboundDurableObjectFacetRecord(clone.depth))
		.action({ args: [request], name: durableObjectFacetActions.import });
}

/** A clone() whose copy has not finished. It is also a row of the parent's clone table. */
interface FacetCloneRecord {
	readonly dst: string;
	readonly dstKey: readonly string[];
	readonly id: string;
	readonly src: string;
	readonly srcKey: readonly string[];
}

function cloneIncarnation(clone: FacetCloneRecord): number {
	return Number(clone.dstKey.at(-1));
}

/**
 * Clones whose record their parent has not stored durably yet, per parent actor and encoded dst
 * name. The parent's later objects in this process read dst's incarnation from them, so a parent
 * whose ctx.abort() discarded the record still reaches the copy, and stores the record again.
 */
const clonesInFlight = new Map<string, Map<string, FacetCloneRecord>>();

/** Per-name incarnations in the parent's SQLite. `delete()` and clone() advance one so the next facet gets a new actor. */
class FacetIncarnations {
	readonly #database: DurableObjectTurnDatabase;
	readonly #parentActorId: string;
	#tableExists = false;

	constructor(database: DurableObjectTurnDatabase, parentActorId: string) {
		this.#database = database;
		this.#parentActorId = parentActorId;
	}

	get(encodedName: string): number {
		const clone = clonesInFlight.get(this.#parentActorId)?.get(encodedName);
		return Math.max(this.stored(encodedName), clone === undefined ? 0 : cloneIncarnation(clone));
	}

	/** The incarnation in SQLite, without clones in flight. */
	stored(encodedName: string): number {
		if (!this.#tableExists) {
			this.#tableExists =
				this.#database.executeSync(incarnationTableExistsSql).rows.length > 0;
			if (!this.#tableExists) return 0;
		}
		const value = this.#database.executeSync(selectIncarnationSql, [encodedName])
			.rows[0]?.[0];
		if (value === undefined) return 0;
		const incarnation = Number(value);
		if (!Number.isSafeInteger(incarnation) || incarnation < 0) {
			throw new Error("Durable Object facet incarnation is invalid");
		}
		return incarnation;
	}

	/** This parent's clones whose record an earlier object did not store. */
	unstoredClones(): FacetCloneRecord[] {
		return [...(clonesInFlight.get(this.#parentActorId)?.values() ?? [])].filter(
			(clone) => this.stored(clone.dst) < cloneIncarnation(clone),
		);
	}

	bump(encodedName: string): void {
		const next = this.get(encodedName) + 1;
		if (!this.#tableExists) {
			this.#database.executeSync(createDurableObjectFacetIncarnationTableSql);
			this.#tableExists = true;
		}
		this.#database.executeSync(advanceIncarnationSql, [encodedName, next]);
	}

	/**
	 * Stores the clone's record and moves dst to its incarnation in one commit-boundary write. Reads
	 * see the incarnation at once. Resolves true when the write is durable, and false when the
	 * parent discarded it.
	 */
	recordClone(clone: FacetCloneRecord): Promise<boolean> {
		let clones = clonesInFlight.get(this.#parentActorId);
		if (clones === undefined) {
			clones = new Map();
			clonesInFlight.set(this.#parentActorId, clones);
		}
		const earlier = clones.get(clone.dst);
		if (earlier === undefined || cloneIncarnation(earlier) <= cloneIncarnation(clone)) {
			clones.set(clone.dst, clone);
		}
		this.#database.writeAtCommitBoundary(
			() => {
				this.#database.executeSync(createDurableObjectFacetIncarnationTableSql);
				this.#database.executeSync(advanceIncarnationSql, [clone.dst, cloneIncarnation(clone)]);
				this.#database.executeSync(createCloneTableSql);
				this.#database.executeSync(insertCloneSql, [
					clone.id,
					clone.src,
					clone.dst,
					JSON.stringify(clone.srcKey),
					JSON.stringify(clone.dstKey),
				]);
			},
			{ confirmed: true },
		);
		return this.#database.whenCommitBoundaryWritesCommit().then(
			async (committed) => {
				if (!committed) return false;
				await this.#database.whenDurable(this.#database.commitTicket());
				return true;
			},
		).catch((error: unknown) => {
			// The clone stays in flight, so the parent's next object stores it again.
			console.warn("[durable-object] facet clone record did not become durable", error);
			return false;
		});
	}

	/** Forgets a clone in flight once SQLite holds its record durably. */
	settle(clone: FacetCloneRecord): void {
		const clones = clonesInFlight.get(this.#parentActorId);
		if (clones?.get(clone.dst) !== clone) return;
		clones.delete(clone.dst);
		if (clones.size === 0) clonesInFlight.delete(this.#parentActorId);
	}

	/**
	 * Records that the name has storage, so a clone of this object copies the facet. It commits
	 * with the parent's turn, outside any storage transaction the caller may roll back, and before
	 * the parent's outputs.
	 */
	register(encodedName: string, incarnation: number): void {
		this.#database.writeAtCommitBoundary(
			() => {
				this.#database.executeSync(createDurableObjectFacetIncarnationTableSql);
				this.#database.executeSync(registerIncarnationSql, [encodedName, incarnation]);
			},
			{ confirmed: true },
		);
	}
}

export interface DurableObjectFacetParent {
	/** The parent's Rivet actor id. Facet keys use it, so a deleted parent facet's children become unreachable. */
	readonly actorId: string;
	readonly className: string;
	readonly database: DurableObjectTurnDatabase;
	/** 0 for a root Durable Object. */
	readonly depth: number;
	readonly id: DurableObjectId | string;
	waitUntil(promise: Promise<unknown>): void;
}

interface FacetEntry {
	readonly actor: Promise<RivetActorHandle>;
	readonly detached: AbortController;
	readonly lifecycles: Set<DurableObjectStubLifecycle>;
	/** Routes stub transports to `actor` once it resolves. */
	readonly target: RivetActorHandle;
}

class FacetManager {
	readonly #entries = new Map<string, FacetEntry>();
	readonly #host: DurableObjectFacetHost;
	readonly #incarnations: FacetIncarnations;
	readonly #parent: DurableObjectFacetParent;
	readonly #pendingResets = new Map<string, Promise<void>>();
	readonly #registered = new Set<string>();
	#recovered = false;

	constructor(host: DurableObjectFacetHost, parent: DurableObjectFacetParent) {
		this.#host = host;
		this.#incarnations = new FacetIncarnations(parent.database, parent.actorId);
		this.#parent = parent;
	}

	// Runs the clones that a previous object of this parent left unfinished, before any facet
	// call. A clone is idempotent, so running a finished one again changes nothing.
	#recover(): void {
		if (this.#recovered) return;
		this.#recovered = true;
		// A clone whose record an earlier object of this parent discarded, for example with
		// ctx.abort(), runs in this process once this object stores the record again.
		for (const clone of this.#incarnations.unstoredClones()) {
			this.#registered.add(clone.dst);
			this.#enqueueClone(clone, this.#incarnations.recordClone(clone));
		}
		const database = this.#parent.database;
		if (database.executeSync(cloneTableExistsSql).rows.length === 0) return;
		for (const [id, src, dst, srcKey, dstKey] of database.executeSync(selectClonesSql).rows) {
			if (
				typeof id !== "string" ||
				typeof src !== "string" ||
				typeof dst !== "string" ||
				typeof srcKey !== "string" ||
				typeof dstKey !== "string"
			) {
				throw new Error("Durable Object facet clone record is invalid");
			}
			this.#enqueueClone(
				{ dst, dstKey: parseFacetKey(dstKey), id, src, srcKey: parseFacetKey(srcKey) },
				Promise.resolve(true),
			);
		}
	}

	get(nameValue: unknown, getStartupOptions: unknown): object {
		const name = requireFacetName(nameValue);
		this.#recover();
		// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/actor-state.c%2B%2B#L1042-L1044
		if (this.#parent.depth + 1 >= maximumFacetTreeDepth) {
			throw new Error(
				`Facet nesting depth limit exceeded. The maximum depth including the root Durable Object is ${maximumFacetTreeDepth}.`,
			);
		}
		if (typeof getStartupOptions !== "function") {
			throw new TypeError("Facet startup options must be a function");
		}
		return createFacetStub(
			(lifecycle) => this.#bind(name, () => getStartupOptions(), lifecycle),
			this.#parent.id.toString(),
		);
	}

	// Workerd aborts the running facet and keeps its storage. Its old stubs fail with `reason`.
	// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/server/server.c%2B%2B#L747-L752
	abort(nameValue: unknown, reason: unknown): void {
		const name = requireFacetName(nameValue);
		this.#recover();
		const entry = this.#detach(
			name,
			reason instanceof Error ? reason : new Error(String(reason)),
		);
		if (entry === undefined) return;
		// Orange restarts the child actor so the next instance starts with fresh memory. The next
		// entry for the name waits for this, so it never reaches the old instance.
		const reset = entry.actor
			.then(async (actor) => {
				await this.#settledWork(encodeFacetName(name));
				return actor;
			})
			.then((actor) =>
				actor.action({
					args: ["Facet was aborted."],
					name: durableObjectFacetActions.reset,
				}),
			)
			.then(
				() => undefined,
				() => undefined,
			);
		this.#pendingResets.set(name, reset);
		this.#keepParentAwake(reset);
	}

	// Workerd aborts the facet and deletes its storage. An unknown name is a no-op.
	// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/server/server.c%2B%2B#L754-L766
	delete(nameValue: unknown): void {
		const name = requireFacetName(nameValue);
		this.#recover();
		this.#detach(name, new Error("Facet was deleted."));
		this.#pendingResets.delete(name);
		const encodedName = encodeFacetName(name);
		const oldKey = this.#key(encodedName, this.#incarnations.get(encodedName));
		// The next get() uses a new key, so it gets a new actor with empty storage.
		this.#incarnations.bump(encodedName);
		// Destroying the old actor only frees it, so a failure leaves an orphan and nothing else.
		const destroy = (async () => {
			// A clone that reads the old facet copies it first.
			await this.#settledWork(encodedName);
			const actor = this.#host.client().get(this.#host.actorName, oldKey);
			await actor.action({ args: [], name: durableObjectFacetActions.destroy });
		})().then(
			() => undefined,
			() => undefined,
		);
		this.#keepParentAwake(destroy);
	}

	/**
	 * Replaces `dst`'s storage, and its children's, with a copy of `src`'s as of this call. Workerd
	 * copies SQLite files synchronously. Orange returns at once and forks `src`'s actor, with its
	 * children, to a new incarnation of `dst` in the background; an engine that cannot fork it gets
	 * a row copy instead. Calls to `src` and `dst` that start after this call wait for the copy, so
	 * `dst` never misses it and later writes to `src` never reach it.
	 * https://github.com/cloudflare/workerd/blob/7236b3650b6c0951484a4d170f17fb6f800b5662/src/workerd/server/server/actor.rs#L1029-L1044
	 */
	clone(srcValue: unknown, dstValue: unknown): void {
		const src = requireFacetName(srcValue);
		const dst = requireFacetName(dstValue);
		// No facet can exist below the maximum depth, so there is nothing to copy or replace.
		if (this.#parent.depth + 1 >= maximumFacetTreeDepth) return;
		this.#recover();
		const reason = new Error("Facet was cloned-over.");
		if (src === dst) {
			// Workerd only aborts the facet. Its storage stays.
			this.abort(dst, reason);
			return;
		}
		this.#detach(dst, reason);
		this.#pendingResets.delete(dst);
		const encodedSrc = encodeFacetName(src);
		const encodedDst = encodeFacetName(dst);
		const srcKey = this.#key(encodedSrc, this.#incarnations.get(encodedSrc));
		// The copy goes to a key that never had an actor. The old dst is destroyed afterwards, and
		// its key is never used again.
		const dstIncarnation = this.#incarnations.get(encodedDst) + 1;
		const dstKey = this.#key(encodedDst, dstIncarnation);
		const clone: FacetCloneRecord = { dst: encodedDst, dstKey, id: randomUUID(), src: encodedSrc, srcKey };
		// The record and the new incarnation commit together with the parent's turn, outside the
		// caller's storage transactions, and before the parent's outputs, so a caller that sees
		// clone() return sees the copy after a crash. The copy starts once they are durable.
		this.#registered.add(encodedDst);
		this.#enqueueClone(clone, this.#incarnations.recordClone(clone));
	}

	#enqueueClone(clone: FacetCloneRecord, recorded: Promise<boolean>): void {
		const copy = enqueueDurableObjectFacetWork(
			this.#parent.actorId,
			[clone.src, clone.dst],
			new Set([clone.dst]),
			// The copy does not wait for the parent's output gate. Workerd's copy does not depend on
			// the parent's turn either, so ctx.abort() after clone() keeps it.
			() => runOutsideOutputGate(async () => {
				// A crash after this point finds the record and runs the clone again. A parent that
				// discarded the record copies nothing yet: its next object stores the record again and
				// copies then, before any facet call. So no actor ever exists at an incarnation that
				// the parent's SQLite does not hold, and a crash first loses the clone whole.
				if (!(await recorded)) return false;
				await cloneDurableObjectFacetActor(this.#host, {
					cloneId: clone.id,
					depth: this.#parent.depth + 1,
					dstKey: clone.dstKey,
					srcKey: clone.srcKey,
				});
				try {
					this.#parent.database.writeAtCommitBoundary(() => {
						this.#parent.database.executeSync(deleteCloneSql, [clone.id]);
					});
				} catch {
					// A reset parent keeps the record. Its next object runs the finished clone again,
					// which changes nothing.
				}
				return true;
			}),
		);
		// Once the parent holds the new incarnation durably, the actor that dst had before it is
		// destroyed. Until then it stays, so a parent that lost the incarnation never reuses its key.
		const oldKey = this.#key(clone.dst, cloneIncarnation(clone) - 1);
		const destroy = copy.then(async (durable) => {
			if (!durable) return;
			this.#incarnations.settle(clone);
			const client = this.#host.client();
			if (!(await client.exists(this.#host.actorName, oldKey))) return;
			await client
				.get(this.#host.actorName, oldKey)
				.action({ args: [], name: durableObjectFacetActions.destroy });
		}).catch((error: unknown) => {
			// A failed copy fails dst's calls, and the record runs it again. A failed destroy leaves
			// an orphan actor and nothing else.
			console.warn(`[durable-object] facet clone did not finish clone_id=${clone.id}`, error);
		});
		this.#keepParentAwake(destroy);
	}

	#register(encodedName: string, incarnation: number): void {
		if (this.#registered.has(encodedName)) return;
		this.#registered.add(encodedName);
		this.#incarnations.register(encodedName, incarnation);
	}

	// Waits for the facet's pending work without failing when a clone into it failed.
	async #settledWork(encodedName: string): Promise<void> {
		await pendingDurableObjectFacetWork(this.#parent.actorId, encodedName)?.then(
			settled,
			settled,
		);
	}

	// Workerd binds a stub to the running facet at its first call. A repeat get() while the facet
	// runs reuses it and skips the startup callback.
	// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/server/server.c%2B%2B#L716-L732
	#bind(
		name: string,
		getStartupOptions: () => unknown,
		lifecycle: DurableObjectStubLifecycle,
	): RivetActorHandle {
		let entry = this.#entries.get(name);
		if (entry === undefined) {
			entry = this.#start(name, getStartupOptions);
			this.#entries.set(name, entry);
		}
		entry.lifecycles.add(lifecycle);
		return entry.target;
	}

	#start(name: string, getStartupOptions: () => unknown): FacetEntry {
		const previousReset = this.#pendingResets.get(name);
		this.#pendingResets.delete(name);
		let startup: Promise<unknown>;
		try {
			startup = Promise.resolve(getStartupOptions());
		} catch (error: unknown) {
			startup = Promise.reject(error);
		}
		const detached = new AbortController();
		const actor = (async (): Promise<RivetActorHandle> => {
			// Read the incarnation now, so a delete() after this call cannot move the call to the
			// next incarnation.
			const encodedName = encodeFacetName(name);
			const incarnation = this.#incarnations.get(encodedName);
			const key = this.#key(encodedName, incarnation);
			this.#register(encodedName, incarnation);
			const record = this.#record(await startup);
			await previousReset;
			// A clone into this facet must finish first. When it failed, the call fails with it.
			await pendingDurableObjectFacetWork(this.#parent.actorId, encodedName);
			// An entry that abort() or delete() detached never creates its actor.
			detached.signal.throwIfAborted();
			const handle = this.#host
				.client()
				.getOrCreate(this.#host.actorName, key, record);
			// A new entry uses the class and ID from its own startup callback, as workerd does when
			// it starts a facet that is not running, for example after abort(). The facet actor
			// restarts when they differ from the ones it runs. Storage stays with the name.
			// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/server/server.c%2B%2B#L716-L752
			// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/server/server-test.c%2B%2B#L5783-L5788
			await handle.action({ args: [record], name: durableObjectFacetActions.bind });
			return handle;
		})();
		// A call that a clone() in the same turn follows waits for the copy, as workerd copies before
		// the call runs. The check runs after a promise turn, so it sees that clone().
		const ready = async (): Promise<RivetActorHandle> => {
			const handle = await actor;
			await pendingDurableObjectFacetWork(this.#parent.actorId, encodeFacetName(name));
			return handle;
		};
		const entry: FacetEntry = {
			actor,
			detached,
			lifecycles: new Set(),
			target: {
				action: async (options) => await (await ready()).action(options),
				fetch: async (request) => await (await ready()).fetch(request),
				webSocket: async (path) => await (await ready()).webSocket(path),
			},
		};
		// A failed start does not stick. The next get() runs its own startup callback.
		actor.catch(() => {
			if (this.#entries.get(name) === entry) this.#entries.delete(name);
		});
		return entry;
	}

	#record(startup: unknown): DurableObjectFacetRecord {
		if (typeof startup !== "object" || startup === null) {
			throw new TypeError("Facet startup options must be an object with a `class`");
		}
		const { className, props } = this.#host.classTarget(Reflect.get(startup, "class"));
		// A facet without an `id` inherits its parent's ID. A string `id` becomes the facet's
		// `ctx.id` as is.
		// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/actor-state.c%2B%2B#L1054-L1066
		// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/actor-state.c%2B%2B#L1161-L1171
		const startupId: unknown = Reflect.get(startup, "id");
		const id = startupId === undefined || startupId === null ? this.#parent.id : startupId;
		const snapshot = typeof id === "string" ? id : snapshotDurableObjectId(id);
		if (snapshot === undefined) {
			throw new TypeError("Facet startup option `id` must be a DurableObjectId or a string");
		}
		return {
			className,
			depth: this.#parent.depth + 1,
			id: snapshot,
			...(props === undefined ? {} : { props }),
		};
	}

	#detach(name: string, error: Error): FacetEntry | undefined {
		const entry = this.#entries.get(name);
		if (entry === undefined) return undefined;
		this.#entries.delete(name);
		entry.detached.abort(error);
		for (const lifecycle of entry.lifecycles) lifecycle.abort(error);
		return entry;
	}

	#key(encodedName: string, incarnation: number): readonly string[] {
		return durableObjectFacetKey(this.#host, this.#parent, encodedName, incarnation);
	}

	#keepParentAwake(promise: Promise<void>): void {
		try {
			this.#parent.waitUntil(promise);
		} catch {
			// A parent that already reset cannot be held awake. The work still runs.
		}
	}
}

const facetStubFetchers = new WeakMap<
	object,
	(input: Request | string | URL, init?: RequestInit) => Promise<Response>
>();

// Workerd returns a plain Fetcher without `id` or `name`.
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/actor-state.c%2B%2B#L1103-L1107
class DurableObjectFacetStub {
	fetch(input: Request | string | URL, init?: RequestInit): Promise<Response> {
		const fetchFacet = facetStubFetchers.get(this);
		if (fetchFacet === undefined) {
			return Promise.reject(new TypeError("Illegal invocation"));
		}
		return fetchFacet(input, init);
	}
}

function createFacetStub(
	bind: (lifecycle: DurableObjectStubLifecycle) => RivetActorHandle,
	durableObjectId: string,
): object {
	const lifecycle = new DurableObjectStubLifecycle();
	let target: RivetActorHandle | undefined;
	// Binds synchronously at the call, so a later abort() or delete() fails the call.
	const bound = (): RivetActorHandle => {
		target ??= bind(lifecycle);
		return target;
	};
	const stub = new Proxy(new DurableObjectFacetStub(), {
		get(object, property, receiver): unknown {
			if (property === "then") return undefined;
			if (Reflect.has(object, property)) {
				return Reflect.get(object, property, receiver);
			}
			if (typeof property !== "string") return undefined;
			if (property === "connect") {
				return (): never => {
					throw notSupported("Fetcher.connect() is not supported on facet stubs by Orange");
				};
			}
			if (isDurableObjectReservedRpcMethod(property)) return undefined;
			const actor = bound();
			return createDurableObjectStubRpcProperty(
				() => actor,
				lifecycle,
				property,
				durableObjectId,
			);
		},
	});
	facetStubFetchers.set(stub, (input, init) => {
		let request: Request;
		try {
			request = prepareDurableObjectFetch(input, init);
		} catch (error: unknown) {
			return Promise.reject(error);
		}
		const actor = bound();
		return lifecycle.start((order, signal) =>
			fetchDurableObjectStub(() => actor, request, order, signal),
		).promise;
	});
	return stub;
}

export function createDurableObjectFacets(
	host: DurableObjectFacetHost,
	parent: DurableObjectFacetParent,
): DurableObjectFacets {
	const manager = new FacetManager(host, parent);
	return {
		abort: (name, reason) => manager.abort(name, reason),
		clone: (src, dst) => manager.clone(src, dst),
		delete: (name) => manager.delete(name),
		get: (name, getStartupOptions) => manager.get(name, getStartupOptions),
	};
}
