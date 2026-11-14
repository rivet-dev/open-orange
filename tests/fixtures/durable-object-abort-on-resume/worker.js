import { DurableObject } from "cloudflare:workers";

// Mirrors the Agents SDK idle cleanup: the alarm wipes storage and resets the object with
// `ctx.abort(reason, { retryAlarm: false })` from a timer, as `Agent.destroy()` does.
export class IdleSession extends DurableObject {
	async fetch(request) {
		const url = new URL(request.url);
		const storage = this.ctx.storage;
		if (url.pathname === "/arm") {
			await storage.put("peer", url.searchParams.get("peer"));
			await storage.setAlarm(Date.now() + Number(url.searchParams.get("delay")));
			return new Response("armed");
		}
		if (url.pathname === "/put") {
			await storage.put(url.searchParams.get("key"), "value");
			return new Response("stored");
		}
		if (url.pathname === "/destroy") {
			await storage.deleteAll();
			setTimeout(() => this.ctx.abort("destroyed", { retryAlarm: false }), 0);
			return new Response("destroying");
		}
		if (url.pathname === "/put-and-abort") {
			void storage.put(url.searchParams.get("key"), "value");
			this.ctx.abort("aborted in the same turn");
		}
		if (url.pathname === "/sql") {
			storage.sql.exec("CREATE TABLE IF NOT EXISTS agent_state (value TEXT)");
			storage.sql.exec("INSERT INTO agent_state VALUES (?)", "old");
			return new Response("stored");
		}
		if (url.pathname === "/tables") {
			return Response.json(
				storage.sql
					.exec("SELECT name FROM sqlite_master WHERE type = ?", "table")
					.toArray()
					.map((row) => row.name)
					.filter((name) => !name.startsWith("_")),
			);
		}
		if (url.pathname === "/keys") {
			return Response.json([...(await storage.list()).keys()]);
		}
		return Response.json({ alarm: await storage.getAlarm() });
	}

	async alarm() {
		const peer = await this.ctx.storage.get("peer");
		// A peer that is not ready yet fails the alarm, so it stays scheduled and runs again later.
		const response = await fetch(`${peer}/alarm`);
		if (!response.ok) throw new Error(`the peer refused the alarm with ${response.status}`);
		await this.ctx.storage.deleteAll();
		setTimeout(() => this.ctx.abort("destroyed", { retryAlarm: false }), 0);
	}
}

export default {
	fetch(request, env) {
		const url = new URL(request.url);
		return env.SESSION.getByName(url.searchParams.get("name") ?? "idle").fetch(request);
	},
};
