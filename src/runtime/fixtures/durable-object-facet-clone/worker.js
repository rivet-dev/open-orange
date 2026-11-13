import { DurableObject } from "cloudflare:workers";

// The first routes port workerd's "Durable Object facet cloning" test.
// https://github.com/cloudflare/workerd/blob/7236b3650b6c0951484a4d170f17fb6f800b5662/src/workerd/server/server-test.c%2B%2B#L7256-L7499

const describe = (error) => `${error?.constructor?.name}: ${error?.message}`;
const settle = (promise) =>
	promise.then(
		(value) => ({ ok: value }),
		(error) => ({ err: describe(error) }),
	);

export class Parent extends DurableObject {
	f(name, className = "NestedFacet") {
		return this.ctx.facets.get(name, () => ({ class: this.ctx.exports[className] }));
	}

	async fetch(request) {
		const url = new URL(request.url);
		const facets = this.ctx.facets;
		switch (url.pathname) {
			case "/setup": {
				const src = this.f("src");
				await src.setValue(10);
				await src.setChildValue("a", 100);
				await src.setChildValue("b", 200);
				return new Response("ok");
			}
			case "/clone-basic": {
				facets.clone("src", "dst");
				const dst = this.f("dst");
				return new Response(
					`dst=${await dst.getValue()} dst.a=${await dst.getChildValue("a")} dst.b=${await dst.getChildValue("b")}`,
				);
			}
			case "/verify-src-unchanged": {
				const src = this.f("src");
				return new Response(
					`src=${await src.getValue()} src.a=${await src.getChildValue("a")} src.b=${await src.getChildValue("b")}`,
				);
			}
			case "/mutate-dst-then-check-src": {
				const dst = this.f("dst");
				await dst.setValue(999);
				await dst.setChildValue("a", 888);
				const src = this.f("src");
				return new Response(`src=${await src.getValue()} src.a=${await src.getChildValue("a")}`);
			}
			case "/clone-replaces-existing": {
				const target = this.f("target");
				await target.setValue(42);
				await target.setChildValue("oldChild", 77);
				facets.clone("src", "target");
				const target2 = this.f("target");
				return new Response(
					`target=${await target2.getValue()} target.a=${await target2.getChildValue("a")} oldChild=${await target2.getChildValue("oldChild")}`,
				);
			}
			case "/clone-from-nonexistent-deletes-dst": {
				const dst = this.f("toBeWiped");
				await dst.setValue(123);
				await dst.setChildValue("c", 456);
				facets.clone("never-existed", "toBeWiped");
				const dst2 = this.f("toBeWiped");
				return new Response(`val=${await dst2.getValue()} c=${await dst2.getChildValue("c")}`);
			}
			case "/clone-self-aborts-but-preserves": {
				const self = this.f("self");
				await self.setValue(7);
				await self.setMemoryOnly("alive");
				const beforeMem = await self.getMemoryOnly();
				facets.clone("self", "self");
				let oldThrew = false;
				try {
					await self.getValue();
				} catch {
					oldThrew = true;
				}
				const self2 = this.f("self");
				return new Response(
					`beforeMem=${beforeMem} oldThrew=${oldThrew} val=${await self2.getValue()} mem=${await self2.getMemoryOnly()}`,
				);
			}
			case "/read-restored": {
				const dst = this.f("dst");
				return new Response(
					`dst=${await dst.getValue()} dst.a=${await dst.getChildValue("a")} dst.b=${await dst.getChildValue("b")}`,
				);
			}
			case "/names": {
				const out = [];
				for (const [label, run] of [
					["clone-256", () => facets.clone("y".repeat(256), "z".repeat(256))],
				]) {
					try {
						run();
						out.push(`${label}=ok`);
					} catch (error) {
						out.push(`${label}=${describe(error)}`);
					}
				}
				const long = this.f("l".repeat(256));
				await long.setValue(256);
				facets.clone("l".repeat(256), "m".repeat(256));
				out.push(`copy256=${await this.f("m".repeat(256)).getValue()}`);
				// Workerd refuses names over 256 characters, a Cloudflare quota that Orange does not copy.
				const longer = this.f("L".repeat(2000));
				await longer.setValue(2000);
				facets.clone("L".repeat(2000), "M".repeat(2000));
				out.push(`copy2000=${await this.f("M".repeat(2000)).getValue()}`);
				return new Response(out.join(" "));
			}
			case "/snapshot-point": {
				const src = this.f("s");
				await src.setValue(1);
				facets.clone("s", "d");
				await src.setValue(2);
				return new Response(`d=${await this.f("d").getValue()} s=${await src.getValue()}`);
			}
			case "/call-before-clone": {
				// The call starts before clone() in the same turn. Workerd copies before it runs.
				const src = this.f("s");
				await src.setValue(1);
				const write = src.setValue(2);
				facets.clone("s", "d");
				await write;
				return new Response(`d=${await this.f("d").getValue()} s=${await src.getValue()}`);
			}
			case "/dst-stubs": {
				const dst = this.f("d");
				await dst.setValue(5);
				const inflight = settle(dst.hang());
				const unused = this.f("d");
				const src = this.f("s");
				await src.setValue(1);
				facets.clone("s", "d");
				const old = await settle(dst.getValue());
				return new Response(
					JSON.stringify({
						inflight: await inflight,
						old,
						stubFirstUsedAfterClone: await settle(unused.getValue()),
					}),
				);
			}
			case "/dst-in-transaction": {
				// dst is inside storage.transaction() when clone() replaces it.
				const dst = this.f("d");
				await dst.setValue(5);
				const write = settle(dst.transactionWrite(9, 500));
				await new Promise((resolve) => setTimeout(resolve, 20));
				const src = this.f("s");
				await src.setValue(1);
				facets.clone("s", "d");
				return new Response(`write=${JSON.stringify(await write)} d=${await this.f("d").getValue()}`);
			}
			case "/overlap": {
				const src = this.f("s");
				await src.setValue(1);
				await src.setChildValue("a", 11);
				facets.clone("s", "d1");
				facets.clone("s", "d2");
				facets.clone("d1", "d3");
				const reads = Promise.all(
					["d1", "d2", "d3"].map(async (name) => `${name}=${await this.f(name).getValue()} ${name}.a=${await this.f(name).getChildValue("a")}`),
				);
				await src.setValue(2);
				await src.setChildValue("a", 22);
				return new Response(`${(await reads).join(" ")} s=${await src.getValue()}`);
			}
			case "/abort-after-clone": {
				const src = this.f("s");
				await src.setValue(41);
				facets.clone("s", "d");
				this.ctx.abort("after clone");
				return new Response("unreachable");
			}
			case "/read-d":
				return new Response(`d=${await this.f("d").getValue()}`);
			case "/tree": {
				// src has children and grandchildren, and dst runs another class.
				const src = this.f("s");
				await src.setValue(3);
				await src.setChildValue("a", 33);
				await src.setGrandchild("n", "g", 7);
				facets.clone("s", "d");
				const dst = this.f("d", "OtherFacet");
				return new Response(
					`d=${await dst.getValue()} d.a=${await dst.getChildValue("a")} d.n.g=${await dst.getGrandchild("n", "g")} seenAtConstruction=${await dst.seenAtConstruction()}`,
				);
			}
			case "/depth":
				return new Response(await this.f("s").deepClone());
			case "/mid-write": {
				// src writes a pair in every turn, on its own timer, while the copy runs.
				const src = this.f("s");
				await src.startTicking();
				await new Promise((resolve) => setTimeout(resolve, 20));
				facets.clone("s", "d");
				const pair = await this.f("d").pair();
				await src.stopTicking();
				return new Response(`torn=${pair.a !== pair.b} copied=${pair.a > 0}`);
			}
			case "/in-transaction": {
				// src is inside storage.transaction() when the copy reads it.
				const src = this.f("s");
				await src.setValue(1);
				const write = src.transactionWrite(2, 500);
				await new Promise((resolve) => setTimeout(resolve, 20));
				facets.clone("s", "d");
				await write;
				return new Response(`d=${await this.f("d").getValue()} s=${await src.getValue()}`);
			}
			case "/flag-src": {
				const src = this.f("s", "ExplodingFacet");
				await src.setValueAndExplode(5);
				return new Response("ok");
			}
			case "/clone-flagged": {
				facets.clone("s", "d");
				return new Response(`d=${await this.f("d").getValue()}`);
			}
			case "/fill": {
				// About 40 MB, so a row copy takes seconds. The child is copied too.
				const src = this.f("s", "SqlFacet");
				for (let index = 0; index < 5; index++) await src.fillBlobs(8);
				await src.setChildValue("c", 5);
				return new Response("ok");
			}
			case "/write-d": {
				await this.f("d", "SqlFacet").setChildValue("c", Number(url.searchParams.get("value")));
				return new Response("ok");
			}
			case "/chain": {
				// Each clone copies the previous copy, so the copies form a chain of forks.
				const length = Number(url.searchParams.get("length"));
				await this.f("c0").setValue(1);
				await this.f("c0").setChildValue("k", 2);
				for (let index = 1; index <= length; index++) facets.clone(`c${index - 1}`, `c${index}`);
				const last = this.f(`c${length}`);
				return new Response(`v=${await last.getValue()} k=${await last.getChildValue("k")}`);
			}
			case "/wide": {
				// src holds 10 MB and four children, so one clone forks five actors.
				const src = this.f("s", "SqlFacet");
				await src.fillBlobs(10);
				for (let index = 1; index <= 4; index++) await src.setChildValue(`k${index}`, index);
				facets.clone("s", "d");
				const dst = this.f("d", "SqlFacet");
				const children = [];
				for (let index = 1; index <= 4; index++) children.push(await dst.getChildValue(`k${index}`));
				return new Response(`d=${(await dst.blobs()).bytes} children=${children.join(",")}`);
			}
			case "/big-fill": {
				const src = this.f("big", "SqlFacet");
				await src.fillBlobs(Number(url.searchParams.get("mb")));
				return new Response("ok");
			}
			case "/big-clone": {
				const started = performance.now();
				facets.clone("big", "big-copy");
				const blobs = await this.f("big-copy", "SqlFacet").blobs();
				return Response.json({ ...blobs, ms: performance.now() - started });
			}
			case "/clone-and-return": {
				this.ctx.facets.clone("s", "d");
				return new Response("cloned");
			}
			case "/ping":
				return new Response("pong");
			case "/read-blobs": {
				const dst = this.f("d", "SqlFacet");
				return Response.json({ ...(await dst.blobs()), c: await dst.getChildValue("c") });
			}
			case "/sql": {
				const src = this.f("s", "SqlFacet");
				await src.fill();
				const before = await src.dump();
				facets.clone("s", "d");
				const after = await this.f("d", "SqlFacet").dump();
				return Response.json({ after, before });
			}
		}
		return new Response("bad url", { status: 404 });
	}
}

