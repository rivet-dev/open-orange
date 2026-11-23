// Links a dynamic Worker's modules into plain files that Node.js can import
// with no module hooks. Each import specifier is rewritten at prepare time:
// another module of the Worker becomes a relative path, an Orange module
// rewrite becomes its file, and a module that does not exist becomes a module
// that throws workerd's error. A specifier computed at runtime resolves
// through agentOS's own resolver; see `packageFiles`.

import { isBuiltin } from "node:module";
import { posix } from "node:path";
import { pathToFileURL } from "node:url";

import { init, parse } from "es-module-lexer";

export type DynamicModuleType = "cjs" | "data" | "esm" | "json" | "text" | "wasm";

export interface DynamicModule {
	content: string | Uint8Array;
	name: string;
	type: DynamicModuleType;
}

export interface LinkedModules {
	// File path relative to the module directory, and its source.
	files: Map<string, string>;
	mainFile: string;
	// The module name of each file, for error locations.
	moduleNames: Record<string, string>;
}

type Target =
	| { kind: "builtin"; specifier: string }
	| { kind: "missing"; message: string }
	| { kind: "module"; name: string }
	| { kind: "rewrite"; path: string };

// A string literal specifier at source[start, end), quotes included.
interface ImportSite {
	end: number;
	start: number;
	// A static import or re-export fails linking when it cannot resolve.
	static: boolean;
	target: Target;
}

interface ScannedModule {
	// In source order.
	imports: ImportSite[];
	module: DynamicModule;
	source: string;
}

const missingDirectory = ".open-orange-missing";
const nestedDirectory = ".open-orange-nested";

/**
 * Where each module's content is in the bundle, relative to its root: its name, so `node:fs` reads
 * `/bundle/<name>`. Module names are opaque keys, so `a` and `a/b` can both exist, and a module whose
 * name is also the folder of another module's name goes under an escaped name instead.
 */
export function bundlePaths(modules: readonly DynamicModule[]): Map<string, string> {
	const folders = new Set<string>();
	for (const { name } of modules) {
		for (let slash = name.indexOf("/"); slash > 0; slash = name.indexOf("/", slash + 1)) {
			folders.add(name.slice(0, slash));
		}
	}
	return new Map(
		modules.map(({ name }) => [name, folders.has(name) ? `${nestedDirectory}/${encodeURIComponent(name)}` : name]),
	);
}

// The extension is always added, so a module's file never has the path of
// another module's package folder (see `packageFiles`).
function fileOf(module: DynamicModule): string {
	return `${module.name}${module.type === "cjs" ? ".cjs" : ".mjs"}`;
}

// workerd resolves every specifier against the importer, so `import(name)`
// finds the module of that name even when `name` is computed at runtime:
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/jsg/modules.c%2B%2B#L80-L91
// agentOS resolves a computed specifier itself. The linked files are in a
// node_modules directory, so a name that is not relative, such as
// `dir/a.js` or `https://a.invalid/b.js`, resolves to its file with `.mjs`
// or `.cjs` added. agentOS reads a name with one segment, such as `a.js` or
// `@scope/a`, as a package, so that module also gets a package.json whose
// main is its file.
function packageFiles(modules: readonly DynamicModule[]): Map<string, string> {
	const files = new Map<string, string>();
	for (const module of modules) {
		const name = posix.normalize(module.name);
		const segments = name.split("/").length;
		if (segments !== (name.startsWith("@") ? 2 : 1)) continue;
		files.set(`${name}/package.json`, JSON.stringify({ main: posix.relative(name, fileOf(module)) }));
	}
	return files;
}

function noSuchModule(name: string, importer: string): string {
	return `No such module "${name}".\n  imported from "${importer}"`;
}

// The stack names no file, so the error reads like the resolve error it
// replaces instead of pointing into the generated module.
function throwingSource(message: string): string {
	const text = JSON.stringify(message);
	return `const error = new Error(${text});\nerror.stack = "Error: " + ${text};\nthrow error;\n`;
}

// agentOS answers one read with one message of at most 16 MiB, with the bytes in base64. A 4 MiB
// read stays under it, so a module of any size loads.
const bytesReadChunk = 4 * 1024 * 1024;

// Reads the module's bytes from its file in the bundle. The bytes never become JavaScript source,
// so a text or JSON module is not capped by the 16 MiB file message either.
function bytesSource(path: string, name: string): string {
	return `import { closeSync, fstatSync, openSync, readSync } from "node:fs";
const fd = openSync(${JSON.stringify(path)}, "r");
let bytes;
try {
	bytes = new Uint8Array(fstatSync(fd).size);
	for (let offset = 0; offset < bytes.length; ) {
		const read = readSync(fd, bytes, offset, Math.min(${bytesReadChunk}, bytes.length - offset), offset);
		if (read === 0) throw new Error(${JSON.stringify(`Dynamic Worker module ${name} ended early`)});
		offset += read;
	}
} finally {
	closeSync(fd);
}
`;
}

