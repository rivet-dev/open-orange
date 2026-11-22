import assert from "node:assert/strict";
import { glob, readFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

import { durableObjectActorName } from "../../packages/runtime-node/src/bindings/durable-objects/actor-routing.js";
import { queueActorName } from "../../packages/runtime-node/src/internal-actors/queue.js";

import { resolveDeploymentStorage } from "../../src/runtime/deployment.js";
import { freePort } from "../harness/free-port.js";
import {
	closeWebSocket,
	collectMessages,
	copyProject,
	openWebSocket,
	repositoryRoot,
	startOrangeDev,
	withDeadline,
	type RunningOrangeDev,
} from "../harness/orange-dev.js";
import { adminToken, exited, startServe, startStandaloneEngine } from "../harness/orange-serve.js";
import { startRecordingGatewayProxy, type GatewayCall } from "../harness/recording-gateway-proxy.js";

// The local Engine's admin token. Only the test uses it, to look up actors and mint a token.
const adminHeaders = { authorization: "Bearer default", "content-type": "application/json" };
const workerName = "orange-test-gateway-auth";
// Past Orange's 10 second idle timeout, with a margin.
const pastIdleTimeoutMs = 16_000;

async function engineEndpoint(projectDirectory: string): Promise<string> {
	for await (const path of glob(".open-orange/rivetkit/*/.rivetkit/var/engine/runtime.json", {
		cwd: projectDirectory,
	})) {
		const runtime = JSON.parse(await readFile(join(projectDirectory, path), "utf8")) as {
			endpoint: string;
		};
		return runtime.endpoint;
	}
	throw new Error("The project has no running Rivet Engine");
}

async function actorId(endpoint: string, name: string): Promise<string> {
	const url = new URL("/actors", endpoint);
	url.searchParams.set("namespace", "default");
	url.searchParams.set("name", name);
	const response = await fetch(url, { headers: adminHeaders });
	assert.equal(response.status, 200, await response.clone().text());
	const body = (await response.json()) as { actors: { actor_id: string }[] };
	assert.equal(body.actors.length, 1, JSON.stringify(body));
	return body.actors[0]!.actor_id;
}

// A token that another Rivet client in the same project could hold.
async function mintToken(
	endpoint: string,
	grants: { operations: string[]; resource: string; target: "any" }[],
): Promise<string> {
	const response = await fetch(new URL("/auth/tokens", endpoint), {
		body: JSON.stringify({ duration: 600, grants, namespace: "default" }),
		headers: adminHeaders,
		method: "POST",
	});
	assert.equal(response.status, 200, await response.clone().text());
	return ((await response.json()) as { token: string }).token;
}

async function sleepActor(dev: RunningOrangeDev, endpoint: string, id: string): Promise<void> {
	const slept = dev.actorSlept(id);
	const url = new URL(`/actors/${id}/sleep`, endpoint);
	url.searchParams.set("namespace", "default");
	const response = await fetch(url, { body: "{}", headers: adminHeaders, method: "POST" });
	assert.equal(response.status, 200, await response.text());
	await slept;
}

async function assertGatewayRejected(response: Response): Promise<void> {
	const body = await response.text();
	assert.ok(response.status === 401 || response.status === 403, `${response.status} ${body}`);
	assert.match(response.headers.get("x-rivet-error") ?? body, /^auth\.|"group":"auth"/, body);
}

function assertNoCredential(headers: [string, string][]): void {
	for (const [name, value] of headers) {
		assert.notEqual(name.toLowerCase(), "x-rivet-token", "the object saw the gateway credential");
		assert.doesNotMatch(value, /rivet_token\./, "the object saw the gateway credential");
	}
}

test(
	"Rivet's gateway decides who calls Orange actors, so other Rivet clients in the project can too",
	{ timeout: 240_000 },
	async (t) => {
		const project = await copyProject(join(repositoryRoot, "tests", "fixtures", "gateway-auth"));
		const { deploymentIdentity } = await resolveDeploymentStorage({
			environment: undefined,
			projectRoot: project.directory,
			workerName,
		});
		const dev = await startOrangeDev(project.directory, "wrangler.jsonc", { actorLifecycleLogs: true });
		try {
			assert.deepEqual(await dev.json("/rpc"), { count: 1 });
			const sent = await fetch(`${dev.origin}/send`);
			assert.equal(sent.status, 200, `${await sent.text()}\n${dev.output()}`);
			const endpoint = await engineEndpoint(project.directory);
			const counterId = await actorId(endpoint, durableObjectActorName(deploymentIdentity, "Counter"));
			const queueId = await actorId(endpoint, queueActorName);
			const gatewayToken = await mintToken(endpoint, [
				{ operations: ["read"], resource: "actor_gateway", target: "any" },
			]);
			const noGatewayToken = await mintToken(endpoint, [
				{ operations: ["read"], resource: "actor", target: "any" },
			]);
			const doFetchUrl = (): URL => {
				const url = new URL(`/gateway/${counterId}/request/__open-orange/durable-object/fetch`, endpoint);
				url.searchParams.set("url", "http://direct/");
				url.searchParams.set("order", "direct");
				url.searchParams.set("sequence", "0");
				return url;
			};
			const head = Buffer.from(JSON.stringify({ body: false, headers: [], method: "GET" })).toString("base64");
			const enqueue = (token: string | undefined): Promise<Response> =>
				fetch(new URL(`/gateway/${queueId}/action/enqueue`, endpoint), {
					body: JSON.stringify({
						args: [
							[
								{
									delayMs: 0,
									envelope: {
										attempts: 0,
										body: "direct",
										contentType: "text",
										id: "direct",
										timestamp: Date.now(),
									},
								},
							],
						],
					}),
					headers: {
						"content-type": "application/json",
						"x-rivet-encoding": "json",
						...(token === undefined ? {} : { "x-rivet-token": token }),
					},
					method: "POST",
				});

			await t.test("a call without a token never reaches a Durable Object", async () => {
				await assertGatewayRejected(
					await fetch(doFetchUrl(), { headers: { "x-open-orange-internal-durable-object-request": head } }),
				);
				assert.deepEqual(await dev.json("/read"), { count: 1 });
			});

			await t.test("a token without an actor_gateway grant never reaches a Durable Object", async () => {
				await assertGatewayRejected(
					await fetch(doFetchUrl(), {
						headers: {
							"x-open-orange-internal-durable-object-request": head,
							"x-rivet-token": noGatewayToken,
						},
					}),
				);
				await assertGatewayRejected(await enqueue(noGatewayToken));
				assert.deepEqual(await dev.json("/read"), { count: 1 });
				assert.equal(((await dev.json("/backlog")) as { backlogCount: number }).backlogCount, 1);
			});

			await t.test("a token with an actor_gateway grant reaches a Durable Object and an internal Queue actor", async () => {
				const fetched = await fetch(doFetchUrl(), {
					headers: {
						"x-open-orange-internal-durable-object-request": head,
						"x-rivet-token": gatewayToken,
					},
				});
				assert.equal(fetched.status, 200, await fetched.clone().text());
				assert.equal(((await fetched.json()) as { count: number }).count, 2);
				assert.deepEqual(await dev.json("/read"), { count: 2 });
				const metrics = await fetch(new URL(`/gateway/${queueId}/action/metrics`, endpoint), {
					body: JSON.stringify({ args: [] }),
					headers: {
						"content-type": "application/json",
						"x-rivet-encoding": "json",
						"x-rivet-token": gatewayToken,
					},
					method: "POST",
				});
				const body = await metrics.text();
				assert.equal(metrics.ok, true, body);
				assert.equal((JSON.parse(body) as { output: { backlogCount: number } }).output.backlogCount, 1, body);
			});

			await t.test("the Worker reaches its object over fetch, RPC, and WebSocket, before and after it hibernates and sleeps", async () => {
				const assertWorkerCalls = async (): Promise<void> => {
					const fetched = (await dev.json("/fetch")) as {
						count: number;
						headers: [string, string][];
					};
					assertNoCredential(fetched.headers);
					const rpc = (await dev.json("/rpc")) as { count: number };
					assert.equal(rpc.count, fetched.count + 1);
					const socket = await openWebSocket(`${dev.origin}/ws`);
					socket.send("headers");
					socket.send("hello");
					const [headers, echo] = await collectMessages(socket, 2);
					assertNoCredential(JSON.parse(headers!) as [string, string][]);
					assert.equal(echo, "echo:hello");
					await closeWebSocket(socket);
				};
				await assertWorkerCalls();

				// With an accepted WebSocket open, the idle object drops its instance and its actor stays
				// awake. The socket stays open, and its next message builds a new instance.
				const held = await openWebSocket(`${dev.origin}/ws`);
				held.send("boot");
				const [before] = await collectMessages(held, 1);
				await delay(pastIdleTimeoutMs);
				held.send("boot");
				held.send("headers");
				held.send("after hibernation");
				const [after, headers, echo] = await withDeadline(collectMessages(held, 3), "replies after hibernation");
				assert.notEqual(after, before, "the idle object kept its instance");
				assertNoCredential(JSON.parse(headers!) as [string, string][]);
				assert.equal(echo, "echo:after hibernation");
				await closeWebSocket(held);

				await sleepActor(dev, endpoint, counterId);
				await assertWorkerCalls();
			});
		} finally {
			try {
				await dev.close();
			} finally {
				await project.dispose();
			}
		}
	},
);

// The expiry of a Rivet JWT, in Unix milliseconds. Rivet's tokens are standard JWTs.
function tokenExpiry(token: string): number {
	const claims = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString()) as { exp?: unknown };
	assert.equal(typeof claims.exp, "number", `not a JWT with an expiry: ${token.slice(0, 16)}…`);
	return (claims.exp as number) * 1_000;
}

