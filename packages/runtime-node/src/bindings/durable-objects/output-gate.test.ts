import assert from "node:assert/strict";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import test from "node:test";

import { WebSocketPair } from "../../globals/websocket.js";
import type {
	RivetSqliteBindings,
	RivetSqliteDatabase,
	RivetSqliteExecuteResult,
	RivetSynchronousSqliteTransaction,
} from "../../internal/rivetkit.js";
import { DurableObject } from "../../modules/cloudflare-workers/durable-object.js";
import { DurableObjectTurnDatabase } from "./gates.js";
import { createDurableObjectGeneration } from "./state.js";

function sqliteInput(value: unknown): SQLInputValue {
	if (
		value === null ||
		typeof value === "number" ||
		typeof value === "bigint" ||
		typeof value === "string" ||
		value instanceof Uint8Array
	) {
		return value;
	}
	throw new TypeError("Test SQLite adapter received an invalid binding");
}

// Local SQLite whose commits become durable only when the test says so, like a depot that has
// not acknowledged the flush yet.
class HeldDurabilityDatabase implements RivetSqliteDatabase {
	readonly #database = new DatabaseSync(":memory:");
	readonly #flushes = new Map<number, PromiseWithResolvers<void>>();
	#commits = 0;
	#durableThrough = 0;

	close(): void {
		this.#database.close();
	}

	/** Makes `ticket` and every earlier commit durable. */
	makeDurable(ticket: number): void {
		this.#durableThrough = Math.max(this.#durableThrough, ticket);
		for (const [pending, flush] of this.#flushes) {
			if (pending <= ticket) flush.resolve();
		}
	}

	failDurability(error: Error): void {
		for (const flush of this.#flushes.values()) flush.reject(error);
	}

	commitTicket(): number {
		return this.#commits;
	}

	whenDurable(ticket: number): Promise<void> {
		if (ticket <= this.#durableThrough) return Promise.resolve();
		let flush = this.#flushes.get(ticket);
		if (flush === undefined) {
			flush = Promise.withResolvers<void>();
			this.#flushes.set(ticket, flush);
		}
		return flush.promise;
	}

	beginTransactionSync(): RivetSynchronousSqliteTransaction {
		this.#database.exec("BEGIN");
		return {
			commitSync: () => {
				this.#database.exec("COMMIT");
				this.#commits += 1;
			},
			execSync: (sql) => this.execSync(sql),
			executeSync: (sql, params) => this.executeSync(sql, params),
			rollbackSync: () => this.#database.exec("ROLLBACK"),
		};
	}

	execSync(sql: string): void {
		this.#database.exec(sql);
	}

	executeSync(
		sql: string,
		params?: RivetSqliteBindings,
	): RivetSqliteExecuteResult {
		if (params !== undefined && !Array.isArray(params)) {
			throw new TypeError("Test SQLite adapter requires positional bindings");
		}
		const statement = this.#database.prepare(sql);
		const bindings = (params ?? []).map(sqliteInput);
		const columns = statement.columns().map(({ name }) => name);
		if (columns.length > 0) {
			return {
				changes: 0,
				columns,
				rows: statement
					.all(...bindings)
					.map((row) => columns.map((column) => row[column])),
			};
		}
		const result = statement.run(...bindings);
		return { changes: Number(result.changes), columns: [], rows: [] };
	}
}

class SocketObject extends DurableObject {
	// Created by the object, so its sends wait on the object's output gate.
	readonly pair = new WebSocketPair();
}

function startSocketObject(t: test.TestContext) {
	const database = new HeldDurabilityDatabase();
	t.after(() => database.close());
	const resets: Error[] = [];
	const generation = createDurableObjectGeneration({
		bindings: {},
		className: "SocketObject",
		database: new DurableObjectTurnDatabase(database, (error) => resets.push(error)),
		userClass: SocketObject,
	});
	const instance = generation.instance;
	assert.ok(instance instanceof SocketObject);
	const [peer, socket] = [instance.pair[0], instance.pair[1]];
	const received: unknown[] = [];
	peer.accept();
	peer.addEventListener("message", (event: unknown) => {
		received.push(Reflect.get(Object(event), "data"));
	});
	socket.accept();
	return { database, generation, received, resets, socket };
}

function nextTurn(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

test("delivers a Durable Object's WebSocket messages in order once the writes before each are durable", async (t) => {
	const { database, generation, received, socket } = startSocketObject(t);
	await generation.ready;
	const storage = generation.state.storage;

	const event = generation.stateController.runEvent(async () => {
		storage.kv.put("first", 1);
		socket.send("after first write");
		// The next turn's write commits separately and must not hold the message above.
		await nextTurn();
		storage.kv.put("second", 2);
		socket.send("after second write");
	});
	await nextTurn();
	await nextTurn();
	assert.deepEqual(received, []);

	database.makeDurable(1);
	await nextTurn();
	assert.deepEqual(received, ["after first write"]);

	database.makeDurable(2);
	await event;
	await nextTurn();
	assert.deepEqual(received, ["after first write", "after second write"]);
});

test("never delivers a WebSocket message whose writes fail to become durable", async (t) => {
	const { database, generation, received, resets, socket } = startSocketObject(t);
	await generation.ready;
	const storage = generation.state.storage;

	const event = generation.stateController.runEvent(() => {
		storage.kv.put("lost", true);
		socket.send("depends on lost write");
	});
	await nextTurn();
	database.failDurability(new Error("depot unavailable"));
	await assert.rejects(event, /resetting to its last durable state/);
	await nextTurn();
	assert.deepEqual(received, []);
	assert.equal(resets.length, 1);
});
