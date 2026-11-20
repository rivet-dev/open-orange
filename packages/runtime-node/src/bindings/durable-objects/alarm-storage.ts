import { randomUUID } from "node:crypto";

import type {
	RivetActorSchedule,
	RivetScheduledEventInfo,
	RivetScheduledFireInfo,
	RivetSynchronousSqliteExecutor,
} from "../../internal/rivetkit.js";
import type {
	AlarmInvocationInfo,
} from "../../modules/cloudflare-workers/durable-object.js";
import { durableObjectAbortRetriesAlarm } from "./abort.js";

export const durableObjectAlarmAction = "__openorange_alarm";

const tableExistsSql =
	"SELECT name FROM sqlite_master WHERE type = 'table' AND name = '_cf_ALARM'";
/** The table that holds an object's alarm, as workerd names it. */
export const durableObjectAlarmTable = "_cf_ALARM";
const createTableSql =
	"CREATE TABLE IF NOT EXISTS _cf_ALARM (id INTEGER PRIMARY KEY CHECK (id = 1), scheduled_time INTEGER NOT NULL, token TEXT NOT NULL)";
const tableColumnsSql = "PRAGMA table_info('_cf_ALARM')";
const addTokenSql = "ALTER TABLE _cf_ALARM ADD COLUMN token TEXT";
const getSql = "SELECT scheduled_time, token FROM _cf_ALARM WHERE id = 1";
const setSql =
	"INSERT INTO _cf_ALARM (id, scheduled_time, token) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET scheduled_time = excluded.scheduled_time, token = excluded.token";
const deleteSql = "DELETE FROM _cf_ALARM WHERE id = 1";

const maximumAlarmRetries = 6;

// Tokens of alarms whose handler called `ctx.abort(reason, { retryAlarm: false })`. The abort
// breaks storage before the alarm row can be deleted, so the object's next generation in this
// process deletes the row instead of running the alarm again. Tokens are random UUIDs.
const abandonedAlarmTokens = new Set<string>();
const retryStartMilliseconds = 2_000;
const retryJitterFactor = 0.25;

function alarmTimeFromSqlite(value: unknown): number {
	const time = typeof value === "bigint" ? Number(value) : value;
	if (typeof time !== "number" || !Number.isSafeInteger(time) || time <= 0) {
		throw new Error("RivetKit SQLite returned an invalid alarm time");
	}
	return time;
}

export function normalizeAlarmTime(value: unknown): number {
	// Workerd rejects non-positive alarm times and asks the actor cache to clamp
	// past times to now before persisting the alarm.
	// https://github.com/cloudflare/workerd/blob/23263780e6ba38c7f230497a6abc1a4ff72124fb/src/workerd/api/actor-state.c%2B%2B#L466-L500
	const time = value instanceof Date ? value.getTime() : value;
	if (typeof time !== "number" || !Number.isFinite(time) || time <= 0) {
		throw new TypeError("setAlarm() cannot be called with an alarm time <= 0");
	}
	return Math.max(Math.trunc(time), Date.now());
}

export interface DurableObjectAlarmRecord {
	readonly scheduledTime: number;
	readonly token: string;
}

export interface DurableObjectAlarmPersistence {
	delete(): void;
	getRecord(): DurableObjectAlarmRecord | null;
}

export class DurableObjectAlarmStore {
	readonly #database: () => RivetSynchronousSqliteExecutor;
	#schemaReady = false;

	constructor(database: () => RivetSynchronousSqliteExecutor) {
		this.#database = database;
	}

