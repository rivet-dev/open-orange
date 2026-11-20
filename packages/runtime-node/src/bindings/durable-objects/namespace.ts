import { Buffer } from "node:buffer";

import {
	createDurableObjectIdScope,
	type DurableObjectId,
	type DurableObjectJurisdiction,
} from "./id.js";
import type { RivetActorHandle } from "../../internal/rivetkit.js";
import {
	createDurableObjectStubRpcProperty,
	isDurableObjectReservedRpcMethod,
} from "./rpc/methods.js";
import type { DurableObjectRpcTarget } from "./rpc/target.js";
import {
	fetchDurableObjectStub,
	prepareDurableObjectFetch,
} from "./fetch.js";
import { DurableObjectStubLifecycle } from "./ordering.js";
import { isRecord } from "../unknown-values.js";

export type DurableObjectLocationHint =
	| "wnam"
	| "enam"
	| "sam"
	| "weur"
	| "eeur"
	| "apac"
	| "apac-ne"
	| "apac-se"
	| "oc"
	| "afr"
	| "me";

export type DurableObjectRoutingMode = "primary-only";

export interface DurableObjectNamespaceGetDurableObjectOptions {
	locationHint?: DurableObjectLocationHint;
	routingMode?: DurableObjectRoutingMode;
}

type DurableObjectReservedRpcMethod =
	| "alarm"
	| "connect"
	| "dup"
	| "fetch"
	| "then"
	| "webSocketClose"
	| "webSocketError"
	| "webSocketMessage";

export type DurableObjectRpcProvider<
	T,
	Reserved extends string = "dup",
> = DurableObjectRpcMaybeCallableProvider<T> &
	(T extends object
		? {
				[Key in keyof T as Key extends symbol
					? never
					: Key extends Reserved
						? never
						: Key]: T[Key] extends (...args: infer Arguments) => infer Result
					? (...args: Arguments) => DurableObjectRpcResult<Awaited<Result>>
					: DurableObjectRpcResult<Awaited<T[Key]>>;
			}
		: unknown);

type DurableObjectRpcMaybeCallableProvider<T> = T extends (
	...args: infer Arguments
) => infer Result
	? (...args: Arguments) => DurableObjectRpcResult<Awaited<Result>>
	: unknown;

export type DurableObjectRpcResult<Result> =
	Result extends DurableObjectRpcStubable
		? Promise<DurableObjectRpcStub<Result>> & DurableObjectRpcProvider<Result>
		: Result extends DurableObjectRpcSerializable<Result>
			? Promise<
					DurableObjectRpcStubify<Result> &
						(Result extends object ? Disposable : unknown)
				> &
					DurableObjectRpcProvider<Result>
			: never;

export type DurableObjectRpcStubable =
	| DurableObjectRpcTarget
	| ((...args: never[]) => unknown);

export type DurableObjectRpcStub<T extends object> = DurableObjectRpcProvider<T> &
	Disposable & {
		dup(): DurableObjectRpcStub<T>;
	};

type DurableObjectRpcBaseValue =
	| void
	| undefined
	| null
	| boolean
	| number
	| bigint
	| string
	| ArrayBufferView
	| ArrayBuffer
	| Date
	| Error
	| RegExp
	| ReadableStream<Uint8Array>
	| WritableStream<Uint8Array>
	| Request
	| Response
	| Headers;

type DurableObjectRpcSerializable<T> =
	| DurableObjectRpcBaseValue
	| Map<
			T extends Map<infer Key, unknown>
				? DurableObjectRpcSerializable<Key>
				: never,
			T extends Map<unknown, infer Value>
				? DurableObjectRpcSerializable<Value>
				: never
		>
	| Set<
			T extends Set<infer Value>
				? DurableObjectRpcSerializable<Value>
				: never
		>
	| ReadonlyArray<
			T extends ReadonlyArray<infer Value>
				? DurableObjectRpcSerializable<Value>
				: never
		>
	| {
			[Key in keyof T]: Key extends string | number
				? DurableObjectRpcSerializable<T[Key]>
				: never;
		}
	| DurableObjectRpcStub<DurableObjectRpcStubable>
	| DurableObjectRpcStubable;