test(
	"Orange calls each of its actors with a Rivet token for that actor only, and renews it",
	{ timeout: 300_000 },
	async (t) => {
		const engine = await startStandaloneEngine();
		const proxy = await startRecordingGatewayProxy(engine.endpoint);
		const project = await copyProject(join(repositoryRoot, "tests", "fixtures", "gateway-auth"));
		const port = await freePort();
		const origin = `http://127.0.0.1:${port}`;
		// Each token lasts 2 seconds, so the calls below run on many renewed tokens.
		const serve = await startServe(project.directory, proxy.endpoint, port, {
			ORANGE_ACTOR_TOKEN_DURATION_SECONDS: "2",
		});
		const gateway = new URL(engine.endpoint);
		gateway.username = "";
		gateway.password = "";
		const get = async (path: string): Promise<Response> => {
			const response = await fetch(`${origin}${path}`);
			assert.equal(response.status, 200, `${path}: ${await response.clone().text()}\n${serve.output()}`);
			return response;
		};
		const echo = async (name: string): Promise<void> => {
			const socket = await openWebSocket(`${origin}/ws?name=${name}`);
			socket.send(name);
			assert.deepEqual(await withDeadline(collectMessages(socket, 1), `the echo from ${name}`), [`echo:${name}`]);
			await closeWebSocket(socket);
		};
		// Whether a token gets a call past the gateway to the actor. The path is one that no actor serves,
		// so the call changes nothing.
		const reaches = async (token: string, actorId: string): Promise<boolean> => {
			const response = await fetch(new URL(`/gateway/${actorId}/request/__orange-test-unserved`, gateway), {
				headers: { "x-rivet-token": token },
			});
			const error = response.headers.get("x-rivet-error") ?? "";
			await response.body?.cancel();
			return !error.startsWith("auth.");
		};
		const assertScoped = async (calls: readonly GatewayCall[]): Promise<void> => {
			assert.ok(calls.length > 0, "no call reached the gateway");
			const actorIds = [...new Set(calls.map((call) => call.actorId))];
			const checked = new Set<string>();
			for (const call of calls) {
				assert.equal(call.tokens.length, 1, `a ${call.kind} call to ${call.actorId} carried ${call.tokens.length} tokens`);
				const [token] = call.tokens as [string];
				assert.notEqual(token, adminToken, `a ${call.kind} call to ${call.actorId} carried the Rivet admin token`);
				assert.ok(tokenExpiry(token) > call.at, `a ${call.kind} call to ${call.actorId} carried an expired token`);
				if (checked.has(token)) continue;
				checked.add(token);
				assert.equal(await reaches(token, call.actorId), true, `a token sent to ${call.actorId} does not reach it`);
				const other = actorIds.find((actorId) => actorId !== call.actorId);
				if (other !== undefined) {
					assert.equal(await reaches(token, other), false, `a token sent to ${call.actorId} also reaches ${other}`);
				}
			}
		};
		try {
			await t.test("concurrent calls to many objects each carry a token that reaches only their own object", async () => {
				const names = Array.from({ length: 12 }, (_, index) => `object-${index}`);
				await Promise.all([
					...names.flatMap((name) => [get(`/rpc?name=${name}`), get(`/fetch?name=${name}`), echo(name)]),
					get("/send"),
					get("/backlog"),
				]);
				const calls = proxy.calls.splice(0);
				assert.ok(new Set(calls.map((call) => call.actorId)).size >= names.length + 1, JSON.stringify(calls.map((call) => call.actorId)));
				assert.ok(calls.some((call) => call.kind === "websocket"), "no WebSocket reached the gateway");
				await assertScoped(calls);
			});

			await t.test("a call waits out a brief outage of Rivet's token signing", async () => {
				proxy.failTokenIssuance = "unavailable";
				const call = fetch(`${origin}/try-rpc?name=outage`);
				// Long enough for several refused attempts, well inside the time a call waits for one.
				await delay(1_500);
				proxy.failTokenIssuance = undefined;
				const response = await call;
				assert.equal(response.status, 200, `${await response.clone().text()}\n${serve.output()}`);
				assert.deepEqual(await response.json(), { count: 1 });
			});

			await t.test("a call fails at once with a clear error while Rivet issues no tokens, and works once it does", async () => {
				proxy.failTokenIssuance = "disabled";
				try {
					const failed = await fetch(`${origin}/try-rpc?name=never-called`);
					assert.equal(failed.status, 502, serve.output());
					const { error } = (await failed.json()) as { error: string };
					assert.match(error, /^ActorTokenError: OpenOrange could not get a Rivet token to call actor \S+: JWT issuance is not enabled/);
				} finally {
					proxy.failTokenIssuance = undefined;
				}
				assert.deepEqual(await (await get("/rpc?name=never-called")).json(), { count: 1 });
				proxy.calls.splice(0);
			});

			await t.test("a call that reaches an object while its actor stops goes out again and runs once", async () => {
				assert.deepEqual(await (await get("/rpc?name=stopping")).json(), { count: 1 });
				// Rivet's answer when a call reaches an actor that is stopping. Nothing ran the call.
				const answered = proxy.answerNextWith({
					error: { code: "stopping", group: "actor", message: "An internal error occurred" },
					method: "GET",
					path: /^\/gateway\/[^/]+\/request\/__open-orange\/durable-object\/fetch/,
					status: 500,
				});
				const fetched = (await (await get("/fetch?name=stopping")).json()) as { count: number };
				await withDeadline(answered, "the stopping answer");
				assert.equal(fetched.count, 2);
				assert.deepEqual(await (await get("/read?name=stopping")).json(), { count: 2 });
				proxy.calls.splice(0);
			});

			await t.test("a call waits for an object whose actor the Engine is still creating", async () => {
				// The Engine creates the actor, and answers as when it stopped waiting for the creation.
				const answered = proxy.answerNextWith({
					afterEngine: true,
					error: {
						code: "create_pending",
						group: "actor",
						message: "Actor creation may still be in progress; do not retry creation automatically.",
					},
					method: "PUT",
					path: /^\/actors(\?|$)/,
					status: 503,
				});
				assert.deepEqual(await (await get("/rpc?name=pending")).json(), { count: 1 });
				await withDeadline(answered, "the create_pending answer");
				assert.deepEqual(await (await get("/read?name=pending")).json(), { count: 1 });
				proxy.calls.splice(0);
			});

			await t.test("calls work after tokens expire, and an open WebSocket outlives its token", async () => {
				const held = await openWebSocket(`${origin}/ws?name=held`);
				held.send("boot");
				const [before] = await withDeadline(collectMessages(held, 1), "the first reply");
				// Rivet's gateway accepts a token for 60 seconds past its expiry. After this wait, every
				// token minted before it is rejected, and the held socket's idle object has hibernated.
				await delay(65_000);
				proxy.calls.splice(0);
				held.send("boot");
				held.send("after expiry");
				const [after, reply] = await withDeadline(collectMessages(held, 2), "replies after expiry");
				assert.notEqual(after, before, "the idle object kept its instance");
				assert.equal(reply, "echo:after expiry");
				await get("/rpc?name=held");
				await get("/fetch?name=held");
				await echo("held");
				await get("/backlog");
				await closeWebSocket(held);
				await assertScoped(proxy.calls.splice(0));
			});
		} finally {
			try {
				const exit = exited(serve.child);
				serve.child.kill("SIGTERM");
				await withDeadline(exit, "orange serve stop", 15_000).catch(() => serve.child.kill("SIGKILL"));
			} finally {
				await project.dispose();
				await proxy.close();
				await engine.stop();
			}
		}
	},
);
