// Aligns Node.js web streams with workerd's stream behavior where the two
// differ. Some differences live in state that Node.js keeps behind its
// unexported `kState` symbol, so this module reads that slot directly. Where a
// Node.js build has no such slot, as in the agentOS VM, the patches that need
// it are skipped.

type State = Record<PropertyKey, unknown>;

function isObject(value: unknown): value is object {
	return (typeof value === "object" && value !== null) || typeof value === "function";
}

// Any object can be read by property key, so every object is a valid State.
function isState(value: unknown): value is State {
	return isObject(value);
}

function nodeGlobal(name: string): Function {
	const value: unknown = Reflect.get(globalThis, name);
	if (typeof value !== "function") {
		throw new Error(`Node.js does not provide the required ${name} global`);
	}
	return value;
}

function prototypeOf(name: string): object {
	const prototype: unknown = Reflect.get(nodeGlobal(name), "prototype");
	if (!isObject(prototype)) throw new Error(`Node.js ${name} has no prototype`);
	return prototype;
}

const NativeReadableStream = nodeGlobal("ReadableStream");
const readableStreamPrototype = prototypeOf("ReadableStream");
const writableStreamPrototype = prototypeOf("WritableStream");
const defaultReaderPrototype = prototypeOf("ReadableStreamDefaultReader");
const byobReaderPrototype = prototypeOf("ReadableStreamBYOBReader");
const byobRequestPrototype = prototypeOf("ReadableStreamBYOBRequest");
const writerPrototype = prototypeOf("WritableStreamDefaultWriter");
const byteControllerPrototype = prototypeOf("ReadableByteStreamController");
const defaultControllerPrototype = prototypeOf("ReadableStreamDefaultController");

const kState: symbol | undefined = (() => {
	const probe: object = Reflect.construct(NativeReadableStream, []);
	const symbol = Object.getOwnPropertySymbols(probe).find(
		(candidate) => candidate.description === "kState",
	);
	if (symbol === undefined || !isObject(Reflect.get(probe, symbol))) return undefined;
	return symbol;
})();

function stateOf(value: unknown): State | undefined {
	if (!isObject(value) || kState === undefined) return undefined;
	const state: unknown = Reflect.get(value, kState);
	return isState(state) ? state : undefined;
}

// Node.js keeps pending requests in an Array, or in its own ring-buffer Queue
// in newer v24 releases. Returns the entries in order for either.
function queueItems(value: unknown): unknown[] {
	if (Array.isArray(value)) return value;
	if (!isObject(value)) return [];
	const list: unknown = Reflect.get(value, "list");
	const head: unknown = Reflect.get(value, "head");
	const length: unknown = Reflect.get(value, "length");
	const mask: unknown = Reflect.get(value, "capacityMask");
	if (
		!Array.isArray(list) ||
		typeof head !== "number" ||
		typeof length !== "number" ||
		typeof mask !== "number"
	) {
		throw new Error("Node.js web streams use an unknown request queue shape");
	}
	const items: unknown[] = [];
	for (let index = 0; index < length; index += 1) {
		items.push(list[(head + index) & mask]);
	}
	return items;
}

function queueLength(value: unknown): number {
	const length: unknown = isObject(value) ? Reflect.get(value, "length") : undefined;
	return typeof length === "number" ? length : 0;
}

function method(prototype: object, name: string): Function {
	const value: unknown = Reflect.get(prototype, name);
	if (typeof value !== "function") throw new Error(`Node.js stream method ${name} is missing`);
	return value;
}

// Replaces a prototype method and keeps its name, length and enumerability.
function patchMethod(
	prototype: object,
	name: string,
	wrap: (native: Function) => (this: unknown, ...args: unknown[]) => unknown,
): void {
	const native = method(prototype, name);
	const replacement = wrap(native);
	Object.defineProperty(replacement, "name", { value: name });
	Object.defineProperty(replacement, "length", { value: native.length });
	const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
	Object.defineProperty(prototype, name, {
		configurable: true,
		enumerable: descriptor?.enumerable ?? true,
		value: replacement,
		writable: true,
	});
}

