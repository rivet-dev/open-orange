// Node builds a built-in's ESM namespace from its CommonJS exports on the first import. Loading
// it before Worker code runs keeps the named exports fixed when a Worker patches the object that
// require() returns, as in workerd.
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/node/tests/module-require-mutable-exports-test.js#L38-L59
import "node:timers/promises";

import { calledByWorker } from "../internal/worker-caller.js";
import { currentWorkerTmp } from "../internal/worker-tmp.js";

const nodeClearTimeout = globalThis.clearTimeout;
const nodeSetInterval = globalThis.setInterval;
const nodeSetTimeout = globalThis.setTimeout;

type NodeTimer = ReturnType<typeof nodeSetTimeout>;

const timers = new Map<number, NodeTimer>();
let nextTimerId = 1;

function allocateTimerId(): number {
	const id = nextTimerId;
	nextTimerId = nextTimerId === 2_147_483_647 ? 1 : nextTimerId + 1;
	if (timers.has(id)) {
		throw new Error("Cloudflare timer identifier space is exhausted");
	}
	return id;
}

function requireCallback(method: string, callback: Function): void {
	if (typeof callback !== "function") {
		throw new TypeError(
			`Failed to execute '${method}' on 'ServiceWorkerGlobalScope': parameter 1 is not of type 'function'.`,
		);
	}
}

function invoke(callback: Function, args: readonly unknown[]): void {
	Reflect.apply(callback, undefined, [...args]);
}

// workerd clamps delays to [0, 100 years]. Workerd also caps an event at 10,000 active timeouts;
// that is a Cloudflare quota, and Orange has no cap.
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/io/io-context.c%2B%2B#L823-L829
const MAX_DELAY = 3_153_600_000_000;
// Node runs a timer longer than this after 1 ms, so longer delays are chained.
const NODE_MAX_DELAY = 2_147_483_647;

function clampDelay(msDelay: unknown): number {
	const delay = Number(msDelay);
	if (!(delay > 0)) return 0;
	return Math.trunc(Math.min(delay, MAX_DELAY));
}

/** Learns when a timer starts in an owner's scope. The returned function runs when it ends. */
export type TimerObserver = (timer: { delayMilliseconds: number; repeat: boolean }) => () => void;

// Keyed by the /tmp scope that timer code runs in, which is one Durable Object instance.
const timerObservers = new WeakMap<object, TimerObserver>();
const timerReleases = new Map<number, { owner: object; release: () => void }>();
// The pending timers of each owner, so an owner that is gone can cancel them.
const ownerTimers = new WeakMap<object, Set<number>>();

/** Calls `observer` for each timer that code in the scope of `owner` starts. */
export function observeTimers(owner: object, observer: TimerObserver): void {
	timerObservers.set(owner, observer);
}

/**
 * Cancels every pending timer that Worker code started in the scope of `owner`. Workerd cancels an
 * aborted IoContext's timers, and drops them with the IoContext.
 * https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/io/io-context.c%2B%2B#L344-L361
 */
export function cancelTimers(owner: object): void {
	for (const id of [...(ownerTimers.get(owner) ?? [])]) cancelTimer(id);
}

function currentTimerObserver(): TimerObserver | undefined {
	const owner = currentWorkerTmp();
	return owner === undefined ? undefined : timerObservers.get(owner);
}

function observeTimer(id: number, delay: number, repeat: boolean): void {
	if (timerReleases.has(id)) return;
	const owner = currentWorkerTmp();
	const observer = owner === undefined ? undefined : timerObservers.get(owner);
	if (owner === undefined || observer === undefined) return;
	timerReleases.set(id, { owner, release: observer({ delayMilliseconds: delay, repeat }) });
	let owned = ownerTimers.get(owner);
	if (owned === undefined) ownerTimers.set(owner, (owned = new Set()));
	owned.add(id);
}

function releaseTimer(id: number): void {
	const entry = timerReleases.get(id);
	if (entry === undefined) return;
	timerReleases.delete(id);
	ownerTimers.get(entry.owner)?.delete(id);
	entry.release();
}

function armTimeout(id: number, delay: number, fire: () => void): void {
	const step = Math.min(delay, NODE_MAX_DELAY);
	timers.set(
		id,
		nodeSetTimeout(() => {
			if (delay > NODE_MAX_DELAY) armTimeout(id, delay - NODE_MAX_DELAY, fire);
			else fire();
		}, step),
	);
}

function armTimer(
	id: number,
	delay: number,
	repeat: boolean,
	callback: Function,
	args: readonly unknown[],
): void {
	if (!repeat) {
		armTimeout(id, delay, () => {
			timers.delete(id);
			releaseTimer(id);
			invoke(callback, args);
		});
	} else if (delay <= NODE_MAX_DELAY) {
		timers.set(id, nodeSetInterval(() => invoke(callback, args), delay));
	} else {
		const fire = (): void => {
			invoke(callback, args);
			if (timers.has(id)) armTimeout(id, delay, fire);
		};
		armTimeout(id, delay, fire);
	}
}

