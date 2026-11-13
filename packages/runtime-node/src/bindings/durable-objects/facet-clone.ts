import { randomUUID } from "node:crypto";
import { setImmediate as nextTurn, setTimeout as sleep } from "node:timers/promises";

import {
	isRivetStorageOverloaded,
	type RivetActorFork,
	rivetActorErrorCode,
	type RivetSqliteDatabase,
	type RivetSynchronousSqliteExecutor,
} from "../../internal/rivetkit.js";
import {
	cloneDurableObjectFacetActor,
	createDurableObjectFacetIncarnationTableSql,
	durableObjectFacetCloneTable,
	type DurableObjectFacetForkInput,
	type DurableObjectFacetForkOutcome,
	type DurableObjectFacetForkRequest,
	type DurableObjectFacetExportManifest,
	type DurableObjectFacetHost,
	type DurableObjectFacetImportRequest,
	durableObjectFacetActions,
	durableObjectFacetIncarnationTable,
	durableObjectFacetKey,
	enqueueDurableObjectFacetWork,
	requireDurableObjectFacetDepth,
	unboundDurableObjectFacetRecord,
} from "./facets.js";
import {
	durableObjectMetadataTable,
	readDurableObjectMetadata,
	writeDurableObjectMetadata,
} from "./metadata.js";
import {
	readSqliteSnapshotChunks,
	SqliteSnapshotFrameReader,
	SqliteSnapshotWriter,
} from "./sqlite-snapshot.js";

/** The facet actor that a clone reads from or writes into. */
export interface DurableObjectFacetCloneActor {
	readonly actorId: string;
	/**
	 * The actor's own SQLite, outside any object's turn. Use it only inside the object's events
	 * or after the object is cleared: RivetKit rejects it while a storage transaction is open.
	 */
	readonly database: RivetSqliteDatabase;
	readonly host: DurableObjectFacetHost;
}

// The copy is the object's storage: user tables, workerd's `_cf_` tables, and the facet registry
// that names its children. RivetKit's and Orange's other `_rivet_` tables stay with each actor.
function isCopiedTable(table: string): boolean {
	return !table.startsWith("_rivet_") || table === durableObjectFacetIncarnationTable;
}

// A snapshot stays in the source's memory until its clone reads it. An importer that dies leaves
// it, so it expires after this long without a read.
const snapshotIdleMs = 5 * 60_000;
// The import holds one transaction while chunks arrive, longer than RivetKit's 60-second default.
const importTransactionTimeoutMs = 10 * 60_000;
const chunkReadsInFlight = 4;
// Chunks the importer confirmed are dropped, so the source holds only the unread rest.
const snapshots = new Map<string, { chunks: (Uint8Array | undefined)[]; timer: NodeJS.Timeout }>();

function keepSnapshot(snapshotId: string, chunks: Uint8Array[]): void {
	const timer = setTimeout(() => snapshots.delete(snapshotId), snapshotIdleMs);
	timer.unref();
	snapshots.set(snapshotId, { chunks, timer });
}

function readIncarnations(database: RivetSynchronousSqliteExecutor): Map<string, number> {
	const incarnations = new Map<string, number>();
	const exists = database.executeSync(
		`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '${durableObjectFacetIncarnationTable}'`,
	).rows.length > 0;
	if (!exists) return incarnations;
	for (const [name, incarnation] of database.executeSync(
		`SELECT name, incarnation FROM ${durableObjectFacetIncarnationTable}`,
	).rows) {
		const value = Number(incarnation);
		if (typeof name !== "string" || !Number.isSafeInteger(value) || value < 0) {
			throw new Error("Durable Object facet incarnation is invalid");
		}
		incarnations.set(name, value);
	}
	return incarnations;
}

/**
 * Takes this facet's snapshot for a clone, then its children's. `readInObject` runs the read as an
 * event of the running object, if any, so it never sees an open transaction. The read is one
 * synchronous call, so no write lands in the middle of it. Calls from this facet to its children
 * wait until each child's snapshot is taken, so none reaches the copy.
 */
