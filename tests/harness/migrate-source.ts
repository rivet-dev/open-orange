import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { repositoryRoot } from "./orange-dev.js";

export const migratorToken = "migrator-test-token";

export interface CloudflareSource {
	close(): Promise<void>;
	origin: string;
	output(): string;
}

// What a failed request to a source needs to tell the keep-alive race from other failures.
const sourceStates = new Map<string, () => string>();

export function describeSource(origin: string): string {
	return sourceStates.get(origin)?.() ?? "";
}

/**
 * Runs the prepared Worker on real workerd through `wrangler dev`, so the export route, the dirty
 * check, and the block after a move are the migrator's real code on the real runtime. Only
 * Cloudflare's network is missing.
 */
export async function startCloudflareSource(
	projectDirectory: string,
	port = 0,
	vars: Readonly<Record<string, string>> = {},
): Promise<CloudflareSource> {
	const devVars = { WORKER_MIGRATOR_TOKEN: migratorToken, ...vars };
	await writeFile(join(projectDirectory, ".dev.vars"), Object.entries(devVars).map(([name, value]) => `${name}=${value}\n`).join(""));
	const wrangler = join(repositoryRoot, "node_modules", "wrangler", "bin", "wrangler.js");
	const child = spawn(process.execPath, [wrangler, "dev", "--config", "wrangler.migrate.jsonc", "--port", String(port), "--ip", "127.0.0.1", "--inspector-port", "0", "--show-interactive-dev-session=false"], {
		cwd: projectDirectory,
		// Its own process group, so close() also stops workerd.
		detached: true,
		env: { ...process.env, CI: "1", NO_COLOR: "1", WRANGLER_SEND_METRICS: "false" },
		stdio: ["ignore", "pipe", "pipe"],
	});
	let output = "";
	child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
	child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
	let keepConnectionBusy: NodeJS.Timeout | undefined;
	const close = async (): Promise<void> => {
		clearInterval(keepConnectionBusy);
		if (child.exitCode !== null || child.signalCode !== null) return;
		const exited = new Promise((resolveExit) => child.once("exit", resolveExit));
		process.kill(-child.pid!, "SIGKILL");
		await exited;
	};
	const deadline = Date.now() + 60_000;
	for (;;) {
		const ready = /Ready on http:\/\/127\.0\.0\.1:(\d+)/.exec(output);
		if (ready !== null) {
			const origin = `http://127.0.0.1:${ready[1]}`;
			// `wrangler dev` forwards requests over keep-alive connections between its two workerd
			// processes, and each end drops an idle connection at 5 seconds. A request sent just before
			// that fails with `Network connection lost`, and `wrangler dev` then exits. Cloudflare has no
			// such hop. This route answers 401 in the Worker, so it wakes no object and writes nothing.
			// https://github.com/capnproto/capnproto/blob/aac38c2a569e0a4c592246aacc5318b3cb20a6f2/c%2B%2B/src/kj/compat/http.h#L1000
			// https://github.com/capnproto/capnproto/blob/aac38c2a569e0a4c592246aacc5318b3cb20a6f2/c%2B%2B/src/kj/compat/http.h#L1146
			let lastPing = Date.now();
			let longestPingGap = 0;
			keepConnectionBusy = setInterval(() => {
				void fetch(`${origin}/__migrate/`)
					.then((response) => {
						longestPingGap = Math.max(longestPingGap, Date.now() - lastPing);
						lastPing = Date.now();
						return response.body?.cancel();
					})
					.catch(() => undefined);
			}, 1_000);
			keepConnectionBusy.unref();
			sourceStates.set(
				origin,
				() =>
					`wrangler dev ${child.exitCode === null && child.signalCode === null ? "still runs" : `exited (${child.exitCode ?? child.signalCode})`}, longest gap between keep-alive pings ${longestPingGap} ms, last ping ${Date.now() - lastPing} ms ago\n${output.slice(-2_000)}`,
			);
			return { close, origin, output: () => output };
		}
		if (child.exitCode !== null || Date.now() > deadline) {
			await close();
			throw new Error(`wrangler dev did not start:\n${output}`);
		}
		await delay(50);
	}
}