// ignoreBOM keeps a leading U+FEFF in the string, as the module's content had it.
const textSource = `new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes)`;

// Text, data, JSON, and Wasm modules have a default export, as in workerd.
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/worker-loader.c%2B%2B#L273-L330
function valueModuleSource(module: DynamicModule, bundleFile: string): string {
	switch (module.type) {
		case "text":
			return `${bytesSource(bundleFile, module.name)}export default ${textSource};\n`;
		case "json":
			return `${bytesSource(bundleFile, module.name)}export default JSON.parse(${textSource});\n`;
		case "data":
			return `${bytesSource(bundleFile, module.name)}export default bytes.buffer;\n`;
		case "wasm":
			return `${bytesSource(bundleFile, module.name)}export default new WebAssembly.Module(bytes);\n`;
		case "cjs":
		case "esm":
			throw new Error(`Module "${module.name}" is not a value module`);
	}
}

function resolveTarget(
	specifier: string,
	importer: string,
	names: ReadonlySet<string>,
	rewrites: Readonly<Record<string, string>>,
): Target {
	const rewrite =
		rewrites[specifier] ?? (isBuiltin(specifier) ? rewrites[`node:${specifier}`] : undefined);
	if (rewrite !== undefined) return { kind: "rewrite", path: rewrite };
	if (specifier.startsWith("cloudflare:")) {
		return { kind: "missing", message: noSuchModule(specifier, importer) };
	}
	if (isBuiltin(specifier)) return { kind: "builtin", specifier };
	const name = /^\.{0,2}\//.test(specifier)
		? posix.normalize(posix.join(posix.dirname(importer), specifier)).replace(/^\/+/, "")
		: specifier;
	if (names.has(name)) return { kind: "module", name };
	return { kind: "missing", message: noSuchModule(name, importer) };
}

