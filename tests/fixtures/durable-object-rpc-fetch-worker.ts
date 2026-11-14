import {
	DurableObject,
	type DurableObjectState,
} from "cloudflare:workers";

interface StorageLifecycleSnapshot {
	alarm: number | null;
	asyncValue: string | null;
	generation: number;
	id: string;
	sqlValue: string | null;
	syncValue: string | null;
	transactionValue: string | null;
}

interface CounterStub {
	add(amount: number): Promise<{ value: number }>;
	echo(request: Request): Promise<Response>;
	fail(): Promise<never>;
	fetch(input: Request | string | URL, init?: RequestInit): Promise<Response>;
	sql(value: number): Promise<{
		bindingError: string;
		columnNames: string[];
		databaseSize: number;
		inserted: number;
		raw: [number, string][];
		rows: { id: number; value: string }[];
		rowsRead: number;
		total: number;
	}>;
	transactions(): Promise<{
		ids: number[];
		returned: string;
		transactionControlError: string;
	}>;
	syncKv(): Promise<{
		cloneValue: number;
		committed: string;
		deleteResults: boolean[];
		invalidatedIteratorError: string;
		prefix: [string, number][];
		reverse: [string, number][];
		rolledBack: boolean;
	}>;
	asyncKv(): Promise<{
		afterReset: number;
		deleted: number;
		list: [string, number][];
		multi: [string, number][];
		resetSql: boolean;
		resetValue: boolean;
	}>;
	asyncTransactions(): Promise<{
		alarmRoundTrip: boolean;
		committed: [string, number][];
		explicitRolledBack: boolean;
		gateDiagnostic: string;
		nestedRolledBack: boolean;
		returned: string;
		thrownRolledBack: boolean;
	}>;
	deleteAlarm(): Promise<number | null>;
	getAlarm(): Promise<number | null>;
	setAlarm(scheduledTime: number): Promise<number | null>;
	stateSurface(): Promise<{
		diagnostics: string[];
		generation: number;
		id: string;
		startupReady: boolean;
	}>;
	abortAndCatch(): Promise<string>;
	startWaitUntil(): Promise<number>;
	waitUntilStatus(): Promise<number | null>;
	storageLifecycleWrite(
		marker: string,
		alarmTime: number,
	): Promise<StorageLifecycleSnapshot>;
	storageLifecycleRead(): Promise<StorageLifecycleSnapshot>;
	blockSql(milliseconds: number): Promise<{
		elapsedMilliseconds: number;
		passes: number;
	}>;
}

interface CounterNamespace {
	getByName(name: string): CounterStub;
}

interface Env {
	COUNTERS: CounterNamespace;
	MIRRORS: CounterNamespace;
}

export class Counter extends DurableObject {
	static generationCount = 0;
	readonly #generation: number;
	#startupReady = false;
	#value = 0;

	constructor(ctx: DurableObjectState, env: unknown) {
		super(ctx, env);
		this.#generation = ++Counter.generationCount;
		void ctx.blockConcurrencyWhile(async () => {
			await Promise.resolve();
			this.#startupReady = true;
		});
	}

	async alarm(): Promise<void> {}