function isNodeStateError(error: unknown, message: string): boolean {
	return (
		error instanceof TypeError &&
		Reflect.get(error, "code") === "ERR_INVALID_STATE" &&
		error.message.includes(message)
	);
}

// Rethrows Node.js invalid-state errors with workerd's message.
function patchThrownMessage(
	prototype: object,
	name: string,
	nodeMessage: string,
	workerdMessage: string,
): void {
	patchMethod(prototype, name, (native) =>
		function (this: unknown, ...args: unknown[]): unknown {
			try {
				return Reflect.apply(native, this, args);
			} catch (error: unknown) {
				if (isNodeStateError(error, nodeMessage)) throw new TypeError(workerdMessage);
				throw error;
			}
		},
	);
}

const writerLockedMessage = "This WritableStream is currently locked to a writer.";
const lockedByPipe = new WeakSet<object>();

// Workerd leaves an internal writable locked after a pipe closes it.
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/tests/pipe-streams-test.js#L237-L258
export function keepLockedAfterPipe(writable: object): void {
	lockedByPipe.add(writable);
}

// Workerd's messages for lock and enqueue errors.
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/streams/writable.c%2B%2B#L24-L31
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/streams/standard.c%2B%2B#L3619
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/streams/standard.c%2B%2B#L2660
function installLockAndEnqueueMessages(): void {
	patchThrownMessage(
		writableStreamPrototype,
		"getWriter",
		"WritableStream is locked",
		writerLockedMessage,
	);
	patchMethod(writableStreamPrototype, "getWriter", (native) =>
		function getWriter(this: unknown, ...args: unknown[]): unknown {
			if (isObject(this) && lockedByPipe.has(this)) throw new TypeError(writerLockedMessage);
			return Reflect.apply(native, this, args);
		},
	);
	const locked = Object.getOwnPropertyDescriptor(writableStreamPrototype, "locked");
	const lockedGetter = locked?.get;
	if (locked === undefined || lockedGetter === undefined) {
		throw new Error("Node.js WritableStream.prototype.locked is missing");
	}
	Object.defineProperty(writableStreamPrototype, "locked", {
		...locked,
		get(this: unknown): unknown {
			if (isObject(this) && lockedByPipe.has(this)) return true;
			return Reflect.apply(lockedGetter, this, []);
		},
	});
	patchThrownMessage(
		readableStreamPrototype,
		"getReader",
		"ReadableStream is locked",
		"This ReadableStream is currently locked to a reader.",
	);
	patchThrownMessage(
		byteControllerPrototype,
		"enqueue",
		"zero-length or detached",
		"Cannot enqueue a zero-length ArrayBuffer.",
	);
	// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/streams/standard.c%2B%2B#L4366-L4370
	patchThrownMessage(
		prototypeOf("TransformStreamDefaultController"),
		"enqueue",
		"Unable to enqueue",
		"The readable side of this TransformStream is no longer readable.",
	);
}

const readerReleasedMessage = "This ReadableStream reader has been released.";
const writerReleasedMessage = "This WritableStream writer has been released.";

// Workerd rejects the reads that a released reader still has pending with its
// own message. Node.js rejects them too, so only the reason changes.
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/streams/standard.c%2B%2B#L290-L320
function installReaderRelease(prototype: object, requestsKey: string): void {
	patchMethod(prototype, "releaseLock", (native) =>
		function releaseLock(this: unknown): unknown {
			const readerState = stateOf(this);
			if (readerState !== undefined) {
				for (const request of queueItems(readerState[requestsKey])) {
					const requestState = stateOf(request);
					const reject = requestState?.reject;
					if (requestState === undefined || typeof reject !== "function") continue;
					requestState.reject = () => reject(new TypeError(readerReleasedMessage));
				}
			}
			return Reflect.apply(native, this, []);
		},
	);
}

interface PendingWrite {
	resolve?: (value?: unknown) => void;
	reject?: (reason: unknown) => void;
}

function isOptionalFunction(value: unknown): boolean {
	return value === undefined || typeof value === "function";
}

function isPendingWrite(value: unknown): value is PendingWrite {
	return (
		isObject(value) &&
		isOptionalFunction(Reflect.get(value, "resolve")) &&
		isOptionalFunction(Reflect.get(value, "reject"))
	);
}