// Finds `require("literal")` calls, skipping comments, strings, templates,
// and regular expression literals. Returns each literal's range with quotes.
function requireRanges(source: string): { end: number; specifier: string; start: number }[] {
	const ranges: { end: number; specifier: string; start: number }[] = [];
	const regexPrefix = "(,=:[!&|?{};+-*%<>~^";
	let previous = "";
	let i = 0;
	const skipString = (quote: string): number => {
		let j = i + 1;
		while (j < source.length && source[j] !== quote) {
			if (source[j] === "\\") j++;
			else if (source[j] === "\n" && quote !== "`") break;
			j++;
		}
		return j + 1;
	};
	while (i < source.length) {
		const char = source[i] ?? "";
		const next = source[i + 1];
		if (char === "/" && next === "/") {
			const end = source.indexOf("\n", i);
			i = end === -1 ? source.length : end;
			continue;
		}
		if (char === "/" && next === "*") {
			const end = source.indexOf("*/", i + 2);
			i = end === -1 ? source.length : end + 2;
			continue;
		}
		if (char === "/" && (previous === "" || regexPrefix.includes(previous))) {
			let j = i + 1;
			let inClass = false;
			while (j < source.length && source[j] !== "\n") {
				const c = source[j];
				if (c === "\\") j++;
				else if (c === "[") inClass = true;
				else if (c === "]") inClass = false;
				else if (c === "/" && !inClass) break;
				j++;
			}
			i = j + 1;
			previous = "/";
			continue;
		}
		if (char === '"' || char === "'" || char === "`") {
			i = skipString(char);
			previous = char;
			continue;
		}
		if (/\s/.test(char)) {
			i++;
			continue;
		}
		const isWordStart = /[A-Za-z_$]/.test(char) && !/[\w$.]/.test(source[i - 1] ?? "");
		if (isWordStart && source.startsWith("require", i) && !/[\w$]/.test(source[i + 7] ?? "")) {
			const call = /^require\s*\(\s*(["'])((?:(?!\1)[^\\\n])*)\1\s*\)/.exec(source.slice(i));
			if (call !== null) {
				const start = i + call[0].indexOf(call[1] ?? "");
				const specifier = call[2] ?? "";
				ranges.push({ end: start + specifier.length + 2, specifier, start });
				i += call[0].length;
				previous = ")";
				continue;
			}
		}
		if (/[\w$]/.test(char)) {
			while (i < source.length && /[\w$]/.test(source[i] ?? "")) i++;
			previous = "a";
			continue;
		}
		previous = char;
		i++;
	}
	return ranges;
}

// Finds each literal specifier's exact source range, so the linked module
// keeps every other byte, and with it stack trace lines and columns. A module
// that does not parse stays as written, so Node.js reports its own error.
async function scanModule(
	module: DynamicModule,
	names: ReadonlySet<string>,
	rewrites: Readonly<Record<string, string>>,
): Promise<ScannedModule> {
	const source = typeof module.content === "string" ? module.content : "";
	const imports: ImportSite[] = [];
	const target = (specifier: string): Target =>
		resolveTarget(specifier, module.name, names, rewrites);
	if (module.type === "cjs") {
		for (const { end, specifier, start } of requireRanges(source)) {
			imports.push({ end, start, static: false, target: target(specifier) });
		}
		return { imports, module, source };
	}
	await init;
	let parsed: ReturnType<typeof parse>[0];
	try {
		[parsed] = parse(source, module.name);
	} catch {
		return { imports, module, source };
	}
	for (const entry of parsed) {
		// Type 3 is import.meta. A dynamic import of an expression resolves at
		// runtime.
		if (entry.t === 3 || entry.n === undefined) continue;
		const isStaticImport = entry.d === -1;
		const start = isStaticImport ? entry.s - 1 : entry.s;
		const end = isStaticImport ? entry.e + 1 : entry.e;
		imports.push({ end, start, static: isStaticImport, target: target(entry.n) });
	}
	return { imports, module, source };
}

export async function linkModules(
	modules: readonly DynamicModule[],
	mainModule: string,
	rewrites: Readonly<Record<string, string>>,
	// Where the modules as written are, so data and Wasm modules read their bytes there.
	bundleRoot: string,
): Promise<LinkedModules> {
	const names = new Set(modules.map((module) => module.name));
	const byName = new Map(modules.map((module) => [module.name, module]));
	const paths = bundlePaths(modules);
	const scanned = new Map<string, ScannedModule>();
	await Promise.all(
		modules.map(async (module) => {
			if (module.type === "esm" || module.type === "cjs") {
				scanned.set(module.name, await scanModule(module, names, rewrites));
			}
		}),
	);

	// A static import that cannot resolve fails linking for its importer and
	// for every module that statically imports that importer.
	const broken = new Map<string, string>();
	let changed = true;
	while (changed) {
		changed = false;
		for (const [name, { imports }] of scanned) {
			if (broken.has(name)) continue;
			for (const site of imports) {
				if (!site.static) continue;
				let message: string | undefined;
				if (site.target.kind === "missing") message = site.target.message;
				else if (site.target.kind === "module") message = broken.get(site.target.name);
				if (message === undefined) continue;
				broken.set(name, message);
				changed = true;
				break;
			}
		}
	}

	const files = new Map<string, string>();
	const moduleNames: Record<string, string> = {};
	let missingCount = 0;
	for (const module of modules) {
		const file = fileOf(module);
		moduleNames[file] = module.name;
		const brokenMessage = broken.get(module.name);
		if (brokenMessage !== undefined) {
			files.set(file, throwingSource(brokenMessage));
			continue;
		}
		const entry = scanned.get(module.name);
		if (entry === undefined) {
			files.set(file, valueModuleSource(module, posix.join(bundleRoot, paths.get(module.name)!)));
			continue;
		}
		let source = "";
		let cursor = 0;
		for (const site of [...entry.imports].sort((left, right) => left.start - right.start)) {
			let specifier: string;
			switch (site.target.kind) {
				case "builtin":
					specifier = site.target.specifier;
					break;
				case "rewrite":
					specifier =
						module.type === "cjs" ? site.target.path : pathToFileURL(site.target.path).href;
					break;
				case "module": {
					const target = byName.get(site.target.name);
					if (target === undefined) throw new Error(`Module "${site.target.name}" is missing`);
					specifier = relativeSpecifier(file, fileOf(target));
					break;
				}
				case "missing": {
					const missingFile = `${missingDirectory}/${missingCount++}.${module.type === "cjs" ? "cjs" : "mjs"}`;
					files.set(missingFile, throwingSource(site.target.message));
					specifier = relativeSpecifier(file, missingFile);
					break;
				}
			}
			source += entry.source.slice(cursor, site.start) + JSON.stringify(specifier);
			cursor = site.end;
		}
		source += entry.source.slice(cursor);
		files.set(file, source);
	}
	for (const [file, source] of packageFiles(modules)) files.set(file, source);
	const main = byName.get(mainModule);
	if (main === undefined) throw new TypeError(`Main module "${mainModule}" is not in the modules object.`);
	return { files, mainFile: fileOf(main), moduleNames };
}

function relativeSpecifier(from: string, to: string): string {
	const relative = posix.relative(posix.dirname(from), to);
	return relative.startsWith("../") ? relative : `./${relative}`;
}
