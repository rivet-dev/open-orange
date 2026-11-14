import { Buffer } from "node:buffer";
import { createReadStream } from "node:fs";
import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import type {
	HeadObjectCommandOutput,
	S3Client,
	S3ClientConfig,
} from "@aws-sdk/client-s3";

import {
	pullStream,
	R2Digests,
	verifyChecksums,
	type R2Backend,
	type R2Body,
	type R2Checksums,
	type R2GetResult,
	type R2HashField,
	type R2ListPage,
	type R2ListRequest,
	type R2PutRequest,
	type R2StoredObject,
	type R2UploadedPart,
	type R2WriteMetadata,
} from "./backend.js";
import {
	conditionPasses,
	resolveRange,
	type R2Conditional,
	type R2HttpFields,
	type R2RangeRequest,
} from "./conditional.js";
import { R2StorageError } from "./errors.js";
import { r2ExpectedHashFields } from "./wire.js";

// The opt-in R2 backend: an S3-compatible store such as AWS S3, MinIO, or R2
// itself. It maps each R2 call to S3 calls. R2-only behavior that S3 lacks,
// such as condition evaluation, range validation, and SHA-384 and SHA-512
// verification, runs here through the same code as the SQLite backend.

type S3Module = typeof import("@aws-sdk/client-s3");

export interface R2S3Settings {
	accessKeyId: string;
	bucket: string;
	endpoint: string;
	region: string;
	secretAccessKey: string;
}

// For bucket `my-bucket`, the settings come from ORANGE_R2_MY_BUCKET_S3_*.
function r2S3EnvironmentPrefix(bucketName: string): string {
	return `ORANGE_R2_${bucketName.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_S3_`;
}

// Returns the S3 settings for a bucket, or undefined when the bucket uses the
// default SQLite backend. Setting the endpoint opts the bucket in.
export function r2S3SettingsFromEnvironment(
	bucketName: string,
	environment: NodeJS.ProcessEnv,
): R2S3Settings | undefined {
	const prefix = r2S3EnvironmentPrefix(bucketName);
	const read = (name: string): string | undefined => {
		const value = environment[`${prefix}${name}`];
		return value === undefined || value === "" ? undefined : value;
	};
	const endpoint = read("ENDPOINT");
	if (endpoint === undefined) return undefined;
	const accessKeyId = read("ACCESS_KEY_ID") ?? environment.AWS_ACCESS_KEY_ID;
	const secretAccessKey = read("SECRET_ACCESS_KEY") ?? environment.AWS_SECRET_ACCESS_KEY;
	if (accessKeyId === undefined || secretAccessKey === undefined) {
		throw new Error(
			`R2 bucket "${bucketName}" sets ${prefix}ENDPOINT, so it also needs ${prefix}ACCESS_KEY_ID and ${prefix}SECRET_ACCESS_KEY (or AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY).`,
		);
	}
	return {
		accessKeyId,
		bucket: read("BUCKET") ?? bucketName,
		endpoint,
		region: read("REGION") ?? environment.AWS_REGION ?? "auto",
		secretAccessKey,
	};
}

interface S3ErrorShape {
	$metadata?: { httpStatusCode?: number };
	message?: string;
	name?: string;
}

function s3ErrorShape(error: unknown): S3ErrorShape {
	if (typeof error !== "object" || error === null) return {};
	const metadata: unknown = Reflect.get(error, "$metadata");
	const status: unknown =
		typeof metadata === "object" && metadata !== null
			? Reflect.get(metadata, "httpStatusCode")
			: undefined;
	const message: unknown = Reflect.get(error, "message");
	const name: unknown = Reflect.get(error, "name");
	return {
		...(typeof status === "number" ? { $metadata: { httpStatusCode: status } } : {}),
		...(typeof message === "string" ? { message } : {}),
		...(typeof name === "string" ? { name } : {}),
	};
}

function isPreconditionFailed(error: unknown): boolean {
	const shape = s3ErrorShape(error);
	return shape.name === "PreconditionFailed" || shape.$metadata?.httpStatusCode === 412;
}

function isNotFound(error: unknown): boolean {
	const shape = s3ErrorShape(error);
	return (
		shape.name === "NotFound" ||
		shape.name === "NoSuchKey" ||
		shape.$metadata?.httpStatusCode === 404
	);
}

