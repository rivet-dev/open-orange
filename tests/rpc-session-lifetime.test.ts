import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import { copyProject, repositoryRoot, startOrangeDev, waitFor } from "./orange-dev.js";

const slept = "old=SleepFinalize new=Terminated";

test("an RPC session lasts as long as the event that opened it", { timeout: 180_000 }, async () => {
	const project = await copyProject(join(repositoryRoot, "tests", "fixtures", "rpc-session-lifetime"));
	try {
		const dev = await startOrangeDev(project.directory, "wrangler.jsonc", { actorLifecycleLogs: true });
		const text = async (path: string): Promise<string> => {
			const response = await fetch(new URL(path, dev.origin));
			const body = await response.text();
			assert.equal(response.status, 200, `${body}\n${dev.output()}`);
			return body;
		};
		const waitForSleep = async (): Promise<void> => {
			const from = dev.output().length;
			await waitFor("the object's sleep", () => dev.output().includes(slept, from), 60_000);
		};
		try {
			// The session ends with the event, not the response, so waitUntil() work can still call it.
			const boot = await text("/boot");
			assert.equal(await text("/wait-until"), "sent");
			await waitFor("waitUntil() using the session", async () => (await text("/recorded")) === boot, 20_000);

			// A WorkerEntrypoint gives the session to its caller, whose event then owns it.
			assert.equal(await text("/relayed"), boot, dev.output());
			assert.equal(await text("/relayed-twice"), boot, dev.output());
			assert.match(await text("/kept"), /^rejected /, dev.output());

			const first = await text("/session");

			// The Worker kept the stub, but its event is over.
			const kept = await text("/kept");
			assert.match(kept, /^rejected /, dev.output());

			// Nothing but that stale stub refers to the object, so it sleeps and wakes as a new instance.
			await waitForSleep();
			assert.notEqual(await text("/boot"), first, dev.output());

			// A Dynamic Worker's call ends when the session reaches it, and the session must outlive that.
			// Once the Dynamic Worker disposes the session, its object can sleep: "a", woken above, plus
			// the caller "b" and the target "c" all sleep. A session still open keeps "c" awake.
			const sleptBefore = dev.output().split(slept).length;
			assert.match(await text("/dynamic-worker"), /^[0-9a-f-]{36}$/, dev.output());
			await waitFor(
				"every object's sleep after the Dynamic Worker disposed its session",
				() => dev.output().split(slept).length >= sleptBefore + 3,
				60_000,
			);

			// The same session as a plain object of functions, which the Dynamic Worker calls after the
			// entrypoint's reply reached it.
			assert.match(await text("/dynamic-worker-functions"), /^[0-9a-f-]{36}$/, dev.output());
		} finally {
			await dev.close();
		}
	} finally {
		await project.dispose();
	}
});
