import { Buffer } from "node:buffer";
import { createHash, randomBytes } from "node:crypto";

import { Response as OrangeResponse } from "../../globals/http.js";
import { WebSocketPair } from "../../globals/websocket.js";
import type { InternalObjectState } from "../internal-objects.js";
import { r2Limits, type R2Checksums, type R2ListPage, type R2ListRequest, type R2StoredObject } from "./backend.js";
import { conditionPasses, type R2Conditional, type R2HttpFields } from "./conditional.js";
import { R2StorageError } from "./errors.js";
import {
	parseR2ChunkRead,
	parseR2Checksums,
	parseR2CommitRequest,
	parseR2CompleteRequest,
	parseR2CreateUploadRequest,
	parseR2HttpFields,
	parseR2ListRequest,
	parseR2PartRequest,
	parseR2StringMap,
	parseR2UploadRequest,
} from "./wire.js";

// The default R2 backend: one internal Durable Object (a Rivet Actor) per
// bucket, holding metadata and bodies in its SQLite storage. The client in
// ./actor-backend.ts cuts every body into 512 KiB chunks and writes each with
// its own request, so every SQLite commit stays far below Rivet's dirty-page
// limit and no request nears the 20 MiB actor request limit. A body becomes
// visible only when a commit request points an object row at it, which
// mirrors Miniflare's "blob visible only once committed" rule. Reads stream
// chunks over one WebSocket per body, because the pinned RivetKit can abort a
// streamed actor HTTP response after it was sent. The schema and
// the multipart rules follow Miniflare's R2 bucket object.
// https://github.com/cloudflare/workers-sdk/blob/be87ff0382c53a294e948e49419d25d653c50e86/packages/miniflare/src/workers/r2/schemas.worker.ts#L39-L67
// https://github.com/cloudflare/workers-sdk/blob/be87ff0382c53a294e948e49419d25d653c50e86/packages/miniflare/src/workers/r2/bucket.worker.ts#L344-L606

export const r2ChunkSize = 512 * 1024;

// Blobs that no row references wait this long before garbage collection, so
// an upload in progress and a read of an overwritten object keep their chunks.
const gcDelayMs = 5 * 60 * 1000;
// Chunks deleted per alarm run, which keeps each commit small.
const gcChunkBudget = 16;

const uploadInProgress = 0;
const uploadCompleted = 1;
const uploadAborted = 2;

export interface R2BucketState extends InternalObjectState {
	readonly storage: InternalObjectState["storage"] & {
		getAlarm(): Promise<number | null>;
		setAlarm(scheduledTime: number): Promise<void>;
	};
}

// Where an object's bytes live: one blob, or the blobs of its multipart parts
// in part order.
export interface R2BlobSegment {
	blobId: string;
	size: number;
}

export interface R2GetResponse {
	object: R2StoredObject;
	segments: R2BlobSegment[];
}

export interface R2CommitRequest {
	blobId: string;
	checksums: R2Checksums;
	customMetadata?: Record<string, string>;
	etag: string;
	httpMetadata?: R2HttpFields;
	key: string;
	onlyIf?: R2Conditional;
	size: number;
	storageClass?: string;
}

export interface R2PartRequest {
	blobId: string;
	key: string;
	md5: string;
	partNumber: number;
	size: number;
	uploadId: string;
}

export interface R2ErrorBody {
	error: { code: number; message: string };
}

type ObjectRow = {
	blob_id: string | null;
	checksums: string;
	custom_metadata: string;
	etag: string;
	http_metadata: string;
	key: string;
	multipart_upload_id: string | null;
	size: number;
	storage_class: string;
	uploaded: number;
	version: string;
};

type UploadRow = {
	custom_metadata: string;
	http_metadata: string;
	state: number;
	storage_class: string;
};

type PartRow = { blob_id: string; checksum_md5: string; etag: string; part_number: number; size: number };

