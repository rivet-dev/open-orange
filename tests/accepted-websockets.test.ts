import assert from "node:assert/strict";
import { createServer } from "node:http";
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
	type TemporaryProject,
} from "./orange-dev.js";

const slept = "old=SleepFinalize new=Terminated";
const hibernated = "event=hibernated";
// Past Orange's 10 second sleep timeout, with a margin.
const pastSleepTimeoutMs = 16_000;

interface Reply {
	attachment: string;
	autoResponseAt: number | null;
	boot: string;
	bornAt: number;
	constructedWith: number;
	count: number;
	everyone: number;
	fetchDoneBy: string | null;
	message: string;
	messages: number;
	sameName: number;
	tags: string[];
	timerFiredBy: string | null;
}

function socketUrl(dev: RunningOrangeDev, room: string, name: string): string {
	return `${dev.origin}/socket?room=${room}&name=${name}`;
}

async function ask(socket: ClientWebSocket, message: string): Promise<Reply> {
	const replies = collectMessages(socket, 1);
	socket.send(message);
	const [reply] = await withDeadline(replies, `reply to ${message}`);
	return JSON.parse(String(reply)) as Reply;
}

function sleeps(dev: RunningOrangeDev): number {
	return dev.output().split(slept).length - 1;
}

async function waitForSleep(dev: RunningOrangeDev, before: number): Promise<void> {
	await waitFor("the object to sleep", () => sleeps(dev) > before, 60_000);
}

// An idle object with accepted sockets hibernates and keeps its actor, so it logs this in place of a sleep.
function hibernations(dev: RunningOrangeDev): number {
	return dev.output().split(hibernated).length - 1;
}

async function waitForHibernations(dev: RunningOrangeDev, before: number, count = 1): Promise<void> {
	await waitFor("the object to hibernate", () => hibernations(dev) >= before + count, 60_000);
}

function closeOf(socket: ClientWebSocket): Promise<{ code: number; reason: string }> {
	return new Promise((resolve) => {
		socket.once("close", (code: unknown, reason: unknown) => {
			resolve({ code: Number(code), reason: String(reason) });
		});
	});
}

async function withProject(run: (project: TemporaryProject) => Promise<void>): Promise<void> {
	const project = await copyProject(join(repositoryRoot, "tests", "fixtures", "accepted-websockets"));
	try {
		await run(project);
	} finally {
		await project.dispose();
	}
}

const logs = { actorLifecycleLogs: true };

// Workerd drops an idle object after 10 seconds and keeps its accepted sockets. The next message
// constructs a new instance, which sees the sockets with their tags and attachments.
test("an idle object hibernates under an open accepted WebSocket, and its next message builds a new instance", { timeout: 120_000 }, async () => {
	await withProject(async (project) => {
		const dev = await startOrangeDev(project.directory, "wrangler.jsonc", logs);
		try {
			const socket = await openWebSocket(socketUrl(dev, "idle", "ann"));
			let closed = false;
			socket.once("close", () => {
				closed = true;
			});
			const first = await ask(socket, "one");
			await delay(2_000);
			const soon = await ask(socket, "two");
			assert.equal(soon.boot, first.boot, "the object hibernated before its idle timeout");
			assert.equal(soon.messages, 2);
			const sleepsBefore = sleeps(dev);
			await waitForHibernations(dev, hibernations(dev));
			assert.equal(closed, false, dev.output());

			const woken = await ask(socket, "three");
			assert.notEqual(woken.boot, first.boot, "the idle object did not hibernate");
			assert.equal(woken.messages, 1, "the new instance kept the old instance's memory");
			assert.equal(woken.constructedWith, 1, "the constructor did not see the open socket");
			assert.equal(woken.count, 3, "storage did not survive the hibernation");
			assert.equal(woken.attachment, "ann");
			assert.deepEqual(woken.tags, ["ann", "everyone"]);
			assert.equal(woken.everyone, 1);
			assert.equal(sleeps(dev), sleepsBefore, "the actor slept and closed its sockets");

			const pong = collectMessages(socket, 1);
			socket.send("ping");
			assert.deepEqual(await withDeadline(pong, "auto-response"), ["pong"]);
			const after = await ask(socket, "four");
			assert.equal(after.count, 4, "the auto-response reached the handler");
			assert.equal(after.boot, woken.boot);
		} finally {
			await dev.close();
		}
	});
});

