import assert from "node:assert/strict";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { freePort } from "./free-port.js";
import { copyProject, repositoryRoot, startOrangeDev, type TemporaryProject, withDeadline } from "./orange-dev.js";

// A real headless Chromium: OPEN_ORANGE_TEST_CHROMIUM, or the headless shell that Playwright installs.
// OPEN_ORANGE_TEST_CHROMIUM_LIBS adds a directory of shared libraries, for a machine without them.
function chromiumPath(): string | undefined {
	const configured = process.env.OPEN_ORANGE_TEST_CHROMIUM;
	if (configured !== undefined && configured.length > 0) return configured;
	const cache = join(homedir(), ".cache", "ms-playwright");
	if (!existsSync(cache)) return undefined;
	for (const entry of readdirSync(cache).filter((name) => name.startsWith("chromium_headless_shell-")).sort().reverse()) {
		for (const candidate of ["chrome-linux/headless_shell", "chrome-headless-shell-linux64/chrome-headless-shell"]) {
			if (existsSync(join(cache, entry, candidate))) return join(cache, entry, candidate);
		}
	}
	return undefined;
}

const chromiumLibraries = process.env.OPEN_ORANGE_TEST_CHROMIUM_LIBS;
const chromiumEnvironment = {
	...process.env,
	...(chromiumLibraries === undefined
		? {}
		: { LD_LIBRARY_PATH: [chromiumLibraries, process.env.LD_LIBRARY_PATH].filter(Boolean).join(":") }),
};
const chromium = chromiumPath();
// A Chromium that is installed but cannot start, such as one missing shared libraries, skips too.
const chromiumProbe = chromium === undefined ? undefined : spawnSync(chromium, ["--version"], { encoding: "utf8", env: chromiumEnvironment });
const chromiumSkip =
	chromium === undefined
		? "needs a headless Chromium: set OPEN_ORANGE_TEST_CHROMIUM"
		: chromiumProbe?.status !== 0
			? `Chromium at ${chromium} cannot start: ${chromiumProbe?.stderr.trim().split("\n")[0] ?? ""}. Set OPEN_ORANGE_TEST_CHROMIUM_LIBS`
			: false;

// A skip counts toward a passing run, so a CI without Chromium would look green. Say so loudly.
if (chromiumSkip !== false) {
	const rule = "!".repeat(78);
	process.stderr.write(
		`\n${rule}\n! SKIPPED: the Browser Rendering test with a real headless Chromium did not run.\n! ${chromiumSkip}\n${rule}\n\n`,
	);
}

async function startChromium(): Promise<{ endpoint: string; stop(): Promise<void> }> {
	const profile = await mkdtemp(join(tmpdir(), "oo-chromium-"));
	const child: ChildProcess = spawn(
		chromium!,
		["--headless", "--no-sandbox", "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"],
		{ env: chromiumEnvironment, stdio: ["ignore", "ignore", "pipe"] },
	);
	let output = "";
	const listening = new Promise<string>((resolveListening, rejectListening) => {
		child.stderr?.on("data", (chunk: Buffer) => {
			output += chunk.toString();
			const match = /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//.exec(output);
			if (match !== null) resolveListening(`http://127.0.0.1:${match[1]}`);
		});
		child.once("exit", (code) => rejectListening(new Error(`Chromium exited with ${code}:\n${output}`)));
	});
	const endpoint = await withDeadline(listening, "Chromium start", 30_000);
	return {
		endpoint,
		async stop() {
			if (child.exitCode === null) {
				const exited = new Promise((resolveExit) => child.once("exit", resolveExit));
				child.kill("SIGKILL");
				await exited;
			}
			await rm(profile, { force: true, recursive: true });
		},
	};
}

async function startPageServer(): Promise<{ server: Server; url: string }> {
	const server = createServer((_request, response) => {
		response.setHeader("content-type", "text/html");
		response.end("<!doctype html><title>Orange page</title><h1>Hello from the page</h1>");
	});
	await new Promise<void>((listening) => server.listen(0, "127.0.0.1", listening));
	const address = server.address();
	assert.ok(address !== null && typeof address !== "string");
	return { server, url: `http://127.0.0.1:${address.port}/page` };
}

// The fixture imports @cloudflare/puppeteer, which the repository installs.
async function browserProject(): Promise<TemporaryProject> {
	const project = await copyProject(join(repositoryRoot, "tests", "fixtures", "browser-rendering"));
	await mkdir(join(project.directory, "node_modules", "@cloudflare"), { recursive: true });
	await symlink(join(repositoryRoot, "node_modules", "@cloudflare", "puppeteer"), join(project.directory, "node_modules", "@cloudflare", "puppeteer"));
	return project;
}