type DurableObjectRpcStubify<T> = T extends DurableObjectRpcStubable
	? DurableObjectRpcStub<T>
	: T extends Map<infer Key, infer Value>
		? Map<DurableObjectRpcStubify<Key>, DurableObjectRpcStubify<Value>>
		: T extends Set<infer Value>
			? Set<DurableObjectRpcStubify<Value>>
			: T extends Array<infer Value>
				? Array<DurableObjectRpcStubify<Value>>
				: T extends ReadonlyArray<infer Value>
					? ReadonlyArray<DurableObjectRpcStubify<Value>>
					: T extends DurableObjectRpcBaseValue
						? T
						: T extends object
							? { [Key in keyof T]: DurableObjectRpcStubify<T[Key]> }
							: T;

interface DurableObjectStubIdentity {
	readonly id: DurableObjectId;
	readonly name?: string;
	fetch(input: Request | string | URL, init?: RequestInit): Promise<Response>;
}

export type DurableObjectStub<T = undefined> = DurableObjectStubIdentity &
	DurableObjectRpcProvider<T, DurableObjectReservedRpcMethod>;

export interface DurableObjectNamespace<T = undefined> {
	newUniqueId(options?: { jurisdiction?: DurableObjectJurisdiction }): DurableObjectId;
	idFromName(name: string): DurableObjectId;
	idFromString(id: string): DurableObjectId;
	get(
		id: DurableObjectId,
		options?: DurableObjectNamespaceGetDurableObjectOptions,
	): DurableObjectStub<T>;
	getByName(
		name: string,
		options?: DurableObjectNamespaceGetDurableObjectOptions,
	): DurableObjectStub<T>;
	jurisdiction(jurisdiction: DurableObjectJurisdiction): DurableObjectNamespace<T>;
}

export interface DurableObjectStubDescriptor {
	readonly className: string;
	readonly deploymentIdentity: string;
	readonly id: DurableObjectId;
	readonly jurisdiction?: string;
	readonly locationHint?: DurableObjectLocationHint;
	readonly routingMode?: DurableObjectRoutingMode;
}

export interface CreateDurableObjectNamespaceOptions {
	className: string;
	deploymentIdentity: string;
	/** Forks objects for `orange.fork()`. A namespace without it has no `orange`. */
	forkActor?: ForkDurableObjectActor;
	jurisdiction?: DurableObjectJurisdiction;
	resolveActor?: ResolveDurableObjectActor;
}

export type ResolveDurableObjectActor = (
	descriptor: DurableObjectStubDescriptor,
) => RivetActorHandle;

/** Forks the actor of the object `source` to the actor of `target`. See actor-routing.ts. */
export type ForkDurableObjectActor = (
	source: DurableObjectStubDescriptor,
	target: DurableObjectStubDescriptor,
	input: unknown,
) => Promise<void>;

export interface DurableObjectNamespaceForkOptions {
	/** The copy's name: `getByName(name)` reaches it. */
	name?: string;
	/** The copy's ID. Without `name` or `id`, the copy gets a new unique ID. */
	id?: DurableObjectId;
	/** A structured-clone value for the copy's `onOrangeFork()`. */
	input?: unknown;
}

/** OpenOrange's extensions to a Durable Object namespace. Cloudflare has no `orange`. */
export interface DurableObjectNamespaceOrange<T> {
	fork(
		source: DurableObjectId,
		options?: DurableObjectNamespaceForkOptions,
	): Promise<DurableObjectStub<T>>;
}

interface DurableObjectStubState {
	descriptor: DurableObjectStubDescriptor;
	handle?: RivetActorHandle;
	readonly lifecycle: DurableObjectStubLifecycle;
	resolveActor?: ResolveDurableObjectActor;
}

const stubStates = new WeakMap<object, DurableObjectStubState>();
const namespaceClassNames = new WeakMap<object, string>();

/** The class name behind an Orange namespace, or undefined for any other value. */
export function durableObjectNamespaceClassName(value: unknown): string | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	return namespaceClassNames.get(value);
}

// workerd exposes `id` and `name` as the stub's only own enumerable keys.
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/actor.h#L104-L108
class LazyDurableObjectStub implements DurableObjectStubIdentity {
	declare readonly id: DurableObjectId;
	declare readonly name: string | undefined;

	constructor(id: DurableObjectId) {
		Object.defineProperties(this, {
			id: { configurable: true, enumerable: true, value: id },
			name: { configurable: true, enumerable: true, value: id.name },
		});
	}

	fetch(input: Request | string | URL, init?: RequestInit): Promise<Response> {
		let request: Request;
		try {
			request = prepareDurableObjectFetch(input, init);
		} catch (error) {
			return Promise.reject(error);
		}
		const state = requireDurableObjectStubState(this);
		return state.lifecycle.start((order, signal) =>
			fetchDurableObjectStub(
				() => resolveDurableObjectStub(this),
				request,
				order,
				signal,
			),
		).promise;
	}
}