export async function exportDurableObjectFacet(
	actor: DurableObjectFacetCloneActor,
	readInObject: <Result>(read: () => Result) => Promise<Result>,
): Promise<DurableObjectFacetExportManifest> {
	const { children, chunks } = await readInObject(() => {
		const read = readSqliteSnapshotChunks(actor.database, isCopiedTable);
		const held = [...readIncarnations(actor.database)].map(([name, incarnation]) => {
			const release = Promise.withResolvers<void>();
			enqueueDurableObjectFacetWork(actor.actorId, [name], new Set(), () => release.promise);
			return { incarnation, name, release: release.resolve };
		});
		return { children: held, chunks: read };
	});
	const snapshotId = randomUUID();
	keepSnapshot(snapshotId, chunks);
	const client = actor.host.client();
	const exported = await Promise.all(
		children.map(async (child) => {
			try {
				const key = durableObjectFacetKey(actor.host, facetParent(actor), child.name, child.incarnation);
				if (!(await client.exists(actor.host.actorName, key))) return undefined;
				const manifest = await client
					.get(actor.host.actorName, key)
					.action({ args: [], name: durableObjectFacetActions.export });
				return { key, manifest: requireManifest(manifest), name: child.name };
			} finally {
				child.release();
			}
		}),
	);
	return {
		chunks: chunks.length,
		children: exported.filter((child) => child !== undefined),
		snapshotId,
	};
}

/**
 * Forks this facet's actor to a new actor at the request's key, then its children under the new
 * actor. The fork copies the last durable commit, so the read commits the object's open turn first,
 * and never sees a transaction in progress. Calls from this facet to its children wait until each
 * child is copied, so none reaches the copy, and the copied tree is one consistent cut: nothing
 * else can call a facet. A fork that the engine refuses for good is returned, so the clone copies
 * rows instead.
 */
export async function forkDurableObjectFacet(
	actor: DurableObjectFacetCloneActor,
	requestValue: unknown,
	readInObject: <Result>(read: () => Result) => Promise<Result>,
): Promise<DurableObjectFacetForkOutcome> {
	const request = requireForkRequest(requestValue);
	const { children, depth } = await readInObject(() => {
		const held = [...readIncarnations(actor.database)].map(([name, incarnation]) => {
			const release = Promise.withResolvers<void>();
			enqueueDurableObjectFacetWork(actor.actorId, [name], new Set(), () => release.promise);
			return { incarnation, name, release: release.resolve };
		});
		return { children: held, depth: requireDurableObjectFacetDepth(actor.database) };
	});
	try {
		await actor.database.whenDurable(actor.database.commitTicket());
		const client = actor.host.client();
		const input: DurableObjectFacetForkInput = { cloneId: request.cloneId, depth };
		let forkedActorId: string;
		try {
			forkedActorId = await forkWhenStorageAccepts(() =>
				client.fork(actor.host.actorName, actor.actorId, request.key, input),
			);
		} catch (error: unknown) {
			const code = rivetActorErrorCode(error);
			if (code === "fork_failed" || code === "fork_too_deep" || code === "fork_unavailable") {
				return code;
			}
			// A clone that runs again after a crash finds its own fork. A fork still in progress
			// answers once it starts. Any other failure, such as a token without the fork grant,
			// falls back to the row copy, which only costs time.
			if (code !== "duplicate_key" && code !== "fork_pending") {
				console.warn(
					`[durable-object] facet fork failed, copying rows instead: ${error instanceof Error ? error.message : String(error)} clone_id=${request.cloneId}`,
				);
				return "fork_error";
			}
			const clonedBy = await client
				.get(actor.host.actorName, request.key)
				.action({ args: [], name: durableObjectFacetActions.clonedBy });
			if (clonedBy !== request.cloneId) {
				throw new Error("Durable Object facet clone destination holds another clone", { cause: error });
			}
			forkedActorId = await client.resolve(actor.host.actorName, request.key);
		}
		const forked = { actorId: forkedActorId, className: "", depth: 1 };
		await Promise.all(
			children.map((child) =>
				cloneDurableObjectFacetActor(actor.host, {
					cloneId: request.cloneId,
					depth: depth + 1,
					dstKey: durableObjectFacetKey(actor.host, forked, child.name, child.incarnation),
					srcKey: durableObjectFacetKey(actor.host, facetParent(actor), child.name, child.incarnation),
				}),
			),
		);
		return "forked";
	} finally {
		for (const child of children) child.release();
	}
}

