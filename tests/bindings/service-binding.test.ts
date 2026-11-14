import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const cliEntrypoint = fileURLToPath(new URL("../../src/bin.ts", import.meta.url));
const configPath = fileURLToPath(
	new URL("../fixtures/service-binding/wrangler.jsonc", import.meta.url),
);

function waitForReady(child: ChildProcess): Promise<number> {
	return new Promise((resolveReady, rejectReady) => {
		let output = "";
		const timeout = setTimeout(() => {
			rejectReady(new Error(`orange dev readiness timed out: ${output}`));
		}, 30_000);
		const onData = (chunk: unknown): void => {
			output += String(chunk);
			const match = /Local\s+http:\/\/127\.0\.0\.1:(\d+)/.exec(output);
			if (match?.[1] !== undefined) {
				clearTimeout(timeout);
				resolveReady(Number(match[1]));
			}
		};
		child.stdout?.on("data", onData);
		child.stderr?.on("data", onData);
		child.once("exit", (code) => {
			clearTimeout(timeout);
			rejectReady(new Error(`orange dev exited before readiness (code ${code}): ${output}`));
		});
	});
}

function stop(child: ChildProcess): Promise<void> {
	return new Promise((resolveStop) => {
		if (child.exitCode !== null || child.signalCode !== null) {
			resolveStop();
			return;
		}
		const timeout = setTimeout(() => child.kill("SIGKILL"), 10_000);
		child.once("exit", () => {
			clearTimeout(timeout);
			resolveStop();
		});
		child.kill("SIGINT");
	});
}

test("calls a named entrypoint over a self service binding with workerd RPC semantics", async () => {
	const child = spawn(
		process.execPath,
		[
			"--import",
			"tsx",
			cliEntrypoint,
			"dev",
			"--config",
			configPath,
			"--port",
			"0",
			"--ip",
			"127.0.0.1",
			"--show-interactive-dev-session=false",
		],
		{ env: { ...process.env, CI: "1", NO_COLOR: "1" }, stdio: ["ignore", "pipe", "pipe"] },
	);
	try {
		const port = await waitForReady(child);
		const response = await fetch(`http://127.0.0.1:${port}/`);
		assert.equal(response.status, 200);
		assert.deepEqual(await response.json(), {
			// A disposed stub fails instead of reaching the target.
			afterDispose: "RPC stub used after being disposed.",
			aggregateFailure: { message: "every calculation failed", name: "AggregateError" },
			// The callee mutates its own clone of the argument.
			calleeSize: 2,
			callerSize: 1,
			// A thrown error keeps its type and own properties and is marked remote.
			failure: { code: 7, message: "calculator failed", name: "TypeError", remote: true },
			// Overlapping calls each get a new entrypoint instance.
			overlapping: [1, 1],
			pipelined: 7,
		});
	} finally {
		await stop(child);
	}
});
