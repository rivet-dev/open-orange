import assert from "node:assert/strict";

import type { Scenario } from "../../src/real-projects/scenario.js";

const post: RequestInit = { method: "POST" };

const postJson = (body: unknown): RequestInit => ({
	method: "POST",
	headers: { "Content-Type": "application/json" },
	body: JSON.stringify(body),
});

interface Check {
	allowed: boolean;
	pathNodeIds?: string[];
	pathEdgeKinds?: string[];
}

interface Graph {
	nodes: unknown[];
	edges: unknown[];
}

interface Timeline {
	steps: { index: number; recordedAt: string }[];
}

const aliceEditsRoadmap = "/check?user=alice&relation=editor&doc=roadmap";

// Each example and tenant pair is its own Durable Object, with a TypeGraph graph in its SQLite database.
const scenario: Scenario = async (t) => {
	const searchIds = async (tenant: string, query: string): Promise<string[]> => {
		const { hits } = await t.json<{ hits: { id: string }[] }>(
			`/api/notes/${tenant}/search?q=${encodeURIComponent(query)}`,
		);
		return hits.map((hit) => hit.id);
	};

	await t.step("authz seeds a workspace, and a check finds the inherited grant by a recursive path query", "do-state", async () => {
		const seeded = await t.json<{ ok: boolean; workspace: { users: number } }>("/api/authz/acme/seed", post);
		assert.equal(seeded.ok, true);
		assert.equal(seeded.workspace.users, 5);
		const check = await t.json<Check>(`/api/authz/acme${aliceEditsRoadmap}`);
		assert.equal(check.allowed, true);
		assert.deepEqual(check.pathNodeIds, [
			"user:alice",
			"group:eng",
			"group:staff",
			"folder:engineering",
			"folder:specs",
			"doc:roadmap",
		]);
		assert.deepEqual(check.pathEdgeKinds, ["memberOf", "memberOf", "editor", "parentOf", "parentOf"]);
	});

	await t.step("another workspace is another object, and has none of the first one's users", "do-state", async () => {
		const missing = await t.json<{ error: string }>(`/api/authz/globex${aliceEditsRoadmap}`, undefined, 404);
		assert.equal(missing.error, "unknown user: alice");
	});

	await t.step("notes seeds a garden, and FTS5 search ranks the matching note first", "do-state", async () => {
		const seeded = await t.json<{ ok: boolean; notes: number }>("/api/notes/me/seed", post);
		assert.equal(seeded.notes, 12);
		const { hits } = await t.json<{ hits: { id: string; snippet: string }[] }>("/api/notes/me/search?q=reachability");
		assert.equal(hits[0]?.id, "note:reachability");
		assert.match(hits[0]?.snippet ?? "", /<mark>Reachability<\/mark>/);
	});

	await t.step("a note written through one request reaches an open WebSocket and the next search", "websocket", async () => {
		const socket = await t.webSocket("/api/notes/me/ws");
		try {
			socket.send("ping");
			assert.equal(await socket.next(), "pong");
			await t.json(
				"/api/notes/me/notes",
				postJson({ title: "Orchard", body: "A quince tree links to [[Reachability]]." }),
			);
			assert.deepEqual(JSON.parse(await socket.next()), { type: "graph-changed" });
		} finally {
			await socket.close();
		}
		assert.ok((await searchIds("me", "quince")).includes("note:orchard"));
	});

	let recordedAtFourth = "";
	let graphAtFourth: Graph = { nodes: [], edges: [] };
	let graphNow: Graph = { nodes: [], edges: [] };

	await t.step("agent-memory replays a conversation, and a recorded-time read returns the earlier graph", "do-state", async () => {
		const seeded = await t.json<{ applied: number; total: number }>("/api/agent-memory/session-42/seed", post);
		assert.deepEqual(seeded, { applied: 12, total: 12 });
		const { steps } = await t.json<Timeline>("/api/agent-memory/session-42/timeline");
		assert.equal(steps.length, 12);
		recordedAtFourth = steps[3]?.recordedAt ?? "";
		graphAtFourth = await t.json<Graph>(
			`/api/agent-memory/session-42/graph?recorded=${encodeURIComponent(recordedAtFourth)}`,
		);
		graphNow = await t.json<Graph>("/api/agent-memory/session-42/graph");
		assert.ok(graphAtFourth.nodes.length > 0);
		assert.ok(graphAtFourth.nodes.length < graphNow.nodes.length);
		assert.ok(graphAtFourth.edges.length < graphNow.edges.length);
	});

	const assertEveryGraphKept = async () => {
		const check = await t.json<Check>(`/api/authz/acme${aliceEditsRoadmap}`);
		assert.equal(check.allowed, true);
		assert.ok((await searchIds("me", "quince")).includes("note:orchard"));
		const earlier = await t.json<Graph>(
			`/api/agent-memory/session-42/graph?recorded=${encodeURIComponent(recordedAtFourth)}`,
		);
		assert.equal(earlier.nodes.length, graphAtFourth.nodes.length);
		assert.equal(earlier.edges.length, graphAtFourth.edges.length);
		const now = await t.json<Graph>("/api/agent-memory/session-42/graph");
		assert.equal(now.nodes.length, graphNow.nodes.length);
	};

	await t.step("every object sleeps, and each graph and its history are there when it wakes", "sleep", async () => {
		await t.waitForSleep();
		await assertEveryGraphKept();
	});

	await t.step("orange dev restarts, and each graph and its history are still there", "restart", async () => {
		await t.restart();
		await assertEveryGraphKept();
	});
};

export default scenario;
