import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import {
	type ClientWebSocket,
	copyProject,
	openWebSocket,
	repositoryRoot,
	startOrangeDev,
	withDeadline,
} from "../harness/orange-dev.js";

function nextClose(socket: ClientWebSocket): Promise<[number, string]> {
	return withDeadline(
		new Promise((resolve) => {
			socket.once("close", (code, reason) => resolve([Number(code), String(reason)]));
		}),
		"WebSocket close",
	);
}

test(
	"a Durable Object that closes its WebSocket with 1012 closes the client with 1011 and no uncaught exception",
	{ timeout: 180_000 },
	async () => {
		const project = await copyProject(join(repositoryRoot, "tests", "fixtures", "websocket-close-codes"));
		try {
			const dev = await startOrangeDev(project.directory);
			try {
				const socket = await openWebSocket(dev.origin);
				const closed = nextClose(socket);
				socket.send("1012");
				// RivetKit's actor WebSocket cannot send 1012, so the client gets 1011 and the reason.
				assert.deepEqual(await closed, [1011, "closed by the object"]);
				assert.doesNotMatch(dev.output(), /Uncaught/);
				// The object still serves new connections.
				const next = await openWebSocket(dev.origin);
				const nextClosed = nextClose(next);
				next.send("1000");
				assert.deepEqual(await nextClosed, [1000, "closed by the object"]);
			} finally {
				await dev.close();
			}
		} finally {
			await project.dispose();
		}
	},
);
