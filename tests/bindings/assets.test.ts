import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { get as httpGet } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

// Drives Wrangler's static assets through a real `orange dev` process and
// real HTTP requests.

const cliEntrypoint = fileURLToPath(new URL("../../src/bin.ts", import.meta.url));

const worker = `export default {
	async fetch(request, env) {
		const url = new URL(request.url);
		if (url.pathname === "/api/assets") {
			return env.ASSETS.fetch(new URL(url.searchParams.get("path"), url));
		}
		return new Response("worker " + url.pathname);
	},
};
`;

const publicFiles: Record<string, string> = {
	"public/.assetsignore": "secret.txt\n",
	"public/about.html": "about page",
	"public/api/data.json": '{"from":"asset"}',
	"public/api/static/info.txt": "static info",
	"public/docs/index.html": "docs index",
	"public/index.html": "<h1>home</h1>",
	"public/secret.txt": "secret value",
};

interface DevServer {
	origin: string;
	stop(): Promise<void>;
}

interface Project {
	root: string;
	server: DevServer;
}

function startDev(projectRoot: string): {
	exit: Promise<{ code: number | null; output: string }>;
	ready: Promise<DevServer>;
} {
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
		],
		{ env: { ...process.env, CI: "1", NO_COLOR: "1" }, stdio: ["ignore", "pipe", "pipe"] },
	);
	let output = "";
	const exit = new Promise<{ code: number | null; output: string }>((resolveExit) => {
		child.once("exit", (code) => resolveExit({ code, output }));
	});
	const ready = new Promise<DevServer>((resolveReady, rejectReady) => {
		const timeout = setTimeout(() => {
			child.kill("SIGKILL");
			rejectReady(new Error(`orange dev readiness timed out: ${output}`));
		}, 60_000);
		const onData = (chunk: unknown): void => {
			output += String(chunk);
			const match = /Local\s+(http:\/\/127\.0\.0\.1:\d+)/.exec(output);
			if (match?.[1] !== undefined) {
				clearTimeout(timeout);
				resolveReady({
					origin: match[1],
					async stop(): Promise<void> {
						if (child.exitCode === null && child.signalCode === null) {
							child.kill("SIGINT");
							await exit;
						}
					},
				});
			}
		};
		child.stdout?.on("data", onData);
		child.stderr?.on("data", onData);
		void exit.then(({ code }) => {
			clearTimeout(timeout);
			rejectReady(new Error(`orange dev exited before readiness (code ${code}): ${output}`));
		});
	});
	return { exit, ready };
}

async function writeProject(
	configuration: Record<string, unknown>,
	files: Record<string, string>,
): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "open-orange-assets-"));
	await writeFile(join(root, "wrangler.json"), JSON.stringify(configuration));
	for (const [path, contents] of Object.entries(files)) {
		await mkdir(dirname(join(root, path)), { recursive: true });
		await writeFile(join(root, path), contents);
	}
	return root;
}

async function startProject(
	configuration: Record<string, unknown>,
	files: Record<string, string>,
): Promise<Project> {
	const root = await writeProject(configuration, files);
	try {
		return { root, server: await startDev(root).ready };
	} catch (error: unknown) {
		await rm(root, { force: true, recursive: true });
		throw error;
	}
}

async function stopProject(project: Project | undefined): Promise<void> {
	if (project === undefined) return;
	await project.server.stop();
	await rm(project.root, { force: true, recursive: true });
}

async function get(
	project: Project | undefined,
	path: string,
	init: RequestInit = {},
): Promise<{ body: string; headers: Headers; status: number }> {
	assert.ok(project !== undefined);
	const response = await fetch(new URL(path, project.server.origin), {
		...init,
		redirect: "manual",
	});
	return { body: await response.text(), headers: response.headers, status: response.status };
}

// fetch() always sends its own Sec-Fetch-Mode, so a browser navigation needs
// a plain HTTP request.
function navigate(project: Project | undefined, path: string): Promise<string> {
	assert.ok(project !== undefined);
	const url = new URL(path, project.server.origin);
	return new Promise((resolveBody, rejectBody) => {
		httpGet(url, { headers: { "Sec-Fetch-Mode": "navigate" } }, (response) => {
			let body = "";
			response.setEncoding("utf8");
			response.on("data", (chunk: string) => {
				body += chunk;
			});
			response.once("end", () => resolveBody(body));
		}).once("error", rejectBody);
	});
}