const ignore = (): void => {};

// Workerd rejects the writes still queued behind the in-flight write when a
// writer releases its lock, and the next writer starts with an empty queue.
// The chunks stay in Node's queue, so their completion is ignored instead.
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/streams/standard.c%2B%2B#L462-L476
function installWriterRelease(): void {
	patchMethod(writerPrototype, "releaseLock", (native) =>
		function releaseLock(this: unknown): unknown {
			const stream = stateOf(this)?.stream;
			const streamState = stateOf(stream);
			if (streamState !== undefined) {
				for (const request of queueItems(streamState.writeRequests)) {
					if (!isPendingWrite(request)) continue;
					request.reject?.(new TypeError(writerReleasedMessage));
					request.resolve = ignore;
					request.reject = ignore;
				}
			}
			return Reflect.apply(native, this, []);
		},
	);
	// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/streams/writable.c%2B%2B#L136-L148
	patchMethod(writerPrototype, "write", (native) =>
		function write(this: unknown, ...args: unknown[]): unknown {
			const writerState = stateOf(this);
			if (writerState !== undefined) {
				const streamState = stateOf(writerState.stream);
				if (writerState.stream === undefined) {
					return Promise.reject(new TypeError(writerReleasedMessage));
				}
				if (streamState?.state === "closed") {
					return Promise.reject(new TypeError("This WritableStream has been closed."));
				}
			}
			return Reflect.apply(native, this, args);
		},
	);
}

// A tee branch's cancel() settles as soon as that branch is canceled. Node.js
// follows the spec and waits until both branches are canceled.
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/tests/streams-tee-edge-cases-test.js#L118-L163
function installTeeCancel(): void {
	patchMethod(readableStreamPrototype, "tee", (native) =>
		function tee(this: unknown): unknown {
			const branches: unknown = Reflect.apply(native, this, []);
			if (!Array.isArray(branches)) return branches;
			const canceled = [false, false];
			branches.forEach((branch: unknown, index: number) => {
				const controllerState = stateOf(stateOf(branch)?.controller);
				const cancel = controllerState?.cancelAlgorithm;
				if (controllerState === undefined || typeof cancel !== "function") {
					throw new Error("Node.js tee branches no longer expose a cancel algorithm");
				}
				controllerState.cancelAlgorithm = (reason: unknown): unknown => {
					canceled[index] = true;
					const result: unknown = cancel(reason);
					return canceled[1 - index] ? result : Promise.resolve();
				};
			});
			return branches;
		},
	);
}

interface PullIntoDescriptor {
	bytesFilled: number;
	ctor?: unknown;
	elementSize: number;
	minimumFill: number;
}

function isPullIntoDescriptor(value: unknown): value is PullIntoDescriptor {
	return (
		isObject(value) &&
		typeof Reflect.get(value, "bytesFilled") === "number" &&
		typeof Reflect.get(value, "elementSize") === "number" &&
		typeof Reflect.get(value, "minimumFill") === "number"
	);
}

// Workerd exposes how many more bytes the pending read needs as atLeast.
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/streams/queue.c%2B%2B#L924-L945
function installByobRequestAtLeast(): void {
	Object.defineProperty(byobRequestPrototype, "atLeast", {
		configurable: true,
		enumerable: true,
		get(this: unknown): number | null {
			const requestState = stateOf(this);
			if (requestState === undefined) throw new TypeError("Illegal invocation");
			const controllerState = stateOf(requestState.controller);
			const pending: unknown =
				controllerState === undefined
					? undefined
					: queueItems(controllerState.pendingPullIntos)[0];
			if (requestState.view === null || !isPullIntoDescriptor(pending)) return null;
			return Math.max(pending.minimumFill - pending.bytesFilled, pending.elementSize);
		},
	});
}

