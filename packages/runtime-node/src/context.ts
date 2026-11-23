import { AsyncLocalStorage } from "node:async_hooks";
import { runOutsideOutputGate } from "./internal/output-gate.js";
import { runWithWorkerTmp, WorkerTmp } from "./internal/worker-tmp.js";
import { mapVirtualHost } from "./internal/virtual-hosts.js";
import { type Tracing, tracing } from "./modules/cloudflare-workers/tracing.js";

export interface ExecutionContext<Props = unknown> {
	waitUntil(promise: Promise<unknown>): void;
	passThroughOnException(): void;
	readonly exports: object;
	readonly props: Props;
	readonly cache?: undefined;
	readonly access?: undefined;
	readonly tracing: Tracing;
	abort(reason?: unknown): void;
}

export interface ExecutionContextOptions<Props> {
	exports?: object;
	props: Props;
	// Set for a WorkerEntrypoint call. What it returns goes to its caller, so it can't own that value.
	entrypointCall?: { caller: ExecutionContext | undefined };
}

export interface ExecutionContextController<Props> {
	context: ExecutionContext<Props>;
	drainWaitUntil(): Promise<PromiseSettledResult<unknown>[]>;
	/** Ends the event once nothing needs it any more, which removes its /tmp. */
	end(): void;
}

interface ContextState {
	entrypointCall?: { caller: ExecutionContext | undefined };
	pending: Set<Promise<unknown>>;
	// Releases the I/O objects, such as RPC stubs, that the context owns.
	releasers: Set<() => void>;
	aborted: boolean;
	tmp: WorkerTmp;
}

const contextStates = new WeakMap<ExecutionContext, ContextState>();

// Tracks the execution context of the event that is running, like workerd's
// current IoContext, for APIs that do not receive ctx explicitly.
const currentContext = new AsyncLocalStorage<ExecutionContext>();

export function currentExecutionContext(): ExecutionContext | undefined {
	return currentContext.getStore();
}

// A Worker event has its own /tmp and no output gate, even when a Durable
// Object called it through a service binding.
export function runInExecutionContext<Result>(
	context: ExecutionContext,
	callback: () => Result,
): Result {
	const state = contextStates.get(context);
	if (state === undefined) throw new TypeError("Illegal invocation");
	return currentContext.run(context, () =>
		runWithWorkerTmp(state.tmp, () => runOutsideOutputGate(callback)),
	);
}

// Runs `callback` outside every execution context, for objects that outlive the event that made
// them, such as a loaded dynamic Worker's stubs.
export function runOutsideExecutionContext<Result>(callback: () => Result): Result {
	return currentContext.exit(callback);
}

// Runs `release` when the context aborts or is released. Returns a function that
// unregisters it, for an object that its owner releases first. Objects made
// outside an execution context are never released this way.
export function onExecutionContextRelease(
	context: ExecutionContext | undefined,
	release: () => void,
): () => void {
	const state = context === undefined ? undefined : contextStates.get(context);
	if (state === undefined) return () => {};
	if (state.aborted) {
		release();
		return () => {};
	}
	state.releasers.add(release);
	return () => state.releasers.delete(release);
}

// The event that keeps a Durable Object RPC result alive: the top-level event behind a chain of
// WorkerEntrypoint calls. Undefined when the chain starts outside one, such as in a Durable Object.
export function rpcResultOwner(context: ExecutionContext | undefined): ExecutionContext | undefined {
	let owner = context;
	while (owner !== undefined) {
		const call = contextStates.get(owner)?.entrypointCall;
		if (call === undefined) return owner;
		owner = call.caller;
	}
	return undefined;
}

function releaseOwnedObjects(state: ContextState): void {
	const releasers = [...state.releasers];
	state.releasers.clear();
	for (const release of releasers) {
		try {
			release();
		} catch {
			// Releasing is best effort, like dropping an I/O object.
		}
	}
}

