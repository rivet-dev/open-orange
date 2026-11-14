import { DurableObject } from "cloudflare:workers";

// A facet class with no binding and no migration, like the agents SDK's CodemodeRuntime.
export class Counter extends DurableObject {
	memory = 0;

	increment() {
		this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS counter (value INTEGER NOT NULL)");
		const row = this.ctx.storage.sql
			.exec("UPDATE counter SET value = value + 1 RETURNING value")
			.toArray()[0];
		const stored =
			row === undefined
				? this.ctx.storage.sql.exec("INSERT INTO counter (value) VALUES (1) RETURNING value").one()
						.value
				: row.value;
		this.memory += 1;
		return { memory: this.memory, stored };
	}

	ping() {
		return "pong";
	}

	version() {
		return "v1";
	}

	async setChild(value) {
		const child = this.ctx.facets.get("child", () => ({ class: this.ctx.exports.Leaf }));
		await child.set(value);
	}

	// Stays in flight until the facet is aborted or deleted.
	hang() {
		return new Promise(() => {});
	}
}

// The new code that replaces Counter after abort(). It reads Counter's table.
export class CounterV2 extends DurableObject {
	version() {
		return "v2";
	}

	read() {
		return this.ctx.storage.sql.exec("SELECT value FROM counter").one().value;
	}

	async readChild() {
		const child = this.ctx.facets.get("child", () => ({ class: this.ctx.exports.Leaf }));
		return await child.get();
	}
}

export class Leaf extends DurableObject {
	async set(value) {
		await this.ctx.storage.put("value", value);
	}

	async get() {
		return (await this.ctx.storage.get("value")) ?? null;
	}
}

export class Parent extends DurableObject {
	facet(name, className = "Counter") {
		return this.ctx.facets.get(name, () => ({ class: this.ctx.exports[className] }));
	}

	async fetch(request) {
		const url = new URL(request.url);
		const name = url.searchParams.get("facet");
		switch (url.pathname) {
			case "/increment":
				return Response.json(await this.facet(name).increment());
			case "/abort": {
				const old = this.facet(name);
				const before = await old.increment();
				const inFlightError = errorMessage(old.hang());
				await old.ping();
				this.ctx.facets.abort(name, url.searchParams.get("reason"));
				const oldStubError = await errorMessage(old.increment());
				return Response.json({
					after: await this.facet(name).increment(),
					before,
					inFlightError: await inFlightError,
					oldStubError,
				});
			}
			case "/swap": {
				const before = await this.facet(name).increment();
				// While the facet runs, get() skips the callback, so the class does not change.
				const whileRunning = await this.facet(name, "CounterV2").version();
				this.ctx.facets.abort(name, "swap");
				const swapped = this.facet(name, "CounterV2");
				return Response.json({
					after: { stored: await swapped.read(), version: await swapped.version() },
					before,
					whileRunning,
				});
			}
			case "/swap-children": {
				await this.facet(name).setChild("kept");
				this.ctx.facets.abort(name, "swap");
				return Response.json({ child: await this.facet(name, "CounterV2").readChild() });
			}
			case "/delete": {
				const old = this.facet(name);
				const before = await old.increment();
				const inFlightError = errorMessage(old.hang());
				await old.ping();
				this.ctx.facets.delete(name);
				return Response.json({
					after: await this.facet(name).increment(),
					before,
					inFlightError: await inFlightError,
				});
			}
			default:
				return new Response("not found", { status: 404 });
		}
	}
}

async function errorMessage(promise) {
	try {
		await promise;
		return null;
	} catch (error) {
		return error.message;
	}
}

export default {
	async fetch(request, env) {
		const url = new URL(request.url);
		const parent = env.PARENT.getByName(url.searchParams.get("parent"));
		return await parent.fetch(request);
	},
};