// A source that responds with its own view switches the pending read to that
// view's element type, so the read resolves with every byte it was given.
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/streams/queue.c%2B%2B#L975-L1005
function installRespondWithNewViewElementSize(): void {
	patchMethod(byobRequestPrototype, "respondWithNewView", (native) =>
		function respondWithNewView(this: unknown, ...args: unknown[]): unknown {
			const [view] = args;
			const controllerState = stateOf(stateOf(this)?.controller);
			const pending: unknown =
				controllerState === undefined
					? undefined
					: queueItems(controllerState.pendingPullIntos)[0];
			if (!ArrayBuffer.isView(view) || !isPullIntoDescriptor(pending)) {
				return Reflect.apply(native, this, args);
			}
			const descriptor = pending;
			const { ctor, elementSize } = descriptor;
			descriptor.ctor = view instanceof DataView ? DataView : view.constructor;
			descriptor.elementSize = view instanceof DataView ? 1 : Reflect.get(view, "BYTES_PER_ELEMENT");
			try {
				return Reflect.apply(native, this, args);
			} catch (error: unknown) {
				descriptor.ctor = ctor;
				descriptor.elementSize = elementSize;
				throw error;
			}
		},
	);
}

interface ByteQueueEntry {
	buffer: ArrayBuffer;
	byteOffset: number;
	byteLength: number;
}

function isByteQueueEntry(value: unknown): value is ByteQueueEntry {
	return (
		isObject(value) &&
		Reflect.get(value, "buffer") instanceof ArrayBuffer &&
		typeof Reflect.get(value, "byteOffset") === "number" &&
		typeof Reflect.get(value, "byteLength") === "number"
	);
}

function replaceQueueItems(queue: unknown, items: readonly unknown[]): void {
	if (Array.isArray(queue)) {
		queue.splice(0, queue.length, ...items);
		return;
	}
	if (!isObject(queue)) throw new Error("Node.js byte stream queue is missing");
	const shift: unknown = Reflect.get(queue, "shift");
	const push: unknown = Reflect.get(queue, "push");
	if (typeof shift !== "function" || typeof push !== "function") {
		throw new Error("Node.js web streams use an unknown byte queue shape");
	}
	while (queueLength(queue) > 0) Reflect.apply(shift, queue, []);
	for (const item of items) Reflect.apply(push, queue, [item]);
}

function entryBytes(entry: ByteQueueEntry, start: number, end: number): Uint8Array {
	return new Uint8Array(entry.buffer, entry.byteOffset + start, end - start);
}

const defaultByteReadSize = 16_384;

// Workerd fills a default read on a byte stream from a buffer of the stream's
// autoAllocateChunkSize, or 16 KiB without one, so the read joins queued
// chunks and splits a larger one. Node.js returns one queued chunk.
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/streams/standard.c%2B%2B#L2125-L2158
function coalesceByteQueue(controllerState: State): void {
	const items = queueItems(controllerState.queue);
	if (items.length === 0 || !items.every(isByteQueueEntry)) return;
	const chunkSize = controllerState.autoAllocateChunkSize;
	const limit = typeof chunkSize === "number" ? chunkSize : defaultByteReadSize;
	const first = items[0];
	if (
		first === undefined ||
		first.byteLength === limit ||
		(items.length === 1 && first.byteLength < limit)
	) {
		return;
	}
	const merged = new Uint8Array(Math.min(limit, Number(controllerState.queueTotalSize)));
	let filled = 0;
	const rest: ByteQueueEntry[] = [];
	for (const entry of items) {
		const room = merged.byteLength - filled;
		if (room === 0) {
			rest.push(entry);
			continue;
		}
		const taken = Math.min(room, entry.byteLength);
		merged.set(entryBytes(entry, 0, taken), filled);
		filled += taken;
		if (taken < entry.byteLength) {
			const remainder = entryBytes(entry, taken, entry.byteLength).slice();
			rest.push({ buffer: remainder.buffer, byteOffset: 0, byteLength: remainder.byteLength });
		}
	}
	replaceQueueItems(controllerState.queue, [
		{ buffer: merged.buffer, byteOffset: 0, byteLength: merged.byteLength },
		...rest,
	]);
}

