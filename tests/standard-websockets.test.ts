import assert from "node:assert/strict";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

import {
	collectMessages,
	copyProject,
	openWebSocket,
	repositoryRoot,
	startOrangeDev,
	waitFor,
	withDeadline,
	type ClientWebSocket,
	type RunningOrangeDev,
} from "./orange-dev.js";

// Past Orange's 10 second idle timer, with a margin.
const pastSleepTimeoutMs = 16_000;
const slept = "old=SleepFinalize new=Terminated";

async function withDev(run: (dev: RunningOrangeDev) => Promise<void>): Promise<void> {
	const project = await copyProject(join(repositoryRoot, "tests", "fixtures", "standard-websockets"));
	try {
		const dev = await startOrangeDev(project.directory, "wrangler.jsonc", { actorLifecycleLogs: true });
		try {
			await run(dev);
		} finally {
			await dev.close();
		}
	} finally {
		await project.dispose();
	}
}

async function get(dev: RunningOrangeDev, path: string): Promise<string> {
	return await (await fetch(`${dev.origin}${path}`)).text();
}

function closeOf(socket: ClientWebSocket): Promise<number> {
	return new Promise((resolve) => {
		socket.once("close", (code: unknown) => resolve(Number(code)));
	});
}

// Waits until each room has had time to sleep, then asks each one. Asking wakes a room that slept.
async function assertSlept(dev: RunningOrangeDev, rooms: Readonly<Record<string, string>>): Promise<void> {
	await waitFor("each room to sleep", () => dev.output().split(slept).length - 1 >= Object.keys(rooms).length, 60_000);
	for (const [room, boot] of Object.entries(rooms)) {
		assert.notEqual(await get(dev, `/boot?room=${room}`), boot, `room ${room} did not sleep`);
	}
}

test("an object sleeps after it closes its last standard WebSocket, in a request or in alarm()", { timeout: 150_000 }, async () => {
	await withDev(async (dev) => {
		const rooms = {
			fetch: await get(dev, "/boot?room=fetch"),
			alarm: await get(dev, "/boot?room=alarm"),
		};
		const inFetch = await openWebSocket(`${dev.origin}/s?room=fetch&name=first`);
		const inAlarm = await openWebSocket(`${dev.origin}/s?room=alarm&name=first`);
		// As in cloudflare/meet: the alarm drops one user, and the other client leaves by itself.
		const other = await openWebSocket(`${dev.origin}/s?room=alarm&name=second`);
		const closes = [closeOf(inFetch), closeOf(inAlarm), closeOf(other)];

		await get(dev, "/close?room=fetch");
		await get(dev, "/close-in-alarm?room=alarm");
		assert.equal(await withDeadline(closes[0]!, "the close in a request"), 1000);
		assert.equal(await withDeadline(closes[1]!, "the close in alarm()"), 1011);
		other.close(1000);
		await withDeadline(closes[2]!, "the other client's close");

		await assertSlept(dev, rooms);
	});
});

test("an object sleeps after a client vanishes without a close frame, on either kind of WebSocket", { timeout: 150_000 }, async () => {
	await withDev(async (dev) => {
		const rooms = {
			standard: await get(dev, "/boot?room=standard"),
			accepted: await get(dev, "/boot?room=accepted"),
		};
		(await openWebSocket(`${dev.origin}/s?room=standard&name=first`)).terminate();
		(await openWebSocket(`${dev.origin}/s?room=accepted&accepted=1`)).terminate();

		await assertSlept(dev, rooms);
	});
});

test("an open standard WebSocket keeps its object awake past the idle timer, beside a room that sleeps", { timeout: 120_000 }, async () => {
	await withDev(async (dev) => {
		const boot = await get(dev, "/boot?room=open");
		const socket = await openWebSocket(`${dev.origin}/s?room=open&name=first`);
		const asleep = { closing: await get(dev, "/boot?room=closing") };
		const closing = await openWebSocket(`${dev.origin}/s?room=closing&name=first`);
		const closed = closeOf(closing);
		await get(dev, "/close?room=closing");
		await withDeadline(closed, "the other room's close");

		await delay(pastSleepTimeoutMs);
		await assertSlept(dev, asleep);

		const reply = collectMessages(socket, 1);
		socket.send("still here");
		assert.deepEqual(await withDeadline(reply, "the reply"), [`${boot}:still here`]);
	});
});