// The Engine's storage refuses a fork for now while a volume changes, for example when many forks
// start at once. It asks for a retry after 100 ms.
const forkAttempts = 8;

async function forkWhenStorageAccepts(fork: () => Promise<string>): Promise<string> {
	for (let attempt = 1; ; attempt++) {
		try {
			return await fork();
		} catch (error: unknown) {
			if (!isRivetStorageOverloaded(error) || attempt === forkAttempts) throw error;
			await sleep(100 * 2 ** (attempt - 1));
		}
	}
}

/**
 * The forked actor's `onFork`. The copy is storage only, as in workerd: it keeps the user's tables
 * and the incarnations that name its children, and drops what Orange keeps beside the source's
 * object. It has no class until its parent's next get() binds one.
 */
export function storeForkedDurableObjectFacet(
	database: RivetSynchronousSqliteExecutor,
	fork: RivetActorFork,
): void {
	const input = requireForkInput(fork.input);
	const tables = new Set(
		database
			.executeSync("SELECT name FROM sqlite_master WHERE type = 'table'")
			.rows.map(([name]) => name),
	);
	// The source's unfinished clones belong to the source.
	if (tables.has(durableObjectFacetCloneTable)) {
		database.executeSync(`DELETE FROM ${durableObjectFacetCloneTable}`);
	}
	if (tables.has(durableObjectMetadataTable)) {
		database.executeSync(`DELETE FROM ${durableObjectMetadataTable}`);
	}
	writeDurableObjectMetadata(database, "facet", unboundDurableObjectFacetRecord(input.depth));
	writeDurableObjectMetadata(database, "clone", input.cloneId);
}

/** The clone that filled this facet, or undefined. */
export function readDurableObjectFacetCloneId(database: RivetSynchronousSqliteExecutor): unknown {
	return readDurableObjectMetadata(database, "clone");
}

/** Returns chunk `index`, and drops the chunks below `confirmed`, which the importer already holds. */
export function readDurableObjectFacetExportChunk(
	snapshotId: unknown,
	index: unknown,
	confirmed: unknown,
): Uint8Array {
	const snapshot = typeof snapshotId === "string" ? snapshots.get(snapshotId) : undefined;
	if (snapshot !== undefined && typeof confirmed === "number") {
		for (let below = 0; below < Math.min(confirmed, snapshot.chunks.length); below++) {
			snapshot.chunks[below] = undefined;
		}
	}
	const chunk = typeof index === "number" ? snapshot?.chunks[index] : undefined;
	if (snapshot === undefined || chunk === undefined) {
		throw new Error("Durable Object facet snapshot expired before the clone read it");
	}
	snapshot.timer.refresh();
	return chunk;
}

export function releaseDurableObjectFacetExport(snapshotId: unknown): void {
	if (typeof snapshotId !== "string") return;
	clearTimeout(snapshots.get(snapshotId)?.timer);
	snapshots.delete(snapshotId);
}

/**
 * Replaces this facet's storage and children with the source's snapshot. Children are copied to
 * new keys first, and this facet's own rows, with the incarnations that point at them, commit in
 * one transaction last, so a crash leaves the old facet whole. A request that already committed
 * does nothing, not even abort the object, so the parent can run it again after a crash.
 */