function cancelTimer(id: number): void {
	const timer = timers.get(id);
	if (timer === undefined) return;
	timers.delete(id);
	releaseTimer(id);
	nodeClearTimeout(timer);
}

let restartTimer: (timeout: Timeout) => void;

// With enable_nodejs_global_timers, workerd's global setTimeout and setInterval
// return node:timers Timeout objects that convert to their numeric ID.
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/node/internal/internal_timers.ts#L52-L134
export class Timeout {
	readonly #id: number;
	readonly #delay: number;
	readonly #repeat: boolean;
	readonly #callback: Function;
	readonly #args: readonly unknown[];
	// Whether Worker code started the timer, so it is a timer of the Worker's object.
	readonly #byWorker: boolean;
	#refed = true;

	constructor(
		id: number,
		delay: number,
		repeat: boolean,
		callback: Function,
		args: readonly unknown[],
		byWorker: boolean,
	) {
		this.#id = id;
		this.#delay = delay;
		this.#repeat = repeat;
		this.#callback = callback;
		this.#args = args;
		this.#byWorker = byWorker;
	}

	refresh(): this {
		restartTimer(this);
		return this;
	}

	ref(): this {
		this.#refed = true;
		timers.get(this.#id)?.ref();
		return this;
	}

	// Workerd's unref() changes only hasRef(), so an unref()'d timer keeps its object awake until
	// it runs. Measured on `wrangler dev` 4.129.
	// https://github.com/cloudflare/workerd/blob/v1.20260903.1/src/node/internal/internal_timers.ts#L99-L103
	unref(): this {
		this.#refed = false;
		timers.get(this.#id)?.unref();
		return this;
	}

	hasRef(): boolean {
		return this.#refed;
	}

	close(): this {
		cancelTimer(this.#id);
		return this;
	}

	[Symbol.dispose](): void {
		cancelTimer(this.#id);
	}

	[Symbol.toPrimitive](): number {
		return this.#id;
	}

	static {
		restartTimer = (timeout) => {
			cancelTimer(timeout.#id);
			if (timeout.#byWorker) observeTimer(timeout.#id, timeout.#delay, timeout.#repeat);
			armTimer(
				timeout.#id,
				timeout.#delay,
				timeout.#repeat,
				timeout.#callback,
				timeout.#args,
			);
			if (!timeout.#refed) timers.get(timeout.#id)?.unref();
		};
	}
}

function startTimer(
	method: string,
	repeat: boolean,
	callback: Function,
	msDelay: unknown,
	args: readonly unknown[],
	caller: Function,
): Timeout {
	requireCallback(method, callback);
	const id = allocateTimerId();
	const delay = clampDelay(msDelay);
	// Only an object's scope has an observer, so other timers skip the look at the call stack.
	const byWorker = currentTimerObserver() !== undefined && calledByWorker(caller);
	if (byWorker) observeTimer(id, delay, repeat);
	armTimer(id, delay, repeat, callback, args);
	return new Timeout(id, delay, repeat, callback, args, byWorker);
}

/**
 * A timer for an Orange API that the Worker calls, such as scheduler.wait() or node:timers. `api` is
 * that function, so the timer is the Worker's when Worker code called it.
 */
export function startTimerFor(
	api: Function,
	repeat: boolean,
	callback: Function,
	msDelay: unknown,
	args: readonly unknown[] = [],
): Timeout {
	return startTimer(repeat ? "setInterval" : "setTimeout", repeat, callback, msDelay, args, api);
}

// Workers types declare numeric timer IDs, while the runtime returns a Timeout that
// converts to its ID. The overloads keep that declared shape and hide Timeout.
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/global-scope.h#L1156-L1161
export function setTimeout(
	callback: Function,
	msDelay?: number,
	...args: unknown[]
): number;
export function setTimeout(
	callback: Function,
	msDelay?: number,
	...args: unknown[]
): number | Timeout {
	return startTimer("setTimeout", false, callback, msDelay, args, setTimeout);
}

export function setInterval(
	callback: Function,
	msDelay?: number,
	...args: unknown[]
): number;
export function setInterval(
	callback: Function,
	msDelay?: number,
	...args: unknown[]
): number | Timeout {
	return startTimer("setInterval", true, callback, msDelay, args, setInterval);
}

export function clearTimeout(timer: Timeout | number | null | undefined): void {
	if (timer instanceof Timeout) timer.close();
	else if (typeof timer === "number") cancelTimer(timer);
	// Infrastructure may retain handles created before Worker globals were installed.
	else if (timer !== null && typeof timer === "object") nodeClearTimeout(timer as NodeTimer);
}

export function clearInterval(timer: Timeout | number | null | undefined): void {
	clearTimeout(timer);
}