// Cloudflare hibernates an object only when no setTimeout() or setInterval() callback is pending.
// https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/
test("a pending timer keeps an idle object from hibernating until the timer runs", { timeout: 120_000 }, async () => {
	await withProject(async (project) => {
		const dev = await startOrangeDev(project.directory, "wrangler.jsonc", logs);
		try {
			const socket = await openWebSocket(socketUrl(dev, "timer", "ann"));
			// The object arms a 14 second timer, which writes the instance's boot ID to storage.
			const armed = await ask(socket, "arm-timer");
			// Past the 14 second timer, and so past the 10 second idle timeout.
			await delay(17_000);
			const afterTimer = await ask(socket, "check");
			assert.equal(afterTimer.boot, armed.boot, "the object hibernated with a timer pending");
			assert.equal(afterTimer.timerFiredBy, armed.boot, "the timer did not run in the live instance");

			await waitForHibernations(dev, hibernations(dev));
			const woken = await ask(socket, "after");
			assert.notEqual(woken.boot, armed.boot, "the object did not hibernate after its timer ran");
		} finally {
			await dev.close();
		}
	});
});

// Measured on `wrangler dev` 4.129: an object with no WebSocket and a 25 second setTimeout() ran
// the timer in the same instance, and was gone 15 seconds later.
test("a pending timer of an object with no WebSocket runs in the instance that set it", { timeout: 120_000 }, async () => {
	await withProject(async (project) => {
		const dev = await startOrangeDev(project.directory, "wrangler.jsonc", logs);
		try {
			const text = async (path: string): Promise<string> => await (await fetch(`${dev.origin}${path}?room=no-socket`)).text();
			const armed = await text("/arm-timer");
			// Past the 14 second timer, and so past the 10 second idle timeout.
			await delay(17_000);
			assert.equal(await text("/timer-fired-by"), armed, "the timer did not run in the instance that set it");
			assert.equal(await text("/boot"), armed, "the object was replaced while its timer was pending");
			const sleepsBefore = sleeps(dev);

			// With no accepted socket, the idle object sleeps with its actor.
			await waitForSleep(dev, sleepsBefore);
			assert.notEqual(await text("/boot"), armed, "the object did not sleep after its timer ran");
		} finally {
			await dev.close();
		}
	});
});

// In workerd, node:timers and node:timers/promises run on the global timers, so their timers keep
// an object awake too.
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/node/internal/internal_timers.ts#L30-L52
test("a pending node:timers or node:timers/promises timer of an object with no WebSocket runs in the instance that set it", { timeout: 120_000 }, async () => {
	await withProject(async (project) => {
		const dev = await startOrangeDev(project.directory, "wrangler.jsonc", logs);
		try {
			const kinds = ["callback", "promise", "interval"];
			const text = async (kind: string, path: string): Promise<string> =>
				await (await fetch(`${dev.origin}${path}?room=node-${kind}&kind=${kind}`)).text();
			const armed = await Promise.all(kinds.map((kind) => text(kind, "/arm-node-timer")));
			// Past the 14 second timers, and so past the 10 second idle timeout.
			await delay(17_000);
			for (const [index, kind] of kinds.entries()) {
				assert.equal(await text(kind, "/timer-fired-by"), armed[index], `the ${kind} timer did not run in the instance that set it`);
				assert.equal(await text(kind, "/boot"), armed[index], `the object was replaced while its ${kind} timer was pending`);
			}
		} finally {
			await dev.close();
		}
	});
});

