import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { isRecord, stopProjectEngines, waitFor } from "../../tests/orange-dev.js";

const cliEntrypoint = fileURLToPath(new URL("../bin.ts", import.meta.url));
const fixtureDirectory = fileURLToPath(
	new URL("./fixtures/durable-object-abort-on-resume/", import.meta.url),
);

// A retried alarm runs again after 2 s plus up to 25% jitter.
const retryWindowMs = 4_000;

async function startOrangeDev(
	projectDirectory: string,
): Promise<{ child: ChildProcess; origin: string; output(): string }> {
	const child = spawn(
		process.execPath,
		[
			"--import",
			"tsx",
			cliEntrypoint,
			"dev",
			"--config",
			join(projectDirectory, "wrangler.jsonc"),
			"--port",
			"0",
			"--ip",
			"127.0.0.1",
			"--show-interactive-dev-session=false",
		],
		{
			env: { ...process.env, CI: "1", NO_COLOR: "1" },
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	let output = "";
	const ready = Promise.withResolvers<number>();
	const timeout = setTimeout(() => {
		ready.reject(new Error(`orange dev readiness timed out:\n${output}`));
	}, 30_000);
	const collect = (chunk: unknown): void => {
		output += String(chunk);
		const match = /Local\s+http:\/\/127\.0\.0\.1:(\d+)/.exec(output);
		if (match?.[1] !== undefined) ready.resolve(Number(match[1]));
	};
	child.stdout?.on("data", collect);
	child.stderr?.on("data", collect);
	child.once("exit", (code) => {
		ready.reject(new Error(`orange dev exited (code ${code}):\n${output}`));
	});
	try {
		const port = await ready.promise;
		return { child, origin: `http://127.0.0.1:${port}`, output: () => output };
	} catch (error: unknown) {
		child.kill("SIGKILL");
		throw error;
	} finally {
		clearTimeout(timeout);
	}
}

function stopOrangeDev(child: ChildProcess): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
	return new Promise((resolveStop) => {
		const timeout = setTimeout(() => child.kill("SIGKILL"), 10_000);
		child.once("exit", () => {
			clearTimeout(timeout);
			resolveStop();
		});
		child.kill("SIGINT");
	});
}

function listeningPort(server: Server): number {
	const address = server.address();
	assert.ok(address !== null && typeof address === "object", "the server is not listening on a port");
	return address.port;
}

test("an overdue alarm that resets its object with retryAlarm: false runs once when orange dev resumes, and the object keeps serving", async () => {
	const directory = await mkdtemp(join(tmpdir(), "open-orange-abort-on-resume-"));
	const projectDirectory = join(directory, "project");
	await cp(fixtureDirectory, projectDirectory, { recursive: true });
	const alarmRuns: number[] = [];
	const firstRun = Promise.withResolvers<void>();
	// The alarm is due 1 s after /arm. Under load it can fire before the first `orange dev` stops,
	// so until the restart the peer refuses it, and only a run after the restart can finish.
	let peerAcceptsAlarm = false;
	const peer = createServer((request, response) => {
		if (request.url === "/alarm") {
			if (!peerAcceptsAlarm) {
				response.statusCode = 503;
				response.end("not yet");
				return;
			}
			alarmRuns.push(Date.now());
			firstRun.resolve();
		}
		response.end("ok");
	});
	await new Promise<void>((resolveListen) => peer.listen(0, "127.0.0.1", resolveListen));
	const peerOrigin = `http://127.0.0.1:${listeningPort(peer)}`;
	let orange: Awaited<ReturnType<typeof startOrangeDev>> | undefined;
	try {
		// The first run stores the object with a pending alarm, then stops before it is due.
		orange = await startOrangeDev(projectDirectory);
		const armed = await fetch(
			`${orange.origin}/arm?delay=1000&peer=${encodeURIComponent(peerOrigin)}`,
		);
		assert.equal(await armed.text(), "armed", orange.output());
		await stopOrangeDev(orange.child);
		await stopProjectEngines(projectDirectory);
		orange = undefined;
		assert.deepEqual(alarmRuns, []);

		peerAcceptsAlarm = true;
		orange = await startOrangeDev(projectDirectory);
		await Promise.race([
			firstRun.promise,
			delay(20_000).then(() => {
				throw new Error("the overdue alarm did not run");
			}),
		]);
		await delay(retryWindowMs);

		const response = await fetch(`${orange.origin}/read`);
		assert.equal(response.status, 200, orange.output());
		assert.deepEqual(await response.json(), { alarm: null });
		assert.equal(alarmRuns.length, 1, orange.output());
	} finally {
		if (orange !== undefined) await stopOrangeDev(orange.child);
		await stopProjectEngines(projectDirectory);
		peer.closeAllConnections();
		await new Promise((resolveClose) => peer.close(() => resolveClose(undefined)));
		await rm(directory, { force: true, recursive: true });
	}
});

test("ctx.abort() keeps the writes of turns that finished before it and discards the writes of its own turn", async () => {
	const directory = await mkdtemp(join(tmpdir(), "open-orange-abort-durable-"));
	const projectDirectory = join(directory, "project");
	await cp(fixtureDirectory, projectDirectory, { recursive: true });
	let orange: Awaited<ReturnType<typeof startOrangeDev>> | undefined;
	try {
		orange = await startOrangeDev(projectDirectory);
		const origin = orange.origin;
		const keys = async (name: string): Promise<unknown> =>
			(await fetch(`${origin}/keys?name=${name}`)).json();

		// Agent.destroy() wipes storage in one turn and aborts from a later timer.
		await fetch(`${origin}/put?name=agent&key=a`);
		await fetch(`${origin}/put?name=agent&key=b`);
		await (await fetch(`${origin}/destroy?name=agent`)).arrayBuffer();
		// The abort runs on a later timer and gives no signal; let it fire before reading.
		await delay(500);
		assert.deepEqual(await keys("agent"), [], orange.output());

		// The same wipe from an alarm, with SQL tables as the Agents SDK keeps them.
		let alarmReachedPeer = false;
		const peer = createServer((_request, response) => {
			alarmReachedPeer = true;
			response.end("ok");
		});
		await new Promise<void>((resolveListen) => peer.listen(0, "127.0.0.1", resolveListen));
		const peerOrigin = `http://127.0.0.1:${listeningPort(peer)}`;
		try {
			await fetch(`${origin}/sql?name=alarmed`);
			await fetch(`${origin}/put?name=alarmed&key=a`);
			await fetch(`${origin}/arm?name=alarmed&delay=200&peer=${encodeURIComponent(peerOrigin)}`);
			await waitFor("the alarm to reach the peer", () => alarmReachedPeer);
			// The alarm wipes storage after the peer answers, then aborts on a later timer.
			await delay(500);
			assert.deepEqual(await keys("alarmed"), [], orange.output());
			const tables = await (await fetch(`${origin}/tables?name=alarmed`)).json();
			assert.deepEqual(tables, [], orange.output());
		} finally {
			peer.closeAllConnections();
			await new Promise((resolveClose) => peer.close(() => resolveClose(undefined)));
		}

		// A write in the same turn as abort() is discarded with the turn.
		await fetch(`${origin}/put?name=same-turn&key=kept`);
		const aborted = await fetch(`${origin}/put-and-abort?name=same-turn&key=lost`);
		assert.equal(aborted.status, 500, orange.output());
		await aborted.arrayBuffer();
		assert.deepEqual(await keys("same-turn"), ["kept"], orange.output());
	} finally {
		if (orange !== undefined) await stopOrangeDev(orange.child);
		await stopProjectEngines(projectDirectory);
		await rm(directory, { force: true, recursive: true });
	}
});
