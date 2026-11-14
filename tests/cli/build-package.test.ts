import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { isBuiltin } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { pathToFileURL } from "node:url";

import { init, parse } from "es-module-lexer";

import { buildPackage } from "../../src/build/build-package.js";
import { runtimeModuleEntrypoints } from "../../src/build/rewrite-module-imports.js";

// Maps a packaged artifact such as `node/assert-strict` or `node-fs-promises` back to the
// `node:` specifier a Worker imports.
function nodeSpecifier(artifact: string): string | undefined {
	if (artifact.startsWith("node/")) {
		return `node:${artifact.slice("node/".length).replace("-", "/")}`;
	}
	if (artifact === "node-fs") return "node:fs";
	if (artifact === "node-fs-promises") return "node:fs/promises";
	if (artifact === "node-http") return "node:http";
	return undefined;
}

// Reduces `@scope/name/sub/path` or `name/sub/path` to the package name npm installs.
function packageName(specifier: string): string {
	const parts = specifier.split("/");
	return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

// Collects every package a built file loads at runtime: static imports,
// `export from`, literal dynamic imports, and literal `require` calls.
function bareImports(source: string): string[] {
	const specifiers = parse(source)[0].flatMap((entry) =>
		entry.n === undefined ? [] : [entry.n],
	);
	for (const match of source.matchAll(/\brequire\(\s*(["'])([^"']+)\1\s*\)/g)) {
		specifiers.push(match[2]);
	}
	return specifiers.filter(
		(specifier) =>
			!specifier.startsWith(".") &&
			!specifier.startsWith("/") &&
			!specifier.startsWith("file:") &&
			!isBuiltin(specifier),
	);
}

// The export names of each module in a plain Node process that runs a script file. The test
// runner's own process is no oracle: the tsx CLI that runs it adds an own `emit` to `process`, and
// `--eval` adds `_eval`, so either looks like a stock `node:process` export.
async function stockExports(specifiers: readonly string[]): Promise<Map<string, string[]>> {
	const directory = await mkdtemp(join(tmpdir(), "open-orange-stock-exports-"));
	try {
		const script = join(directory, "stock-exports.mjs");
		await writeFile(
			script,
			`const names = {};
for (const specifier of ${JSON.stringify(specifiers)}) names[specifier] = Object.keys(await import(specifier));
process.stdout.write(JSON.stringify(names));`,
		);
		const { NODE_OPTIONS: _nodeOptions, ...environment } = process.env;
		const output = execFileSync(process.execPath, [script], { encoding: "utf8", env: environment });
		const parsed: unknown = JSON.parse(output);
		assert.ok(typeof parsed === "object" && parsed !== null, output);
		const stock = new Map<string, string[]>();
		for (const [specifier, names] of Object.entries(parsed)) {
			assert.ok(Array.isArray(names) && names.every((name) => typeof name === "string"), output);
			stock.set(specifier, names);
		}
		return stock;
	} finally {
		await rm(directory, { force: true, recursive: true });
	}
}

describe("packaged node: modules", () => {
	let outputDirectory: string;

	before(async () => {
		outputDirectory = await mkdtemp(join(tmpdir(), "open-orange-package-"));
		await buildPackage(outputDirectory);
	});

	after(async () => {
		await rm(outputDirectory, { force: true, recursive: true });
	});

	it("when a Worker imports any stock export of a shimmed node: module from the built package, the export exists", async () => {
		const missing: string[] = [];
		const artifacts = Object.keys(runtimeModuleEntrypoints).flatMap((artifact) => {
			const specifier = nodeSpecifier(artifact);
			return specifier === undefined ? [] : [{ artifact, specifier }];
		});
		const stock = await stockExports(artifacts.map(({ specifier }) => specifier));
		for (const { artifact, specifier } of artifacts) {
			const packaged = await import(
				pathToFileURL(join(outputDirectory, "runtime", `${artifact}.js`)).href
			);
			for (const name of stock.get(specifier) ?? []) {
				if (!(name in packaged)) missing.push(`${specifier} ${name}`);
			}
		}
		assert.deepEqual(missing, []);
	});

	it("when the published package runs, every package its built output imports is a declared dependency", async () => {
		await init;
		const manifest = JSON.parse(await readFile("package.json", "utf8"));
		const declared = new Set(
			[
				manifest.dependencies,
				manifest.optionalDependencies,
				manifest.peerDependencies,
			].flatMap((dependencies) => Object.keys(dependencies ?? {})),
		);
		const undeclared = new Set<string>();
		const files = await readdir(outputDirectory, { recursive: true });
		for (const file of files) {
			if (!/\.(c|m)?js$/.test(file)) continue;
			const source = await readFile(join(outputDirectory, file), "utf8");
			for (const specifier of bareImports(source)) {
				const name = packageName(specifier);
				if (!declared.has(name)) undeclared.add(`${name} (${file})`);
			}
		}
		assert.deepEqual([...undeclared].sort(), []);
	});
});