const schema = [
	`CREATE TABLE IF NOT EXISTS objects (
		key TEXT PRIMARY KEY,
		version TEXT NOT NULL,
		size INTEGER NOT NULL,
		etag TEXT NOT NULL,
		uploaded INTEGER NOT NULL,
		http_metadata TEXT NOT NULL,
		custom_metadata TEXT NOT NULL,
		checksums TEXT NOT NULL,
		storage_class TEXT NOT NULL,
		blob_id TEXT,
		multipart_upload_id TEXT
	)`,
	`CREATE TABLE IF NOT EXISTS blob_chunks (
		blob_id TEXT NOT NULL,
		idx INTEGER NOT NULL,
		bytes BLOB NOT NULL,
		PRIMARY KEY (blob_id, idx)
	)`,
	// touched_at is the last chunk write, so a slow upload is not collected.
	`CREATE TABLE IF NOT EXISTS pending_blobs (
		blob_id TEXT PRIMARY KEY,
		touched_at INTEGER NOT NULL
	)`,
	"CREATE INDEX IF NOT EXISTS pending_blobs_touched_at ON pending_blobs (touched_at)",
	`CREATE TABLE IF NOT EXISTS multipart_uploads (
		upload_id TEXT PRIMARY KEY,
		key TEXT NOT NULL,
		http_metadata TEXT NOT NULL,
		custom_metadata TEXT NOT NULL,
		storage_class TEXT NOT NULL,
		state INTEGER NOT NULL
	)`,
	`CREATE TABLE IF NOT EXISTS multipart_parts (
		upload_id TEXT NOT NULL,
		part_number INTEGER NOT NULL,
		blob_id TEXT NOT NULL,
		size INTEGER NOT NULL,
		etag TEXT NOT NULL,
		checksum_md5 TEXT NOT NULL,
		PRIMARY KEY (upload_id, part_number)
	)`,
];

function chunkCount(size: number): number {
	return Math.ceil(size / r2ChunkSize);
}

function storedObject(row: Omit<ObjectRow, "blob_id" | "multipart_upload_id">): R2StoredObject {
	const checksums = parseR2Checksums(JSON.parse(row.checksums));
	// A single-part object's ETag is its MD5, as in Miniflare.
	if (/^[0-9a-f]{32}$/.test(row.etag)) checksums.md5 = row.etag;
	return {
		checksums,
		customMetadata: parseR2StringMap(JSON.parse(row.custom_metadata), "custom metadata"),
		etag: row.etag,
		httpMetadata: parseR2HttpFields(JSON.parse(row.http_metadata)),
		key: row.key,
		size: row.size,
		storageClass: row.storage_class,
		uploaded: row.uploaded,
		version: row.version,
	};
}

function errorResponse(error: R2StorageError): Response {
	const body: R2ErrorBody = { error: { code: error.code, message: error.message } };
	return Response.json(body, { status: 400 });
}

function requiredParameter(url: URL, name: string): string {
	const value = url.searchParams.get(name);
	if (value === null) throw new TypeError(`R2 request is missing ${name}`);
	return value;
}

export class R2BucketObject {
	readonly #state: R2BucketState;
	#schemaReady = false;
	#alarmKnown = false;

	constructor(state: R2BucketState) {
		this.#state = state;
	}

