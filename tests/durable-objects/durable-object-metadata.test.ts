import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { join } from "node:path";
import test from "node:test";

import {
	closeWebSocket,
	collectMessages,
	copyProject,
	openWebSocket,
	repositoryRoot,
	startOrangeDev,
	withDeadline,
} from "../harness/orange-dev.js";

test(
	"ctx.id.name, WebSocket hibernation settings, and facets survive deleteAll() and sleep",
	{ timeout: 180_000 },
	async () => {
		const project = await copyProject(join(repositoryRoot, "tests", "fixtures", "object-metadata"));
		try {
			const dev = await startOrangeDev(project.directory);
			try {
				const socket = await openWebSocket(`${dev.origin}/socket`);
				try {
					const configured = await fetch(`${dev.origin}/configure`);
					assert.equal(configured.status, 204, `${await configured.text()}\n${dev.output()}`);

					// Stay idle past the 10-second window so the room and its facet sleep. The
					// hibernatable socket stays open.
					await delay(11_000);
					const replies = collectMessages(socket, 2);
					socket.send("ping");
					socket.send("hello");
					assert.deepEqual(await withDeadline(replies, "replies after wake"), ["pong", "echo:hello"]);

					const response = await fetch(dev.origin);
					assert.equal(response.status, 200, `${await response.clone().text()}\n${dev.output()}`);
					assert.deepEqual(await response.json(), {
						autoResponse: "pong",
						child: { constructions: 2, name: "lobby" },
						constructions: 2,
						eventTimeout: 5_000,
						name: "lobby",
						tables: [],
					});
				} finally {
					await closeWebSocket(socket);
				}
			} finally {
				await dev.close();
			}
		} finally {
			await project.dispose();
		}
	},
);

test(
	"WebSocket hibernation settings made in a rolled-back storage transaction survive sleep",
	{ timeout: 180_000 },
	async () => {
		const project = await copyProject(join(repositoryRoot, "tests", "fixtures", "object-metadata"));
		try {
			const dev = await startOrangeDev(project.directory);
			try {
				const kinds = ["sync", "async"] as const;
				const sockets = await Promise.all(
					kinds.map((kind) => openWebSocket(`${dev.origin}/socket?room=rollback-${kind}`)),
				);
				try {
					for (const kind of kinds) {
						const configured = await fetch(`${dev.origin}/configure?room=rollback-${kind}&rollback=${kind}`);
						assert.equal(configured.status, 204, `${kind}: ${await configured.text()}\n${dev.output()}`);
					}

					// Stay idle past the 10-second window so both rooms sleep.
					await delay(11_000);
					for (const [index, kind] of kinds.entries()) {
						const socket = sockets[index];
						assert.ok(socket);
						const reply = collectMessages(socket, 1);
						socket.send("ping");
						assert.deepEqual(await withDeadline(reply, `${kind} reply after wake`), ["pong"], kind);

						const response = await fetch(`${dev.origin}/settings?room=rollback-${kind}`);
						assert.equal(response.status, 200, `${kind}: ${await response.clone().text()}\n${dev.output()}`);
						assert.deepEqual(await response.json(), { autoResponse: "pong", constructions: 2, eventTimeout: 5_000 }, kind);
					}
				} finally {
					await Promise.all(sockets.map((socket) => closeWebSocket(socket)));
				}
			} finally {
				await dev.close();
			}
		} finally {
			await project.dispose();
		}
	},
);
