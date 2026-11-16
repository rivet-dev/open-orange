import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, matchesGlob } from "node:path";

import { repositoryRoot } from "./orange-dev.js";

export const migratorToken = "migrator-test-token";

export interface CloudflareSource {
	close(): Promise<void>;
	origin: string;
	output(): string;
}

interface MiniflareInstance {
	ready: Promise<URL>;
	dispose(): Promise<void>;
}

interface MiniflareModule {
	Log: new (level: number) => { log(message: string): void };
	LogLevel: { INFO: number };
	Miniflare: new (options: unknown) => MiniflareInstance;
	convertV4MiniflareOptions(options: Record<string, unknown>): unknown;
}

interface WranglerModule {
	unstable_getMiniflareWorkerOptions(configPath: string): {
		workerOptions: Record<string, unknown> & { modulesRules?: { type: string; include: string[] }[] };
	};
}

// The pinned Wrangler, and the Miniflare it runs, so the runtime is the one `wrangler dev` would use.
// Loaded untyped: their declarations need Cloudflare's own types, which this repo does not install.
const requireFromHere = createRequire(import.meta.url);
const { unstable_getMiniflareWorkerOptions } = requireFromHere("wrangler") as WranglerModule;
const { Log, LogLevel, Miniflare, convertV4MiniflareOptions } = createRequire(requireFromHere.resolve("wrangler"))("miniflare") as MiniflareModule;

// What a failed request to a source needs to tell a dead source from other failures.
const sourceStates = new Map<string, () => string>();

export function describeSource(origin: string): string {
	return sourceStates.get(origin)?.() ?? "";
}

/**
 * Runs the prepared Worker on real workerd through Miniflare, so the export route, the dirty check,
 * and the block after a move are the migrator's real code on the real runtime. Only Cloudflare's
 * network is missing.
 *
 * `wrangler dev` would put a proxy Worker in its own workerd process in front of the Worker, with
 * keep-alive connections between the two that drop a request when one of them times out. Cloudflare
 * has no such hop, so the source runs the Worker in one process. Its storage is kept under the
 * project's `.wrangler/state/v3`, as `wrangler dev` keeps it, so a source started again on the same
 * port has the same data, as Cloudflare does after an outage.
 */
export async function startCloudflareSource(
	projectDirectory: string,
	port = 0,
	vars: Readonly<Record<string, string>> = {},
): Promise<CloudflareSource> {
	const devVars = { WORKER_MIGRATOR_TOKEN: migratorToken, ...vars };
	await writeFile(join(projectDirectory, ".dev.vars"), Object.entries(devVars).map(([name, value]) => `${name}=${value}\n`).join(""));
	const config = join(projectDirectory, "wrangler.migrate.jsonc");
	// Wrangler bundles the Worker as `wrangler deploy` would, without deploying it.
	const outdir = join(projectDirectory, ".wrangler", "source-bundle");
	const built = spawnSync(
		process.execPath,
		[join(repositoryRoot, "node_modules", "wrangler", "bin", "wrangler.js"), "deploy", "--dry-run", "--outdir", outdir, "--config", config],
		{ cwd: projectDirectory, encoding: "utf8", env: { ...process.env, CI: "1", NO_COLOR: "1", WRANGLER_SEND_METRICS: "false" } },
	);
	if (built.status !== 0) throw new Error(`wrangler could not bundle the prepared Worker:\n${built.stdout}${built.stderr}`);

	let output = "";
	class OutputLog extends Log {
		override log(message: string): void {
			output += `${message}\n`;
		}
	}
	const { modulesRules = [], ...workerOptions } = unstable_getMiniflareWorkerOptions(config).workerOptions;
	// The bundle is worker.js plus the files that `find_additional_modules` keeps, such as text that
	// the Worker reads from /bundle. Each one is a module, typed by the project's first matching rule.
	const modules = readdirSync(outdir, { recursive: true, encoding: "utf8" })
		.filter((path) => path === "worker.js" || (path !== "README.md" && !path.endsWith(".map") && modulesRules.some((rule) => rule.include.some((glob) => matchesGlob(path, glob)))))
		.sort((a, b) => Number(b === "worker.js") - Number(a === "worker.js"))
		.map((path) => ({
			path: join(outdir, path),
			type: path === "worker.js" ? "ESModule" : modulesRules.find((rule) => rule.include.some((glob) => matchesGlob(path, glob)))!.type,
		}));
	// Wrangler's options use Miniflare's v4 shape, which Wrangler converts the same way.
	const miniflare = new Miniflare(
		convertV4MiniflareOptions({
			host: "127.0.0.1",
			port,
			resourcePersistencePath: join(projectDirectory, ".wrangler", "state", "v3"),
			log: new OutputLog(LogLevel.INFO),
			workers: [{ ...workerOptions, modules, modulesRoot: outdir }],
		}),
	);
	const origin = (await miniflare.ready).origin;
	let closed = false;
	sourceStates.set(origin, () => `the source ${closed ? "was closed" : "still runs"}\n${output.slice(-2_000)}`);
	return {
		async close(): Promise<void> {
			if (closed) return;
			closed = true;
			await miniflare.dispose();
		},
		origin,
		output: () => output,
	};
}
