import assert from "node:assert/strict";
import { cp, mkdtemp, rm, writeFile, glob, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { durableObjectActorName } from "../../packages/runtime-node/src/bindings/durable-objects/actor-routing.js";
import { createDurableObjectIdScope } from "../../packages/runtime-node/src/bindings/durable-objects/id.js";
import { durableObjectNamespaceKey } from "../../packages/runtime-node/src/bindings/durable-objects/namespace.js";
import {
	workflowEngineClassName,
	workflowEngineObjectName,
} from "../../packages/runtime-node/src/bindings/workflows/engine-object.js";
import {
	isRecord,
	startOrangeDev,
	stopProjectEngines,
	type RunningOrangeDev,
	waitFor,
} from "../../tests/orange-dev.js";
import { resolveDeploymentStorage } from "./deployment.js";

// Drives Workflow bindings through a real `orange dev` process, Wrangler configuration, and
// Rivet Engine. The fixture runs a script of steps from its params and counts each step body
// in KV. The expected values match what the same fixture shows under `wrangler dev`, except
// that errors keep their names, as workerd's RPC keeps them from compatibility date 2026-04-21.

const fixtureWorker = fileURLToPath(new URL("./fixtures/workflows/worker.js", import.meta.url));
const workerName = "workflows-e2e";

const wranglerConfiguration = {
	compatibility_date: "2026-09-03",
	kv_namespaces: [{ binding: "KV", id: "workflow-state" }],
	main: "./worker.js",
	name: workerName,
	workflows: [
		{ binding: "SCRIPT", class_name: "ScriptWorkflow", name: "script" },
		{ binding: "OTHER", class_name: "ScriptWorkflow", name: "other" },
	],
};

// The local Engine's admin token. Only the test uses it, to find and sleep engine actors.
const adminHeaders = { authorization: "Bearer default", "content-type": "application/json" };

type Op = Record<string, unknown>;

interface Status {
	error?: { message: string; name: string };
	output: unknown;
	status: string;
}

const terminal = (status: string): boolean =>
	status === "complete" || status === "errored" || status === "terminated";

describe("Workflow bindings through orange dev", () => {
	let projectRoot: string;
	let server: RunningOrangeDev;
	let engineActorName: string;
	let deploymentIdentity: string;

	async function call(path: string, body?: unknown): Promise<unknown> {
		const response = await fetch(`${server.origin}${path}`, {
			...(body === undefined ? {} : { body: JSON.stringify(body), method: "POST" }),
		});
		const text = await response.text();
		assert.equal(response.status, 200, `${path}: ${text}\n${server.output()}`);
		return JSON.parse(text);
	}

	async function value(path: string, body?: unknown): Promise<unknown> {
		const result = await call(path, body);
		assert.ok(isRecord(result) && "value" in result, `${path}: ${JSON.stringify(result)}`);
		return result.value;
	}

	async function failure(path: string, body?: unknown): Promise<unknown> {
		const result = await call(path, body);
		assert.ok(isRecord(result) && "error" in result, `${path}: ${JSON.stringify(result)}`);
		return result.error;
	}

	async function create(id: string, ops: Op[], workflow = "SCRIPT"): Promise<void> {
		assert.equal(await value(`/create?workflow=${workflow}&id=${id}`, { ops }), id);
	}

	async function status(id: string): Promise<Status> {
		const result = await value(`/status?id=${id}`);
		assert.ok(isRecord(result) && typeof result.status === "string", JSON.stringify(result));
		const { error, output, status: name } = result;
		return {
			...(isRecord(error) ? { error: { message: String(error.message), name: String(error.name) } } : {}),
			output,
			status: name,
		};
	}

	// A Workflow instance has no push notification, so the caller polls status() the way an
	// application would.
	async function statusUntil(
		id: string,
		done: (status: string) => boolean,
		timeoutMs = 40_000,
	): Promise<Status> {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			const current = await status(id);
			if (done(current.status)) return current;
			assert.ok(Date.now() < deadline, `${id} stayed ${JSON.stringify(current)}`);
			await delay(150);
		}
	}

	async function count(id: string, step: string): Promise<number> {
		return Number(await value(`/count?id=${id}&step=${step}`));
	}

	async function openGate(id: string, gate = "g"): Promise<void> {
		await value(`/gate?id=${id}&gate=${gate}`);
	}

	// A gated step counts its body before it waits, so a count of 1 means the step is running.
	async function stepStarted(id: string, step: string): Promise<void> {
		await waitFor(`${id}/${step} to start`, async () => (await count(id, step)) !== 0, 20_000);
	}

	async function engineEndpoint(): Promise<string> {
		for await (const path of glob(".open-orange/rivetkit/*/.rivetkit/var/engine/runtime.json", {
			cwd: projectRoot,
		})) {
			const runtime: unknown = JSON.parse(await readFile(join(projectRoot, path), "utf8"));
			assert.ok(isRecord(runtime) && typeof runtime.endpoint === "string");
			return runtime.endpoint;
		}
		throw new Error("The project has no running Rivet Engine");
	}

	async function engineActorId(id: string, workflow = "script"): Promise<string> {
		const key = createDurableObjectIdScope({
			namespaceKey: durableObjectNamespaceKey(deploymentIdentity, workflowEngineClassName),
		})
			.idFromName(workflowEngineObjectName(workflow, id))
			.toString();
		const url = new URL("/actors", await engineEndpoint());
		url.searchParams.set("namespace", "default");
		url.searchParams.set("name", engineActorName);
		url.searchParams.set("key", key);
		const response = await fetch(url, { headers: adminHeaders });
		const body: unknown = await response.json();
		assert.ok(isRecord(body) && Array.isArray(body.actors) && body.actors.length === 1, JSON.stringify(body));
		const [actor] = body.actors;
		assert.ok(isRecord(actor) && typeof actor.actor_id === "string");
		return actor.actor_id;
	}

	// Forces the instance's engine actor to sleep through the Engine API, as an idle actor would,
	// and waits until the actor has stopped.
	async function sleepEngineActor(id: string): Promise<void> {
		const endpoint = await engineEndpoint();
		const actorId = await engineActorId(id);
		const url = new URL(`/actors/${actorId}/sleep`, endpoint);
		url.searchParams.set("namespace", "default");
		const stopped = server.actorSlept(actorId);
		const slept = await fetch(url, { body: "{}", headers: adminHeaders, method: "POST" });
		assert.equal(slept.status, 200, await slept.text());
		await stopped;
	}

	before(async () => {
		projectRoot = await mkdtemp(join(tmpdir(), "open-orange-workflows-"));
		await cp(fixtureWorker, join(projectRoot, "worker.js"));
		await writeFile(join(projectRoot, "wrangler.json"), JSON.stringify(wranglerConfiguration));
		({ deploymentIdentity } = await resolveDeploymentStorage({
			environment: undefined,
			projectRoot,
			workerName,
		}));
		engineActorName = durableObjectActorName(deploymentIdentity, workflowEngineClassName);
		server = await startOrangeDev(projectRoot, "wrangler.json", { actorLifecycleLogs: true });
	});

	after(async () => {
		try {
			await server?.close();
		} finally {
			await stopProjectEngines(projectRoot);
			await rm(projectRoot, { force: true, recursive: true });
		}
	});

	describe("instances", { concurrency: true }, () => {
		it("terminate stops a running instance before its next step, also after its actor sleeps", async () => {
			await create("term", [
				{ gate: "g", kind: "do", name: "a" },
				{ kind: "do", name: "b" },
			]);
			await stepStarted("term", "a");
			assert.equal(await value("/terminate?id=term"), null);
			assert.deepEqual(await status("term"), { output: null, status: "terminated" });
			await openGate("term");
			await sleepEngineActor("term");
			assert.deepEqual(await status("term"), { output: null, status: "terminated" });
			assert.equal(await count("term", "b"), 0);
			assert.deepEqual(await failure("/terminate?id=term"), {
				message: "(instance.cannot_terminate) Cannot terminate instance since its on a finite state",
				name: "WorkflowError",
			});
			// Pause, resume, and events are no-ops on a stopped instance, as in wrangler dev.
			assert.equal(await value("/pause?id=term"), null);
			assert.equal(await value("/resume?id=term"), null);
			assert.equal(await value("/event?id=term", { late: true }), null);
			assert.equal((await status("term")).status, "terminated");
		});

		it("pause holds a sleep past its deadline across actor sleep, and resume waits only the time left", async () => {
			await create("pause-sleep", [
				{ kind: "do", name: "before", returns: "now" },
				{ duration: "4 seconds", kind: "sleep", name: "nap" },
				{ kind: "do", name: "after", returns: "now" },
			]);
			await stepStarted("pause-sleep", "before");
			// No status marks the move into the sleep step; give the workflow time to enter it.
			await delay(1_000);
			assert.equal(await value("/pause?id=pause-sleep"), null);
			const pausedBy = Date.now();
			assert.equal((await statusUntil("pause-sleep", (s) => s === "paused")).status, "paused");
			await sleepEngineActor("pause-sleep");
			// Waits past the sleep's original deadline. The engine's alarm fires meanwhile.
			await delay(5_000);
			assert.equal((await status("pause-sleep")).status, "paused");
			assert.equal(await count("pause-sleep", "after"), 0);
			const resumedAt = Date.now();
			assert.equal(await value("/resume?id=pause-sleep"), null);
			const done = await statusUntil("pause-sleep", terminal);
			assert.equal(done.status, "complete", JSON.stringify(done));
			assert.ok(isRecord(done.output) && Array.isArray(done.output.results));
			const [before, , after] = done.output.results.map(Number);
			// The engine paused no later than pause() returned and resumed no earlier than resume()
			// was called, and it moves the sleep's deadline by the time in between.
			const pausedFor = resumedAt - pausedBy;
			assert.ok(
				after - before >= 4_000 + pausedFor,
				`slept ${after - before}ms with ${pausedFor}ms paused`,
			);
			assert.equal(await count("pause-sleep", "after"), 1);
		});

		it("pause waits for the running step, and resume before then cancels the pause", async () => {
			await create("pause-step", [
				{ gate: "g", kind: "do", name: "a" },
				{ kind: "do", name: "b" },
			]);
			await stepStarted("pause-step", "a");
			await value("/pause?id=pause-step");
			assert.equal((await status("pause-step")).status, "waitingForPause");
			await value("/resume?id=pause-step");
			assert.equal((await status("pause-step")).status, "running");
			await value("/pause?id=pause-step");
			await openGate("pause-step");
			assert.equal((await statusUntil("pause-step", (s) => s === "paused")).status, "paused");
			assert.equal(await count("pause-step", "b"), 0);
			await value("/resume?id=pause-step");
			assert.equal((await statusUntil("pause-step", terminal)).status, "complete");
			assert.deepEqual([await count("pause-step", "a"), await count("pause-step", "b")], [1, 1]);
		});

		it("restart reruns every step, or the steps from a given step", async () => {
			const steps = [
				{ kind: "do", name: "a" },
				{ kind: "do", name: "b" },
				{ kind: "do", name: "c" },
			];
			await create("restart", steps);
			assert.equal((await statusUntil("restart", terminal)).status, "complete");
			await value("/restart?id=restart", {});
			assert.equal((await statusUntil("restart", terminal)).status, "complete");
			const counts = async () =>
				[await count("restart", "a"), await count("restart", "b"), await count("restart", "c")];
			assert.deepEqual(await counts(), [2, 2, 2]);
			await value("/restart?id=restart", { from: { name: "b" } });
			assert.equal((await statusUntil("restart", terminal)).status, "complete");
			assert.deepEqual(await counts(), [2, 3, 3]);
			assert.deepEqual(await failure("/restart?id=restart", { from: { name: "zzz" } }), {
				message: '(instance.cannot_restart) Step "zzz" not found in execution history',
				name: "WorkflowError",
			});
			assert.deepEqual(await failure("/restart?id=restart", { from: { name: "a", type: "sleep" } }), {
				message: '(instance.cannot_restart) Step "a" not found in execution history',
				name: "WorkflowError",
			});
		});

		it("restart while a step runs starts the run again", async () => {
			await create("restart-running", [
				{ gate: "g", kind: "do", name: "a" },
				{ kind: "do", name: "b" },
			]);
			await stepStarted("restart-running", "a");
			await value("/restart?id=restart-running", {});
			await openGate("restart-running");
			assert.equal((await statusUntil("restart-running", terminal)).status, "complete");
			assert.deepEqual(
				[await count("restart-running", "a"), await count("restart-running", "b")],
				[2, 1],
			);
		});

		it("runs parallel steps at once, and a wait does not block the step that sends its event", async () => {
			// Step p1 waits for a gate that only step p2 opens, so the instance completes only if
			// both steps run at the same time.
			await create("parallel", [
				{
					kind: "all",
					ops: [
						{ gate: "g", kind: "do", name: "p1" },
						{ kind: "do", name: "p2", opens: "g" },
					],
				},
			]);
			assert.deepEqual(await statusUntil("parallel", terminal), {
				output: {
					instanceId: "parallel",
					results: [[{ attempt: 1, step: "p1" }, { attempt: 1, step: "p2" }]],
				},
				status: "complete",
			});
			await create("parallel-event", [
				{
					kind: "all",
					ops: [
						{ kind: "wait", name: "w", timeout: "10 seconds", type: "go" },
						{ binding: "SCRIPT", kind: "send", name: "s", payload: 7, type: "go" },
					],
				},
			]);
			assert.deepEqual(await statusUntil("parallel-event", terminal), {
				output: {
					instanceId: "parallel-event",
					results: [[{ payload: 7, timestampIsDate: true, type: "go" }, "sent"]],
				},
				status: "complete",
			});
		});

		it("delivers an event sent before its wait, and takes one over Cloudflare's 1 MiB without harm", async () => {
			await create("events", [
				{ duration: "2 seconds", kind: "sleep", name: "s" },
				{ kind: "wait", name: "w1", type: "a" },
				// The output keeps only the length of the large payload. A status() response of about
				// 1 MiB hits RivetKit's response-window abort under load (RIVETKIT_FRICTION.md).
				{ kind: "wait", measure: true, name: "w2", type: "a" },
			]);
			assert.equal(await value("/event?id=events&type=a", { early: true }), null);
			assert.equal(await value(`/event-bytes?id=events&type=a&bytes=${1024 * 1024}`), null);
			assert.equal(await value(`/event-bytes?id=events&type=a&bytes=${2 * 1024 * 1024}`), null);
			const done = await statusUntil("events", terminal);
			assert.equal(done.status, "complete", JSON.stringify(done.error));
			assert.ok(isRecord(done.output) && Array.isArray(done.output.results));
			const [, early, large] = done.output.results;
			assert.deepEqual(early, { payload: { early: true }, timestampIsDate: true, type: "a" });
			assert.deepEqual(large, { payloadLength: 1024 * 1024, type: "a" });
		});

		it("reports waiting while the run waits for an event", async () => {
			await create("wait-status", [{ kind: "wait", name: "w", timeout: "30 seconds", type: "go" }]);
			assert.equal((await statusUntil("wait-status", (s) => s === "waiting")).status, "waiting");
			await value("/event?id=wait-status&type=go", 1);
			assert.deepEqual(await statusUntil("wait-status", terminal), {
				output: { instanceId: "wait-status", results: [{ payload: 1, timestampIsDate: true, type: "go" }] },
				status: "complete",
			});
		});

		it("times out a wait with no event, and an event of another type does not end it", async () => {
			await create("wait-timeout", [{ kind: "wait", name: "w", timeout: "1 second", type: "never" }]);
			await value("/event?id=wait-timeout&type=other", 1);
			assert.deepEqual(await statusUntil("wait-timeout", terminal), {
				error: { message: "Execution timed out after 1000ms", name: "WorkflowTimeoutError" },
				output: null,
				status: "errored",
			});
		});

		it("keeps instances with the same step names apart", async () => {
			const steps = [
				{ gate: "g", kind: "do", name: "a" },
				{ kind: "do", name: "b" },
			];
			await Promise.all([create("iso-1", steps), create("iso-2", steps), create("iso-2", [], "OTHER")]);
			await Promise.all([stepStarted("iso-1", "a"), stepStarted("iso-2", "a")]);
			await value("/terminate?id=iso-1");
			await openGate("iso-2");
			await openGate("iso-1");
			assert.deepEqual(await statusUntil("iso-2", terminal), {
				output: {
					instanceId: "iso-2",
					results: [
						{ attempt: 1, step: "a" },
						{ attempt: 1, step: "b" },
					],
				},
				status: "complete",
			});
			assert.equal((await status("iso-1")).status, "terminated");
			assert.deepEqual([await count("iso-1", "b"), await count("iso-2", "b")], [0, 1]);
		});

		it("finishes a sleep from its alarm after the actor sleeps, with no requests", async () => {
			await create("alarm", [
				{ kind: "do", name: "before" },
				{ duration: "3 seconds", kind: "sleep", name: "nap" },
				{ kind: "do", name: "after" },
			]);
			// The sleep has its timer once the instance reports waiting.
			assert.equal((await statusUntil("alarm", (s) => s === "waiting")).status, "waiting");
			await sleepEngineActor("alarm");
			// Reads only the KV namespace, never the instance, so only the alarm can run the step.
			await stepStarted("alarm", "after");
			assert.equal(await count("alarm", "after"), 1);
			assert.equal((await status("alarm")).status, "complete");
		});

		it("runs a step again soon after its actor is stopped in the middle of it, with no requests", async () => {
			await create("cut-step", [
				{ gate: "g", kind: "do", name: "a" },
				{ kind: "do", name: "b" },
			]);
			await stepStarted("cut-step", "a");
			await sleepEngineActor("cut-step");
			await openGate("cut-step");
			// Reads only the KV namespace, never the instance, so only the engine's own alarm can
			// start the next generation. The step's timeout is 10 minutes away.
			await stepStarted("cut-step", "b");
			assert.deepEqual([await count("cut-step", "a"), await count("cut-step", "b")], [2, 1]);
			assert.equal((await statusUntil("cut-step", terminal)).status, "complete");
		});

		it("keeps the actor awake for a step that runs longer than its idle timeout", async () => {
			await create("long-step", [{ busyMs: 13_000, kind: "do", name: "long" }]);
			const done = await statusUntil("long-step", terminal, 60_000);
			assert.equal(done.status, "complete", JSON.stringify(done));
			assert.equal(await count("long-step", "long"), 1);
		});

		it("errors an instance on a failed step and reports the error with its name", async () => {
			await Promise.all([
				create("non-retryable", [
					{ config: { retries: { delay: 10, limit: 5 } }, kind: "do", name: "f", throws: { message: "stop", nonRetryable: true } },
				]),
				create("exhausted", [
					{
						config: { retries: { backoff: "constant", delay: 10, limit: 2 } },
						kind: "do",
						name: "f",
						throws: { message: "boom", name: "CustomError" },
					},
				]),
				create("past", [{ inMs: -5_000, kind: "sleepUntil", name: "s" }]),
				create("unserializable", [{ kind: "do", name: "fn", returns: "function" }, { kind: "do", name: "next" }]),
				// Cloudflare caps a step's output at 1 MiB. Orange's bound is Rivet's 128 MiB commit.
				create("large", [{ bytes: 2 * 1024 * 1024 + 1_000, kind: "do", name: "big", returns: "bytes" }]),
				create("too-large", [
					{ bytes: 128 * 1024 * 1024, config: { retries: { delay: 10, limit: 0 } }, kind: "do", name: "big", returns: "bytes" },
				]),
				create("step-timeout", [
					{ busyMs: 2_000, config: { retries: { delay: 10, limit: 0 }, timeout: 300 }, kind: "do", name: "slow" },
				]),
			]);
			// The compatibility date enables workflows_preserve_non_retryable_error_message.
			assert.deepEqual(await statusUntil("non-retryable", terminal), {
				error: { message: "stop", name: "NonRetryableError" },
				output: null,
				status: "errored",
			});
			assert.equal(await count("non-retryable", "f"), 1);
			assert.deepEqual(await statusUntil("exhausted", terminal), {
				error: { message: "boom", name: "CustomError" },
				output: null,
				status: "errored",
			});
			assert.equal(await count("exhausted", "f"), 3);
			assert.deepEqual(await statusUntil("past", terminal), {
				error: { message: "You can't sleep until a time in the past, time-traveler", name: "Error" },
				output: null,
				status: "errored",
			});
			assert.deepEqual(await statusUntil("unserializable", terminal), {
				error: {
					message:
						'The execution of the Workflow instance was terminated, as the step "fn" returned a value which is not serialisable',
					name: "WorkflowFatalError",
				},
				output: null,
				status: "errored",
			});
			assert.equal(await count("unserializable", "next"), 0);
			assert.equal((await statusUntil("large", terminal)).status, "complete");
			const tooLarge = await statusUntil("too-large", terminal);
			assert.equal(tooLarge.status, "errored");
			assert.equal(tooLarge.error?.name, "WorkflowInternalError");
			assert.match(
				String(tooLarge.error?.message),
				/^Step big-1 output is too large to store: A storage key and value together is \d+ bytes\. Rivet stores at most 134217728 bytes \(128 MiB\)/,
			);
			assert.deepEqual(await statusUntil("step-timeout", terminal), {
				error: { message: "Execution timed out after 300ms", name: "WorkflowTimeoutError" },
				output: null,
				status: "errored",
			});
		});

		it("deletes instances, reports missing ones, and lets a deleted ID be created again", async () => {
			await create("del", [{ gate: "g", kind: "do", name: "a" }]);
			await create("del-2", []);
			await stepStarted("del", "a");
			assert.equal(await value("/delete?id=del"), null);
			assert.deepEqual(await failure("/status?id=del"), { message: "instance.not_found", name: "Error" });
			assert.deepEqual(await value("/delete-batch", ["del-2", "del-missing", "del-2"]), {
				deleted: [{ id: "del-2" }, { id: "del-2" }],
				errors: [{ code: 10400, id: "del-missing", message: "workflows.api.error.instance.not_found" }],
			});
			assert.deepEqual(await failure("/status?id=del-2"), { message: "instance.not_found", name: "Error" });
			await create("del", [{ kind: "do", name: "again" }]);
			assert.deepEqual(await statusUntil("del", terminal), {
				output: { instanceId: "del", results: [{ attempt: 1, step: "again" }] },
				status: "complete",
			});
		});

		it("rejects duplicate and invalid IDs, also for concurrent creates", async () => {
			const results = await Promise.all(
				[1, 2, 3].map(() => call("/create?id=dup", { ops: [] })),
			);
			assert.equal(results.filter((result) => isRecord(result) && "value" in result).length, 1);
			assert.deepEqual(await failure("/create?id=dup", { ops: [] }), {
				message: '(instance.already_exists) Workflow instance with id "dup" already exists',
				name: "WorkflowError",
			});
			assert.deepEqual(await failure("/create?id=bad%20id", {}), {
				message: "Workflow instance has invalid id",
				name: "WorkflowError",
			});
			assert.deepEqual(await failure("/status?id=never-created"), {
				message: "instance.not_found",
				name: "Error",
			});
			assert.deepEqual(await value("/create-batch", { instances: [{ id: "batch-1" }, { id: "batch-1" }, { id: "dup" }] }), {
				created: ["batch-1"],
				errors: [
					{ code: 10415, id: "batch-1", index: 1, message: "workflows.api.error.instance.duplicate_in_batch" },
					{ code: 10405, id: "dup", index: 2, message: "workflows.api.error.instance.already_exists" },
				],
			});
		});
	});

	it("resumes a sleeping instance after orange dev restarts", async () => {
		await create("restart-dev", [
			{ kind: "do", name: "before", returns: "now" },
			{ duration: "8 seconds", kind: "sleep", name: "nap" },
			{ kind: "do", name: "after", returns: "now" },
		]);
		await stepStarted("restart-dev", "before");
		await server.close();
		server = await startOrangeDev(projectRoot, "wrangler.json", { actorLifecycleLogs: true });
		const done = await statusUntil("restart-dev", terminal);
		assert.equal(done.status, "complete", JSON.stringify(done));
		assert.ok(isRecord(done.output) && Array.isArray(done.output.results));
		const [before, , after] = done.output.results;
		assert.ok(Number(after) - Number(before) >= 8_000, `slept ${Number(after) - Number(before)}ms`);
		// Instances that finished before the restart keep their outcome.
		assert.equal((await status("restart")).status, "complete");
	});
});