function installByteStreamDefaultRead(): void {
	patchMethod(defaultReaderPrototype, "read", (native) =>
		function read(this: unknown, ...args: unknown[]): unknown {
			const controller = stateOf(stateOf(this)?.stream)?.controller;
			const controllerState = stateOf(controller);
			if (
				controllerState !== undefined &&
				isObject(controller) &&
				Reflect.getPrototypeOf(controller) === byteControllerPrototype &&
				queueLength(controllerState.queue) > 0
			) {
				coalesceByteQueue(controllerState);
			}
			return Reflect.apply(native, this, args);
		},
	);
}

const controllerEnqueue = method(defaultControllerPrototype, "enqueue");
const controllerClose = method(defaultControllerPrototype, "close");

function nextResult(value: unknown, step: string): { done: boolean; value: unknown } {
	if (!isObject(value)) {
		throw new TypeError(
			`The promise returned by the iterator.${step}() method must fulfill with an object`,
		);
	}
	return { done: Boolean(Reflect.get(value, "done")), value: Reflect.get(value, "value") };
}

// ReadableStream.from() as in the Streams spec. Node.js fails with an internal
// error message when the iterator's return property is not callable.
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/tests/streams-test.js#L508-L527
function installReadableStreamFrom(): void {
	const native: unknown = Reflect.get(NativeReadableStream, "from");
	const from = function from(this: unknown, iterable: unknown): unknown {
		const getIterator: unknown =
			iterable === null || iterable === undefined
				? undefined
				: (Reflect.get(Object(iterable), Symbol.asyncIterator) ??
					Reflect.get(Object(iterable), Symbol.iterator));
		if (typeof getIterator !== "function") {
			if (typeof native === "function") return Reflect.apply(native, this, [iterable]);
			throw new TypeError("ReadableStream.from requires an iterable");
		}
		const iterator: unknown = Reflect.apply(getIterator, iterable, []);
		if (!isObject(iterator)) {
			throw new TypeError("The iterator method must return an object");
		}
		return Reflect.construct(NativeReadableStream, [
			{
				async pull(controller: object) {
					const next: unknown = Reflect.get(iterator, "next");
					if (typeof next !== "function") throw new TypeError("iterator.next is not a function");
					const result = nextResult(await Reflect.apply(next, iterator, []), "next");
					if (result.done) Reflect.apply(controllerClose, controller, []);
					else Reflect.apply(controllerEnqueue, controller, [await result.value]);
				},
				async cancel(reason: unknown) {
					const returnMethod: unknown = Reflect.get(iterator, "return");
					if (returnMethod === undefined || returnMethod === null) return;
					if (typeof returnMethod !== "function") {
						throw new TypeError("The iterator's return property is not a function");
					}
					nextResult(await Reflect.apply(returnMethod, iterator, [reason]), "return");
				},
			},
			{ highWaterMark: 0 },
		]);
	};
	Object.defineProperty(NativeReadableStream, "from", {
		configurable: true,
		enumerable: false,
		value: from,
		writable: true,
	});
}

interface PipeState {
	readonly signal: AbortSignal | undefined;
}

const pipeDestinations = new WeakMap<object, PipeState>();

function pipeSignal(options: unknown): AbortSignal | undefined {
	const signal: unknown = isObject(options) ? Reflect.get(options, "signal") : undefined;
	return signal instanceof AbortSignal ? signal : undefined;
}

// Returns the pipe state of a writable that a ReadableStream pipes into, so
// Orange's internal streams can act as workerd's internal pipe loop does.
export function pipeIntoState(writable: object): PipeState | undefined {
	return pipeDestinations.get(writable);
}

const nativeGetReader = method(readableStreamPrototype, "getReader");
const nativeCancel = method(readableStreamPrototype, "cancel");
const nativeGetWriter = method(writableStreamPrototype, "getWriter");
const nativeReaderRelease = method(defaultReaderPrototype, "releaseLock");
const nativeWriterRelease = method(writerPrototype, "releaseLock");

function closingPromise(destination: unknown): Promise<unknown> | undefined {
	const state = stateOf(destination);
	if (state?.state !== "writable") return undefined;
	for (const key of ["inFlightCloseRequest", "closeRequest"]) {
		const request = state[key];
		const promise: unknown = isObject(request) ? Reflect.get(request, "promise") : undefined;
		if (promise instanceof Promise) return promise;
	}
	return undefined;
}