describe("a Worker with assets, an SPA fallback, and run_worker_first rules", () => {
	let project: Project | undefined;

	before(async () => {
		project = await startProject(
			{
				assets: {
					binding: "ASSETS",
					directory: "./public",
					not_found_handling: "single-page-application",
					run_worker_first: ["/api/*", "!/api/static/*"],
				},
				compatibility_date: "2026-09-03",
				main: "./worker.js",
				name: "assets-e2e",
			},
			{ ...publicFiles, "worker.js": worker },
		);
	});

	after(async () => {
		await stopProject(project);
	});

	it("serves an asset with its content type and ETag, and 304 for a matching If-None-Match", async () => {
		const home = await get(project, "/");
		assert.equal(home.status, 200);
		assert.equal(home.body, "<h1>home</h1>");
		assert.equal(home.headers.get("content-type"), "text/html; charset=utf-8");
		assert.equal(home.headers.get("cache-control"), "public, max-age=0, must-revalidate");
		const eTag = home.headers.get("etag");
		assert.match(eTag ?? "", /^"[0-9a-f]{32}"$/);

		const notModified = await get(project, "/", { headers: { "If-None-Match": `W/${eTag}` } });
		assert.equal(notModified.status, 304);
		assert.equal(notModified.body, "");

		const head = await get(project, "/api/static/info.txt", { method: "HEAD" });
		assert.equal(head.status, 200);
		assert.equal(head.headers.get("content-type"), "text/plain; charset=utf-8");
		assert.equal(head.body, "");
	});

	it("redirects HTML paths to their canonical form", async () => {
		const aboutHtml = await get(project, "/about.html");
		assert.equal(aboutHtml.status, 307);
		assert.equal(aboutHtml.headers.get("location"), "/about");
		assert.equal((await get(project, "/about")).body, "about page");

		const docs = await get(project, "/docs?tab=1");
		assert.equal(docs.status, 307);
		assert.equal(docs.headers.get("location"), "/docs/?tab=1");
		assert.equal((await get(project, "/docs/")).body, "docs index");
	});

	it("runs the Worker first only for matching rules and serves everything else from assets", async () => {
		// The asset exists, but the run_worker_first rule sends it to the Worker.
		assert.equal((await get(project, "/api/data.json")).body, "worker /api/data.json");
		// The negated rule sends this path back to assets.
		assert.equal((await get(project, "/api/static/info.txt")).body, "static info");
		// With route rules, a missing path uses the SPA fallback instead of the Worker.
		const missing = await get(project, "/settings/profile");
		assert.equal(missing.status, 200);
		assert.equal(missing.body, "<h1>home</h1>");
		// An asset accepts only GET and HEAD.
		assert.equal((await get(project, "/about", { method: "POST" })).status, 405);
		// .assetsignore keeps a file out of the assets, along with itself.
		assert.equal((await get(project, "/secret.txt")).body, "<h1>home</h1>");
		assert.equal((await get(project, "/.assetsignore")).body, "<h1>home</h1>");
	});

	it("serves assets through env.ASSETS.fetch() and follows their redirects", async () => {
		const about = await get(project, "/api/assets?path=/about.html");
		assert.equal(about.status, 200);
		assert.equal(about.body, "about page");
		const fallback = await get(project, "/api/assets?path=/no/such/page");
		assert.equal(fallback.status, 200);
		assert.equal(fallback.body, "<h1>home</h1>");
	});

	it("serves a file added while orange dev runs", async () => {
		assert.ok(project !== undefined);
		await writeFile(join(project.root, "public", "late.txt"), "added later");
		const late = await get(project, "/late.txt");
		assert.equal(late.status, 200);
		assert.equal(late.body, "added later");
	});
});

describe("a Worker with an SPA fallback and no route rules", () => {
	let project: Project | undefined;

	before(async () => {
		project = await startProject(
			{
				assets: { directory: "./public", not_found_handling: "single-page-application" },
				compatibility_date: "2026-09-03",
				main: "./worker.js",
				name: "assets-navigation-e2e",
			},
			{ ...publicFiles, "worker.js": worker },
		);
	});

	after(async () => {
		await stopProject(project);
	});

	it("sends a missing path to the Worker unless the browser navigates to it", async () => {
		assert.equal((await get(project, "/missing")).body, "worker /missing");
		assert.equal(await navigate(project, "/missing"), "<h1>home</h1>");
	});
});

describe("an assets-only project", () => {
	let project: Project | undefined;

	before(async () => {
		project = await startProject(
			{
				assets: {
					directory: "./site",
					html_handling: "drop-trailing-slash",
					not_found_handling: "404-page",
				},
				compatibility_date: "2026-09-03",
				name: "assets-only-e2e",
			},
			{
				"site/404.html": "root not found",
				"site/blog/404.html": "blog not found",
				"site/blog/index.html": "blog index",
			},
		);
	});

	after(async () => {
		await stopProject(project);
	});

	it("drops trailing slashes and serves the nearest 404.html with status 404", async () => {
		const blogSlash = await get(project, "/blog/");
		assert.equal(blogSlash.status, 307);
		assert.equal(blogSlash.headers.get("location"), "/blog");
		assert.equal((await get(project, "/blog")).body, "blog index");

		const blogMissing = await get(project, "/blog/2020/missing");
		assert.equal(blogMissing.status, 404);
		assert.equal(blogMissing.body, "blog not found");
		const rootMissing = await get(project, "/missing.js");
		assert.equal(rootMissing.status, 404);
		assert.equal(rootMissing.body, "root not found");
	});
});

it("stops orange dev when the assets directory does not exist", async () => {
	const root = await writeProject(
		{
			assets: { directory: "./dist" },
			compatibility_date: "2026-09-03",
			main: "./worker.js",
			name: "assets-missing-e2e",
		},
		{ "worker.js": worker },
	);
	try {
		const { exit, ready } = startDev(root);
		ready.catch(() => undefined);
		const result = await exit;
		assert.equal(result.code, 1);
		assert.match(
			result.output,
			/The directory specified by the "assets.directory" field in your configuration file does not exist:\n.*\/dist/,
		);
	} finally {
		await rm(root, { force: true, recursive: true });
	}
});