	#sql(): InternalObjectState["storage"]["sql"] {
		const sql = this.#state.storage.sql;
		if (!this.#schemaReady) {
			for (const statement of schema) sql.exec(statement);
			this.#schemaReady = true;
		}
		return sql;
	}

	#transaction<T>(closure: () => T): T {
		this.#sql();
		return this.#state.storage.transactionSync(closure);
	}

	async fetch(request: Request): Promise<Response | OrangeResponse> {
		const url = new URL(request.url);
		try {
			switch (`${request.method} ${url.pathname}`) {
				case "PUT /chunk":
					return await this.#putChunk(request, url);
				case "GET /chunks":
					return this.#chunkReader(request);
				case "POST /head":
					return this.#head(await request.json());
				case "POST /get":
					return this.#get(await request.json());
				case "POST /put":
					return await this.#put(await request.json());
				case "POST /delete":
					return await this.#delete(await request.json());
				case "POST /list":
					return Response.json(this.#list(parseR2ListRequest(await request.json())));
				case "POST /multipart/create":
					return this.#createMultipartUpload(await request.json());
				case "POST /multipart/part":
					return await this.#uploadPart(parseR2PartRequest(await request.json()));
				case "POST /multipart/complete":
					return await this.#completeMultipartUpload(await request.json());
				case "POST /multipart/abort":
					return await this.#abortMultipartUpload(await request.json());
				default:
					return new Response(null, { status: 404 });
			}
		} catch (error: unknown) {
			if (error instanceof R2StorageError) return errorResponse(error);
			throw error;
		}
	}

	async #putChunk(request: Request, url: URL): Promise<Response> {
		const blobId = requiredParameter(url, "blob");
		const index = Number(requiredParameter(url, "idx"));
		const bytes = new Uint8Array(await request.arrayBuffer());
		this.#transaction(() => {
			this.#sql().exec(
				"INSERT OR REPLACE INTO blob_chunks (blob_id, idx, bytes) VALUES (?, ?, ?)",
				blobId,
				index,
				bytes,
			);
			this.#markPending([blobId]);
		});
		await this.#ensureGcAlarm();
		return new Response(null, { status: 204 });
	}

	// Answers each `{ blob, idx }` text message, in order, with the chunk as a
	// binary message, or with the text "missing" when the chunk is gone.
	#chunkReader(request: Request): Response | OrangeResponse {
		if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
			return new Response(null, { status: 426 });
		}
		const pair = new WebSocketPair();
		const server = pair[1];
		server.accept();
		server.addEventListener("message", (event: MessageEvent) => {
			const { blob, idx } = parseR2ChunkRead(JSON.parse(String(event.data)));
			const row = this.#sql()
				.exec<{ bytes: ArrayBuffer }>(
					"SELECT bytes FROM blob_chunks WHERE blob_id = ? AND idx = ?",
					blob,
					idx,
				)
				.toArray()[0];
			server.send(row === undefined ? "missing" : row.bytes);
		});
		server.addEventListener("close", () => server.close());
		return new OrangeResponse(null, { status: 101, webSocket: pair[0] });
	}

	#objectRow(key: string): ObjectRow | undefined {
		return this.#sql()
			.exec<ObjectRow>("SELECT * FROM objects WHERE key = ?", key)
			.toArray()[0];
	}

	#head(body: unknown): Response {
		const row = this.#objectRow(String(Reflect.get(Object(body), "key")));
		return row === undefined
			? new Response(null, { status: 404 })
			: Response.json({ object: storedObject(row) });
	}

	// Metadata and the blob layout come from one synchronous read, so a reader
	// always streams one committed version, even if a writer replaces it next.
	#get(body: unknown): Response {
		const row = this.#objectRow(String(Reflect.get(Object(body), "key")));
		if (row === undefined) return new Response(null, { status: 404 });
		const segments: R2BlobSegment[] =
			row.multipart_upload_id === null
				? [{ blobId: row.blob_id ?? "", size: row.size }]
				: this.#sql()
						.exec<{ blob_id: string; size: number }>(
							"SELECT blob_id, size FROM multipart_parts WHERE upload_id = ? ORDER BY part_number",
							row.multipart_upload_id,
						)
						.toArray()
						.map((part) => ({ blobId: part.blob_id, size: part.size }));
		const response: R2GetResponse = { object: storedObject(row), segments };
		return Response.json(response);
	}

	// Checks that every chunk of a committed blob is present. An upload whose
	// chunks were collected after a long pause fails here instead of exposing
	// a truncated object.
	#assertBlobComplete(blobId: string, size: number): void {
		const row = this.#sql()
			.exec<{ count: number; total: number }>(
				"SELECT count(*) AS count, coalesce(sum(length(bytes)), 0) AS total FROM blob_chunks WHERE blob_id = ?",
				blobId,
			)
			.toArray()[0];
		if (row?.count !== chunkCount(size) || row.total !== size) {
			throw R2StorageError.of("InternalError", "the upload expired before it was committed");
		}
	}

	#markPending(blobIds: Iterable<string>): void {
		const now = Date.now();
		for (const blobId of blobIds) {
			this.#sql().exec(
				"INSERT INTO pending_blobs (blob_id, touched_at) VALUES (?, ?) ON CONFLICT (blob_id) DO UPDATE SET touched_at = excluded.touched_at",
				blobId,
				now,
			);
		}
	}

	// Unlinks the body of an object row that is about to be replaced or deleted.
	#releaseObject(row: Pick<ObjectRow, "blob_id" | "multipart_upload_id"> | undefined): void {
		if (row === undefined) return;
		if (row.blob_id !== null) this.#markPending([row.blob_id]);
		if (row.multipart_upload_id !== null) {
			const parts = this.#sql()
				.exec<{ blob_id: string }>(
					"DELETE FROM multipart_parts WHERE upload_id = ? RETURNING blob_id",
					row.multipart_upload_id,
				)
				.toArray();
			this.#markPending(parts.map((part) => part.blob_id));
		}
	}

	#writeObject(
		key: string,
		fields: Omit<ObjectRow, "key" | "uploaded" | "version">,
	): R2StoredObject {
		const row: ObjectRow = {
			...fields,
			key,
			uploaded: Date.now(),
			version: randomBytes(16).toString("hex"),
		};
		this.#sql().exec(
			`INSERT OR REPLACE INTO objects
				(key, version, size, etag, uploaded, http_metadata, custom_metadata, checksums, storage_class, blob_id, multipart_upload_id)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			row.key,
			row.version,
			row.size,
			row.etag,
			row.uploaded,
			row.http_metadata,
			row.custom_metadata,
			row.checksums,
			row.storage_class,
			row.blob_id,
			row.multipart_upload_id,
		);
		return storedObject(row);
	}

	async #put(body: unknown): Promise<Response> {
		const request = parseR2CommitRequest(body);
		const object = this.#transaction((): R2StoredObject | null => {
			const current = this.#objectRow(request.key);
			if (request.onlyIf !== undefined && !conditionPasses(request.onlyIf, current)) {
				return null;
			}
			this.#assertBlobComplete(request.blobId, request.size);
			this.#releaseObject(current);
			this.#sql().exec("DELETE FROM pending_blobs WHERE blob_id = ?", request.blobId);
			return this.#writeObject(request.key, {
				blob_id: request.blobId,
				checksums: JSON.stringify(request.checksums),
				custom_metadata: JSON.stringify(request.customMetadata ?? {}),
				etag: request.etag,
				http_metadata: JSON.stringify(request.httpMetadata ?? {}),
				multipart_upload_id: null,
				size: request.size,
				storage_class: request.storageClass ?? "Standard",
			});
		});
		await this.#ensureGcAlarm();
		return object === null
			? new Response(null, { status: 412 })
			: Response.json({ object });
	}

	async #delete(body: unknown): Promise<Response> {
		const keys = Reflect.get(Object(body), "keys");
		if (!Array.isArray(keys)) throw new TypeError("R2 delete requires keys");
		this.#transaction(() => {
			for (const key of keys) {
				const row = this.#sql()
					.exec<Pick<ObjectRow, "blob_id" | "multipart_upload_id">>(
						"DELETE FROM objects WHERE key = ? RETURNING blob_id, multipart_upload_id",
						String(key),
					)
					.toArray()[0];
				this.#releaseObject(row);
			}
		});
		await this.#ensureGcAlarm();
		return new Response(null, { status: 204 });
	}

	// https://github.com/cloudflare/workers-sdk/blob/be87ff0382c53a294e948e49419d25d653c50e86/packages/miniflare/src/workers/r2/bucket.worker.ts#L875-L979
	#list(request: R2ListRequest): R2ListPage {
		let startAfter = request.startAfter;
		if (request.cursor !== undefined) {
			const cursorKey = Buffer.from(request.cursor, "base64url").toString("utf8");
			if (startAfter === undefined || cursorKey > startAfter) startAfter = cursorKey;
		}
		const delimiter = request.delimiter === "" ? undefined : request.delimiter;
		const objects: R2StoredObject[] = [];
		const delimitedPrefixes: string[] = [];
		const toObject = (row: Omit<ObjectRow, "blob_id" | "multipart_upload_id">): R2StoredObject => {
			const object = storedObject(row);
			if (!request.includeHttpMetadata) delete object.httpMetadata;
			if (!request.includeCustomMetadata) delete object.customMetadata;
			return object;
		};
		let lastKey: string | undefined;
		let hasMore: boolean;
		if (delimiter === undefined) {
			const rows = this.#sql()
				.exec<ObjectRow>(
					`SELECT * FROM objects
					WHERE substr(key, 1, length(?1)) = ?1 AND (?2 IS NULL OR key > ?2)
					ORDER BY key LIMIT ?3`,
					request.prefix,
					startAfter ?? null,
					request.limit + 1,
				)
				.toArray();
			hasMore = rows.length > request.limit;
			for (const row of rows.slice(0, request.limit)) {
				objects.push(toObject(row));
				lastKey = row.key;
			}
		} else {
			// Groups keys that share a delimited prefix into one row whose
			// last_key lets the next page skip the whole group.
			const rows = this.#sql()
				.exec<ObjectRow & { group_key: string; last_key: string }>(
					`SELECT max(key) AS last_key,
						iif(instr(substr(key, length(?1) + 1), ?3),
							'dlp:' || substr(key, 1, length(?1) + instr(substr(key, length(?1) + 1), ?3) + length(?3) - 1),
							'key:' || key) AS group_key,
						key, version, size, etag, uploaded, http_metadata, custom_metadata, checksums, storage_class
					FROM objects
					WHERE substr(key, 1, length(?1)) = ?1 AND (?2 IS NULL OR key > ?2)
					GROUP BY group_key ORDER BY last_key LIMIT ?4`,
					request.prefix,
					startAfter ?? null,
					delimiter,
					request.limit + 1,
				)
				.toArray();
			hasMore = rows.length > request.limit;
			for (const row of rows.slice(0, request.limit)) {
				if (row.group_key.startsWith("dlp:")) {
					delimitedPrefixes.push(row.group_key.slice(4));
				} else {
					objects.push(toObject({ ...row, key: row.last_key }));
				}
				lastKey = row.last_key;
			}
		}
		return hasMore && lastKey !== undefined
			? {
					cursor: Buffer.from(lastKey, "utf8").toString("base64url"),
					delimitedPrefixes,
					objects,
					truncated: true,
				}
			: { delimitedPrefixes, objects, truncated: false };
	}

	#createMultipartUpload(body: unknown): Response {
		const request = parseR2CreateUploadRequest(body);
		const uploadId = randomBytes(32).toString("base64url");
		this.#sql().exec(
			`INSERT INTO multipart_uploads (upload_id, key, http_metadata, custom_metadata, storage_class, state)
				VALUES (?, ?, ?, ?, ?, ?)`,
			uploadId,
			request.key,
			JSON.stringify(request.httpMetadata ?? {}),
			JSON.stringify(request.customMetadata ?? {}),
			request.storageClass ?? "Standard",
			uploadInProgress,
		);
		return Response.json({ uploadId });
	}

	#uploadRow(key: string, uploadId: string): UploadRow | undefined {
		return this.#sql()
			.exec<UploadRow>(
				"SELECT http_metadata, custom_metadata, storage_class, state FROM multipart_uploads WHERE upload_id = ? AND key = ?",
				uploadId,
				key,
			)
			.toArray()[0];
	}

	async #uploadPart(request: R2PartRequest): Promise<Response> {
		const etag = this.#transaction(() => {
			if (this.#uploadRow(request.key, request.uploadId)?.state !== uploadInProgress) {
				throw R2StorageError.of("NoSuchUpload");
			}
			this.#assertBlobComplete(request.blobId, request.size);
			const previous = this.#sql()
				.exec<{ blob_id: string }>(
					"SELECT blob_id FROM multipart_parts WHERE upload_id = ? AND part_number = ?",
					request.uploadId,
					request.partNumber,
				)
				.toArray()[0];
			if (previous !== undefined) this.#markPending([previous.blob_id]);
			const partEtag = randomBytes(16).toString("hex");
			this.#sql().exec(
				`INSERT OR REPLACE INTO multipart_parts (upload_id, part_number, blob_id, size, etag, checksum_md5)
					VALUES (?, ?, ?, ?, ?, ?)`,
				request.uploadId,
				request.partNumber,
				request.blobId,
				request.size,
				partEtag,
				request.md5,
			);
			this.#sql().exec("DELETE FROM pending_blobs WHERE blob_id = ?", request.blobId);
			return partEtag;
		});
		await this.#ensureGcAlarm();
		return Response.json({ etag });
	}

	// https://github.com/cloudflare/workers-sdk/blob/be87ff0382c53a294e948e49419d25d653c50e86/packages/miniflare/src/workers/r2/bucket.worker.ts#L453-L582
	async #completeMultipartUpload(body: unknown): Promise<Response> {
		const request = parseR2CompleteRequest(body);
		const object = this.#transaction(() => {
			const upload = this.#uploadRow(request.key, request.uploadId);
			if (upload === undefined) throw R2StorageError.of("InternalError");
			if (upload.state !== uploadInProgress) throw R2StorageError.of("NoSuchUpload");
			const partNumbers = new Set<number>();
			for (const { partNumber } of request.parts) {
				if (partNumbers.has(partNumber)) throw R2StorageError.of("InternalError");
				partNumbers.add(partNumber);
			}
			const uploaded = new Map(
				this.#sql()
					.exec<PartRow>(
						"SELECT part_number, blob_id, size, etag, checksum_md5 FROM multipart_parts WHERE upload_id = ?",
						request.uploadId,
					)
					.toArray()
					.map((part) => [part.part_number, part]),
			);
			const parts = request.parts.map((selected) => {
				const part = uploaded.get(selected.partNumber);
				if (part === undefined || part.etag !== selected.etag) {
					throw R2StorageError.of("InvalidPart");
				}
				return part;
			});
			// R2 checks sizes in argument order first, with a friendly error,
			// then in part order, where every part but the last has one size.
			for (const part of parts.slice(0, -1)) {
				if (part.size < r2Limits.minMultipartPartSize) {
					throw R2StorageError.of("EntityTooSmall");
				}
			}
			parts.sort((left, right) => left.part_number - right.part_number);
			const partSize = parts[0]?.size;
			for (const part of parts.slice(0, -1)) {
				if (part.size < r2Limits.minMultipartPartSize || part.size !== partSize) {
					throw R2StorageError.of("BadUpload");
				}
			}
			const last = parts.at(-1);
			if (parts.length > 1 && partSize !== undefined && last !== undefined && last.size > partSize) {
				throw R2StorageError.of("BadUpload");
			}
			this.#releaseObject(this.#objectRow(request.key));
			const unused = this.#sql()
				.exec<{ blob_id: string; part_number: number }>(
					"SELECT blob_id, part_number FROM multipart_parts WHERE upload_id = ?",
					request.uploadId,
				)
				.toArray()
				.filter((part) => !partNumbers.has(part.part_number));
			for (const part of unused) {
				this.#sql().exec(
					"DELETE FROM multipart_parts WHERE upload_id = ? AND part_number = ?",
					request.uploadId,
					part.part_number,
				);
			}
			this.#markPending(unused.map((part) => part.blob_id));
			this.#sql().exec(
				"UPDATE multipart_uploads SET state = ? WHERE upload_id = ?",
				uploadCompleted,
				request.uploadId,
			);
			// The ETag is the MD5 of the part MD5s followed by the part count.
			const md5 = createHash("md5");
			for (const part of parts) md5.update(Buffer.from(part.checksum_md5, "hex"));
			return this.#writeObject(request.key, {
				blob_id: null,
				checksums: "{}",
				custom_metadata: upload.custom_metadata,
				etag: `${md5.digest("hex")}-${parts.length}`,
				http_metadata: upload.http_metadata,
				multipart_upload_id: request.uploadId,
				size: parts.reduce((total, part) => total + part.size, 0),
				storage_class: upload.storage_class,
			});
		});
		await this.#ensureGcAlarm();
		return Response.json({ object });
	}

	async #abortMultipartUpload(body: unknown): Promise<Response> {
		const request = parseR2UploadRequest(body);
		this.#transaction(() => {
			const upload = this.#uploadRow(request.key, request.uploadId);
			if (upload === undefined) throw R2StorageError.of("InternalError");
			// Aborting an aborted or completed upload is a no-op.
			if (upload.state !== uploadInProgress) return;
			const parts = this.#sql()
				.exec<{ blob_id: string }>(
					"DELETE FROM multipart_parts WHERE upload_id = ? RETURNING blob_id",
					request.uploadId,
				)
				.toArray();
			this.#markPending(parts.map((part) => part.blob_id));
			this.#sql().exec(
				"UPDATE multipart_uploads SET state = ? WHERE upload_id = ?",
				uploadAborted,
				request.uploadId,
			);
		});
		await this.#ensureGcAlarm();
		return new Response(null, { status: 204 });
	}

	async #ensureGcAlarm(): Promise<void> {
		if (this.#alarmKnown) return;
		const pending = this.#sql()
			.exec<{ next: number | null }>("SELECT min(touched_at) AS next FROM pending_blobs")
			.toArray()[0]?.next;
		if (pending === null || pending === undefined) return;
		if ((await this.#state.storage.getAlarm()) === null) {
			await this.#state.storage.setAlarm(pending + gcDelayMs);
		}
		this.#alarmKnown = true;
	}

	// Deletes the chunks of blobs that stayed unreferenced for gcDelayMs:
	// overwritten and deleted objects, aborted parts, and abandoned uploads.
	async alarm(): Promise<void> {
		this.#alarmKnown = false;
		const cutoff = Date.now() - gcDelayMs;
		let budget = gcChunkBudget;
		const expired = this.#sql()
			.exec<{ blob_id: string }>(
				"SELECT blob_id FROM pending_blobs WHERE touched_at <= ? ORDER BY touched_at LIMIT 32",
				cutoff,
			)
			.toArray();
		for (const { blob_id: blobId } of expired) {
			if (budget <= 0) break;
			this.#transaction(() => {
				const chunks = this.#sql()
					.exec<{ idx: number }>(
						"DELETE FROM blob_chunks WHERE blob_id = ? AND idx IN (SELECT idx FROM blob_chunks WHERE blob_id = ? ORDER BY idx LIMIT ?) RETURNING idx",
						blobId,
						blobId,
						budget,
					)
					.toArray();
				budget -= chunks.length;
				const remaining = this.#sql()
					.exec<{ found: number }>(
						"SELECT EXISTS (SELECT 1 FROM blob_chunks WHERE blob_id = ?) AS found",
						blobId,
					)
					.toArray()[0];
				if (remaining?.found !== 1) {
					this.#sql().exec(
						"DELETE FROM pending_blobs WHERE blob_id = ? AND touched_at <= ?",
						blobId,
						cutoff,
					);
				}
			});
		}
		const next = this.#sql()
			.exec<{ next: number | null }>("SELECT min(touched_at) AS next FROM pending_blobs")
			.toArray()[0]?.next;
		if (next !== null && next !== undefined) {
			await this.#state.storage.setAlarm(Math.max(next + gcDelayMs, Date.now()));
			this.#alarmKnown = true;
		}
	}
}