const locationHints: ReadonlySet<string> = new Set([
	"wnam",
	"enam",
	"sam",
	"weur",
	"eeur",
	"apac",
	"apac-ne",
	"apac-se",
	"oc",
	"afr",
	"me",
]);

function isLocationHint(value: unknown): value is DurableObjectLocationHint {
	return typeof value === "string" && locationHints.has(value);
}

function normalizeGetOptions(
	options: DurableObjectNamespaceGetDurableObjectOptions | undefined,
): DurableObjectNamespaceGetDurableObjectOptions {
	if (options === undefined) {
		return {};
	}
	if (!isRecord(options)) {
		throw new TypeError("Durable Object get options must be an object");
	}
	const locationHint = options.locationHint;
	if (locationHint !== undefined && !isLocationHint(locationHint)) {
		throw new TypeError(`Unsupported Durable Object location hint: ${locationHint}`);
	}
	const routingMode = options.routingMode;
	if (routingMode !== undefined && routingMode !== "primary-only") {
		throw new TypeError(`Unsupported Durable Object routing mode: ${routingMode}`);
	}
	return {
		...(locationHint === undefined ? {} : { locationHint }),
		...(routingMode === undefined ? {} : { routingMode }),
	};
}

// A renamed class keeps its IDs and actors, which derive from the name that created it.
const storageNames = new Map<string, string>();

export function configureDurableObjectStorageNames(
	deploymentIdentity: string,
	classes: readonly { className: string; storageName?: string }[],
): void {
	for (const { className, storageName } of classes) {
		if (storageName !== undefined) {
			storageNames.set(JSON.stringify([deploymentIdentity, className]), storageName);
		}
	}
}

export function durableObjectStorageName(deploymentIdentity: string, className: string): string {
	return storageNames.get(JSON.stringify([deploymentIdentity, className])) ?? className;
}

export function durableObjectNamespaceKey(
	deploymentIdentity: string,
	className: string,
): string {
	if (deploymentIdentity.length === 0 || className.length === 0) {
		throw new TypeError(
			"Durable Object namespaces require deployment and class names",
		);
	}
	return JSON.stringify([deploymentIdentity, durableObjectStorageName(deploymentIdentity, className)]);
}

export function requireDurableObjectStubDescriptor(
	stub: object,
): DurableObjectStubDescriptor {
	return requireDurableObjectStubState(stub).descriptor;
}

function requireDurableObjectStubState(stub: object): DurableObjectStubState {
	const state = stubStates.get(stub);
	if (state === undefined) {
		throw new TypeError("Invalid OpenOrange Durable Object stub");
	}
	return state;
}

export function isDurableObjectStub(value: object): boolean {
	return stubStates.has(value);
}

export interface DurableObjectActorInput {
	readonly name: string;
}

// Workerd starts an object with the name of the ID that reached it, and keeps the name only up
// to 1024 bytes to emulate production.
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/server/server.c%2B%2B#L441-L452
export function durableObjectActorInput(
	descriptor: DurableObjectStubDescriptor,
): DurableObjectActorInput | undefined {
	const name = descriptor.id.name;
	if (name === undefined || Buffer.byteLength(name, "utf8") > 1024) {
		return undefined;
	}
	return { name };
}

export function resolveDurableObjectStub(stub: object): RivetActorHandle {
	const state = requireDurableObjectStubState(stub);
	if (state.handle === undefined) {
		if (state.resolveActor === undefined) {
			throw new Error("OpenOrange Durable Object actor resolver is not available");
		}
		state.handle = state.resolveActor(state.descriptor);
	}
	return state.handle;
}

