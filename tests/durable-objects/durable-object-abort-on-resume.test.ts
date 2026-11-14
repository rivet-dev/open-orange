import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
	copyProject,
	repositoryRoot,
	startOrangeDev,
	stopProjectEngines,
	waitFor,
	type RunningOrangeDev,
} from "../harness/orange-dev.js";

const fixtureDirectory = join(repositoryRoot, "tests", "fixtures", "durable-object-abort-on-resume");

// A retried alarm runs again after 2 s plus up to 25% jitter.
const retryWindowMs = 4_000;

function listeningPort(server: Server): number {
	const address = server.address();
	assert.ok(address !== null && typeof address === "object", "the server is not listening on a port");
	return address.port;
}

test("an overdue alarm that resets its object with retryAlarm: false runs once when orange dev resumes, and the object keeps serving", async () => {
	const project = await copyProject(fixtureDirectory);
	const projectDirectory = project.directory;
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
	let orange: RunningOrangeDev | undefined;
	try {
		// The first run stores the object with a pending alarm, then stops before it is due.
		orange = await startOrangeDev(projectDirectory);
		const armed = await fetch(
			`${orange.origin}/arm?delay=1000&peer=${encodeURIComponent(peerOrigin)}`,
		);
		assert.equal(await armed.text(), "armed", orange.output());
		await orange.close();
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
		try {
			await orange?.close();
		} finally {
			peer.closeAllConnections();
			await new Promise((resolveClose) => peer.close(() => resolveClose(undefined)));
			await project.dispose();
		}
	}
});

test("ctx.abort() keeps the writes of turns that finished before it and discards the writes of its own turn", async () => {
	const project = await copyProject(fixtureDirectory);
	let orange: RunningOrangeDev | undefined;
	try {
		orange = await startOrangeDev(project.directory);
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
		try {
			await orange?.close();
		} finally {
			await project.dispose();
		}
	}
});