export class NestedFacet extends DurableObject {
	constructor(ctx, env) {
		super(ctx, env);
		this.seen = ctx.storage.kv.get("value") ?? null;
	}
	async setValue(value) {
		await this.ctx.storage.put("value", value);
	}
	async getValue() {
		return (await this.ctx.storage.get("value")) ?? null;
	}
	seenAtConstruction() {
		return this.seen;
	}
	child(name, className = "LeafFacet") {
		return this.ctx.facets.get(name, () => ({ class: this.ctx.exports[className] }));
	}
	async setChildValue(name, value) {
		await this.child(name).setValue(value);
	}
	async getChildValue(name) {
		return await this.child(name).getValue();
	}
	async setGrandchild(name, grandchild, value) {
		await this.child(name, "NestedFacet").setChildValue(grandchild, value);
	}
	async getGrandchild(name, grandchild) {
		return await this.child(name, "NestedFacet").getChildValue(grandchild);
	}
	setMemoryOnly(value) {
		this.memoryOnly = value;
	}
	getMemoryOnly() {
		return this.memoryOnly ?? null;
	}
	hang() {
		return new Promise(() => {});
	}
	async transactionWrite(value, milliseconds) {
		await this.ctx.storage.transaction(async (transaction) => {
			await transaction.put("value", value);
			await new Promise((resolve) => setTimeout(resolve, milliseconds));
		});
	}
	startTicking() {
		this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS pair (id INTEGER PRIMARY KEY, b INTEGER)");
		let ticks = 0;
		this.ticking = true;
		const tick = () => {
			if (!this.ticking) return;
			ticks += 1;
			this.ctx.storage.kv.put("a", ticks);
			this.ctx.storage.sql.exec(
				"INSERT INTO pair (id, b) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET b = excluded.b",
				ticks,
			);
			setTimeout(tick, 0);
		};
		tick();
	}
	stopTicking() {
		this.ticking = false;
	}
	pair() {
		return {
			a: this.ctx.storage.kv.get("a"),
			b: this.ctx.storage.sql.exec("SELECT b FROM pair").one().b,
		};
	}
	async deepClone() {
		return await this.child("a", "NestedFacet").deepClone2();
	}
	async deepClone2() {
		return await this.child("leaf", "DeepFacet").run();
	}
}