function unquote(etag: string | undefined): string {
	return (etag ?? "").replace(/^"|"$/g, "");
}

function base64ToHex(value: string | undefined): string | undefined {
	return value === undefined ? undefined : Buffer.from(value, "base64").toString("hex");
}

function hexToBase64(value: string | undefined): string | undefined {
	return value === undefined ? undefined : Buffer.from(value, "hex").toString("base64");
}

function definedFields<T extends object>(fields: T): T {
	const result = { ...fields };
	for (const key of Object.keys(result)) {
		if (Reflect.get(result, key) === undefined) Reflect.deleteProperty(result, key);
	}
	return result;
}

// S3 sends custom metadata as `x-amz-meta-*` headers, so it returns every key
// in lowercase. R2 keeps the case of each key. The original spelling of keys
// with capital letters is stored in this one extra metadata entry.
const keyCaseMetadataKey = "orange-r2-key-case";

function encodeCustomMetadata(
	metadata: Record<string, string> | undefined,
): Record<string, string> | undefined {
	if (metadata === undefined) return undefined;
	const capitalized = Object.keys(metadata).filter((key) => key !== key.toLowerCase());
	if (capitalized.length === 0) return metadata;
	// Header values must be ASCII, so the JSON list is percent-encoded.
	return {
		...metadata,
		[keyCaseMetadataKey]: encodeURIComponent(JSON.stringify(capitalized)),
	};
}

function decodeCustomMetadata(
	metadata: Record<string, string> | undefined,
): Record<string, string> {
	const stored = { ...metadata };
	const encoded = stored[keyCaseMetadataKey];
	delete stored[keyCaseMetadataKey];
	if (encoded === undefined) return stored;
	let keys: unknown;
	try {
		keys = JSON.parse(decodeURIComponent(encoded));
	} catch {
		return stored;
	}
	if (!Array.isArray(keys)) return stored;
	for (const key of keys) {
		if (typeof key !== "string") continue;
		const value = stored[key.toLowerCase()];
		if (value === undefined) continue;
		delete stored[key.toLowerCase()];
		stored[key] = value;
	}
	return stored;
}

// S3 has no object version without bucket versioning, so the ETag stands in.
// S3 gives objects written while versioning is suspended the version ID
// "null", and Neon Object Storage sends it for every object. It names no
// distinct version, so the ETag stands in for it too.
export function objectVersion(versionId: string | undefined, etag: string): string {
	return versionId === undefined || versionId === "null" ? etag : versionId;
}

function objectFromHead(key: string, output: HeadObjectCommandOutput): R2StoredObject {
	const etag = unquote(output.ETag);
	const checksums: R2Checksums = definedFields({
		md5: /^[0-9a-f]{32}$/.test(etag) ? etag : undefined,
		sha1: base64ToHex(output.ChecksumSHA1),
		sha256: base64ToHex(output.ChecksumSHA256),
	});
	const expires = output.ExpiresString === undefined ? NaN : Date.parse(output.ExpiresString);
	const httpMetadata: R2HttpFields = definedFields({
		cacheControl: output.CacheControl,
		cacheExpiry: Number.isNaN(expires) ? undefined : expires,
		contentDisposition: output.ContentDisposition,
		contentEncoding: output.ContentEncoding,
		contentLanguage: output.ContentLanguage,
		contentType: output.ContentType,
	});
	return {
		checksums,
		customMetadata: decodeCustomMetadata(output.Metadata),
		etag,
		httpMetadata,
		key,
		size: output.ContentLength ?? 0,
		storageClass: "Standard",
		uploaded: output.LastModified?.getTime() ?? Date.now(),
		version: objectVersion(output.VersionId, etag),
	};
}

function writeHeaders(metadata: R2WriteMetadata): {
	CacheControl?: string;
	ContentDisposition?: string;
	ContentEncoding?: string;
	ContentLanguage?: string;
	ContentType?: string;
	Expires?: Date;
	Metadata?: Record<string, string>;
} {
	const http = metadata.httpMetadata ?? {};
	return definedFields({
		CacheControl: http.cacheControl,
		ContentDisposition: http.contentDisposition,
		ContentEncoding: http.contentEncoding,
		ContentLanguage: http.contentLanguage,
		ContentType: http.contentType,
		Expires: http.cacheExpiry === undefined ? undefined : new Date(http.cacheExpiry),
		Metadata: encodeCustomMetadata(metadata.customMetadata),
	});
}