	#tableExists(): boolean {
		return this.#database().executeSync(tableExistsSql).rows.length > 0;
	}

	#ensureTable(): void {
		this.#database().executeSync(createTableSql);
		if (this.#schemaReady) return;
		const columns = this.#database().executeSync(tableColumnsSql).rows;
		if (columns.some((row) => row[1] === "token")) {
			this.#schemaReady = true;
			return;
		}
		this.#database().executeSync(addTokenSql);
		const existing = this.#database().executeSync(
			"SELECT id FROM _cf_ALARM WHERE id = 1",
		).rows;
		if (existing.length > 0) {
			this.#database().executeSync(
				"UPDATE _cf_ALARM SET token = ? WHERE id = 1",
				[randomUUID()],
			);
		}
		this.#schemaReady = true;
	}

	getRecord(): DurableObjectAlarmRecord | null {
		if (!this.#tableExists()) return null;
		if (!this.#schemaReady) this.#ensureTable();
		const rows = this.#database().executeSync(getSql).rows;
		if (rows.length === 0) return null;
		if (rows.length !== 1 || rows[0]?.length !== 2) {
			throw new Error("RivetKit SQLite returned an invalid alarm result");
		}
		const token = rows[0][1];
		if (typeof token !== "string" || token.length === 0) {
			throw new Error("RivetKit SQLite returned an invalid alarm token");
		}
		return { scheduledTime: alarmTimeFromSqlite(rows[0][0]), token };
	}

	get(): number | null {
		return this.getRecord()?.scheduledTime ?? null;
	}

	set(scheduledTime: number): void {
		this.#ensureTable();
		this.#database().executeSync(setSql, [scheduledTime, randomUUID()]);
	}

	delete(): void {
		if (!this.#tableExists()) return;
		this.#database().executeSync(deleteSql);
	}
}

export interface DurableObjectAlarmSynchronization {
	assertSupported(): void;
	synchronize(scheduledTime: number | null): Promise<void>;
	visibleAlarm?(record: DurableObjectAlarmRecord | null): number | null;
}

export interface DurableObjectAlarmController
	extends DurableObjectAlarmSynchronization {
	dispatch(
		instance: object,
		record: DurableObjectAlarmRecord,
		retryCount: number,
		fire: RivetScheduledFireInfo,
		runEvent?: <Result>(operation: () => Promise<Result>) => Promise<Result>,
	): Promise<void>;
	finishConstruction(instance?: object): void;
	restore(): Promise<void>;
}

interface ScheduledAlarmPayload extends DurableObjectAlarmRecord {
	retryCount: number;
}

export interface DurableObjectAlarmSchedulerOptions {
	now?: () => number;
	random?: () => number;
}

function scheduledAlarmPayload(
	event: RivetScheduledEventInfo,
): ScheduledAlarmPayload | undefined {
	if (event.action !== durableObjectAlarmAction) return undefined;
	if (
		event.args.length === 3 &&
		typeof event.args[0] === "number" &&
		Number.isSafeInteger(event.args[0]) &&
		event.args[0] > 0 &&
		typeof event.args[1] === "string" &&
		event.args[1].length > 0 &&
		typeof event.args[2] === "number" &&
		Number.isSafeInteger(event.args[2]) &&
		event.args[2] >= 0 &&
		event.args[2] <= maximumAlarmRetries
	) {
		return {
			retryCount: event.args[2],
			scheduledTime: event.args[0],
			token: event.args[1],
		};
	}
	return undefined;
}

function matchingPayload(
	event: RivetScheduledEventInfo,
	record: DurableObjectAlarmRecord,
): ScheduledAlarmPayload | undefined {
	const payload = scheduledAlarmPayload(event);
	return payload?.scheduledTime === record.scheduledTime &&
		payload.token === record.token
		? payload
		: undefined;
}

export function durableObjectAlarmRetryDelay(
	retryCount: number,
	random: () => number,
): number {
	// Match workerd's two-second exponential backoff and 0–25% additive jitter.
	// https://github.com/cloudflare/workerd/blob/23263780e6ba38c7f230497a6abc1a4ff72124fb/src/workerd/server/alarm-scheduler.h#L55-L67
	// https://github.com/cloudflare/workerd/blob/23263780e6ba38c7f230497a6abc1a4ff72124fb/src/workerd/server/alarm-scheduler.c%2B%2B#L252-L287
	const base = retryStartMilliseconds * 2 ** (retryCount - 1);
	const maximumJitter = Math.floor(base * retryJitterFactor);
	const sample = random();
	if (typeof sample !== "number" || !Number.isFinite(sample)) {
		throw new Error("Durable Object alarm retry random source is invalid");
	}
	const clamped = Math.min(Math.max(sample, 0), 1 - Number.EPSILON);
	return base + Math.floor(clamped * (maximumJitter + 1));
}

export class DurableObjectAlarmScheduler
	implements DurableObjectAlarmController
{
	readonly #alarmStore: DurableObjectAlarmPersistence;
	readonly #now: () => number;
	readonly #random: () => number;
	readonly #schedule: RivetActorSchedule;
	#supportsAlarmHandler: boolean;
	#activeAlarmToken: string | undefined;
	#constructionComplete = false;
	#dispatchQueue: Promise<void> = Promise.resolve();
	#mutationSequence = 0;
	#queue: Promise<void> = Promise.resolve();

	constructor(
		schedule: RivetActorSchedule,
		supportsAlarmHandler: boolean,
		alarmStore: DurableObjectAlarmPersistence,
		options: DurableObjectAlarmSchedulerOptions = {},
	) {
		this.#alarmStore = alarmStore;
		this.#now = options.now ?? Date.now;
		this.#random = options.random ?? Math.random;
		this.#schedule = schedule;
		this.#supportsAlarmHandler = supportsAlarmHandler;
	}

	assertSupported(): void {
		// Workerd can only check for a JavaScript alarm handler after the user
		// constructor has finished, so setAlarm() in that constructor is allowed.
		// https://github.com/cloudflare/workerd/blob/23263780e6ba38c7f230497a6abc1a4ff72124fb/src/workerd/api/actor-state.c%2B%2B#L466-L477
		if (this.#constructionComplete && !this.#supportsAlarmHandler) {
			throw new TypeError(
				"Your Durable Object class must have an alarm() handler in order to call setAlarm()",
			);
		}
	}

	finishConstruction(instance?: object): void {
		if (instance !== undefined) {
			this.#supportsAlarmHandler =
				typeof Reflect.get(instance, "alarm") === "function";
		}
		this.#constructionComplete = true;
	}

	visibleAlarm(record: DurableObjectAlarmRecord | null): number | null {
		if (record === null || record.token === this.#activeAlarmToken) return null;
		return record.scheduledTime;
	}

	restore(): Promise<void> {
		return this.#enqueue(() =>
			this.#reconcile(this.#dropAbandonedAlarm(this.#alarmStore.getRecord()), true),
		);
	}

	#dropAbandonedAlarm(
		record: DurableObjectAlarmRecord | null,
	): DurableObjectAlarmRecord | null {
		if (record === null || !abandonedAlarmTokens.has(record.token)) return record;
		this.#alarmStore.delete();
		abandonedAlarmTokens.delete(record.token);
		return null;
	}

	synchronize(_scheduledTime: number | null): Promise<void> {
		this.#mutationSequence += 1;
		return this.#enqueue(async () => {
			const record = this.#alarmStore.getRecord();
			await this.#reconcile(record, false);
		});
	}

	dispatch(
		instance: object,
		record: DurableObjectAlarmRecord,
		retryCount: number,
		fire: RivetScheduledFireInfo,
		runEvent?: <Result>(operation: () => Promise<Result>) => Promise<Result>,
	): Promise<void> {
		const operation = this.#dispatchQueue.then(() =>
			this.#dispatchNow(instance, record, retryCount, fire, runEvent),
		);
		this.#dispatchQueue = operation.catch(() => undefined);
		return operation;
	}

	#enqueue(operation: () => void | Promise<void>): Promise<void> {
		const result = this.#queue.then(operation);
		this.#queue = result.catch(() => undefined);
		return result;
	}

	async #dispatchNow(
		instance: object,
		record: DurableObjectAlarmRecord,
		retryCount: number,
		fire: RivetScheduledFireInfo,
		runEvent: (<Result>(operation: () => Promise<Result>) => Promise<Result>) | undefined,
	): Promise<void> {
		if (
			!Number.isSafeInteger(retryCount) ||
			retryCount < 0 ||
			retryCount > maximumAlarmRetries ||
			fire.kind !== "at"
		) {
			throw new TypeError("RivetKit dispatched invalid Durable Object alarm metadata");
		}
		const started = await this.#startDispatch(record);
		if (started === undefined) return;

		const handler: unknown = Reflect.get(instance, "alarm");
		if (typeof handler !== "function") {
			await this.#finishWithoutRetry(record, started);
			throw new TypeError(
				"Attempted to run a scheduled alarm without an alarm() handler",
			);
		}

		const alarmInfo: AlarmInvocationInfo = Object.freeze({
			isRetry: retryCount > 0,
			retryCount,
			scheduledTime: record.scheduledTime,
		});
		// Workerd passes the original scheduled time and its counted retry number;
		// isRetry is derived from a nonzero retry count.
		// https://github.com/cloudflare/workerd/blob/23263780e6ba38c7f230497a6abc1a4ff72124fb/src/workerd/api/global-scope.h#L462-L483
		try {
			const invoke = async (): Promise<void> => {
				await Reflect.apply(handler, instance, [alarmInfo]);
			};
			await (runEvent === undefined ? invoke() : runEvent(invoke));
		} catch (error: unknown) {
			if (durableObjectAbortRetriesAlarm(error) === false) {
				abandonedAlarmTokens.add(record.token);
				try {
					await this.#finishWithoutRetry(record, started);
					abandonedAlarmTokens.delete(record.token);
				} catch {
					// The abort broke storage. The next generation deletes the alarm row.
				}
				throw error;
			}
			try {
				await this.#finishFailedDispatch(record, retryCount, started);
			} catch (retryError: unknown) {
				throw new AggregateError(
					[error, retryError],
					"Durable Object alarm failed and its retry could not be scheduled",
				);
			}
			throw error;
		}
		await this.#finishWithoutRetry(record, started);
	}

	async #startDispatch(
		record: DurableObjectAlarmRecord,
	): Promise<number | undefined> {
		let started: number | undefined;
		await this.#enqueue(async () => {
			const persisted = this.#alarmStore.getRecord();
			if (
				persisted?.scheduledTime !== record.scheduledTime ||
				persisted.token !== record.token
			) {
				return;
			}
			started = this.#mutationSequence;
			this.#activeAlarmToken = record.token;
			await this.#cancelAlarmEvents();
		});
		return started;
	}

	async #finishWithoutRetry(
		record: DurableObjectAlarmRecord,
		startedMutationSequence: number,
	): Promise<void> {
		await this.#enqueue(async () => {
			try {
				const persisted = this.#alarmStore.getRecord();
				if (
					this.#mutationSequence === startedMutationSequence &&
					persisted?.token === record.token
				) {
					this.#alarmStore.delete();
					await this.#cancelAlarmEvents();
				}
			} finally {
				if (this.#activeAlarmToken === record.token) {
					this.#activeAlarmToken = undefined;
				}
			}
		});
	}

	async #finishFailedDispatch(
		record: DurableObjectAlarmRecord,
		retryCount: number,
		startedMutationSequence: number,
	): Promise<void> {
		await this.#enqueue(async () => {
			try {
				// Like workerd, a newer set/delete wins over a failed running alarm;
				// otherwise the current alarm remains visible between retry attempts.
				// https://github.com/cloudflare/workerd/blob/23263780e6ba38c7f230497a6abc1a4ff72124fb/src/workerd/server/alarm-scheduler.c%2B%2B#L237-L295
				const persisted = this.#alarmStore.getRecord();
				if (
					this.#mutationSequence !== startedMutationSequence ||
					persisted?.token !== record.token
				) {
					return;
				}
				if (retryCount >= maximumAlarmRetries) {
					this.#alarmStore.delete();
					await this.#cancelAlarmEvents();
					return;
				}
				const nextRetryCount = retryCount + 1;
				const delay = durableObjectAlarmRetryDelay(
					nextRetryCount,
					this.#random,
				);
				const runAt = Math.max(Math.trunc(this.#now()), 1) + delay;
				const retainedId = await this.#schedule.at(
					runAt,
					durableObjectAlarmAction,
					record.scheduledTime,
					record.token,
					nextRetryCount,
				);
				await this.#cancelAlarmEvents(retainedId);
			} finally {
				if (this.#activeAlarmToken === record.token) {
					this.#activeAlarmToken = undefined;
				}
			}
		});
	}

	async #reconcile(
		record: DurableObjectAlarmRecord | null,
		preserveRetry: boolean,
	): Promise<void> {
		// Rivet's schedule adapter persists one-shot actions, but core claims them
		// before action dispatch and does not retry failed one-shots. The alarm row
		// and token therefore remain authoritative across startup and retries.
		// https://github.com/rivet-dev/actors/blob/0ed739a2e9ac989a707ceba1255674675f510e33/rivetkit-rust/packages/rivetkit-core/src/actor/schedule.rs#L576-L638
		const existing = (await this.#schedule.list()).filter(
			(event) => event.action === durableObjectAlarmAction,
		);
		if (record === null) {
			await this.#cancel(existing);
			return;
		}

		const matching = existing
			.map((event) => ({ event, payload: matchingPayload(event, record) }))
			.filter(
				(value): value is {
					event: RivetScheduledEventInfo;
					payload: ScheduledAlarmPayload;
				} => value.payload !== undefined,
			)
			.filter(
				({ event, payload }) =>
					preserveRetry ||
					(payload.retryCount === 0 &&
						event.runAt === record.scheduledTime),
			)
			.sort(
				(left, right) =>
					right.payload.retryCount - left.payload.retryCount ||
					left.event.runAt - right.event.runAt,
			);
		let retainedId = matching[0]?.event.id;
		if (retainedId === undefined) {
			retainedId = await this.#schedule.at(
				record.scheduledTime,
				durableObjectAlarmAction,
				record.scheduledTime,
				record.token,
				0,
			);
		}
		await this.#cancel(existing.filter((event) => event.id !== retainedId));
	}

	async #cancelAlarmEvents(retainedId?: string): Promise<void> {
		const existing = (await this.#schedule.list()).filter(
			(event) =>
				event.action === durableObjectAlarmAction && event.id !== retainedId,
		);
		await this.#cancel(existing);
	}

	async #cancel(events: readonly RivetScheduledEventInfo[]): Promise<void> {
		for (const event of events) await this.#schedule.cancel(event.id);
	}
}