export async function importDurableObjectFacet(
	actor: DurableObjectFacetCloneActor,
	requestValue: unknown,
	readInObject: <Result>(read: () => Result) => Promise<Result>,
	clearObject: () => Promise<void>,
): Promise<void> {
	const request = requireImportRequest(requestValue);
	const applied = await readInObject(
		() => readDurableObjectMetadata(actor.database, "clone") === request.cloneId,
	);
	if (applied) return;
	await clearObject();
	const depth = requireDurableObjectFacetDepth(actor.database);
	const client = actor.host.client();
	let manifest = request.source.manifest;
	if (manifest === undefined && (await client.exists(actor.host.actorName, request.source.key))) {
		manifest = requireManifest(
			await client
				.get(actor.host.actorName, request.source.key)
				.action({ args: [], name: durableObjectFacetActions.export }),
		);
	}
	// Every name gets a key it never had, so old children never show through. The source's
	// children are copied to them; the others start empty.
	const oldIncarnations = readIncarnations(actor.database);
	const nextIncarnation = (name: string): number => (oldIncarnations.get(name) ?? -1) + 1;
	await Promise.all(
		(manifest?.children ?? []).map(async (child) => {
			const key = durableObjectFacetKey(
				actor.host,
				facetParent(actor),
				child.name,
				nextIncarnation(child.name),
			);
			const childRequest: DurableObjectFacetImportRequest = {
				cloneId: request.cloneId,
				source: { key: child.key, manifest: child.manifest },
			};
			await client
				.getOrCreate(actor.host.actorName, key, unboundDurableObjectFacetRecord(depth + 1))
				.action({ args: [childRequest], name: durableObjectFacetActions.import });
		}),
	);
	const source = manifest === undefined ? undefined : client.get(actor.host.actorName, request.source.key);
	const chunkCount = manifest?.chunks ?? 0;
	const snapshotId = manifest?.snapshotId;
	// A few reads run ahead of the writer to hide round trips. Each holds at most one chunk.
	const reads = new Map<number, Promise<Uint8Array>>();
	const readChunk = (index: number, confirmed: number): Promise<Uint8Array> => {
		if (source === undefined) throw new Error("Durable Object facet snapshot has no source");
		return source
			.action({ args: [snapshotId, index, confirmed], name: durableObjectFacetActions.exportChunk })
			.then((chunk: unknown) => {
				if (!(chunk instanceof Uint8Array)) {
					throw new TypeError("Durable Object facet snapshot chunk is invalid");
				}
				return chunk;
			});
	};
	await writeImport(actor, depth, oldIncarnations, request.cloneId, async (apply) => {
		const reader = new SqliteSnapshotFrameReader();
		for (let index = 0; index < chunkCount; index++) {
			for (let ahead = index; ahead < Math.min(chunkCount, index + chunkReadsInFlight); ahead++) {
				if (!reads.has(ahead)) reads.set(ahead, readChunk(ahead, index));
			}
			const chunk = await reads.get(index);
			reads.delete(index);
			if (chunk === undefined) throw new Error("Durable Object facet snapshot chunk is missing");
			for (const frame of reader.push(chunk)) apply(frame);
			// Other actors on this process run between chunks.
			await nextTurn();
		}
		reader.finish();
	}).finally(() => {
		// A failed import leaves reads in flight; their results are not needed.
		for (const read of reads.values()) read.catch(() => undefined);
	});
	await actor.database.whenDurable(actor.database.commitTicket());
	if (manifest !== undefined) {
		const snapshotId = manifest.snapshotId;
		// The snapshot expires anyway, so a failed release only holds memory longer.
		void client
			.get(actor.host.actorName, request.source.key)
			.action({ args: [snapshotId], name: durableObjectFacetActions.exportRelease })
			.catch(() => undefined);
	}
}