test("a Worker drives a real headless Chromium through @cloudflare/puppeteer, and closing its browser closes only its own pages", { skip: chromiumSkip, timeout: 180_000 }, async () => {
	const browser = await startChromium();
	const page = await startPageServer();
	const project = await browserProject();
	try {
		const dev = await startOrangeDev(project.directory, "wrangler.jsonc", { environment: { ORANGE_BROWSER_CDP_URL: browser.endpoint } });
		try {
			// A second launch works too: browser.close() in the first did not close the shared Chromium.
			for (let run = 0; run < 2; run += 1) {
				const response = await fetch(`${dev.origin}/?url=${encodeURIComponent(page.url)}`);
				assert.equal(response.status, 200, `${await response.clone().text()}\n${dev.output()}`);
				assert.deepEqual(await response.json(), { heading: "Hello from the page", sessionsAfterClose: 0, title: "Orange page" });
			}
		} finally {
			await dev.close();
		}
		const targets = (await (await fetch(`${browser.endpoint}/json/list`)).json()) as { type: string; url: string }[];
		assert.deepEqual(targets.filter((target) => target.url === page.url), [], "the Worker's pages are closed");
	} finally {
		await project.dispose();
		page.server.close();
		await browser.stop();
	}
});

test("without a browser endpoint BROWSER fails with the setting to configure, and with the browser down launch() names it", { timeout: 120_000 }, async () => {
	const project = await browserProject();
	try {
		const unconfigured = await startOrangeDev(project.directory, "wrangler.jsonc", { environment: { ORANGE_BROWSER_CDP_URL: "" } });
		try {
			const response = await fetch(`${unconfigured.origin}/?url=http://127.0.0.1/`);
			assert.equal(response.status, 500);
			assert.match(await response.text(), /Browser Rendering binding "BROWSER" is not supported by OpenOrange\. Set ORANGE_BROWSER_CDP_URL/);
		} finally {
			await unconfigured.close();
		}

		const closedPort = await freePort();
		const down = await startOrangeDev(project.directory, "wrangler.jsonc", {
			environment: { ORANGE_BROWSER_CDP_URL: `http://127.0.0.1:${closedPort}` },
		});
		try {
			const response = await fetch(`${down.origin}/?url=http://127.0.0.1/`);
			assert.equal(response.status, 500);
			assert.match(
				await response.text(),
				new RegExp(`Unable to create new browser: code: 503: message: Browser Rendering could not reach the browser at http://127\\.0\\.0\\.1:${closedPort}`),
			);
		} finally {
			await down.close();
		}
	} finally {
		await project.dispose();
	}
});

// A hosted browser, such as Browserbase, takes its key in the endpoint. Errors that the Worker reads
// name the endpoint without it.
test("when the browser endpoint refuses or does not answer, the Worker's error names the endpoint without its credentials", { timeout: 120_000 }, async () => {
	const secret = "sk_live_do-not-leak-0123456789";
	const refusing = createServer((_request, response) => {
		response.statusCode = 404;
		response.end();
	});
	refusing.on("upgrade", (_request, socket) => {
		socket.end("HTTP/1.1 401 Unauthorized\r\ncontent-length: 0\r\n\r\n");
	});
	await new Promise<void>((listening) => refusing.listen(0, "127.0.0.1", listening));
	const address = refusing.address();
	assert.ok(address !== null && typeof address !== "string");
	const project = await browserProject();
	try {
		const refused = await startOrangeDev(project.directory, "wrangler.jsonc", {
			environment: { ORANGE_BROWSER_CDP_URL: `ws://127.0.0.1:${address.port}/devtools/browser?apiKey=${secret}` },
		});
		try {
			const response = await fetch(`${refused.origin}/?devtools`);
			const answer = (await response.json()) as { body: string; status: number };
			assert.equal(answer.status, 502);
			assert.equal(
				answer.body,
				`Browser Rendering could not open the DevTools WebSocket at ws://127.0.0.1:${address.port}/devtools/browser: Unexpected server response: 401`,
			);
		} finally {
			await refused.close();
		}

		const closedPort = await freePort();
		const down = await startOrangeDev(project.directory, "wrangler.jsonc", {
			environment: { ORANGE_BROWSER_CDP_URL: `http://user:${secret}@127.0.0.1:${closedPort}/?token=${secret}` },
		});
		try {
			const response = await fetch(`${down.origin}/?url=http://127.0.0.1/`);
			assert.equal(response.status, 500);
			const message = await response.text();
			assert.match(message, new RegExp(`could not reach the browser at http://127\\.0\\.0\\.1:${closedPort} \\(ORANGE_BROWSER_CDP_URL\\)`));
			assert.equal(message.includes(secret), false, message);
		} finally {
			await down.close();
		}
	} finally {
		await project.dispose();
		refusing.close();
	}
});