function createLazyStub<T>(
	descriptor: DurableObjectStubDescriptor,
	resolveActor: ResolveDurableObjectActor | undefined,
): DurableObjectStub<T>;
function createLazyStub(
	descriptor: DurableObjectStubDescriptor,
	resolveActor: ResolveDurableObjectActor | undefined,
): object {
	const target = new LazyDurableObjectStub(descriptor.id);
	const stub = new Proxy(target, {
		get(object, property, receiver): unknown {
			if (property === "then") return undefined;
			if (Reflect.has(object, property)) {
				return Reflect.get(object, property, receiver);
			}
			if (typeof property !== "string") return undefined;
			if (property === "connect") {
				return (): never => {
					throw new Error(
						`DurableObjectStub.${property} is not implemented by OpenOrange`,
					);
				};
			}
			if (isDurableObjectReservedRpcMethod(property)) return undefined;
			const state = requireDurableObjectStubState(stub);
			return createDurableObjectStubRpcProperty(
				() => resolveDurableObjectStub(stub),
				state.lifecycle,
				property,
				state.descriptor.id.toString(),
			);
		},
	});
	stubStates.set(stub, {
		descriptor,
		lifecycle: new DurableObjectStubLifecycle(
			[
				descriptor.deploymentIdentity,
				descriptor.className,
				descriptor.jurisdiction ?? "",
				descriptor.id.toString(),
			].join("\0"),
		),
		resolveActor,
	});
	return stub;
}

export function createDurableObjectNamespace<T = undefined>(
	options: CreateDurableObjectNamespaceOptions,
): DurableObjectNamespace<T> {
	const namespaceKey = durableObjectNamespaceKey(
		options.deploymentIdentity,
		options.className,
	);
	const idScope = createDurableObjectIdScope({
		...(options.jurisdiction === undefined
			? {}
			: { jurisdiction: options.jurisdiction }),
		namespaceKey,
	});

	function get(
		id: DurableObjectId,
		getOptions?: DurableObjectNamespaceGetDurableObjectOptions,
	): DurableObjectStub<T> {
		idScope.assertId(id);
		const normalized = normalizeGetOptions(getOptions);
		return createLazyStub(
			{
				className: options.className,
				deploymentIdentity: options.deploymentIdentity,
				id,
				...(id.jurisdiction === undefined
					? {}
					: { jurisdiction: id.jurisdiction }),
				...normalized,
			},
			options.resolveActor,
		);
	}

	const namespace: DurableObjectNamespace<T> = {
		get,
		getByName(name, getOptions): DurableObjectStub<T> {
			return get(idScope.idFromName(name), getOptions);
		},
		idFromName(name): DurableObjectId {
			return idScope.idFromName(name);
		},
		idFromString(id): DurableObjectId {
			return idScope.idFromString(id);
		},
		// workerd treats a null jurisdiction like an absent one, so the implementation
		// accepts null even though Cloudflare's types do not.
		// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/tests/actor-stub-test.js#L42-L49
		jurisdiction(jurisdiction: DurableObjectJurisdiction | null): DurableObjectNamespace<T> {
			return createDurableObjectNamespace({
				...options,
				jurisdiction: jurisdiction ?? undefined,
			});
		},
		newUniqueId(idOptions?: {
			jurisdiction?: DurableObjectJurisdiction | null;
		}): DurableObjectId {
			return idScope.newUniqueId({ jurisdiction: idOptions?.jurisdiction ?? undefined });
		},
	};
	const forkActor = options.forkActor;
	if (forkActor !== undefined) {
		const orange: DurableObjectNamespaceOrange<T> = {
			async fork(source, forkOptions) {
				idScope.assertId(source);
				const target = forkTarget(idScope, forkOptions);
				const descriptor = (id: DurableObjectId): DurableObjectStubDescriptor => ({
					className: options.className,
					deploymentIdentity: options.deploymentIdentity,
					id,
					...(id.jurisdiction === undefined ? {} : { jurisdiction: id.jurisdiction }),
				});
				await forkActor(descriptor(source), descriptor(target), forkOptions?.input);
				return get(target);
			},
		};
		// Not enumerable, so `Object.keys(env.MY_DO)` stays what workerd returns.
		Object.defineProperty(namespace, "orange", { configurable: true, enumerable: false, value: orange });
	}
	namespaceClassNames.set(namespace, options.className);
	return namespace;
}

function forkTarget(
	idScope: ReturnType<typeof createDurableObjectIdScope>,
	options: DurableObjectNamespaceForkOptions | undefined,
): DurableObjectId {
	if (options === undefined) return idScope.newUniqueId();
	if (!isRecord(options)) throw new TypeError("orange.fork() options must be an object");
	const { id, name } = options as DurableObjectNamespaceForkOptions;
	if (id !== undefined && name !== undefined) {
		throw new TypeError("orange.fork() takes a name or an id, not both");
	}
	if (name !== undefined) {
		if (typeof name !== "string") throw new TypeError("orange.fork() name must be a string");
		return idScope.idFromName(name);
	}
	if (id !== undefined) {
		idScope.assertId(id);
		return id;
	}
	return idScope.newUniqueId();
}
