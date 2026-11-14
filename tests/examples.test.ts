import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import {
	type RunningOrangeDev,
	assertResponse,
	closeWebSocket,
	collectMessages,
	copyProject,
	isRecord,
	openWebSocket,
	repositoryRoot,
	startOrangeDev,
	withDeadline,
} from "./orange-dev.js";
import {
	type ExampleManifest,
	validateExampleManifests,
} from "./validate-example-manifests.js";

interface ExampleScenario {
	exercise(example: RunningOrangeDev): Promise<void>;
	expectedFailure?: RegExp;
}

async function startExample(manifest: ExampleManifest): Promise<RunningOrangeDev> {
	const sourceDirectory = resolve(
		repositoryRoot,
		dirname(manifest.wranglerConfig),
	);
	const project = await copyProject(sourceDirectory);
	try {
		const sourceRelative = relative(
			sourceDirectory,
			resolve(repositoryRoot, manifest.source),
		);
		assert.deepEqual(
			await readFile(join(project.directory, sourceRelative)),
			await readFile(resolve(repositoryRoot, manifest.source)),
			`${manifest.id} source changed while copying the fixture`,
		);
		const dev = await startOrangeDev(
			project.directory,
			basename(manifest.wranglerConfig),
		);
		return {
			...dev,
			async close(): Promise<void> {
				try {
					await dev.close();
				} finally {
					await project.dispose();
				}
			},
		};
	} catch (error) {
		await project.dispose();
		throw error;
	}
}

const scenarios: Record<string, ExampleScenario> = {
	"durable-object-alarm-batcher": {
		async exercise(example) {
			const response = await fetch(example.origin, {
				body: "first",
				method: "POST",
			});
			await assertResponse(response, 200, '{"queued":1}', example.output());
		},
	},
	"durable-object-fetch-stream": {
		async exercise(example) {
			const response = await withDeadline(
				fetch(example.origin),
				"fetch-stream response",
			);
			assert.equal(response.status, 200, example.output());
			assert.deepEqual(await response.json(), ["0", "1", "2", "3", "4", "5"]);
		},
	},
	"durable-object-rpc-counter": {
		async exercise(example) {
			await assertResponse(
				await fetch(`${example.origin}/increment?name=corpus`),
				200,
				"Durable Object 'corpus' count: 1",
				example.output(),
			);
			await assertResponse(
				await fetch(`${example.origin}/?name=corpus`),
				200,
				"Durable Object 'corpus' count: 1",
				example.output(),
			);
		},
	},
	"durable-object-rpc-stream": {
		async exercise(example) {
			const response = await withDeadline(
				fetch(`${example.origin}/rpc`, { method: "POST" }),
				"RPC stream response",
			);
			assert.equal(response.status, 200, example.output());
			assert.ok(response.body);
			const reader = response.body.getReader();
			const values: string[] = [];
			for (let index = 0; index < 3; index++) {
				const result = await withDeadline(reader.read(), "RPC stream chunk");
				assert.equal(result.done, false);
				values.push(new TextDecoder().decode(result.value));
			}
			await reader.cancel("corpus complete");
			assert.deepEqual(values, ["0", "1", "2"]);
		},
	},
	"durable-object-sqlite-counter": {
		async exercise(example) {
			for (const count of [1, 2]) {
				const response = await fetch(`${example.origin}/?id=corpus`, {
					method: "POST",
				});
				assert.equal(response.status, 200, example.output());
				assert.deepEqual(await response.json(), { count });
			}
			const response = await fetch(`${example.origin}/?id=corpus`);
			assert.deepEqual(await response.json(), { count: 2 });
		},
	},
	"durable-object-websocket-hibernation-server": {
		async exercise(example) {
			const socket = await openWebSocket(`${example.origin}/websocket`);
			try {
				const automatic = collectMessages(socket, 1);
				socket.send("ping");
				assert.deepEqual(await withDeadline(automatic, "automatic response"), [
					"pong",
				]);
				// Stay idle past the 10-second window so the object hibernates.
				await delay(11_000);
				const messages = collectMessages(socket, 2);
				socket.send("hello");
				const received = await withDeadline(
					messages,
					"hibernated response",
				).catch((error: unknown) => {
					throw new Error(
						`Hibernation example failed:\n${example.output()}`,
						{ cause: error },
					);
				});
				assert.equal(received.length, 2);
				assert.ok(received.every((message) => message.includes("message: hello")));
			} finally {
				await closeWebSocket(socket);
			}
		},
	},
	"durable-object-websocket-server": {
		async exercise(example) {
			const socket = await openWebSocket(`${example.origin}/websocket`);
			try {
				const messages = collectMessages(socket, 2);
				socket.send("hello");
				const received = await withDeadline(messages, "WebSocket responses");
				assert.ok(received.some((message) => message.includes("to: the initiating client")));
				assert.ok(received.some((message) => message.includes("to: all clients.")));
			} finally {
				await closeWebSocket(socket);
			}
		},
	},
	"workflows-starter": {
		async exercise(example) {
			const started = await fetch(`${example.origin}/api/workflow/start`, {
				method: "POST",
			});
			assert.equal(started.status, 200, example.output());
			const body: unknown = await started.json();
			assert.ok(isRecord(body) && typeof body.instanceId === "string", JSON.stringify(body));
			const instanceId = body.instanceId;
			// A Workflow instance has no push notification, so the caller polls its status.
			const statusUntil = async (expected: string): Promise<unknown> => {
				const deadline = Date.now() + 20_000;
				for (;;) {
					const response = await fetch(
						`${example.origin}/api/workflow/status/${instanceId}`,
					);
					assert.equal(response.status, 200, example.output());
					const status: unknown = await response.json();
					if (isRecord(status) && status.status === expected) return status;
					assert.ok(
						Date.now() < deadline,
						`Workflow stayed ${JSON.stringify(status)}:\n${example.output()}`,
					);
					await delay(200);
				}
			};
			await statusUntil("waiting");
			const event = await fetch(`${example.origin}/api/workflow/event/${instanceId}`, {
				body: JSON.stringify({ approved: true }),
				method: "POST",
			});
			await assertResponse(
				event,
				200,
				'{"success":true,"message":"Event sent successfully"}',
				example.output(),
			);
			// The Workflow returns undefined, so its output is null.
			assert.deepEqual(await statusUntil("complete"), { output: null, status: "complete" });
		},
	},
};

test(
	"runs the immutable upstream example corpus through orange dev",
	{ timeout: 180_000 },
	async (context) => {
		const validation = await validateExampleManifests(repositoryRoot);
		assert.deepEqual(validation.errors, []);
		assert.deepEqual(
			validation.manifests.map(({ id }) => id),
			Object.keys(scenarios).sort(),
			"Every manifest must have exactly one explicit scenario",
		);

		for (const manifest of validation.manifests) {
			await context.test(manifest.id, async () => {
				const scenario = scenarios[manifest.id];
				assert.ok(scenario);
				assert.equal(
					manifest.expectation === "known-broken",
					scenario.expectedFailure !== undefined,
					"Manifest and scenario failure expectations must agree",
				);
				const example = await startExample(manifest);
				let failure: unknown;
				try {
					await scenario.exercise(example);
				} catch (error) {
					failure = error;
				} finally {
					await example.close();
				}

				if (scenario.expectedFailure === undefined) {
					if (failure !== undefined) throw failure;
					return;
				}
				assert.ok(failure, "Known-broken example unexpectedly passed");
				assert.match(
					`${failure instanceof Error ? failure.stack : String(failure)}\n${example.output()}`,
					scenario.expectedFailure,
				);
			});
		}
	},
);
