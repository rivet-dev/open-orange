import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { join } from "node:path";

import type { Scenario } from "../../src/real-projects/scenario.js";

// Puppeteer's default viewport. Kitesurf answers a failed render with a 1 × 1 PNG.
const viewport = { width: 800, height: 600 };

function pngSize(png: Uint8Array): { width: number; height: number } {
	const bytes = Buffer.from(png);
	assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", "not a PNG");
	return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

// Kitesurf's own e2e tests load pages this way.
const moduleScriptPage = `data:text/html;charset=utf-8,${encodeURIComponent(
	'<!doctype html><title>before</title><script type="module">document.title = "module ran";</script>',
)}`;

// The README's flow: Puppeteer over CDP. Each navigation runs the page in a dynamic Worker,
// and screenshots come from a renderer dynamic Worker.
const scenario: Scenario = async (t) => {
	await t.step("the engine answers its health check", "http", async () => {
		assert.equal((await t.fetch("/health")).status, 200);
	});

	const puppeteer = createRequire(join(t.directory, "package.json"))("puppeteer-core");
	let browser: any;
	let page: any;
	await t.step("Puppeteer connects through the discovered browser WebSocket", "http", async () => {
		const { webSocketDebuggerUrl } = await t.json<{ webSocketDebuggerUrl: string }>("/json/version");
		browser = await puppeteer.connect({ browserWSEndpoint: webSocketDebuggerUrl, protocolTimeout: 180_000 });
		page = await browser.newPage();
	});
	try {
		await t.step("a navigation loads example.com", "worker-loader", async () => {
			const response = await page.goto("https://example.com/", { timeout: 180_000 });
			assert.equal(response?.status(), 200);
		});
		await t.step("evaluate reads the loaded document", "worker-loader", async () => {
			assert.equal(await page.evaluate("document.title"), "Example Domain");
		});
		let first: Uint8Array | undefined;
		await t.step("a screenshot renders the page", "worker-loader", async () => {
			first = await page.screenshot();
			assert.deepEqual(pngSize(first!), viewport);
		});
		await t.step("a second navigation in the same tab loads another page", "worker-loader", async () => {
			await page.goto("https://en.wikipedia.org/wiki/Kiteboarding", { timeout: 180_000 });
			assert.equal(await page.evaluate("document.title"), "Kiteboarding - Wikipedia");
		});
		await t.step("a screenshot renders the second page", "worker-loader", async () => {
			const second: Uint8Array = await page.screenshot();
			assert.deepEqual(pngSize(second), viewport);
			assert.notDeepEqual(Buffer.from(second), Buffer.from(first ?? []));
		});
		await t.step("a page's module script runs", "worker-loader", async () => {
			await page.goto(moduleScriptPage, { timeout: 180_000 });
			assert.equal(await page.evaluate("document.title"), "module ran");
		});
	} finally {
		await browser?.disconnect();
	}
};

export default scenario;
