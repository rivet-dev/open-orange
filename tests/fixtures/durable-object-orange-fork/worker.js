import { DurableObject } from "cloudflare:workers";

// Exercises `env.DOC.orange.fork()`, `ctx.orange.forkChain` and `onOrangeFork()`, OpenOrange's
// Durable Object fork extension. Cloudflare has none of them.

const describe = (error) => ({ name: error?.name, code: error?.code, message: error?.message });

export class Child extends DurableObject {
	get() {
		return this.ctx.storage.kv.get("value") ?? null;
	}

	set(value) {
		this.ctx.storage.kv.put("value", value);
	}

	hasOrange() {
		return this.ctx.orange !== undefined;
	}
}

export class Doc extends DurableObject {
	constructor(ctx, env) {
		super(ctx, env);
		ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS log (entry TEXT NOT NULL)");
		// The hook must see a constructed object.
		this.constructed = true;
	}

	onOrangeFork(fork) {
		if (!this.constructed) throw new Error("onOrangeFork ran before the constructor");
		this.ctx.storage.kv.put("fork", {
			from: fork.id.toString(),
			fromName: fork.name ?? null,
			input: fork.input ?? null,
			forkedAt: typeof fork.forkedAt,
		});
	}

	append(entry) {
		this.ctx.storage.sql.exec("INSERT INTO log (entry) VALUES (?)", entry);
	}

	read() {
		return {
			entries: this.ctx.storage.sql.exec("SELECT entry FROM log ORDER BY rowid").toArray().map((row) => row.entry),
			fork: this.ctx.storage.kv.get("fork") ?? null,
			id: this.ctx.id.toString(),
			name: this.ctx.id.name ?? null,
			chain: this.ctx.orange.forkChain.map((link) => ({ id: link.id.toString(), name: link.name ?? null })),
		};
	}

	// Writes and forks in one turn: the copy must hold the write.
	async appendThenFork(entry, name) {
		this.append(entry);
		const copy = await this.env.DOC.orange.fork(this.ctx.id, { name, input: { self: true } });
		return copy.id.toString();
	}

	async setAlarmIn(ms) {
		await this.ctx.storage.setAlarm(Date.now() + ms);
	}

	async getAlarm() {
		return await this.ctx.storage.getAlarm();
	}

	alarm() {}

	child(name) {
		return this.ctx.facets.get(name, () => ({ class: this.ctx.exports.Child }));
	}

	async setChild(name, value) {
		await this.child(name).set(value);
	}

	async getChild(name) {
		return await this.child(name).get();
	}

	async childHasOrange(name) {
		return await this.child(name).hasOrange();
	}
}

async function json(value) {
	return Response.json(await value);
}

export default {
	async fetch(request, env) {
		const url = new URL(request.url);
		const name = url.searchParams.get("name") ?? "a";
		const to = url.searchParams.get("to") ?? `${name}-copy`;
		const doc = env.DOC.getByName(name);
		switch (url.pathname) {
			case "/append":
				await doc.append(url.searchParams.get("entry"));
				return json(doc.read());
			case "/read":
				return json(env.DOC.getByName(name).read());
			case "/fork": {
				const input = url.searchParams.has("input") ? { note: url.searchParams.get("input") } : undefined;
				const copy = await env.DOC.orange.fork(env.DOC.idFromName(name), { name: to, input });
				return json(copy.read());
			}
			case "/fork-unique": {
				const copy = await env.DOC.orange.fork(env.DOC.idFromName(name));
				return json({ named: copy.name ?? null, read: await copy.read() });
			}
			case "/fork-error": {
				try {
					await env.DOC.orange.fork(env.DOC.idFromName(name), { name: to });
					return json({ ok: true });
				} catch (error) {
					return json(describe(error));
				}
			}
			case "/self-fork": {
				const id = await doc.appendThenFork(url.searchParams.get("entry"), to);
				return json({ sameAsName: id === env.DOC.idFromName(to).toString(), copy: await env.DOC.getByName(to).read() });
			}
			case "/alarm": {
				await doc.setAlarmIn(3_600_000);
				await env.DOC.orange.fork(env.DOC.idFromName(name), { name: to });
				return json({
					source: (await doc.getAlarm()) !== null,
					copy: await env.DOC.getByName(to).getAlarm(),
				});
			}
			case "/facets": {
				await doc.setChild("kid", "from-source");
				await env.DOC.orange.fork(env.DOC.idFromName(name), { name: to });
				// A write after the fork, before the copy's first call, must not reach the copy.
				await doc.setChild("kid", "after-fork");
				const copy = env.DOC.getByName(to);
				const copied = await copy.getChild("kid");
				await copy.setChild("kid", "from-copy");
				return json({
					copied,
					copyAfterWrite: await copy.getChild("kid"),
					source: await doc.getChild("kid"),
					facetHasOrange: await doc.childHasOrange("kid"),
				});
			}
			case "/shape":
				return json({
					keys: Object.keys(env.DOC),
					hasOrange: typeof env.DOC.orange?.fork === "function",
				});
			default:
				return new Response("not found", { status: 404 });
		}
	},
};