// Workerd cancels the timers of an object that ctx.abort() reset, so they never run against it.
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/io/io-context.c%2B%2B#L344-L361
test("after ctx.abort() resets an object, the old instance's setInterval() stops", { timeout: 120_000 }, async () => {
	await withProject(async (project) => {
		const dev = await startOrangeDev(project.directory, "wrangler.jsonc", logs);
		try {
			const socket = await openWebSocket(socketUrl(dev, "reset-interval", "ann"));
			const armed = await ask(socket, "log-ticks");
			const ticks = (): number => dev.output().split(`tick from ${armed.boot}`).length - 1;
			await waitFor("the interval's first tick", () => ticks() > 0);
			const closed = closeOf(socket);
			socket.send("abort");
			await withDeadline(closed, "the reset's close");
			const afterReset = ticks();
			// Ten periods of the 200 ms interval.
			await delay(2_000);
			assert.equal(ticks(), afterReset, "the reset object's interval still runs");
		} finally {
			await dev.close();
		}
	});
});

// Workerd's unref() does not let an object hibernate. `wrangler dev` 4.129 kept an object with an
// unref()'d 60 second timer alive, and ran the timer in the same instance.
test("an unref()'d timer of the Worker keeps an idle object from hibernating until the timer runs", { timeout: 120_000 }, async () => {
	await withProject(async (project) => {
		const dev = await startOrangeDev(project.directory, "wrangler.jsonc", logs);
		try {
			const socket = await openWebSocket(socketUrl(dev, "unref-timer", "ann"));
			const armed = await ask(socket, "arm-unref-timer");
			// Past the 14 second timer, and so past the 10 second idle timeout.
			await delay(17_000);
			const afterTimer = await ask(socket, "check");
			assert.equal(afterTimer.boot, armed.boot, "the object hibernated with an unref()'d timer pending");
			assert.equal(afterTimer.timerFiredBy, armed.boot, "the timer did not run in the live instance");

			await waitForHibernations(dev, hibernations(dev));
			const woken = await ask(socket, "after");
			assert.notEqual(woken.boot, armed.boot, "the object did not hibernate after its timer ran");
		} finally {
			await dev.close();
		}
	});
});

// Measured on `wrangler dev` 4.129: an object with an open outbound WebSocket did not hibernate in
// 45 seconds, and one with a 25 second request that nothing awaited hibernated only after the
// response.
test("an open outbound WebSocket or a fetch() in flight keeps an idle object from hibernating", { timeout: 120_000 }, async () => {
	const peer = createServer((_request, response) => {
		// Longer than the 10 second idle timeout.
		setTimeout(() => response.end("slow"), 14_000);
	});
	await new Promise<void>((resolveListen) => peer.listen(0, "127.0.0.1", resolveListen));
	const address = peer.address();
	assert.ok(address !== null && typeof address !== "string");
	try {
		await withProject(async (project) => {
			const dev = await startOrangeDev(project.directory, "wrangler.jsonc", logs);
			try {
				const connected = await openWebSocket(socketUrl(dev, "outbound-socket", "ann"));
				const requesting = await openWebSocket(socketUrl(dev, "outbound-fetch", "ann"));
				const [opened, requested] = await Promise.all([
					// The peer is a standard WebSocket of another object.
					ask(connected, `open-outbound ${dev.origin.replace("http", "ws")}/socket?room=outbound-peer&mode=standard`),
					ask(requesting, `fetch-unawaited http://127.0.0.1:${address.port}/slow`),
				]);
				// Past the 10 second idle timeout, and before the peer's 14 second response.
				await delay(12_500);
				assert.equal((await ask(connected, "check")).boot, opened.boot, "the object hibernated with an outbound WebSocket open");
				assert.equal((await ask(requesting, "check")).boot, requested.boot, "the object hibernated with a request in flight");

				// The object closes its outbound WebSocket, and the response arrives.
				const hibernationsBefore = hibernations(dev);
				await ask(connected, "close-outbound");
				await waitForHibernations(dev, hibernationsBefore, 2);
				assert.notEqual((await ask(connected, "after")).boot, opened.boot, "the object did not hibernate after its outbound WebSocket closed");
				const afterResponse = await ask(requesting, "after");
				assert.notEqual(afterResponse.boot, requested.boot, "the object did not hibernate after the response");
				assert.equal(afterResponse.fetchDoneBy, requested.boot, "the response did not reach the live instance");
			} finally {
				await dev.close();
			}
		});
	} finally {
		await new Promise((resolveClose) => peer.close(resolveClose));
	}
});