// Workerd's pipe into a destination whose close is already in flight holds
// both locks until the close finishes. It then releases them, cancels the
// source unless preventCancel is set, and resolves the pipe.
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/tests/pipe-streams-test.js#L970-L1056
function pipeToClosingDestination(
	source: object,
	destination: object,
	closing: Promise<unknown>,
	options: unknown,
): Promise<void> {
	const preventCancel = isObject(options) && Boolean(Reflect.get(options, "preventCancel"));
	const reader: unknown = Reflect.apply(nativeGetReader, source, []);
	const writer: unknown = Reflect.apply(nativeGetWriter, destination, []);
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	const finish = (): void => {
		Reflect.apply(nativeWriterRelease, writer, []);
		Reflect.apply(nativeReaderRelease, reader, []);
		if (preventCancel) {
			resolve();
			return;
		}
		const canceled: unknown = Reflect.apply(nativeCancel, source, [
			new TypeError("This destination writable stream is closed."),
		]);
		Promise.resolve(canceled).then(() => resolve(), reject);
	};
	closing.then(finish, finish);
	return promise;
}

const nativeAbort = method(writableStreamPrototype, "abort");

// Workerd settles a pipe whose signal is already aborted without locking the
// source, so the destination's abort listeners can pipe the source again.
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/tests/autovuln-88-test.js#L41-L70
async function pipeWithAbortedSignal(
	source: object,
	destination: object,
	signal: AbortSignal,
	options: unknown,
): Promise<void> {
	const reason: unknown = signal.reason;
	const prevent = (name: string): boolean =>
		isObject(options) && Boolean(Reflect.get(options, name));
	const actions: Promise<unknown>[] = [];
	if (!prevent("preventAbort") && stateOf(destination)?.state === "writable") {
		actions.push(Promise.resolve(Reflect.apply(nativeAbort, destination, [reason])));
	}
	if (
		!prevent("preventCancel") &&
		stateOf(source)?.state === "readable" &&
		stateOf(source)?.reader === undefined
	) {
		actions.push(Promise.resolve(Reflect.apply(nativeCancel, source, [reason])));
	}
	await Promise.all(actions);
	throw reason;
}

function installPipeTracking(): void {
	patchMethod(readableStreamPrototype, "pipeTo", (native) =>
		function pipeTo(this: unknown, ...args: unknown[]): unknown {
			const [destination, options] = args;
			const signal = pipeSignal(options);
			if (
				signal?.aborted === true &&
				isObject(this) &&
				isObject(destination) &&
				stateOf(this)?.reader === undefined &&
				stateOf(destination)?.writer === undefined
			) {
				return pipeWithAbortedSignal(this, destination, signal, options);
			}
			const closing = closingPromise(destination);
			if (
				closing !== undefined &&
				isObject(this) &&
				isObject(destination) &&
				stateOf(this)?.state === "readable" &&
				stateOf(this)?.reader === undefined &&
				stateOf(destination)?.writer === undefined
			) {
				return pipeToClosingDestination(this, destination, closing, options);
			}
			const result: unknown = Reflect.apply(native, this, args);
			if (isObject(destination) && result instanceof Promise && !pipeDestinations.has(destination)) {
				const state = { signal: pipeSignal(options) };
				pipeDestinations.set(destination, state);
				const clear = (): void => {
					if (pipeDestinations.get(destination) === state) pipeDestinations.delete(destination);
				};
				result.then(clear, clear);
			}
			return result;
		},
	);
	patchMethod(readableStreamPrototype, "pipeThrough", (native) =>
		function pipeThrough(this: unknown, ...args: unknown[]): unknown {
			const [transform, options] = args;
			const result: unknown = Reflect.apply(native, this, args);
			const writable: unknown = isObject(transform) ? Reflect.get(transform, "writable") : undefined;
			// pipeThrough() does not expose its pipe promise, so the entry lives as
			// long as the writable.
			if (isObject(writable)) pipeDestinations.set(writable, { signal: pipeSignal(options) });
			return result;
		},
	);
}

