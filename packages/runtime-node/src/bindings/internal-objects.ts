import { CacheObject } from "./cache/object.js";
import { D1DatabaseObject } from "./d1/object.js";
import type { ConfiguredDurableObjectClass } from "./durable-objects/classes.js";
import type { DurableObjectNamespace } from "./durable-objects/namespace.js";
import { KvNamespaceObject } from "./kv/object.js";
import { RateLimitObject } from "./ratelimit/object.js";
import { R2BucketObject } from "./r2/storage.js";
import type { SqlStorage } from "../modules/cloudflare-workers/durable-object.js";
import { WorkflowEngineObject, workflowEngineClassName } from "./workflows/engine-object.js";

// KV namespaces, D1 databases, Rate Limiting namespaces, R2 buckets, Cache
// API caches, and Workflow instances run as Durable Objects that OpenOrange registers next to the
// Worker's own classes, so they get the same Rivet Actor SQLite storage and
// persist across `orange dev` restarts. Their class names
// cannot be JavaScript export names, so they never collide with user classes.
export const kvNamespaceClassName = "openorange:kv-namespace";
export const d1DatabaseClassName = "openorange:d1-database";
export const rateLimitClassName = "openorange:ratelimit";
export const r2BucketClassName = "openorange:r2-bucket";
export const cacheClassName = "openorange:cache";
export const internalObjectMigrationTag = "openorange-internal-v1";

// RivetKit display names, so a user can tell Orange's own actors from theirs.
const internalObjectDisplayNames: ReadonlyMap<string, string> = new Map([
	[cacheClassName, "Cache API (Orange)"],
	[d1DatabaseClassName, "D1 databases (Orange)"],
	[kvNamespaceClassName, "KV namespaces (Orange)"],
	[rateLimitClassName, "Rate Limiting (Orange)"],
	[r2BucketClassName, "R2 buckets (Orange)"],
	[workflowEngineClassName, "Workflows (Orange)"],
]);

export function internalObjectDisplayName(className: string): string {
	const displayName = internalObjectDisplayNames.get(className);
	if (displayName === undefined) {
		throw new Error(`Unknown OpenOrange internal object class ${className}`);
	}
	return displayName;
}

export interface InternalObjectState {
	readonly storage: {
		readonly sql: SqlStorage;
		transactionSync<T>(closure: () => T): T;
	};
}

const internalObjectClasses: ReadonlyMap<string, ConfiguredDurableObjectClass> = new Map<
	string,
	ConfiguredDurableObjectClass
>([
	[cacheClassName, CacheObject],
	[d1DatabaseClassName, D1DatabaseObject],
	[kvNamespaceClassName, KvNamespaceObject],
	[rateLimitClassName, RateLimitObject],
	[r2BucketClassName, R2BucketObject],
	[workflowEngineClassName, WorkflowEngineObject],
]);

export function internalObjectClass(className: string): ConfiguredDurableObjectClass {
	const objectClass = internalObjectClasses.get(className);
	if (objectClass === undefined) {
		throw new Error(`Unknown OpenOrange internal object class ${className}`);
	}
	return objectClass;
}

export interface InternalObjectFetcher {
	fetch(input: string, init?: RequestInit): Promise<Response>;
}

// Each request gets its own stub. A Durable Object stub breaks after one
// failed call, and a binding must keep working after a failure.
export function internalObjectFetcher(
	namespace: DurableObjectNamespace,
	name: string,
): InternalObjectFetcher {
	return {
		fetch(input, init): Promise<Response> {
			return namespace.get(namespace.idFromName(name)).fetch(input, init);
		},
	};
}