async function writeImport(
	actor: DurableObjectFacetCloneActor,
	depth: number,
	oldIncarnations: ReadonlyMap<string, number>,
	cloneId: string,
	copyRows: (apply: (frame: unknown) => void) => Promise<void>,
): Promise<void> {
	const database = actor.database;
	// Rows that break a foreign key can exist in the source when it turned the check off. Workerd
	// copies them with the file, so the copy skips the check too. The setting cannot change
	// inside a transaction.
	const foreignKeys = database.executeSync("PRAGMA foreign_keys").rows[0]?.[0];
	database.executeSync("PRAGMA foreign_keys = OFF");
	try {
		// One transaction holds the whole copy, so it commits whole or not at all. Nothing else
		// writes to this facet while it imports.
		const transaction = database.beginTransactionSync(importTransactionTimeoutMs);
		try {
			const writer = new SqliteSnapshotWriter(transaction, isCopiedTable);
			await copyRows((frame) => writer.apply(frame));
			writer.finish();
			transaction.executeSync(createDurableObjectFacetIncarnationTableSql);
			const copied = readIncarnations(transaction);
			for (const name of new Set([...copied.keys(), ...oldIncarnations.keys()])) {
				transaction.executeSync(
					`INSERT INTO ${durableObjectFacetIncarnationTable} (name, incarnation) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET incarnation = excluded.incarnation`,
					[name, (oldIncarnations.get(name) ?? -1) + 1],
				);
			}
			// The copy is storage only, as in workerd. Settings that Orange keeps beside it, such as
			// WebSocket auto-responses, belong to the aborted object.
			transaction.executeSync(
				`DELETE FROM ${durableObjectMetadataTable} WHERE key NOT IN ('facet')`,
			);
			writeDurableObjectMetadata(transaction, "facet", unboundDurableObjectFacetRecord(depth));
			writeDurableObjectMetadata(transaction, "clone", cloneId);
			transaction.commitSync();
		} catch (error: unknown) {
			transaction.rollbackSync();
			throw error;
		}
	} finally {
		database.executeSync(`PRAGMA foreign_keys = ${foreignKeys === 0 || foreignKeys === 0n ? "OFF" : "ON"}`);
	}
}

// A facet's children are keyed by its actor alone, so its class does not matter here.
function facetParent(actor: DurableObjectFacetCloneActor): {
	actorId: string;
	className: string;
	depth: number;
} {
	return { actorId: actor.actorId, className: "", depth: 1 };
}

function field(value: unknown, key: string): unknown {
	return typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((part) => typeof part === "string");
}

function requireManifest(value: unknown): DurableObjectFacetExportManifest {
	const chunks = field(value, "chunks");
	const children = field(value, "children");
	const snapshotId = field(value, "snapshotId");
	if (
		typeof chunks !== "number" ||
		!Number.isSafeInteger(chunks) ||
		chunks < 0 ||
		typeof snapshotId !== "string" ||
		!Array.isArray(children)
	) {
		throw new TypeError("Durable Object facet snapshot manifest is invalid");
	}
	return {
		chunks,
		children: children.map((child: unknown) => {
			const key = field(child, "key");
			const name = field(child, "name");
			if (!isStringArray(key) || typeof name !== "string") {
				throw new TypeError("Durable Object facet snapshot manifest is invalid");
			}
			return { key, manifest: requireManifest(field(child, "manifest")), name };
		}),
		snapshotId,
	};
}

function requireForkRequest(value: unknown): DurableObjectFacetForkRequest {
	const cloneId = field(value, "cloneId");
	const key = field(value, "key");
	if (typeof cloneId !== "string" || !isStringArray(key)) {
		throw new TypeError("Durable Object facet fork request is invalid");
	}
	return { cloneId, key };
}

function requireForkInput(value: unknown): DurableObjectFacetForkInput {
	const cloneId = field(value, "cloneId");
	const depth = field(value, "depth");
	if (typeof cloneId !== "string" || typeof depth !== "number") {
		throw new TypeError("Durable Object facet fork input is invalid");
	}
	return { cloneId, depth };
}

function requireImportRequest(value: unknown): DurableObjectFacetImportRequest {
	const cloneId = field(value, "cloneId");
	const source = field(value, "source");
	const key = field(source, "key");
	const manifest = field(source, "manifest");
	if (typeof cloneId !== "string" || !isStringArray(key)) {
		throw new TypeError("Durable Object facet clone request is invalid");
	}
	return {
		cloneId,
		source: manifest === undefined ? { key } : { key, manifest: requireManifest(manifest) },
	};
}
