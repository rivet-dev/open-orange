import assert from "node:assert/strict";
import { glob, readFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

import { durableObjectActorName } from "../../packages/runtime-node/src/bindings/durable-objects/actor-routing.js";
import { queueActorName } from "../../packages/runtime-node/src/internal-actors/queue.js";

import { resolveDeploymentStorage } from "../../src/runtime/deployment.js";
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

async function workerJson(dev: RunningOrangeDev, path: string): Promise<unknown> {
	const response = await fetch(`${dev.origin}${path}`);
	assert.equal(response.status, 200, `${await response.clone().text()}\n${dev.output()}`);
	return response.json();
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
			assert.deepEqual(await workerJson(dev, "/rpc"), { count: 1 });
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
				assert.deepEqual(await workerJson(dev, "/read"), { count: 1 });
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
				assert.deepEqual(await workerJson(dev, "/read"), { count: 1 });
				assert.equal(((await workerJson(dev, "/backlog")) as { backlogCount: number }).backlogCount, 1);
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
				assert.deepEqual(await workerJson(dev, "/read"), { count: 2 });
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
					const fetched = (await workerJson(dev, "/fetch")) as {
						count: number;
						headers: [string, string][];
					};
					assertNoCredential(fetched.headers);
					const rpc = (await workerJson(dev, "/rpc")) as { count: number };
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
