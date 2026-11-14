import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { isRecord } from "../harness/orange-dev.js";

// Drives cron triggers and Wrangler's scheduled test routes through real
// `orange dev` processes, Wrangler configuration, and a Rivet Engine. The
// fixture Worker records each scheduled() run in KV and serves them at /runs.

const cliEntrypoint = fileURLToPath(new URL("../../src/bin.ts", import.meta.url));
const fixtureWorker = fileURLToPath(
	new URL("../fixtures/cron-triggers/worker.js", import.meta.url),
);

// The fixture's scheduled() throws for this cron.
const throwingCron = "* * * * *";
const passingCron = "*/1 * * * *";
// Cloudflare syntax that Rivet's cron parser lacks or reads differently:
// the last weekday of the month, and Monday, Wednesday, and Friday (2/2 with
// 1 = Sunday).
const lastWeekdayCron = "59 23 LW * *";
const steppedWeekdaysCron = "0 0 * * 2/2";
const invalidCron = "61 * * * *";
const minuteMs = 60_000;
const dayMs = 24 * 60 * minuteMs;

// 23:59 UTC on the last Monday-to-Friday day of the month, after `after`.
function expectedLastWeekdayRun(after: number): number {
	const now = new Date(after);
	for (let offset = 0; ; offset += 1) {
		const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset + 1, 0));
		while (day.getUTCDay() === 0 || day.getUTCDay() === 6) day.setUTCDate(day.getUTCDate() - 1);
		const run = day.getTime() + 23 * 60 * minuteMs + 59 * minuteMs;
		if (run > after) return run;
	}
}

// 00:00 UTC on the next Monday, Wednesday, or Friday after `after`.
function expectedSteppedWeekdaysRun(after: number): number {
	for (let day = Math.floor(after / dayMs) * dayMs + dayMs; ; day += dayMs) {
		if ([1, 3, 5].includes(new Date(day).getUTCDay())) return day;
	}
}

// orange dev prints the cron line right after the ready line, and the two can
// arrive in separate output chunks, so this polls the collected output.
async function waitForOutput(server: DevServer, pattern: RegExp): Promise<void> {
	const deadline = Date.now() + 10_000;
	while (!pattern.test(server.output())) {
		if (Date.now() > deadline) assert.fail(`missing ${pattern}:\n${server.output()}`);
		await delay(50);
	}
}

// Reads the next run of each cron from the `orange dev` startup line.
function printedNextRuns(output: string): Map<string, number> {
	const runs = new Map<string, number>();
	for (const match of output.matchAll(/"([^"]+)" next (\d{4}-\d\d-\d\dT[\d:.]+Z)/g)) {
		if (match[1] !== undefined && match[2] !== undefined) runs.set(match[1], Date.parse(match[2]));
	}
	return runs;
}

interface ScheduledRun {
	cron: string;
	scheduledTime: number;
}

interface DevServer {
	origin: string;
	output(): string;
	stop(): Promise<void>;
}

async function createProject(crons: readonly string[]): Promise<string> {
	const projectRoot = await mkdtemp(join(tmpdir(), "open-orange-cron-"));
	await cp(fixtureWorker, join(projectRoot, "worker.js"));
	await writeConfig(projectRoot, crons);
	return projectRoot;
}

async function writeConfig(projectRoot: string, crons: readonly string[]): Promise<void> {
	await writeFile(
		join(projectRoot, "wrangler.json"),
		JSON.stringify({
			compatibility_date: "2026-09-03",
			kv_namespaces: [{ binding: "KV", id: "runs" }],
			main: "./worker.js",
			name: "cron-triggers-e2e",
			triggers: { crons },
		}),
	);
}