export class OtherFacet extends NestedFacet {}

export class LeafFacet extends DurableObject {
	async setValue(value) {
		await this.ctx.storage.put("value", value);
	}
	async getValue() {
		return (await this.ctx.storage.get("value")) ?? null;
	}
}

// At the maximum depth, no facet can exist below.
export class DeepFacet extends DurableObject {
	run() {
		try {
			this.ctx.facets.clone("x", "y");
			return "clone=ok";
		} catch (error) {
			return `clone=${describe(error)}`;
		}
	}
}

// Its constructor throws once the flag is stored, so it can never start again.
export class ExplodingFacet extends DurableObject {
	constructor(ctx, env) {
		super(ctx, env);
		if (ctx.storage.kv.get("explode") === true) throw new Error("constructor exploded");
	}
	setValueAndExplode(value) {
		this.ctx.storage.kv.put("value", value);
		this.ctx.storage.kv.put("explode", true);
	}
}

export class SqlFacet extends DurableObject {
	fill() {
		const sql = this.ctx.storage.sql;
		sql.exec("CREATE TABLE auto (id INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT)");
		sql.exec("INSERT INTO auto (v) VALUES ('a'), ('b'), ('c')");
		sql.exec("DELETE FROM auto WHERE v = 'c'");
		sql.exec("CREATE TABLE plain (v TEXT)");
		sql.exec("INSERT INTO plain (rowid, v) VALUES (5, 'five'), (9, 'nine')");
		sql.exec("CREATE TABLE gen (a INTEGER, b INTEGER GENERATED ALWAYS AS (a * 2) STORED, c INTEGER AS (a + 1))");
		sql.exec("INSERT INTO gen (a) VALUES (3)");
		sql.exec("CREATE TABLE parent_t (id INTEGER PRIMARY KEY)");
		sql.exec("CREATE TABLE child_t (pid INTEGER REFERENCES parent_t(id))");
		sql.exec("INSERT INTO parent_t VALUES (1)");
		sql.exec("INSERT INTO child_t VALUES (1)");
		sql.exec("CREATE TABLE log (msg TEXT)");
		sql.exec("CREATE TRIGGER plain_ins AFTER INSERT ON plain BEGIN INSERT INTO log VALUES ('ins ' || new.v); END");
		sql.exec("CREATE INDEX plain_v ON plain (v)");
		sql.exec("CREATE VIEW plain_view AS SELECT v FROM plain");
		sql.exec("CREATE VIRTUAL TABLE docs USING fts5(body)");
		sql.exec("INSERT INTO docs (body) VALUES ('hello world'), ('goodbye world')");
		sql.exec("INSERT INTO auto (v) VALUES ('d')");
		sql.exec("CREATE TABLE types (v)");
		sql.exec("INSERT INTO types VALUES (2.0), (9007199254740993), (x''), (x'00ff'), (''), (NULL)");
	}
	async setChildValue(name, value) {
		await this.ctx.facets.get(name, () => ({ class: this.ctx.exports.LeafFacet })).setValue(value);
	}
	async getChildValue(name) {
		return await this.ctx.facets.get(name, () => ({ class: this.ctx.exports.LeafFacet })).getValue();
	}
	fillBlobs(megabytes) {
		this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS blobs (id INTEGER PRIMARY KEY, data BLOB)");
		for (let index = 0; index < megabytes * 4; index++) {
			this.ctx.storage.sql.exec("INSERT INTO blobs (data) VALUES (zeroblob(262144))");
		}
	}
	blobs() {
		return this.ctx.storage.sql.exec("SELECT count(*) AS rows, sum(length(data)) AS bytes FROM blobs").one();
	}
	dump() {
		const rows = (query) => this.ctx.storage.sql.exec(query).toArray();
		return {
			auto: rows("SELECT id, v FROM auto ORDER BY id"),
			fts: rows("SELECT rowid, body FROM docs WHERE docs MATCH 'world' ORDER BY rowid"),
			gen: rows("SELECT a, b, c FROM gen"),
			log: rows("SELECT msg FROM log"),
			plain: rows("SELECT rowid, v FROM plain ORDER BY rowid"),
			seq: rows("SELECT name, seq FROM sqlite_sequence"),
			types: rows("SELECT typeof(v) AS t, quote(v) AS q FROM types ORDER BY rowid"),
			view: rows("SELECT v FROM plain_view ORDER BY v"),
		};
	}
}

export default {
	async fetch(request, env) {
		const url = new URL(request.url);
		return await env.PARENT.getByName(url.searchParams.get("parent") ?? "default").fetch(request);
	},
};