// RivetKit opens one gateway socket for each Durable Object WebSocket. Without its `ws` loader, it
// opens them with the global WebSocket, which is Orange's. Those sockets are not the Worker's.
test("when RivetKit cannot use `ws`, Orange warns once, and RivetKit's own sockets don't count as the object's WebSockets", { timeout: 120_000 }, async () => {
	await withProject(async (project) => {
		const preload = join(repositoryRoot, "tests", "fixtures", "rivetkit-without-ws-loader", "preload.cjs");
		const dev = await startOrangeDev(project.directory, "wrangler.jsonc", {
			...logs,
			environment: { NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --require ${preload}` },
		});
		try {
			const socket = await openWebSocket(socketUrl(dev, "stub-socket", "ann"));
			await ask(socket, "open-stub-socket");
			const heldLines = (): string[] =>
				dev
					.output()
					.split("\n")
					.filter((line) => line.includes("event=held") && line.includes("outbound-websocket"));
			await waitFor("the held report", () => heldLines().length > 0);
			const output = dev.output();
			const held = heldLines().map((line) => /idle_ms=\d+ (.*)$/.exec(line)?.[1]);
			assert.deepEqual(held, ["held_by=outbound-websocket:1"], output);
			const warnings = output.split("RivetKit opens Durable Object WebSockets with the built-in WebSocket").length - 1;
			assert.equal(warnings, 1, output);
			await ask(socket, "close-stub-socket");
			socket.terminate();
		} finally {
			await dev.close();
		}
	});
});

test("with info logs, an object that stays awake past its idle timeout names what holds it, with counts", { timeout: 120_000 }, async () => {
	await withProject(async (project) => {
		const dev = await startOrangeDev(project.directory, "wrangler.jsonc", logs);
		try {
			const timer = await openWebSocket(socketUrl(dev, "held-timer", "ann"));
			const background = await openWebSocket(socketUrl(dev, "held-wait-until", "ann"));
			const accepted = await openWebSocket(socketUrl(dev, "held-standard", "ann"));
			const standard = await openWebSocket(`${dev.origin}/socket?room=held-standard&mode=standard`);
			const quiet = await openWebSocket(socketUrl(dev, "held-nothing", "ann"));
			await Promise.all([
				ask(timer, "arm-timer"),
				ask(background, "hold-wait-until"),
				ask(accepted, "hello"),
				ask(quiet, "hello"),
			]);
			// Each held object reports at the 10 second idle timeout, before the 14 second timer runs, and
			// the quiet object hibernates.
			const heldReports = (): number => dev.output().split("event=held").length - 1;
			await waitFor("the held reports", () => heldReports() >= 3 && hibernations(dev) >= 1);
			const held = dev
				.output()
				.split("\n")
				.filter((line) => line.includes("event=held"))
				.map((line) => /class=Room idle_ms=\d+ (.*)$/.exec(line)?.[1])
				.sort();
			assert.deepEqual(
				held,
				["held_by=standard-websocket:1", "held_by=timer:1 timers=setTimeout(14000ms):1", "held_by=wait-until:1"],
				dev.output(),
			);
			// Unfinished background work would hold the runtime's stop.
			await ask(background, "release-wait-until");
			for (const socket of [timer, background, accepted, standard, quiet]) socket.terminate();
		} finally {
			await dev.close();
		}
	});
});

// The `held` line comes 10 seconds after the idle time reaches 10 seconds, then 20, 40, and so on.
// An event starts that sequence again, and a handler that still runs counts from its own start.
test("with info logs, an event restarts an awake object's held reports, and a long handler counts its idle time from its start", { timeout: 120_000 }, async () => {
	await withProject(async (project) => {
		const dev = await startOrangeDev(project.directory, "wrangler.jsonc", logs);
		const heldLines = (): string[] => dev.output().split("\n").filter((line) => line.includes("event=held"));
		const waitForHeld = async (count: number, deadlineMs: number, what: string): Promise<string> => {
			const deadline = Date.now() + deadlineMs;
			while (heldLines().length < count) {
				assert.ok(Date.now() < deadline, `${what}:\n${heldLines().join("\n")}`);
				await delay(100);
			}
			return heldLines()[count - 1] ?? "";
		};
		try {
			const socket = await openWebSocket(socketUrl(dev, "held-restart", "ann"));
			await ask(socket, "arm-interval");
			// The interval holds the object, so the lines come at 10 and 20 seconds, and the next at 40.
			await waitForHeld(2, 30_000, "the object did not report its interval twice");
			const replied = ask(socket, "slow-event");
			const third = await waitForHeld(3, 12_500, "the event did not restart the reports");
			const idle = Number(/idle_ms=(\d+)/.exec(third)?.[1]);
			assert.ok(idle >= 10_000 && idle < 11_500, `the report during the handler counts ${idle} ms: ${third}`);
			assert.match(third, /held_by=(\S*,)?event:1[ ,]/);
			await replied;
			await ask(socket, "clear-interval");
			socket.terminate();
		} finally {
			await dev.close();
		}
	});
});

// Workerd answers an auto-response in its hibernation manager. It doesn't wake a hibernated
// object, and it doesn't restart the idle timer of an awake one.
test("auto-responses don't keep an object awake or wake a hibernated one", { timeout: 120_000 }, async () => {
	await withProject(async (project) => {
		const dev = await startOrangeDev(project.directory, "wrangler.jsonc", logs);
		try {
			const socket = await openWebSocket(socketUrl(dev, "pings", "ann"));
			const first = await ask(socket, "one");
			const ping = async (): Promise<number> => {
				const pong = collectMessages(socket, 1);
				const sentAt = Date.now();
				socket.send("ping");
				assert.deepEqual(await withDeadline(pong, "auto-response"), ["pong"]);
				return sentAt;
			};
			// A ping every 2 seconds, for longer than the 10 second idle timeout.
			let lastPing = 0;
			for (let index = 0; index < 8; index++) {
				await delay(2_000);
				lastPing = await ping();
			}
			// Time for a wake by the last ping to build an instance before the next message.
			await delay(1_500);
			const askedAt = Date.now();
			const woken = await ask(socket, "two");
			assert.notEqual(woken.boot, first.boot, "the pings kept the object awake");
			assert.ok(woken.bornAt >= askedAt, "a ping woke the hibernated object");
			assert.equal(woken.count, 2, "a ping reached the handler");
			assert.ok(woken.autoResponseAt !== null, "the new instance lost the auto-response timestamp");
			assert.ok(
				woken.autoResponseAt >= lastPing && woken.autoResponseAt <= askedAt,
				`the auto-response timestamp ${woken.autoResponseAt} is not the last ping's (${lastPing})`,
			);

			// While the object is awake, a ping still answers and updates the timestamp.
			const awakePing = await ping();
			const awake = await ask(socket, "three");
			assert.equal(awake.boot, woken.boot);
			assert.ok(awake.autoResponseAt !== null && awake.autoResponseAt >= awakePing);
		} finally {
			await dev.close();
		}
	});
});

// Workerd sends an auto-response only while the socket's outgoing half is open.
// https://github.com/cloudflare/workerd/blob/80c80a712532b012cbeaef4d08ff6ab15407e960/src/workerd/io/legacy-hibernation-manager.c%2B%2B#L347-L368
test("no auto-response answers a ping after the object closed its socket", { timeout: 120_000 }, async () => {
	await withProject(async (project) => {
		const dev = await startOrangeDev(project.directory, "wrangler.jsonc", logs);
		try {
			const socket = await openWebSocket(socketUrl(dev, "closed-ping", "ann"));
			await ask(socket, "hello");
			const received: string[] = [];
			socket.on("message", (data: unknown) => received.push(String(data)));
			const closed = closeOf(socket);
			// The object closes the socket as soon as it gets "close-me". The ping arrives after that.
			socket.send("close-me");
			socket.send("ping");
			assert.equal((await withDeadline(closed, "the close")).code, 4001);
			await delay(1_000);
			assert.deepEqual(received, [], "a ping got an answer after the object closed its socket");
		} finally {
			await dev.close();
		}
	});
});

// Each client reconnects when its socket closes. Spread closes keep them from all reconnecting at once.
test("a stopping runtime closes accepted WebSockets with 1012, spread over a window", { timeout: 120_000 }, async () => {
	await withProject(async (project) => {
		const dev = await startOrangeDev(project.directory, "wrangler.jsonc", logs);
		try {
			const sockets: ClientWebSocket[] = [];
			for (let batch = 0; batch < 15; batch++) {
				sockets.push(
					...(await Promise.all(
						Array.from({ length: 20 }, (_, index) =>
							openWebSocket(socketUrl(dev, `drain-${batch % 10}`, `s${batch}-${index}`)),
						),
					)),
				);
			}
			const closes = sockets.map((socket) =>
				closeOf(socket).then((close) => ({ ...close, at: Date.now() })),
			);
			await dev.close();
			const results = await withDeadline(Promise.all(closes), "the closes", 30_000);
			assert.deepEqual(
				[...new Set(results.map((close) => `${close.code} ${close.reason}`))],
				["1012 Service Restart"],
			);
			const times = results.map((close) => close.at).sort((left, right) => left - right);
			const spread = times.at(-1)! - times[0]!;
			// 300 sockets drain over a 3 second window.
			assert.ok(spread >= 1_500, `all 300 sockets closed within ${spread} ms`);
		} finally {
			await dev.close();
		}
	});
});

// The drain covers only sockets from ctx.acceptWebSocket(). Standard sockets close at once.
test("a stopping runtime with only standard WebSockets closes them at once", { timeout: 120_000 }, async () => {
	await withProject(async (project) => {
		const dev = await startOrangeDev(project.directory, "wrangler.jsonc", logs);
		try {
			const sockets: ClientWebSocket[] = [];
			for (let batch = 0; batch < 15; batch++) {
				sockets.push(
					...(await Promise.all(
						Array.from({ length: 20 }, (_, index) =>
							openWebSocket(`${socketUrl(dev, `standard-${batch % 10}`, `s${batch}-${index}`)}&mode=standard`),
						),
					)),
				);
			}
			const closes = sockets.map((socket) =>
				closeOf(socket).then((close) => ({ ...close, at: Date.now() })),
			);
			const stopping = Date.now();
			await dev.close();
			const stopMs = Date.now() - stopping;
			const results = await withDeadline(Promise.all(closes), "the closes", 30_000);
			assert.deepEqual(
				[...new Set(results.map((close) => `${close.code} ${close.reason}`))],
				["1012 Service Restart"],
			);
			const times = results.map((close) => close.at).sort((left, right) => left - right);
			const spread = times.at(-1)! - times[0]!;
			assert.ok(spread < 1_000, `300 standard sockets closed over ${spread} ms, so the stop waited on a drain`);
			assert.ok(times[0]! - stopping < 1_000, `the first standard socket closed ${times[0]! - stopping} ms after the stop began (stop took ${stopMs} ms)`);
		} finally {
			await dev.close();
		}
	});
});

async function boot(dev: RunningOrangeDev, room: string): Promise<string> {
	return await (await fetch(`${dev.origin}/boot?room=${room}`)).text();
}

test("an object sleeps after a client closes its last accepted WebSocket", { timeout: 180_000 }, async () => {
	await withProject(async (project) => {
		const dev = await startOrangeDev(project.directory, "wrangler.jsonc", logs);
		try {
			const one = await openWebSocket(socketUrl(dev, "client-closes", "one"));
			const two = await openWebSocket(socketUrl(dev, "client-closes", "two"));
			const before = await ask(one, "hello");
			const closedOne = closeOf(one);
			one.close(1000, "done");
			await closedOne;
			const sleepsBefore = sleeps(dev);
			await delay(pastSleepTimeoutMs);
			assert.equal(sleeps(dev), sleepsBefore, "the actor slept with a socket open");
			assert.equal((await ask(two, "still here")).count, 2);

			const sleepsAtClose = sleeps(dev);
			const closedTwo = closeOf(two);
			two.close(1000, "done");
			await closedTwo;
			await waitForSleep(dev, sleepsAtClose);
			// webSocketClose runs for each socket. Its code isn't asserted: workerd passes the client's 1000,
			// but the Engine's pegboard-envoy reports `1001 gateway disconnected` when the stream ends.
			const closes = (await (await fetch(`${dev.origin}/closed?room=client-closes`)).json()) as { name: string }[];
			assert.deepEqual(closes.map((close) => close.name), ["one", "two"]);
			assert.notEqual(await boot(dev, "client-closes"), before.boot);
		} finally {
			await dev.close();
		}
	});
});

// A separate project: this test must have no other object awake, because any object's sleep ends the wait.
test("an object sleeps after it closes its last accepted WebSocket", { timeout: 180_000 }, async () => {
	await withProject(async (project) => {
		const dev = await startOrangeDev(project.directory, "wrangler.jsonc", logs);
		try {
			const socket = await openWebSocket(socketUrl(dev, "object-closes", "three"));
			const opened = await ask(socket, "hello");
			const closedByObject = closeOf(socket);
			const sleepsAtObjectClose = sleeps(dev);
			await fetch(`${dev.origin}/close-all?room=object-closes`);
			assert.equal((await withDeadline(closedByObject, "the close")).code, 4000);
			await waitForSleep(dev, sleepsAtObjectClose);
			assert.notEqual(await boot(dev, "object-closes"), opened.boot);
			const closes = (await (await fetch(`${dev.origin}/closed?room=object-closes`)).json()) as { name: string }[];
			assert.deepEqual(closes.map((close) => close.name), ["three"]);
		} finally {
			await dev.close();
		}
	});
});

test("after the object closes its sockets, a slow close handler finishes and a throwing one doesn't stop its sleep", { timeout: 180_000 }, async () => {
	await withProject(async (project) => {
		const dev = await startOrangeDev(project.directory, "wrangler.jsonc", logs);
		try {
			const slow = await openWebSocket(socketUrl(dev, "handlers", "slow"));
			const throws = await openWebSocket(socketUrl(dev, "handlers", "throws"));
			const opened = await ask(slow, "hello");
			const closed = Promise.all([closeOf(slow), closeOf(throws)]);
			const sleepsAtClose = sleeps(dev);
			await fetch(`${dev.origin}/close-all?room=handlers`);
			await withDeadline(closed, "the closes");
			await waitForSleep(dev, sleepsAtClose);
			assert.notEqual(await boot(dev, "handlers"), opened.boot);
			const closes = (await (await fetch(`${dev.origin}/closed?room=handlers`)).json()) as { name: string }[];
			assert.deepEqual(closes.map((close) => close.name), ["slow"]);
		} finally {
			await dev.close();
		}
	});
});

test("a runner restart closes an accepted WebSocket, and a reconnect finds the object's storage", { timeout: 180_000 }, async () => {
	await withProject(async (project) => {
		let dev = await startOrangeDev(project.directory, "wrangler.jsonc", logs);
		try {
			const socket = await openWebSocket(socketUrl(dev, "restart", "ann"));
			const first = await ask(socket, "before");
			await delay(pastSleepTimeoutMs);
			let closedEarly = false;
			const closed = closeOf(socket).then((close) => {
				closedEarly = true;
				return close;
			});
			assert.equal((await ask(socket, "still open")).count, 2);
			assert.equal(closedEarly, false);

			await dev.kill();
			const close = await withDeadline(closed, "the client's close after a crash", 60_000);
			assert.notEqual(close.code, 1000, `a crash reported a clean close: ${close.code}`);

			dev = await startOrangeDev(project.directory, "wrangler.jsonc", logs);
			const again = await openWebSocket(socketUrl(dev, "restart", "ann"));
			const reply = await ask(again, "after");
			assert.notEqual(reply.boot, first.boot);
			assert.equal(reply.count, 3, "storage did not survive the restart");
			assert.equal(reply.everyone, 1, "the dead socket came back");
		} finally {
			await dev.close();
		}
	});
});

test("overlapping accepted WebSockets on one object see only their own attachment and tags", { timeout: 120_000 }, async () => {
	await withProject(async (project) => {
		const dev = await startOrangeDev(project.directory, "wrangler.jsonc", logs);
		try {
			const names = ["ann", "bob", "cid", "dee"];
			const sockets = await Promise.all(names.map((name) => openWebSocket(socketUrl(dev, "overlap", name))));
			const check = async (open: number): Promise<void> => {
				const replies = await Promise.all(sockets.slice(0, open).map((socket, index) => ask(socket, names[index]!)));
				for (const [index, reply] of replies.entries()) {
					assert.equal(reply.attachment, names[index]);
					assert.deepEqual(reply.tags, [names[index], "everyone"]);
					assert.equal(reply.sameName, 1);
					assert.equal(reply.everyone, open);
				}
			};
			const before = await ask(sockets[0]!, "boot");
			await check(4);
			await waitForHibernations(dev, hibernations(dev));
			// Four messages arrive at the hibernated object at once. One new instance serves them all.
			const woken = await Promise.all(sockets.map((socket, index) => ask(socket, names[index]!)));
			assert.equal(new Set(woken.map((reply) => reply.boot)).size, 1, "a wake built more than one instance");
			assert.notEqual(woken[0]!.boot, before.boot, "the idle object did not hibernate");
			assert.deepEqual(woken.map((reply) => reply.constructedWith), [4, 4, 4, 4]);
			await check(4);
			const closed = closeOf(sockets[3]!);
			sockets[3]!.close(1000, "done");
			await closed;
			await waitFor(
				"the closed socket leaving getWebSockets()",
				async () => (await ask(sockets[0]!, "count")).everyone === 3,
				20_000,
			);
			await check(3);
		} finally {
			await dev.close();
		}
	});
});

// Measured with 1,000 rooms: 84 KB of heap for each room with Node.js's built-in WebSocket on the
// connection from the Worker to the object, and 52 KB with the `ws` package.
test("each connected, hibernated room holds less than 65 KB of runtime heap", { timeout: 180_000 }, async () => {
	await withProject(async (project) => {
		const dev = await startOrangeDev(project.directory, "wrangler.jsonc", {
			...logs,
			environment: { NODE_OPTIONS: "--inspect-port=0" },
		});
		const sockets: ClientWebSocket[] = [];
		const openRooms = async (from: number, count: number): Promise<void> => {
			for (let index = from; index < from + count; index += 50) {
				sockets.push(
					...(await Promise.all(
						Array.from({ length: Math.min(50, from + count - index) }, (_, offset) =>
							openWebSocket(socketUrl(dev, `heap-${index + offset}`, "ann")),
						),
					)),
				);
			}
		};
		try {
			// The first rooms pay for what the runtime loads once.
			await openRooms(0, 50);
			await waitForHibernations(dev, 0, 50);
			const before = await dev.runtimeHeapUsed();
			await openRooms(50, 300);
			await waitForHibernations(dev, 50, 300);
			const perRoom = ((await dev.runtimeHeapUsed()) - before) / 300;
			assert.equal(sockets.filter((socket) => socket.readyState === 1).length, 350);
			assert.ok(perRoom < 65 * 1024, `each room holds ${Math.round(perRoom / 1024)} KB of heap`);
		} finally {
			for (const socket of sockets) socket.terminate();
			await dev.close();
		}
	});
});