// A body that S3 can send with a known length. Streams spool to a temporary
// file first, because S3 needs the length up front and the checksums must be
// verified before the object becomes visible.
interface SizedBody {
	checksums: R2Checksums;
	cleanup(): Promise<void>;
	open(): Uint8Array | Readable;
	size: number;
}

async function sizedBody(body: R2Body, fields: R2HashField[]): Promise<SizedBody> {
	const digests = new R2Digests(fields);
	if (body instanceof Uint8Array) {
		digests.update(body);
		return {
			checksums: digests.digest(),
			cleanup: async () => undefined,
			open: () => body,
			size: body.byteLength,
		};
	}
	const directory = await mkdtemp(join(tmpdir(), "open-orange-r2-"));
	const path = join(directory, "body");
	const cleanup = (): Promise<void> => rm(directory, { force: true, recursive: true });
	try {
		const file = await open(path, "w");
		try {
			for await (const piece of body) {
				digests.update(piece);
				await file.write(piece);
			}
		} finally {
			await file.close();
		}
	} catch (error: unknown) {
		await cleanup();
		throw error;
	}
	return {
		checksums: digests.digest(),
		cleanup,
		open: () => createReadStream(path),
		size: digests.size,
	};
}

async function mapConcurrent<T, R>(
	items: readonly T[],
	limit: number,
	map: (item: T) => Promise<R>,
): Promise<R[]> {
	const results = new Array<R>(items.length);
	// The workers share one iterator, so each item is mapped once.
	const entries = items.entries();
	const worker = async (): Promise<void> => {
		for (let entry = entries.next(); entry.done !== true; entry = entries.next()) {
			const [index, item] = entry.value;
			results[index] = await map(item);
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
	return results;
}

export class R2S3Backend implements R2Backend {
	readonly #settings: R2S3Settings;
	#client: Promise<{ client: S3Client; s3: S3Module }> | undefined;

	constructor(settings: R2S3Settings) {
		this.#settings = settings;
	}

	// The SDK loads on first use, so Workers without an S3 bucket never pay
	// for it.
	#connect(): Promise<{ client: S3Client; s3: S3Module }> {
		this.#client ??= import("@aws-sdk/client-s3").then((s3) => {
			const config: S3ClientConfig = {
				credentials: {
					accessKeyId: this.#settings.accessKeyId,
					secretAccessKey: this.#settings.secretAccessKey,
				},
				endpoint: this.#settings.endpoint,
				forcePathStyle: true,
				region: this.#settings.region,
				// Default CRC checksums break some S3-compatible stores. Orange
				// sends only the checksums the Worker supplied.
				requestChecksumCalculation: "WHEN_REQUIRED",
				responseChecksumValidation: "WHEN_REQUIRED",
			};
			return { client: new s3.S3Client(config), s3 };
		});
		return this.#client;
	}

	// Converts an S3 failure to R2's error, keeping the S3 reason for errors
	// R2 has no code for, such as a missing bucket or an unreachable endpoint.
	#error(error: unknown): R2StorageError {
		if (error instanceof R2StorageError) return error;
		const shape = s3ErrorShape(error);
		switch (shape.name) {
			case "EntityTooLarge":
				return R2StorageError.of("EntityTooLarge");
			case "EntityTooSmall":
				return R2StorageError.of("EntityTooSmall");
			case "InvalidPart":
				return R2StorageError.of("InvalidPart");
			case "InvalidRange":
				return R2StorageError.of("InvalidRange");
			case "KeyTooLongError":
				return R2StorageError.of("InvalidObjectName");
			case "MetadataTooLarge":
				return R2StorageError.of("MetadataTooLarge");
			case "NoSuchUpload":
				return R2StorageError.of("NoSuchUpload");
			default:
				return R2StorageError.of(
					"InternalError",
					`S3 bucket "${this.#settings.bucket}" at ${this.#settings.endpoint}: ${shape.name ?? "Error"}: ${shape.message ?? String(error)}`,
				);
		}
	}

	async #send<T>(run: (client: S3Client, s3: S3Module) => Promise<T>): Promise<T> {
		const { client, s3 } = await this.#connect();
		try {
			return await run(client, s3);
		} catch (error: unknown) {
			throw this.#error(error);
		}
	}

	async head(key: string): Promise<R2StoredObject | null> {
		const { client, s3 } = await this.#connect();
		try {
			const output = await client.send(
				new s3.HeadObjectCommand({
					Bucket: this.#settings.bucket,
					ChecksumMode: "ENABLED",
					Key: key,
				}),
			);
			return objectFromHead(key, output);
		} catch (error: unknown) {
			if (isNotFound(error)) return null;
			throw this.#error(error);
		}
	}

	// Reads metadata first so R2's condition and range rules apply exactly,
	// then reads the body pinned to that ETag. A concurrent overwrite between
	// the two calls restarts the read.
	async get(
		key: string,
		onlyIf: R2Conditional | undefined,
		rangeRequest: R2RangeRequest | undefined,
	): Promise<R2GetResult | null> {
		const { client, s3 } = await this.#connect();
		for (let attempt = 1; ; attempt += 1) {
			const object = await this.head(key);
			if (object === null) return null;
			if (onlyIf !== undefined && !conditionPasses(onlyIf, object)) {
				return { object, passed: false };
			}
			const range = resolveRange(rangeRequest, object.size);
			if (range.length === 0) {
				return { body: pullStream(async () => undefined), object, passed: true, range };
			}
			try {
				const output = await client.send(
					new s3.GetObjectCommand({
						Bucket: this.#settings.bucket,
						IfMatch: `"${object.etag}"`,
						Key: key,
						Range: `bytes=${range.offset}-${range.offset + range.length - 1}`,
					}),
				);
				const stream = output.Body;
				if (!(stream instanceof Readable)) throw new Error("S3 returned no object body");
				const pieces = stream[Symbol.asyncIterator]();
				const body = pullStream(
					async () => {
						const piece = await pieces.next();
						if (piece.done === true) return undefined;
						const value: unknown = piece.value;
						if (!(value instanceof Uint8Array)) throw new Error("S3 returned a non-binary body chunk");
						return new Uint8Array(value);
					},
					() => {
						stream.destroy();
					},
				);
				return { body, object, passed: true, range };
			} catch (error: unknown) {
				if (isPreconditionFailed(error) && attempt < 5) continue;
				if (isNotFound(error)) return null;
				throw this.#error(error);
			}
		}
	}

	async put(key: string, body: R2Body, request: R2PutRequest): Promise<R2StoredObject | null> {
		const sized = await sizedBody(body, r2ExpectedHashFields(request.expected));
		try {
			const checksums = verifyChecksums(request.expected, sized.checksums);
			// S3 has no upload-time conditions, so Orange evaluates R2's rules
			// on the current object and pins the write to it.
			let pin: { IfMatch: string } | { IfNoneMatch: string } | Record<string, never> = {};
			if (request.onlyIf !== undefined) {
				const current = await this.head(key);
				if (!conditionPasses(request.onlyIf, current ?? undefined)) return null;
				pin = current === null ? { IfNoneMatch: "*" } : { IfMatch: `"${current.etag}"` };
			}
			const { client, s3 } = await this.#connect();
			let output;
			try {
				output = await client.send(
					new s3.PutObjectCommand({
						Body: sized.open(),
						Bucket: this.#settings.bucket,
						ContentLength: sized.size,
						Key: key,
						...writeHeaders(request),
						...pin,
						...definedFields({
							ChecksumSHA1: hexToBase64(checksums.sha1),
							ChecksumSHA256: hexToBase64(checksums.sha256),
						}),
					}),
				);
			} catch (error: unknown) {
				if (isPreconditionFailed(error)) return null;
				throw this.#error(error);
			}
			const etag = unquote(output.ETag);
			return {
				checksums: definedFields({
					...checksums,
					md5: /^[0-9a-f]{32}$/.test(etag) ? etag : undefined,
				}),
				customMetadata: request.customMetadata ?? {},
				etag,
				httpMetadata: request.httpMetadata ?? {},
				key,
				size: sized.size,
				storageClass: "Standard",
				uploaded: Date.now(),
				version: objectVersion(output.VersionId, etag),
			};
		} finally {
			await sized.cleanup();
		}
	}

	async delete(keys: string[]): Promise<void> {
		await this.#send((client, s3) =>
			mapConcurrent(keys, 16, (key) =>
				client.send(new s3.DeleteObjectCommand({ Bucket: this.#settings.bucket, Key: key })),
			),
		);
	}

	async list(request: R2ListRequest): Promise<R2ListPage> {
		const output = await this.#send((client, s3) =>
			client.send(
				new s3.ListObjectsV2Command(
					definedFields({
						Bucket: this.#settings.bucket,
						ContinuationToken: request.cursor,
						Delimiter: request.delimiter === "" ? undefined : request.delimiter,
						MaxKeys: request.limit,
						Prefix: request.prefix === "" ? undefined : request.prefix,
						StartAfter: request.startAfter,
					}),
				),
			),
		);
		const listed = output.Contents ?? [];
		const includeMetadata = request.includeCustomMetadata || request.includeHttpMetadata;
		// S3 lists no metadata, so `include` reads each object's headers.
		const objects = await mapConcurrent(listed, 8, async (entry): Promise<R2StoredObject> => {
			const key = entry.Key ?? "";
			const etag = unquote(entry.ETag);
			const headed = includeMetadata ? await this.head(key) : null;
			const object: R2StoredObject = headed ?? {
				checksums: /^[0-9a-f]{32}$/.test(etag) ? { md5: etag } : {},
				etag,
				key,
				size: entry.Size ?? 0,
				storageClass: "Standard",
				uploaded: entry.LastModified?.getTime() ?? 0,
				version: etag,
			};
			if (!request.includeHttpMetadata) delete object.httpMetadata;
			if (!request.includeCustomMetadata) delete object.customMetadata;
			return object;
		});
		const delimitedPrefixes = (output.CommonPrefixes ?? []).flatMap((prefix) =>
			prefix.Prefix === undefined ? [] : [prefix.Prefix],
		);
		return output.IsTruncated === true && output.NextContinuationToken !== undefined
			? { cursor: output.NextContinuationToken, delimitedPrefixes, objects, truncated: true }
			: { delimitedPrefixes, objects, truncated: false };
	}

	async createMultipartUpload(key: string, metadata: R2WriteMetadata): Promise<string> {
		const output = await this.#send((client, s3) =>
			client.send(
				new s3.CreateMultipartUploadCommand({
					Bucket: this.#settings.bucket,
					Key: key,
					...writeHeaders(metadata),
				}),
			),
		);
		if (output.UploadId === undefined) throw R2StorageError.of("InternalError");
		return output.UploadId;
	}

	async uploadPart(
		key: string,
		uploadId: string,
		partNumber: number,
		body: R2Body,
	): Promise<string> {
		const sized = await sizedBody(body, []);
		try {
			const output = await this.#send((client, s3) =>
				client.send(
					new s3.UploadPartCommand({
						Body: sized.open(),
						Bucket: this.#settings.bucket,
						ContentLength: sized.size,
						Key: key,
						PartNumber: partNumber,
						UploadId: uploadId,
					}),
				),
			);
			return output.ETag ?? "";
		} finally {
			await sized.cleanup();
		}
	}

	async completeMultipartUpload(
		key: string,
		uploadId: string,
		parts: R2UploadedPart[],
	): Promise<R2StoredObject> {
		// R2 accepts parts in any order but no repeated part number.
		const numbers = new Set(parts.map((part) => part.partNumber));
		if (numbers.size !== parts.length) throw R2StorageError.of("InternalError");
		const sorted = [...parts].sort((left, right) => left.partNumber - right.partNumber);
		const output = await this.#send((client, s3) =>
			client.send(
				new s3.CompleteMultipartUploadCommand({
					Bucket: this.#settings.bucket,
					Key: key,
					MultipartUpload: {
						Parts: sorted.map((part) => ({ ETag: part.etag, PartNumber: part.partNumber })),
					},
					UploadId: uploadId,
				}),
			),
		);
		const object = await this.head(key);
		if (object === null || object.etag !== unquote(output.ETag)) {
			throw R2StorageError.of("InternalError", "the object changed while the upload completed");
		}
		return object;
	}

	// R2 treats aborting a completed or aborted upload as a no-op. S3 reports
	// both as a missing upload, so that error counts as success.
	async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
		const { client, s3 } = await this.#connect();
		try {
			await client.send(
				new s3.AbortMultipartUploadCommand({
					Bucket: this.#settings.bucket,
					Key: key,
					UploadId: uploadId,
				}),
			);
		} catch (error: unknown) {
			if (s3ErrorShape(error).name === "NoSuchUpload") return;
			throw this.#error(error);
		}
	}
}
