import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { glob, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { copyProject, descendantProcesses, repositoryRoot, startOrangeDev } from "../harness/orange-dev.js";

const configs = ["wrangler.jsonc", "consumer.wrangler.jsonc"];

// The fixture's tail() handlers keep a summary of each TraceItem and serve them back.
async function tailEvents(origin: string, route: string, path: string): Promise<unknown[]> {
	const deadline = Date.now() + 20_000;
	for (;;) {
		const events: unknown = await (await fetch(`${origin}${route}?path=${encodeURIComponent(path)}`)).json();
		assert.ok(Array.isArray(events));
		if (events.length > 0 || Date.now() > deadline) return events;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}

// Expected values are workerd 1.20260903.1's output for the same fixture under `wrangler dev
// --no-bundle`, except `scriptName`: Cloudflare reports the Worker's name, where local workerd
// reports null.
test("tail consumers get each event's logs, exceptions, and outcome, in the Worker itself and in another Worker", { timeout: 180_000 }, async () => {
	const project = await copyProject(join(repositoryRoot, "tests", "fixtures", "tail-consumers"));
	try {
		const dev = await startOrangeDev(project.directory, configs);
		try {
			const id = "0123456789abcdef0123456789abcdef";
			const hello = await fetch(`${dev.origin}/hello/${id}?x=1`, {
				headers: { authorization: "Bearer secret" },
			});
			assert.equal(hello.status, 201, `${await hello.clone().text()}\n${dev.output()}`);
			await hello.text();
			const thrown = await fetch(`${dev.origin}/throws`);
			assert.equal(thrown.status, 500);
			await thrown.text();
			// Overlapping requests each see only their own logs, also when their records share a batch.
			const tags = Array.from({ length: 20 }, (_, index) => `t${index}`);
			const overlapping = await Promise.all(
				tags.map(async (tag) => await (await fetch(`${dev.origin}/overlap/${tag}`)).text()),
			);
			assert.deepEqual(overlapping, tags);

			const common = {
				method: "GET",
				hasCf: true,
				scriptName: "tail-producer",
				executionModel: "stateless",
				truncated: false,
				timestampIsNumber: true,
			};
			assert.deepEqual(await tailEvents(dev.origin, "/events", `/hello/${id}`), [
				{
					...common,
					path: `/hello/${id}`,
					url: `${dev.origin}/hello/REDACTED?x=1`,
					unredactedUrl: `${dev.origin}/hello/${id}?x=1`,
					authorization: "REDACTED",
					unredactedAuthorization: "Bearer secret",
					status: 201,
					outcome: "ok",
					logs: [
						{ level: "log", message: ["plain", 1, { a: 1 }, [2, null], null, null, "[object Map]"], errorInfo: null },
						{
							level: "error",
							message: ["Error: logged"],
							errorInfo: [{ name: "Error", message: "logged", stackHasFrames: true }],
						},
						{ level: "info", message: ["custom"], errorInfo: null },
					],
					exceptions: [],
				},
			]);
			const thrownEvent = {
				...common,
				path: "/throws",
				url: `${dev.origin}/throws`,
				unredactedUrl: `${dev.origin}/throws`,
				status: null,
				outcome: "exception",
				logs: [
					{
						level: "warn",
						message: ["about to throw", "RangeError: out of range"],
						errorInfo: [null, { name: "RangeError", message: "out of range", stackHasFrames: true }],
					},
				],
				exceptions: [{ name: "TypeError", message: "boom", stackHasFrames: true }],
			};
			assert.deepEqual(await tailEvents(dev.origin, "/events", "/throws"), [thrownEvent]);
			assert.deepEqual(await tailEvents(dev.origin, "/consumer-events", "/throws"), [thrownEvent]);
			for (const tag of tags) {
				for (const route of ["/events", "/consumer-events"]) {
					const events = await tailEvents(dev.origin, route, `/overlap/${tag}`);
					assert.equal(events.length, 1, `${route} /overlap/${tag}`);
					assert.deepEqual(Reflect.get(events[0] as object, "logs"), [
						{ level: "log", message: [`${tag} first`], errorInfo: null },
						{ level: "log", message: [`${tag} second`], errorInfo: null },
					]);
				}
			}
		} finally {
			await dev.close();
		}
	} finally {
		await project.dispose();
	}
});

async function getJson(url: string): Promise<unknown> {
	const response = await fetch(url);
	assert.equal(response.status, 200, url);
	return await response.json();
}

async function request(origin: string, path: string): Promise<void> {
	const response = await fetch(`${origin}${path}`);
	await response.text();
}

test("a tail consumer that is not running gets the events in one batch when it starts", { timeout: 180_000 }, async () => {
	const project = await copyProject(join(repositoryRoot, "tests", "fixtures", "tail-consumers"));
	try {
		const paths = Array.from({ length: 5 }, (_, index) => `/down/${index}`);
		// Only the producer runs.
		const producer = await startOrangeDev(project.directory, "wrangler.jsonc");
		try {
			for (const path of paths) await request(producer.origin, path);
		} finally {
			await producer.close();
		}
		const dev = await startOrangeDev(project.directory, configs);
		try {
			for (const path of paths) {
				assert.equal((await tailEvents(dev.origin, "/consumer-events", path)).length, 1, `${path}\n${dev.output()}`);
			}
			// The batch can also hold events of this session's own requests, which come later.
			const batches = await getJson(`${dev.origin}/consumer-batches`);
			const [first] = Array.isArray(batches) ? batches : [];
			assert.deepEqual(Array.isArray(first) ? first.slice(0, paths.length) : first, paths);
		} finally {
			await dev.close();
		}
	} finally {
		await project.dispose();
	}
});

test("a tail() call that throws gets the same events again until a call returns", { timeout: 180_000 }, async () => {
	const project = await copyProject(join(repositoryRoot, "tests", "fixtures", "tail-consumers"));
	try {
		const dev = await startOrangeDev(project.directory, configs);
		try {
			await request(dev.origin, "/tail-throws");
			assert.equal((await tailEvents(dev.origin, "/consumer-events", "/tail-throws")).length, 1, dev.output());
			const attempts = await getJson(`${dev.origin}/consumer-attempts`);
			assert.equal(Reflect.get(attempts as object, "/tail-throws"), 3);
			assert.match(dev.output(), /tail\(\) failed/);
		} finally {
			await dev.close();
		}
	} finally {
		await project.dispose();
	}
});

test("events of a tail() call that a crash interrupts reach the consumer after a restart", { timeout: 180_000 }, async () => {
	const project = await copyProject(join(repositoryRoot, "tests", "fixtures", "tail-consumers"));
	const devVars = join(project.directory, ".dev.vars");
	try {
		await writeFile(devVars, "HANG_TAIL=1\n");
		const crashed = await startOrangeDev(project.directory, configs);
		try {
			await request(crashed.origin, "/tail-hangs");
			// tail() got the event and hangs.
			const deadline = Date.now() + 20_000;
			while (Reflect.get((await getJson(`${crashed.origin}/consumer-attempts`)) as object, "/tail-hangs") !== 1) {
				assert.ok(Date.now() < deadline, crashed.output());
				await new Promise((resolve) => setTimeout(resolve, 50));
			}
		} finally {
			await crashed.kill();
		}
		await rm(devVars);
		const dev = await startOrangeDev(project.directory, configs);
		try {
			assert.equal((await tailEvents(dev.origin, "/consumer-events", "/tail-hangs")).length, 1, dev.output());
		} finally {
			await dev.close();
		}
	} finally {
		await project.dispose();
	}
});

test("a Worker with tail_consumers fails to start with a clear error when the Services binary is missing", { timeout: 60_000 }, async () => {
	const project = await copyProject(join(repositoryRoot, "tests", "fixtures", "tail-consumers"));
	try {
		await assert.rejects(
			startOrangeDev(project.directory, configs, {
				environment: { RIVET_SERVICES_BINARY: join(project.directory, "missing-rivet-services") },
			}),
			/tail_consumers needs Rivet Services[\s\S]*@rivet-dev\/services[\s\S]*missing-rivet-services/,
		);
	} finally {
		await project.dispose();
	}
});

const segmentSeconds = 2;

// Reads a tail segment stream through the session's Engine gateway, as any Durable Streams client of
// the Engine can.
async function segmentStatus(projectDirectory: string, consumer: string, segment: number): Promise<number> {
	const [runtimeFile] = await Array.fromAsync(
		glob("**/.open-orange/rivetkit/*/.rivetkit/var/engine/runtime.json", { cwd: projectDirectory }),
	);
	assert.ok(runtimeFile !== undefined);
	const { endpoint } = JSON.parse(await readFile(join(projectDirectory, runtimeFile), "utf8")) as { endpoint: string };
	const path = `/tail/${consumer}/${segment}`;
	const key = createHash("sha256").update("default").update(Buffer.from([0])).update(path).digest("hex");
	const list = await fetch(new URL(`/actors?namespace=default&name=durableStream&key=${key}`, endpoint), {
		headers: { authorization: "Bearer default" },
	});
	assert.equal(list.status, 200, await list.clone().text());
	const { actors } = (await list.json()) as { actors: { actor_id: string }[] };
	const [actor] = actors;
	if (actor === undefined) return 404;
	const read = await fetch(new URL(`/gateway/${actor.actor_id}@default/request/protocol?offset=-1`, endpoint));
	await read.body?.cancel();
	return read.status;
}

test("a segment that the consumer has delivered is deleted once the next segment begins", { timeout: 180_000 }, async () => {
	const project = await copyProject(join(repositoryRoot, "tests", "fixtures", "tail-consumers"));
	const lengthMs = segmentSeconds * 1_000;
	try {
		const dev = await startOrangeDev(project.directory, configs, {
			environment: { ORANGE_TAIL_RETENTION_SECONDS: "60", ORANGE_TAIL_SEGMENT_SECONDS: String(segmentSeconds) },
		});
		try {
			const firstSegment = Math.floor(Date.now() / lengthMs);
			await request(dev.origin, "/segment/first");
			assert.equal((await tailEvents(dev.origin, "/consumer-events", "/segment/first")).length, 1, dev.output());
			const lastFirstSegment = Math.floor(Date.now() / lengthMs);
			// Past the end of that segment and its grace, which is one segment long here.
			await new Promise((resolve) => setTimeout(resolve, (lastFirstSegment + 1) * lengthMs + lengthMs + 500 - Date.now()));
			const secondSegment = Math.floor(Date.now() / lengthMs);
			await request(dev.origin, "/segment/second");
			assert.equal((await tailEvents(dev.origin, "/consumer-events", "/segment/second")).length, 1, dev.output());
			assert.equal((await tailEvents(dev.origin, "/consumer-events", "/segment/first")).length, 1);
			// The consumer deletes a segment once its grace has passed, on the next pass of its loop.
			for (let segment = firstSegment; segment <= lastFirstSegment; segment += 1) {
				const deadline = Date.now() + 5_000;
				while ((await segmentStatus(project.directory, "tail-consumer", segment)) !== 404) {
					assert.ok(Date.now() < deadline, `segment ${segment} was not deleted`);
					await new Promise((resolve) => setTimeout(resolve, 200));
				}
			}
			assert.equal(await segmentStatus(project.directory, "tail-consumer", secondSegment), 200);
		} finally {
			await dev.close();
		}
	} finally {
		await project.dispose();
	}
});

test("a segment expires after the retention while its consumer is not running", { timeout: 180_000 }, async () => {
	const project = await copyProject(join(repositoryRoot, "tests", "fixtures", "tail-consumers"));
	const lengthMs = segmentSeconds * 1_000;
	const environment = { ORANGE_TAIL_RETENTION_SECONDS: "2", ORANGE_TAIL_SEGMENT_SECONDS: String(segmentSeconds) };
	try {
		// Only the producer runs, so nothing delivers or deletes the segment.
		const producer = await startOrangeDev(project.directory, "wrangler.jsonc", { environment });
		let segments: number[];
		try {
			const first = Math.floor(Date.now() / lengthMs);
			await request(producer.origin, "/expires");
			const last = Math.floor(Date.now() / lengthMs);
			segments = Array.from({ length: last - first + 1 }, (_, index) => first + index);
			const statuses = await Promise.all(segments.map((segment) => segmentStatus(project.directory, "tail-consumer", segment)));
			assert.ok(statuses.includes(200), `no segment holds the event: ${statuses.join(", ")}`);
			// Past the last segment's end and its 2 s retention.
			await new Promise((resolve) => setTimeout(resolve, (last + 1) * lengthMs + 2_000 + 1_000 - Date.now()));
			for (const segment of segments) {
				assert.equal(await segmentStatus(project.directory, "tail-consumer", segment), 404, `segment ${segment}`);
			}
		} finally {
			await producer.close();
		}
	} finally {
		await project.dispose();
	}
});

test("Rivet Services exits when the runtime that started it is killed", { timeout: 120_000 }, async () => {
	const project = await copyProject(join(repositoryRoot, "tests", "fixtures", "tail-consumers"));
	try {
		const dev = await startOrangeDev(project.directory, configs);
		const processes = descendantProcesses(dev.pid);
		const services = processes.filter(({ command }) => command === "rivet-services").map(({ pid }) => pid);
		let killed = false;
		try {
			// The session's first Worker starts the one Services of the session.
			assert.equal(services.length, 1, JSON.stringify(processes));
			// SIGKILL reaches only the Node.js processes, as an out-of-memory kill would.
			for (const { pid } of [{ pid: dev.pid }, ...processes.filter(({ command }) => command === "node")]) {
				process.kill(pid, "SIGKILL");
			}
			killed = true;
			await dev.exited;
			const deadline = Date.now() + 5_000;
			while (services.some((pid) => isAlive(pid))) {
				assert.ok(Date.now() < deadline, "Rivet Services outlived its runtime");
				await new Promise((resolve) => setTimeout(resolve, 50));
			}
		} finally {
			for (const pid of services) if (isAlive(pid)) process.kill(pid, "SIGKILL");
			if (!killed) await dev.close();
		}
	} finally {
		await project.dispose();
	}
});

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}