	add(amount: number): { value: number } {
		this.#value += amount;
		return { value: this.#value };
	}

	echo(request: Request): Response {
		return new Response(request.body, {
			headers: {
				"content-type": request.headers.get("content-type") ?? "text/plain",
				"x-durable-route": "rpc-stream",
			},
			status: 206,
			statusText: "RPC Stream",
		});
	}

	fail(): never {
		throw new RangeError("durable method failed");
	}

	sql(value: number) {
		const sql = this.ctx.storage.sql;
		sql.exec(
			"CREATE TABLE IF NOT EXISTS orange_values (id INTEGER PRIMARY KEY, value TEXT NOT NULL)",
		);
		const inserted = sql.exec(
			"INSERT INTO orange_values (id, value) VALUES (?, ?)",
			value,
			`value-${value}`,
		).rowsWritten;
		const cursor = sql.exec<{ id: number; value: string }>(
			"SELECT id, value FROM orange_values ORDER BY id",
		);
		const columnNames = [...cursor.columnNames];
		const rowsRead = cursor.rowsRead;
		const rows = cursor.toArray();
		const raw = Array.from(
			sql
				.exec("SELECT id, value FROM orange_values ORDER BY id")
				.raw<[number, string]>(),
		);
		const total = sql
			.exec<{ total: number }>("SELECT count(*) AS total FROM orange_values")
			.one().total;
		let bindingError = "";
		try {
			sql.exec("SELECT ?");
		} catch (error: unknown) {
			bindingError = error instanceof Error ? error.message : String(error);
		}
		return {
			bindingError,
			columnNames,
			databaseSize: sql.databaseSize,
			inserted,
			raw,
			rows,
			rowsRead,
			total,
		};
	}

	transactions() {
		const storage = this.ctx.storage;
		storage.sql.exec(
			"CREATE TABLE IF NOT EXISTS orange_transactions (id INTEGER PRIMARY KEY)",
		);
		const returned = storage.transactionSync(() => {
			storage.sql.exec("INSERT INTO orange_transactions (id) VALUES (?)", 8);
			const nested = storage.transactionSync(() => {
				storage.sql.exec("INSERT INTO orange_transactions (id) VALUES (?)", 9);
				return "nested";
			});
			try {
				storage.transactionSync(() => {
					storage.sql.exec(
						"INSERT INTO orange_transactions (id) VALUES (?)",
						10,
					);
					throw new Error("nested rollback");
				});
			} catch (error: unknown) {
				if (!(error instanceof Error) || error.message !== "nested rollback") {
					throw error;
				}
			}
			return `outer:${nested}`;
		});
		try {
			storage.transactionSync(() => {
				storage.sql.exec("INSERT INTO orange_transactions (id) VALUES (?)", 11);
				throw new Error("outer rollback");
			});
		} catch (error: unknown) {
			if (!(error instanceof Error) || error.message !== "outer rollback") {
				throw error;
			}
		}
		const ids = storage.sql
			.exec<{ id: number }>("SELECT id FROM orange_transactions ORDER BY id")
			.toArray()
			.map(({ id }) => id);
		let transactionControlError = "";
		try {
			storage.sql.exec("BEGIN TRANSACTION");
		} catch (error: unknown) {
			transactionControlError =
				error instanceof Error ? error.message : String(error);
		}
		return { ids, returned, transactionControlError };
	}

	syncKv() {
		const storage = this.ctx.storage;
		const kv = storage.kv;
		const original = { nested: { value: 7 } };
		kv.put("clone", original);
		original.nested.value = 99;
		kv.put("bar", 2);
		kv.put("baz", 3);
		kv.put("foo", 1);
		storage.transactionSync(() => kv.put("committed", "yes"));
		try {
			storage.transactionSync(() => {
				kv.put("rolled-back", true);
				throw new Error("roll back KV");
			});
		} catch (error: unknown) {
			if (!(error instanceof Error) || error.message !== "roll back KV") {
				throw error;
			}
		}
		const firstClone = kv.get<{ nested: { value: number } }>("clone");
		if (firstClone === undefined) throw new Error("KV clone is missing");
		firstClone.nested.value = 100;
		const cloneValue = kv.get<{ nested: { value: number } }>("clone")?.nested
			.value;
		if (cloneValue === undefined) throw new Error("KV clone is missing");
		const firstIterator = kv.list();
		kv.list();
		let invalidatedIteratorError = "";
		try {
			Array.from(firstIterator);
		} catch (error: unknown) {
			invalidatedIteratorError =
				error instanceof Error ? error.message : String(error);
		}
		kv.put("delete", true);
		const deleteResults = [kv.delete("delete"), kv.delete("delete")];
		return {
			cloneValue,
			committed: kv.get<string>("committed") ?? "missing",
			deleteResults,
			invalidatedIteratorError,
			prefix: Array.from(kv.list<number>({ prefix: "ba" })),
			reverse: Array.from(
				kv.list<number>({ limit: 2, prefix: "ba", reverse: true }),
			),
			rolledBack: kv.get("rolled-back") === undefined,
		};
	}

	async asyncKv() {
		const storage = this.ctx.storage;
		await storage.put({ b: 2, a: 1, skipped: undefined });
		const multi = Array.from(
			await storage.get<number>(["b", "missing", "a", "b"]),
		);
		const list = Array.from(await storage.list<number>({ prefix: "a" }));
		const deleted = await storage.delete(["b", "missing", "b"]);
		storage.sql.exec("CREATE TABLE reset_by_delete_all (value INTEGER)");
		await storage.put("reset-value", true);
		await storage.deleteAll();
		const resetValue = (await storage.get("reset-value")) === undefined;
		const resetSql =
			storage.sql
				.exec<{ name: string }>(
					"SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'reset_by_delete_all'",
				)
				.toArray().length === 0;
		await storage.put("after-reset", 9);
		const afterReset = await storage.get<number>("after-reset");
		if (afterReset === undefined)
			throw new Error("async KV reset write failed");
		return { afterReset, deleted, list, multi, resetSql, resetValue };
	}

	async asyncTransactions() {
		const storage = this.ctx.storage;
		const alarmTime = Date.now() + 60_000;
		const returned = await storage.transaction(async (transaction) => {
			await transaction.put("committed", 1, { noCache: true });
			await Promise.resolve();
			await storage.put("storage-context", 2);
			storage.transactionSync(() => storage.kv.put("sync-savepoint", 3));
			await transaction.setAlarm(new Date(alarmTime));
			await storage.transaction(async (nested) => {
				await nested.put("nested-committed", 4);
			});
			try {
				await storage.transaction(async (nested) => {
					await nested.put("nested-rolled-back", 5);
					throw new Error("nested rollback");
				});
			} catch (error: unknown) {
				if (!(error instanceof Error) || error.message !== "nested rollback") {
					throw error;
				}
			}
			return "committed";
		});

		try {
			await storage.transaction(async (transaction) => {
				await transaction.put("thrown-rollback", true);
				throw new Error("outer rollback");
			});
		} catch (error: unknown) {
			if (!(error instanceof Error) || error.message !== "outer rollback") {
				throw error;
			}
		}
		await storage.transaction(async (transaction) => {
			await transaction.put("explicit-rollback", true);
			transaction.rollback();
		});

		const alarmRoundTrip = (await storage.getAlarm()) === alarmTime;
		await storage.deleteAlarm();
		await storage.sync();
		let gateDiagnostic = "";
		try {
			await storage.get("committed", { allowConcurrency: true });
		} catch (error: unknown) {
			gateDiagnostic = error instanceof Error ? error.message : String(error);
		}
		return {
			alarmRoundTrip,
			committed: Array.from(await storage.list<number>()),
			explicitRolledBack:
				(await storage.get("explicit-rollback")) === undefined,
			gateDiagnostic,
			nestedRolledBack: (await storage.get("nested-rolled-back")) === undefined,
			returned,
			thrownRolledBack: (await storage.get("thrown-rollback")) === undefined,
		};
	}

	async setAlarm(scheduledTime: number): Promise<number | null> {
		await this.ctx.storage.setAlarm(scheduledTime);
		return await this.ctx.storage.getAlarm();
	}

	async getAlarm(): Promise<number | null> {
		return await this.ctx.storage.getAlarm();
	}

	async deleteAlarm(): Promise<number | null> {
		await this.ctx.storage.deleteAlarm();
		return await this.ctx.storage.getAlarm();
	}

	async stateSurface() {
		const diagnostics: string[] = [];
		for (const property of ["container", "props"] as const) {
			try {
				Reflect.get(this.ctx, property);
			} catch (error: unknown) {
				diagnostics.push(error instanceof Error ? error.message : String(error));
			}
		}
		try {
			await this.ctx.blockConcurrencyWhile(async () => undefined);
		} catch (error: unknown) {
			diagnostics.push(error instanceof Error ? error.message : String(error));
		}
		const exportedCounter: unknown = Reflect.get(Reflect.get(this.ctx, "exports"), "Counter");
		return {
			diagnostics,
			exportsCounterNamespace:
				typeof exportedCounter === "object" &&
				exportedCounter !== null &&
				typeof Reflect.get(exportedCounter, "idFromName") === "function",
			generation: this.#generation,
			id: this.ctx.id.toString(),
			startupReady: this.#startupReady,
		};
	}

	startWaitUntil(): number {
		const generation = this.#generation;
		this.ctx.waitUntil(
			new Promise<void>((resolve) => {
				setTimeout(() => {
					this.ctx.storage.kv.put("wait-until-generation", generation);
					resolve();
				}, 50);
			}),
		);
		return generation;
	}

	waitUntilStatus(): number | null {
		return this.ctx.storage.kv.get<number>("wait-until-generation") ?? null;
	}

	async storageLifecycleWrite(
		marker: string,
		alarmTime: number,
	): Promise<StorageLifecycleSnapshot> {
		const storage = this.ctx.storage;
		storage.sql.exec(
			"CREATE TABLE IF NOT EXISTS storage_lifecycle (name TEXT PRIMARY KEY, value TEXT NOT NULL)",
		);
		storage.sql.exec(
			"INSERT OR REPLACE INTO storage_lifecycle (name, value) VALUES ('marker', ?)",
			marker,
		);
		storage.kv.put("storage-lifecycle-sync", marker);
		await storage.put("storage-lifecycle-async", marker);
		await storage.transaction(async (transaction) => {
			await transaction.put("storage-lifecycle-transaction", marker);
		});
		await storage.setAlarm(alarmTime);
		return await this.storageLifecycleRead();
	}

	async storageLifecycleRead(): Promise<StorageLifecycleSnapshot> {
		const storage = this.ctx.storage;
		storage.sql.exec(
			"CREATE TABLE IF NOT EXISTS storage_lifecycle (name TEXT PRIMARY KEY, value TEXT NOT NULL)",
		);
		const sqlValue = storage.sql
			.exec<{ value: string }>(
				"SELECT value FROM storage_lifecycle WHERE name = 'marker'",
			)
			.toArray()[0]?.value;
		return {
			alarm: await storage.getAlarm(),
			asyncValue:
				(await storage.get<string>("storage-lifecycle-async")) ?? null,
			generation: this.#generation,
			id: this.ctx.id.toString(),
			sqlValue: sqlValue ?? null,
			syncValue:
				storage.kv.get<string>("storage-lifecycle-sync") ?? null,
			transactionValue:
				(await storage.get<string>("storage-lifecycle-transaction")) ?? null,
		};
	}

	blockSql(milliseconds: number): {
		elapsedMilliseconds: number;
		passes: number;
	} {
		if (!Number.isSafeInteger(milliseconds) || milliseconds < 1 || milliseconds > 1_000) {
			throw new RangeError("SQL blocking duration must be 1–1000 milliseconds");
		}
		const started = Date.now();
		let passes = 0;
		do {
			this.ctx.storage.sql
				.exec<{ total: number }>(
					"WITH RECURSIVE counter(value) AS (VALUES (0) UNION ALL SELECT value + 1 FROM counter WHERE value < 100000) SELECT sum(value) AS total FROM counter",
				)
				.one();
			passes += 1;
		} while (Date.now() - started < milliseconds);
		return { elapsedMilliseconds: Date.now() - started, passes };
	}

	abortAndCatch(): string {
		try {
			this.ctx.abort("state fixture reset", { retryAlarm: false });
		} catch {}
		return "abort was caught";
	}

	async fetch(request: Request): Promise<Response> {
		const body = await request.arrayBuffer();
		return new Response(body, {
			headers: {
				"content-type": request.headers.get("content-type") ?? "text/plain",
				"x-durable-route": "legacy-fetch",
				"x-original-url": request.url,
			},
			status: 201,
			statusText: "Legacy Fetch",
		});
	}
}

export class Mirror extends Counter {}

function requireAmount(url: URL): number {
	const amount = Number(url.searchParams.get("amount"));
	if (!Number.isFinite(amount)) throw new TypeError("amount must be a number");
	return amount;
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		const name = url.searchParams.get("name") ?? "fixture";
		const stub = env.COUNTERS.getByName(name);
		if (url.pathname === "/rpc") {
			return Response.json(await stub.add(requireAmount(url)));
		}
		if (url.pathname === "/legacy-fetch") {
			return await stub.fetch(
				new Request("https://durable.example/legacy?source=worker", {
					body: request.body,
					headers: request.headers,
					method: "POST",
				}),
			);
		}
		if (url.pathname === "/rpc-stream") {
			return await stub.echo(
				new Request("https://durable.example/rpc", {
					body: request.body,
					headers: request.headers,
					method: "POST",
				}),
			);
		}
		if (url.pathname === "/error") {
			try {
				await stub.fail();
			} catch (error: unknown) {
				return Response.json({
					message: error instanceof Error ? error.message : String(error),
					name: error instanceof Error ? error.name : "UnknownError",
				});
			}
			throw new Error("Durable Object failure fixture unexpectedly succeeded");
		}
		if (url.pathname === "/isolation") {
			const [counter, otherObject, otherClass] = await Promise.all([
				env.COUNTERS.getByName("shared").add(2),
				env.COUNTERS.getByName("other").add(3),
				env.MIRRORS.getByName("shared").add(5),
			]);
			return Response.json({ counter, otherClass, otherObject });
		}
		if (url.pathname === "/sql") {
			return Response.json(await stub.sql(requireAmount(url)));
		}
		if (url.pathname === "/transactions") {
			return Response.json(await stub.transactions());
		}
		if (url.pathname === "/sync-kv") {
			return Response.json(await stub.syncKv());
		}
		if (url.pathname === "/async-kv") {
			return Response.json(await stub.asyncKv());
		}
		if (url.pathname === "/async-transactions") {
			return Response.json(await stub.asyncTransactions());
		}
		if (url.pathname === "/alarm-set") {
			return Response.json(
				await stub.setAlarm(Number(url.searchParams.get("time"))),
			);
		}
		if (url.pathname === "/alarm-get") {
			return Response.json(await stub.getAlarm());
		}
		if (url.pathname === "/alarm-delete") {
			return Response.json(await stub.deleteAlarm());
		}
		if (url.pathname === "/state") {
			return Response.json(await stub.stateSurface());
		}
		if (url.pathname === "/wait-until-start") {
			return Response.json(await stub.startWaitUntil());
		}
		if (url.pathname === "/wait-until-status") {
			return Response.json(await stub.waitUntilStatus());
		}
		if (url.pathname === "/storage-lifecycle-write") {
			return Response.json(
				await stub.storageLifecycleWrite(
					url.searchParams.get("marker") ?? "missing",
					Number(url.searchParams.get("alarm")),
				),
			);
		}
		if (url.pathname === "/storage-lifecycle-read") {
			return Response.json(await stub.storageLifecycleRead());
		}
		if (url.pathname === "/storage-lifecycle-read-class") {
			return Response.json(
				await env.MIRRORS.getByName(name).storageLifecycleRead(),
			);
		}
		if (url.pathname === "/block-sql") {
			return Response.json(
				await stub.blockSql(Number(url.searchParams.get("milliseconds"))),
			);
		}
		if (url.pathname === "/abort") {
			try {
				return Response.json({ result: await stub.abortAndCatch() });
			} catch (error: unknown) {
				return Response.json({
					message: error instanceof Error ? error.message : String(error),
				});
			}
		}
		return new Response("Not Found", { status: 404 });
	},
};
