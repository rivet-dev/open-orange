import { DurableObject } from "cloudflare:workers";

export interface Env {
	COUNTER: DurableObjectNamespace<Counter>;
}

export class Counter extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);

		ctx.blockConcurrencyWhile(async () => {
			this.ctx.storage.sql.exec(`
				CREATE TABLE IF NOT EXISTS counters (
					name TEXT PRIMARY KEY,
					value INTEGER NOT NULL DEFAULT 0
				)
			`);
		});
	}

	// In-memory only. This field lives on the instance and is not persisted
	// to storage, so it is reset whenever the Durable Object is evicted and
	// reconstructed.
	cachedHits = 0;

	recordHit(): number {
		return ++this.cachedHits;
	}

	getHits(): number {
		return this.cachedHits;
	}

	async increment(name: string = "default"): Promise<number> {
		this.ctx.storage.sql.exec(
			`INSERT INTO counters (name, value) VALUES (?, 1)
			 ON CONFLICT(name) DO UPDATE SET value = value + 1`,
			name
		);
		const result = this.ctx.storage.sql
			.exec<{ value: number }>("SELECT value FROM counters WHERE name = ?", name)
			.one();
		return result.value;
	}

	async getCount(name: string = "default"): Promise<number> {
		const result = this.ctx.storage.sql
			.exec<{ value: number }>("SELECT value FROM counters WHERE name = ?", name)
			.toArray();
		return result[0]?.value ?? 0;
	}

	async reset(name: string = "default"): Promise<void> {
		this.ctx.storage.sql.exec("DELETE FROM counters WHERE name = ?", name);
	}
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		const counterId = url.searchParams.get("id") ?? "default";

		const id = env.COUNTER.idFromName(counterId);
		const stub = env.COUNTER.get(id);

		if (request.method === "POST") {
			const count = await stub.increment();
			return Response.json({ count });
		}

		const count = await stub.getCount();
		return Response.json({ count });
	},
};