function unsharedChunk(chunk: unknown): unknown {
	if (chunk instanceof SharedArrayBuffer) return new Uint8Array(chunk).slice().buffer;
	if (ArrayBuffer.isView(chunk) && chunk.buffer instanceof SharedArrayBuffer) {
		return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength).slice();
	}
	return chunk;
}

const copiesSharedChunks = new WeakSet<object>();

// Workerd compresses chunks backed by a SharedArrayBuffer by copying them.
// Node.js rejects them, as the Compression Streams spec says.
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/tests/pipe-write-special-buffer-test.js#L6-L27
function installSharedChunkCopy(name: string): void {
	const prototype = prototypeOf(name);
	const descriptor = Object.getOwnPropertyDescriptor(prototype, "writable");
	const getter = descriptor?.get;
	if (descriptor === undefined || getter === undefined) {
		throw new Error(`Node.js ${name}.prototype.writable is missing`);
	}
	Object.defineProperty(prototype, "writable", {
		...descriptor,
		get(this: unknown): unknown {
			const writable: unknown = Reflect.apply(getter, this, []);
			if (!isObject(writable) || copiesSharedChunks.has(writable)) return writable;
			copiesSharedChunks.add(writable);
			const controllerState = stateOf(stateOf(writable)?.controller);
			if (controllerState === undefined) {
				throw new Error(`Node.js ${name} no longer exposes its writable controller`);
			}
			// A closed or errored writable has already dropped its algorithms.
			const write = controllerState.writeAlgorithm;
			if (typeof write !== "function") return writable;
			controllerState.writeAlgorithm = (chunk: unknown, controller: unknown): unknown =>
				write(unsharedChunk(chunk), controller);
			return writable;
		},
	});
}

const defaultControllerError = method(defaultControllerPrototype, "error");

// Workerd runs the size algorithm for every enqueued chunk, also when a read
// is waiting for it, and a throwing size errors the stream without throwing
// from enqueue(). Node.js hands the chunk to the waiting read without sizing
// it. Returns true when the stream errored and the chunk must be dropped.
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/streams/standard.c%2B%2B#L2354-L2381
function sizeChunkForWaitingRead(readableController: unknown, chunk: unknown): boolean {
	const controllerState = stateOf(readableController);
	const streamState = stateOf(controllerState?.stream);
	if (controllerState === undefined || streamState?.state !== "readable") return false;
	const readerState = stateOf(streamState.reader);
	if (readerState === undefined || queueLength(readerState.readRequests) === 0) return false;
	const size = controllerState.sizeAlgorithm;
	if (typeof size !== "function") return false;
	try {
		size(chunk);
	} catch (error: unknown) {
		Reflect.apply(defaultControllerError, readableController, [error]);
		return true;
	}
	return streamState.state !== "readable";
}

function installSizeForWaitingReads(): void {
	patchMethod(defaultControllerPrototype, "enqueue", (native) =>
		function enqueue(this: unknown, ...args: unknown[]): unknown {
			if (sizeChunkForWaitingRead(this, args[0])) return undefined;
			return Reflect.apply(native, this, args);
		},
	);
	patchMethod(prototypeOf("TransformStreamDefaultController"), "enqueue", (native) =>
		function enqueue(this: unknown, ...args: unknown[]): unknown {
			const readable = stateOf(stateOf(this)?.stream)?.readable;
			if (sizeChunkForWaitingRead(stateOf(readable)?.controller, args[0])) return undefined;
			return Reflect.apply(native, this, args);
		},
	);
}

// Without `kState`, only the patches that do not read stream state apply.
const hasState = kState !== undefined;
installLockAndEnqueueMessages();
if (hasState) installSizeForWaitingReads();
if (hasState) installSharedChunkCopy("CompressionStream");
if (hasState) installSharedChunkCopy("DecompressionStream");
if (hasState) installPipeTracking();
if (hasState) installReaderRelease(defaultReaderPrototype, "readRequests");
if (hasState) installReaderRelease(byobReaderPrototype, "readIntoRequests");
if (hasState) installWriterRelease();
if (hasState) installTeeCancel();
if (hasState) installByobRequestAtLeast();
if (hasState) installRespondWithNewViewElementSize();
if (hasState) installByteStreamDefaultRead();
installReadableStreamFrom();