// Releases the I/O objects that an event's context still owns once the event
// is over, such as RPC stubs that a callee duplicated and never disposed.
export function releaseExecutionContext(context: ExecutionContext): void {
	const state = contextStates.get(context);
	if (state !== undefined) releaseOwnedObjects(state);
}

class RuntimeExecutionContext<Props> implements ExecutionContext<Props> {
	readonly exports: object;
	readonly props: Props;

	constructor(options: ExecutionContextOptions<Props>) {
		this.exports = options.exports ?? {};
		// SAFETY: Props is unknown when the caller passes no props. workerd's
		// ctx.props is an empty object then.
		// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/io/frankenvalue.c%2B%2B#L224-L230
		this.props = options.props === undefined ? ({} as Props) : options.props;
		contextStates.set(this, {
			aborted: false,
			...(options.entrypointCall === undefined ? {} : { entrypointCall: options.entrypointCall }),
			pending: new Set(),
			releasers: new Set(),
			tmp: new WorkerTmp(),
		});
	}

	waitUntil(promise: Promise<unknown>): void {
		const state = contextStates.get(this);
		if (state === undefined) {
			throw new TypeError("Illegal invocation");
		}
		state.pending.add(promise);
	}

	// Orange has no origin to fall back to. Like workerd with no next service,
	// an exception after this call still fails the request with an error response.
	passThroughOnException(): void {}

	// Workerd returns no ctx.cache unless the embedder supplies one, and local
	// workerd supplies none.
	// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/global-scope.c%2B%2B#L82-L89
	get cache(): undefined {
		return undefined;
	}

	// Local workerd supplies no Access information, so ctx.access is undefined.
	// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/tests/ctx-access-test.js#L7-L15
	get access(): undefined {
		return undefined;
	}

	// Workerd always exposes ctx.tracing, and it is a no-op for untraced requests.
	// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/global-scope.h#L397-L399
	get tracing(): Tracing {
		return tracing;
	}

	// Aborting a context releases the I/O objects it owns, so the other side
	// of each RPC stub sees it disposed. Workerd then terminates the running
	// JavaScript. Node.js cannot do that, so abort() throws the reason, which
	// rejects the event that called it.
	// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/global-scope.c%2B%2B#L165-L175
	abort(reason?: unknown): never {
		const state = contextStates.get(this);
		if (state === undefined) throw new TypeError("Illegal invocation");
		const error =
			reason === undefined
				? new Error("Worker execution was aborted due to call to ctx.abort().")
				: reason;
		if (!state.aborted) {
			state.aborted = true;
			releaseOwnedObjects(state);
		}
		throw error;
	}

	// Assigns a stable `<id>.workers.alt:<port>` host to a fetcher. The first
	// port assigned to a fetcher is kept.
	// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/global-scope.c%2B%2B#L154-L163
	// Workerd exposes this only under the experimental flag, so it stays out of the public
	// ExecutionContext type.
	// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/global-scope.h#L393-L395
	mapVirtualHost(fetcher: object, port: number): string {
		if (!contextStates.has(this)) throw new TypeError("Illegal invocation");
		return mapVirtualHost(fetcher, port);
	}
}

export function createExecutionContext<Props>(
	options: ExecutionContextOptions<Props>,
): ExecutionContextController<Props> {
	const context = new RuntimeExecutionContext(options);
	return {
		context,
		async drainWaitUntil(): Promise<PromiseSettledResult<unknown>[]> {
			const state = contextStates.get(context);
			if (state === undefined) {
				throw new TypeError("Execution context state is unavailable");
			}
			const outcomes: PromiseSettledResult<unknown>[] = [];
			while (state.pending.size > 0) {
				const pending = [...state.pending];
				state.pending.clear();
				outcomes.push(...(await Promise.allSettled(pending)));
			}
			return outcomes;
		},
		end(): void {
			const state = contextStates.get(context);
			if (state === undefined) return;
			// workerd ends the event's RPC sessions with its IoContext, so a stub the
			// Worker kept does not hold its Durable Object awake past the event.
			releaseOwnedObjects(state);
			state.tmp.end();
		},
	};
}