async function startDev(projectRoot: string, extraArgs: readonly string[] = []): Promise<DevServer> {
	const child: ChildProcess = spawn(
		process.execPath,
		[
			"--import",
			"tsx",
			cliEntrypoint,
			"dev",
			"--config",
			join(projectRoot, "wrangler.json"),
			"--port",
			"0",
			"--ip",
			"127.0.0.1",
			...extraArgs,
		],
		{
			env: { ...process.env, CI: "1", NO_COLOR: "1" },
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	let output = "";
	const port = await new Promise<number>((resolveReady, rejectReady) => {
		const timeout = setTimeout(
			() => {
				child.kill("SIGKILL");
				rejectReady(new Error(`orange dev readiness timed out: ${output}`));
			},
			60_000,
		);
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
	return {
		origin: `http://127.0.0.1:${port}`,
		output: () => output,
		stop: () =>
			new Promise<void>((resolveStop) => {
				if (child.exitCode !== null || child.signalCode !== null) {
					resolveStop();
					return;
				}
				const timeout = setTimeout(() => child.kill("SIGKILL"), 15_000);
				child.once("exit", () => {
					clearTimeout(timeout);
					resolveStop();
				});
				child.kill("SIGINT");
			}),
	};
}

async function readRuns(server: DevServer): Promise<ScheduledRun[]> {
	const response = await fetch(`${server.origin}/runs`);
	const text = await response.text();
	assert.equal(response.status, 200, `${text}\n${server.output()}`);
	const runs: unknown = JSON.parse(text);
	assert.ok(Array.isArray(runs));
	return runs.map((run) => {
		assert.ok(isRecord(run) && typeof run.cron === "string" && typeof run.scheduledTime === "number");
		return { cron: run.cron, scheduledTime: run.scheduledTime };
	});
}

function tickTimes(runs: readonly ScheduledRun[], cron: string, since = 0): number[] {
	return [
		...new Set(
			runs
				.filter((run) => run.cron === cron && run.scheduledTime >= since)
				.map((run) => run.scheduledTime),
		),
	].sort((left, right) => left - right);
}

// Cron fires have no caller-visible completion event, so the test polls the
// runs that scheduled() records until `count` ticks of `cron` have run.
async function waitForTicks(
	server: DevServer,
	cron: string,
	count: number,
	since = 0,
): Promise<ScheduledRun[]> {
	const deadline = Date.now() + (count + 1) * minuteMs + 30_000;
	for (;;) {
		const runs = await readRuns(server);
		if (tickTimes(runs, cron, since).length >= count) return runs;
		if (Date.now() > deadline) {
			assert.fail(
				`${cron} ran ${tickTimes(runs, cron, since).length} of ${count} ticks: ${JSON.stringify(runs)}\n${server.output()}`,
			);
		}
		await delay(1_000);
	}
}

// The two groups use separate projects and Engines, so they run at the same time.
describe("cron triggers", { concurrency: true }, () => {
	describe("through orange dev", { concurrency: true }, () => {
		let projectRoot: string;
		let server: DevServer;
		let startedAt: number;

		before(async () => {
			projectRoot = await createProject([
				throwingCron,
				passingCron,
				lastWeekdayCron,
				steppedWeekdaysCron,
				invalidCron,
			]);
			startedAt = Date.now();
			server = await startDev(projectRoot, ["--test-scheduled"]);
		});

		after(async () => {
			try {
				await server?.stop();
			} finally {
				await rm(projectRoot, { force: true, recursive: true });
			}
		});

		it("runs each cron every minute with its expression, and a throwing scheduled() does not stop later runs", { timeout: 4 * minuteMs }, async () => {
			const runs = await waitForTicks(server, throwingCron, 2);
			const [first, second] = tickTimes(runs, throwingCron);
			assert.ok(first !== undefined && second !== undefined);
			assert.equal(first % minuteMs, 0);
			assert.equal(second - first, minuteMs);
			// The other cron ran on the same minute with its own expression.
			assert.ok(tickTimes(runs, passingCron).includes(first), JSON.stringify(runs));
			assert.match(server.output(), /× .*scheduled\(\) failed for \* \* \* \* \*/);
		});

		it("schedules Cloudflare-only syntax on Cloudflare's minutes, and skips an invalid cron without stopping", async () => {
			// Rivet reports each job's due time at startup, and open-orange dev prints it.
			await waitForOutput(server, /Run one now: curl/);
			const nextRuns = printedNextRuns(server.output());
			assert.equal(
				new Date(nextRuns.get(lastWeekdayCron) ?? 0).toISOString(),
				new Date(expectedLastWeekdayRun(startedAt)).toISOString(),
				server.output(),
			);
			assert.equal(
				new Date(nextRuns.get(steppedWeekdaysCron) ?? 0).toISOString(),
				new Date(expectedSteppedWeekdaysRun(startedAt)).toISOString(),
				server.output(),
			);
			assert.equal(nextRuns.has(invalidCron), false);
			assert.match(
				server.output(),
				/! Orange skips cron trigger "61 \* \* \* \*": Minute value "61" must be 0-59/,
			);
		});

		it("answers /cdn-cgi/local/scheduled with 500 when scheduled() or its waitUntil() fails, and 200 otherwise", async () => {
			const scheduled = async (query: string): Promise<[number, string]> => {
				const response = await fetch(`${server.origin}/cdn-cgi/local/scheduled?${query}`);
				return [response.status, await response.text()];
			};
			assert.deepEqual(await scheduled("cron=throws"), [500, "exception"]);
			assert.deepEqual(await scheduled("cron=wait-until-rejects"), [500, "exception"]);
			assert.deepEqual(await scheduled("cron=manual&time=1700000000000"), [200, "ok"]);
			assert.deepEqual(await scheduled("cron=throws&format=json"), [
				500,
				JSON.stringify({ noRetry: false, outcome: "exception" }),
			]);
			assert.deepEqual(await scheduled("cron=no-retry&format=json"), [
				200,
				JSON.stringify({ noRetry: true, outcome: "ok" }),
			]);
			const runs = await readRuns(server);
			assert.ok(runs.some((run) => run.cron === "manual" && run.scheduledTime === 1_700_000_000_000));
		});

		it("answers /__scheduled under --test-scheduled with 500 when scheduled() throws, and 200 otherwise", async () => {
			const failed = await fetch(`${server.origin}/__scheduled?cron=throws`);
			assert.equal(failed.status, 500, await failed.text());
			const passed = await fetch(`${server.origin}/__scheduled?cron=test-route`);
			assert.deepEqual([passed.status, await passed.text()], [200, "Ran scheduled event"]);
			const runs = await readRuns(server);
			assert.ok(runs.some((run) => run.cron === "test-route"));
		});
	});

	describe("with ORANGE_CRONS=off", () => {
		let projectRoot: string;
		const servers: DevServer[] = [];

		after(async () => {
			try {
				await Promise.all(servers.map((server) => server.stop()));
			} finally {
				await rm(projectRoot, { force: true, recursive: true });
			}
		});

		it("runs no cron, including the jobs that an earlier start with crons on left", { timeout: 4 * minuteMs }, async () => {
			projectRoot = await createProject([throwingCron, passingCron]);
			const earlier = await startDev(projectRoot);
			servers.push(earlier);
			await earlier.stop();

			await writeFile(join(projectRoot, ".dev.vars"), "ORANGE_CRONS=off\n");
			const startedAt = Date.now();
			const server = await startDev(projectRoot);
			servers.push(server);
			// Past the next minute, with a margin for a late tick.
			await delay(minuteMs - (Date.now() % minuteMs) + 20_000);
			const runs = await readRuns(server);
			assert.deepEqual(runs.filter((run) => run.scheduledTime > startedAt), [], server.output());
			assert.doesNotMatch(server.output(), /Run one now/);
		});
	});

	describe("across restarts and processes", () => {
		let projectRoot: string;
		const servers: DevServer[] = [];

		after(async () => {
			try {
				await Promise.all(servers.map((server) => server.stop()));
			} finally {
				await rm(projectRoot, { force: true, recursive: true });
			}
		});

		it("skips ticks missed while stopped, stops a removed cron, and runs each tick once across two processes", { timeout: 7 * minuteMs }, async () => {
			projectRoot = await createProject([throwingCron, passingCron]);
			const first = await startDev(projectRoot);
			servers.push(first);
			await first.stop();
			const stoppedAt = Date.now();
			// Stay stopped until more than a minute after the next tick. Orange still
			// runs a tick that a restart delayed by less than a minute.
			await delay(minuteMs - (stoppedAt % minuteMs) + minuteMs + 2_000);

			await writeConfig(projectRoot, [throwingCron]);
			const restartedAt = Date.now();
			// A start that fails must not leave the other start running past `after`.
			const starts = await Promise.allSettled([startDev(projectRoot), startDev(projectRoot)]);
			const restarted: DevServer[] = [];
			for (const start of starts) {
				if (start.status === "fulfilled") restarted.push(start.value);
			}
			servers.push(...restarted);
			for (const start of starts) {
				if (start.status === "rejected") throw start.reason;
			}
			const [server] = restarted;
			assert.ok(server !== undefined);

			// Every run of a tick is visible once the next tick has run.
			const runs = await waitForTicks(server, throwingCron, 2, restartedAt);
			for (const tick of tickTimes(runs, throwingCron, restartedAt).slice(0, -1)) {
				assert.equal(
					runs.filter((run) => run.cron === throwingCron && run.scheduledTime === tick).length,
					1,
					`tick ${tick} ran more than once: ${JSON.stringify(runs)}`,
				);
			}
			assert.deepEqual(tickTimes(runs, passingCron, restartedAt), []);
			assert.deepEqual(
				runs.filter((run) => run.scheduledTime > stoppedAt && run.scheduledTime < restartedAt),
				[],
				"a tick missed while orange dev was stopped ran after the restart",
			);

			// When one of two processes on the same storage exits, the other still serves.
			const [exiting, remaining] = restarted;
			assert.ok(exiting !== undefined && remaining !== undefined);
			await exiting.stop();
			await readRuns(remaining);
		});
	});
});
