import { AsyncLocalStorage } from "node:async_hooks";

import type {
	RivetSqliteBindings,
	RivetSqliteDatabase,
	RivetSqliteExecuteResult,
	RivetSynchronousSqliteTransaction,
} from "../../internal/rivetkit.js";
import type { OutputGate } from "../../internal/output-gate.js";
import { isCriticalSqliteError, sqlStatementError } from "./sqlite-errors.js";

const turnTransactionName = "open-orange.durable-object.turn";
const readOnlyStatement =
	/^(?:\s|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*(?:SELECT|PRAGMA|EXPLAIN|VACUUM)\b/i;

// A pragma or VACUUM outside the turn transaction can still commit a change.
const outsideTurnWriteStatement =
	/^(?:\s|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*(?:PRAGMA|VACUUM)\b/i;

// A script that may run more statements after the first one counts as a write.
function isReadOnlyScript(sql: string): boolean {
	return readOnlyStatement.test(sql) && !/;\s*\S/.test(sql);
}

function brokenStorageError(cause: unknown): Error {
	return new Error(
		"Durable Object storage failed and the object is resetting to its last durable state.",
		{ cause },
	);
}

/**
 * Durable Object SQLite access with workerd's implicit transaction and output gate.
 *
 * Every statement runs in a turn transaction that commits locally after the current macrotask.
 * Writes in one turn, including writes after `await` on storage promises, therefore commit
 * atomically. Local commits are not durable yet; `outputGate` holds outgoing messages until the
 * confirmed writes before them are durable.
 */
export class DurableObjectTurnDatabase implements RivetSqliteDatabase {
	readonly outputGate: OutputGate = { wait: () => this.#waitForOutputLock() };
	readonly #database: RivetSqliteDatabase;
	readonly #onBroken: (error: Error) => void;
	#broken: Error | undefined;
	#turn: RivetSynchronousSqliteTransaction | undefined;
	// Output gate state. Workerd locks the gate for a transaction once it has a write that was
	// not made with `allowUnconfirmed`, until that transaction's commit is durable.
	// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/io/actor-sqlite.c%2B%2B#L392-L420
	#unconfirmedDepth = 0;
	#turnConfirmed = false;
	#turnStartTicket = 0;
	#turnCommitted: PromiseWithResolvers<number> | undefined;
	#outputTicket = 0;
	#durableTicket = 0;
	#pendingDurability: { promise: Promise<void>; ticket: number } | undefined;
	#explicitTransaction: RivetSynchronousSqliteTransaction | undefined;
	readonly #commitBoundaryWrites = new Set<() => void>();
	#commitBoundaryConfirmed = false;
	#commitBoundaryWaiters: PromiseWithResolvers<boolean>[] = [];

	constructor(database: RivetSqliteDatabase, onBroken: (error: Error) => void) {
		this.#database = database;
		this.#onBroken = onBroken;
	}

	/** Runs writes that do not hold the output gate, like workerd's `allowUnconfirmed`. */
	runUnconfirmed<Result>(write: () => Result): Result {
		this.#unconfirmedDepth += 1;
		try {
			return write();
		} finally {
			this.#unconfirmedDepth -= 1;
		}
	}

	/**
	 * Runs `write` in the implicit transaction just before it commits, outside every user
	 * transaction and savepoint, so a storage rollback never undoes it. For values that are not
	 * storage in workerd. Adding the same `write` again before the commit runs it once.
	 *
	 * The write is unconfirmed unless `confirmed` is set. A confirmed write holds the object's
	 * outputs until it is durable, like a storage write.
	 */
	writeAtCommitBoundary(write: () => void, options: { confirmed?: boolean } = {}): void {
		this.#assertNotBroken();
		this.#commitBoundaryWrites.add(write);
		if (options.confirmed === true) this.#commitBoundaryConfirmed = true;
		// The implicit transaction opens after an explicit one ends; see #guardTransaction.
		if (this.#explicitTransaction === undefined) {
			this.#currentTurn();
			if (options.confirmed === true) this.#turnConfirmed = true;
		}
	}

	/**
	 * Resolves true once the commit-boundary writes added so far commit locally, and false when the
	 * object breaks or retires before that, which discards them.
	 */
	whenCommitBoundaryWritesCommit(): Promise<boolean> {
		if (this.#broken !== undefined) return Promise.resolve(false);
		const waiter = Promise.withResolvers<boolean>();
		this.#commitBoundaryWaiters.push(waiter);
		return waiter.promise;
	}

	#settleCommitBoundaryWaiters(
		waiters: readonly PromiseWithResolvers<boolean>[],
		committed: boolean,
	): void {
		for (const waiter of waiters) waiter.resolve(committed);
	}

	get broken(): Error | undefined {
		return this.#broken;
	}

	executeSync(
		sql: string,
		params?: RivetSqliteBindings,
	): RivetSqliteExecuteResult {
		// Workerd opens the implicit transaction at the first statement that may write. Reads
		// before it, and pragmas that SQLite rejects or ignores inside a transaction, run outside.
		// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/io/actor-sqlite.c%2B%2B#L392-L397
		if (this.#turn === undefined && readOnlyStatement.test(sql)) {
			this.#assertNotBroken();
			if (!outsideTurnWriteStatement.test(sql)) {
				return this.#database.executeSync(sql, params);
			}
			const startTicket = this.#database.commitTicket();
			const result = this.#database.executeSync(sql, params);
			if (this.#unconfirmedDepth === 0) this.#holdOutputUntilDurable(startTicket);
			return result;
		}
		try {
			const turn = this.#currentTurn();
			if (!readOnlyStatement.test(sql)) this.#noteTurnWrite();
			return turn.executeSync(sql, params);
		} catch (error: unknown) {
			throw this.#breakOnCriticalError(error);
		}
	}

	execSync(
		sql: string,
		callback?: (row: unknown[], columns: string[]) => void,
	): void {
		try {
			const turn = this.#currentTurn();
			if (!isReadOnlyScript(sql)) this.#noteTurnWrite();
			turn.execSync(sql, callback);
		} catch (error: unknown) {
			throw this.#breakOnCriticalError(error);
		}
	}

	/**
	 * Begins an explicit transaction for `storage.transaction()`. Workerd starts one only after
	 * the open implicit transaction committed locally.
	 * https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/io/actor-sqlite.c%2B%2B#L845-L860
	 */
	beginTransactionSync(
		timeoutMs?: number,
		name?: string,
	): RivetSynchronousSqliteTransaction {
		this.commitTurn();
		const transaction = this.#database.beginTransactionSync(timeoutMs, name);
		this.#explicitTransaction = transaction;
		return this.#guardTransaction(transaction);
	}

	// Opens the implicit transaction for writes deferred while the explicit one was open.
	#endExplicitTransaction(): void {
		this.#explicitTransaction = undefined;
		if (this.#broken === undefined && this.#commitBoundaryWrites.size > 0) {
			this.#currentTurn();
		}
	}

	// Explicit transactions get the same critical-error handling as the implicit one. After a
	// critical error SQLite already rolled the transaction back, so a later rollback is a no-op.
	#guardTransaction(
		transaction: RivetSynchronousSqliteTransaction,
	): RivetSynchronousSqliteTransaction {
		const startTicket = this.#database.commitTicket();
		let confirmed = false;
		return {
			executeSync: (sql, params) => {
				this.#assertNotBroken();
				if (this.#unconfirmedDepth === 0 && !readOnlyStatement.test(sql)) {
					confirmed = true;
				}
				try {
					return transaction.executeSync(sql, params);
				} catch (error: unknown) {
					throw this.#breakOnCriticalError(error);
				}
			},
			execSync: (sql, callback) => {
				this.#assertNotBroken();
				if (this.#unconfirmedDepth === 0 && !isReadOnlyScript(sql)) {
					confirmed = true;
				}
				try {
					transaction.execSync(sql, callback);
				} catch (error: unknown) {
					throw this.#breakOnCriticalError(error);
				}
			},
			commitSync: () => {
				this.#assertNotBroken();
				try {
					transaction.commitSync();
				} catch (error: unknown) {
					// The caller breaks the object, so deferred writes never run.
					this.#explicitTransaction = undefined;
					throw error;
				}
				if (confirmed) this.#holdOutputUntilDurable(startTicket);
				this.#endExplicitTransaction();
			},
			rollbackSync: () => {
				try {
					transaction.rollbackSync();
				} catch (error: unknown) {
					if (this.#broken === undefined) {
						this.#explicitTransaction = undefined;
						throw error;
					}
				}
				this.#endExplicitTransaction();
			},
		};
	}

	commitTicket(): number {
		return this.#database.commitTicket();
	}

	whenDurable(ticket: number): Promise<void> {
		return this.#database.whenDurable(ticket);
	}

	/** Commits the open turn transaction locally. A failed commit breaks the object. */
	commitTurn(): void {
		this.#assertNotBroken();
		if (this.#turn === undefined) return;
		// Waiters added so far wait for writes that this commit runs.
		const waiters = this.#commitBoundaryWaiters;
		this.#commitBoundaryWaiters = [];
		try {
			this.#runCommitBoundaryWrites();
		} catch (error: unknown) {
			this.#settleCommitBoundaryWaiters(waiters, false);
			throw this.breakObject(error);
		}
		const turn = this.#turn;
		const confirmed = this.#turnConfirmed;
		const committed = this.#turnCommitted;
		this.#turn = undefined;
		this.#turnConfirmed = false;
		this.#turnCommitted = undefined;
		try {
			turn.commitSync();
		} catch (error: unknown) {
			this.#settleCommitBoundaryWaiters(waiters, false);
			const broken = this.breakObject(error);
			committed?.reject(broken);
			throw broken;
		}
		this.#settleCommitBoundaryWaiters(waiters, true);
		if (confirmed) this.#holdOutputUntilDurable(this.#turnStartTicket);
		committed?.resolve(this.#outputTicket);
	}

	// Commits always run outside user savepoints: transactionSync() closes its savepoint before the
	// turn ends, and an explicit transaction commits the turn before it begins.
	#runCommitBoundaryWrites(): void {
		if (this.#commitBoundaryWrites.size === 0) return;
		const writes = [...this.#commitBoundaryWrites];
		this.#commitBoundaryWrites.clear();
		if (this.#commitBoundaryConfirmed) this.#turnConfirmed = true;
		this.#commitBoundaryConfirmed = false;
		this.runUnconfirmed(() => {
			for (const write of writes) write();
		});
	}

	/** Discards the open turn transaction, as `ctx.abort()` does in workerd. */
	rollbackTurn(): void {
		const turn = this.#turn;
		const committed = this.#turnCommitted;
		this.#turn = undefined;
		this.#turnConfirmed = false;
		this.#turnCommitted = undefined;
		try {
			turn?.rollbackSync();
		} catch {
			// The object is resetting; its next generation loads only durable state.
		}
		// Outputs waiting on a discarded turn wait only for earlier writes, unless the object broke.
		committed?.resolve(this.#outputTicket);
	}

	/**
	 * Resolves once every write committed before this call is durable, including writes made with
	 * `allowUnconfirmed`. `storage.sync()` waits on this.
	 * https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/actor-state.c%2B%2B#L780-L793
	 */
	async waitForDurability(): Promise<void> {
		this.commitTurn();
		await this.#waitUntilDurable(this.#database.commitTicket());
	}

	/**
	 * Waits for the output gate after committing the open turn. Workerd releases an event's
	 * result only after the confirmed writes before it are durable.
	 * https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/io/worker-entrypoint.c%2B%2B#L515-L524
	 */
	async waitForOutputGate(): Promise<void> {
		this.commitTurn();
		await this.#waitForOutputLock();
	}

	// An outgoing message waits for the confirmed writes made before it. Writes in the open turn
	// commit together at the end of the turn, so a message sent during the turn waits for that
	// commit, as workerd's lock waits for the pending commit promise. Later turns do not hold it.
	// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/io/io-gate.c%2B%2B#L378-L390
	#waitForOutputLock(): Promise<void> | undefined {
		if (this.#broken !== undefined) return Promise.reject(this.#broken);
		if (this.#turn !== undefined && this.#turnConfirmed) {
			this.#turnCommitted ??= Promise.withResolvers<number>();
			return this.#turnCommitted.promise.then((ticket) =>
				this.#waitUntilDurable(ticket),
			);
		}
		if (this.#outputTicket <= this.#durableTicket) return undefined;
		return this.#waitUntilDurable(this.#outputTicket);
	}

	// A commit that changed nothing does not advance the ticket and does not hold the gate.
	#holdOutputUntilDurable(startTicket: number): void {
		const ticket = this.#database.commitTicket();
		if (ticket > startTicket && ticket > this.#outputTicket) {
			this.#outputTicket = ticket;
		}
	}

	// Concurrent waiters share one `whenDurable()` call per ticket. A rejection breaks the object,
	// and the held output must never be released.
	async #waitUntilDurable(ticket: number): Promise<void> {
		if (ticket > this.#durableTicket) {
			let pending = this.#pendingDurability;
			if (pending === undefined || pending.ticket < ticket) {
				const promise = this.#database.whenDurable(ticket).then(
					() => {
						if (ticket > this.#durableTicket) this.#durableTicket = ticket;
						if (this.#pendingDurability?.promise === promise) {
							this.#pendingDurability = undefined;
						}
					},
					(error: unknown) => {
						throw this.breakObject(error);
					},
				);
				pending = { promise, ticket };
				this.#pendingDurability = pending;
			}
			await pending.promise;
		}
		this.#assertNotBroken();
	}

	/**
	 * Marks storage broken. Workerd aborts the object when its output gate breaks, and the next
	 * request gets a new instance.
	 * https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/io/io-context.c%2B%2B#L208-L217
	 */
	breakObject(cause: unknown, broken: Error = brokenStorageError(cause)): Error {
		if (this.#broken !== undefined) return this.#broken;
		this.#broken = broken;
		this.rollbackTurn();
		this.#settleCommitBoundaryWaiters(this.#commitBoundaryWaiters.splice(0), false);
		try {
			this.#onBroken(this.#broken);
		} catch (resetError: unknown) {
			this.#broken.cause = new AggregateError([cause, resetError]);
		}
		return this.#broken;
	}

	/**
	 * Fails every later call with `error` and discards the open turn, without resetting the
	 * actor. The caller builds the next object over the same storage in this actor generation.
	 */
	retire(error: Error): void {
		if (this.#broken !== undefined) return;
		this.#broken = error;
		this.rollbackTurn();
		this.#settleCommitBoundaryWaiters(this.#commitBoundaryWaiters.splice(0), false);
		// Workerd discards an aborted object's open transaction too. The next object in this
		// actor needs the connection, and the old object's later commit fails as broken.
		const explicit = this.#explicitTransaction;
		this.#explicitTransaction = undefined;
		try {
			explicit?.rollbackSync();
		} catch {
			// SQLite already ended it.
		}
	}

	// A critical error breaks the object with the error itself, so the request and every later
	// storage call fail with SQLite's message.
	// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/util/sqlite.c%2B%2B#L680-L701
	#breakOnCriticalError(error: unknown): unknown {
		if (!isCriticalSqliteError(error)) return error;
		const critical = sqlStatementError(error);
		return this.breakObject(
			error,
			critical instanceof Error ? critical : new Error(String(critical)),
		);
	}

	#assertNotBroken(): void {
		if (this.#broken !== undefined) throw this.#broken;
	}

	#noteTurnWrite(): void {
		if (this.#unconfirmedDepth === 0) this.#turnConfirmed = true;
	}

	#currentTurn(): RivetSynchronousSqliteTransaction {
		this.#assertNotBroken();
		if (this.#turn !== undefined) return this.#turn;
		const turn = this.#database.beginTransactionSync(
			undefined,
			turnTransactionName,
		);
		this.#turn = turn;
		this.#turnStartTicket = this.#database.commitTicket();
		// Workerd commits the implicit transaction on the next event-loop turn, after JavaScript
		// and its microtasks finish. setImmediate is the Node equivalent.
		// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/io/actor-sqlite.c%2B%2B#L353-L357
		setImmediate(() => {
			if (this.#turn !== turn) return;
			try {
				this.commitTurn();
			} catch {
				// commitTurn already broke the object; gated outputs observe it.
			}
		});
		return turn;
	}
}

/**
 * Holds new Durable Object events while a critical section runs. Workerd runs
 * `storage.transaction()` and `blockConcurrencyWhile()` as critical sections of the input gate.
 * https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/actor-state.c%2B%2B#L655-L666
 *
 * A critical section takes the gate synchronously when it is free, so an event that starts on
 * the same tick cannot slip in before it.
 *
 * A nested critical section locks its parent section the same way, so sibling sections inside
 * one parent run one after another.
 * https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/io/io-gate.c%2B%2B#L210-L241
 */
export class DurableObjectInputGate {
	readonly #criticalSection = new AsyncLocalStorage<CriticalSectionFrame>();
	readonly #root: CriticalSectionFrame = { depth: 0, child: undefined };

	/** Number of critical sections the caller runs inside. */
	depth(): number {
		return this.#current().depth;
	}

	/**
	 * Returns a promise while another critical section holds the gate. A caller loops until this
	 * returns undefined and then starts its work on the same tick.
	 */
	held(): Promise<void> | undefined {
		if (this.depth() > 0) return undefined;
		return this.#root.child;
	}

	runCriticalSection<Result>(
		operation: () => Promise<Result>,
	): Promise<Result> {
		const parent = this.#current();
		const held = parent.child;
		if (held !== undefined) {
			return held.then(() => this.runCriticalSection(operation));
		}
		const done = Promise.withResolvers<void>();
		parent.child = done.promise;
		const release = (): void => {
			parent.child = undefined;
			done.resolve();
		};
		let result: Promise<Result>;
		try {
			result = this.#criticalSection.run(
				{ depth: parent.depth + 1, child: undefined },
				operation,
			);
		} catch (error: unknown) {
			release();
			return Promise.reject(error);
		}
		return result.finally(release);
	}

	#current(): CriticalSectionFrame {
		return this.#criticalSection.getStore() ?? this.#root;
	}
}

interface CriticalSectionFrame {
	readonly depth: number;
	child: Promise<void> | undefined;
}
