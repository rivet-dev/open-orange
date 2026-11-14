import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isBuiltin } from "node:module";
import { dirname, relative, resolve, sep } from "node:path";

import { build, type BuildFailure, type Message, type Plugin } from "esbuild";

import { isRecord } from "../unknown-values.js";

export interface BundleWorkerOptions {
	entrypoint: string;
	moduleRewrites?: Readonly<Record<string, string>>;
	/** Wrangler module rules in priority order, matched against import specifiers. */
	moduleRules?: readonly ModuleRule[];
	/**
	 * What `process.env.NODE_ENV` becomes in the bundle, as in Wrangler's build. Undefined leaves it
	 * to the runtime, as for a `no_bundle` Worker, which Wrangler doesn't process.
	 */
	nodeEnv?: string;
	outputPath: string;
	/**
	 * Bundles packages only, for an image that bundles again at start. Runtime modules stay as the
	 * specifiers in `moduleRewrites`, and the next bundle resolves them and `process.env.NODE_ENV`.
	 */
	packagesOnly?: boolean;
	/**
	 * The inline source map, on by default. The runtime does not read it, so `orange serve` leaves
	 * it out: a large Worker's map can be bigger than its code, and the runtime holds both.
	 */
	sourcemap?: boolean;
}

export interface ModuleRule {
	globs: string[];
	type: "CompiledWasm" | "Data" | "Text";
}

export interface WorkerBundle {
	bytes: Uint8Array;
	outputPath: string;
	/** Module load errors that workerd reports at runtime, so the bundle defers them to runtime. */
	warnings: string[];
}

/** An import that esbuild rejects but workerd only rejects when the importing module evaluates. */
interface DeferredModuleError {
	importer: string;
	reason: "unresolved" | "top-level-await";
	specifier: string;
}

const deferredModuleErrorNamespace = "open-orange-deferred-module-error";
const requiredBuiltinNamespace = "open-orange-required-builtin";
const moduleRuleNamespace = "open-orange-module-rule";
const moduleRuleBytesNamespace = "open-orange-module-rule-bytes";
const resolvingRuleSpecifier = Symbol("open-orange-resolving-rule-specifier");

// npm packages that Orange replaces with its own implementation.
const replacedPackages = new Set(["@cloudflare/sandbox"]);

function validateModuleRewrites(
	rewrites: Readonly<Record<string, string>>,
): void {
	for (const [specifier, replacement] of Object.entries(rewrites)) {
		if (replacedPackages.has(specifier)) continue;
		const prefix = specifier.startsWith("node:") ? "node:" : "cloudflare:";
		if (!specifier.startsWith(prefix) || specifier.length === prefix.length) {
			throw new Error(
				`Cloudflare module rewrite has invalid specifier ${JSON.stringify(specifier)}`,
			);
		}
		if (replacement.length === 0 || replacement.startsWith("cloudflare:")) {
			throw new Error(
				`Cloudflare module rewrite for ${JSON.stringify(specifier)} has an invalid replacement`,
			);
		}
	}
}

// The bare `process` in Worker code, and `globalThis.process`, are Orange's workerd-like process,
// as in workerd, so Worker code does not see the runtime's real process or its environment. All
// of them name one property of an injected object rather than an import binding, so Worker code
// can still assign or delete `globalThis.process` without touching the runtime's global.
const processGlobalModule = "open-orange:process-global";
const processGlobalSlot = "__openOrangeGlobals.process";
const processGlobalDefines: Readonly<Record<string, string>> = {
	process: processGlobalSlot,
	"globalThis.process": processGlobalSlot,
	"global.process": processGlobalSlot,
	"self.process": processGlobalSlot,
};

function cloudflareModulePlugin(
	rewrites: Readonly<Record<string, string>>,
): Plugin {
	return {
		name: "open-orange-cloudflare-modules",
		setup(buildContext): void {
			buildContext.onResolve({ filter: /^open-orange:process-global$/ }, (args) => ({
				namespace: "open-orange-process-global",
				path: args.path,
			}));
			buildContext.onLoad({ filter: /.*/, namespace: "open-orange-process-global" }, () => ({
				contents: 'import process from "node:process"; export const __openOrangeGlobals = { process };',
				loader: "js",
				resolveDir: process.cwd(),
			}));
			buildContext.onResolve({ filter: /^@cloudflare\/sandbox$/ }, (args) => {
				const replacement = rewrites[args.path];
				return replacement === undefined ? undefined : { external: true, path: replacement };
			});
			buildContext.onResolve({ filter: /^cloudflare:/ }, (args) => {
				const replacement = rewrites[args.path];
				if (replacement === undefined) {
					return {
						errors: [
							{
								text: `Cloudflare module import ${JSON.stringify(args.path)} is not implemented by OpenOrange`,
							},
						],
					};
				}
				return {
					external: true,
					path: replacement,
				};
			});
			// Node.js built-ins with workerd-specific behavior resolve to the
			// OpenOrange implementation, with or without the `node:` prefix.
			buildContext.onResolve({ filter: /^(node:)?[a-z0-9_/]+$/ }, (args) => {
				if (args.kind === "require-call" && isBuiltin(args.path)) {
					return { namespace: requiredBuiltinNamespace, path: args.path };
				}
				const specifier = args.path.startsWith("node:")
					? args.path
					: `node:${args.path}`;
				const replacement = rewrites[specifier];
				if (replacement === undefined) {
					return undefined;
				}
				return {
					external: true,
					path: replacement,
				};
			});
			// An ESM bundle has no require(), so a CommonJS require() of a built-in
			// becomes an import, as Wrangler does.
			// https://github.com/cloudflare/workers-sdk/blob/be87ff0382c53a294e948e49419d25d653c50e86/packages/wrangler/src/deployment-bundle/esbuild-plugins/hybrid-nodejs-compat.ts#L110-L133
			buildContext.onLoad(
				{ filter: /.*/, namespace: requiredBuiltinNamespace },
				(args) => ({
					contents: `import libDefault from ${JSON.stringify(args.path)};\nmodule.exports = libDefault;\n`,
					loader: "js",
					resolveDir: buildContext.initialOptions.absWorkingDir ?? process.cwd(),
				}),
			);
		},
	};
}

// Wrangler converts each glob with glob-to-regexp, where only `*` is special
// and it also matches `/`.
function globRegExp(glob: string): RegExp {
	const pattern = glob
		.split("*")
		.map((part) => part.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&"))
		.join(".*");
	return new RegExp(`^${pattern}$`);
}

/**
 * Loads imports that match a Wrangler module rule the way workerd does: Text as a string,
 * Data as an ArrayBuffer, and CompiledWasm as a WebAssembly.Module.
 * https://github.com/cloudflare/workers-sdk/blob/be87ff0382c53a294e948e49419d25d653c50e86/packages/wrangler/src/deployment-bundle/module-collection.ts#L253-L262
 */
function moduleRulesPlugin(rules: readonly ModuleRule[]): Plugin {
	return {
		name: "open-orange-module-rules",
		setup(buildContext): void {
			for (const rule of rules) {
				for (const glob of rule.globs) {
					buildContext.onResolve({ filter: globRegExp(glob) }, async (args) => {
						// The rule's own wrapper module imports the bytes, and a package lookup
						// below comes back through this hook. Without this, a bare specifier such
						// as `@resvg/resvg-wasm/index_bg.wasm` resolves itself forever.
						if (args.namespace === moduleRuleNamespace || args.pluginData === resolvingRuleSpecifier) {
							return undefined;
						}
						// Wrangler drops the query string, as in `./module.wasm?module`.
						const specifier = args.path.replace(/\?.*$/, "");
						let path: string;
						if (/^\.{0,2}\//.test(specifier)) {
							path = resolve(args.resolveDir, specifier);
						} else {
							const resolved = await buildContext.resolve(specifier, {
								importer: args.importer,
								kind: args.kind,
								pluginData: resolvingRuleSpecifier,
								resolveDir: args.resolveDir,
							});
							if (resolved.errors.length > 0) {
								return { errors: resolved.errors };
							}
							path = resolved.path;
						}
						return { namespace: moduleRuleNamespace, path, pluginData: rule.type };
					});
				}
			}
			buildContext.onLoad({ filter: /.*/, namespace: moduleRuleNamespace }, async (args) => {
				const type: unknown = args.pluginData;
				if (type === "Text") {
					return { contents: await readFile(args.path), loader: "text" };
				}
				// esbuild's binary loader embeds and decodes the bytes. Building the same
				// base64 decode as JavaScript source made a Worker with a 14 MB Wasm module
				// grow esbuild past 7 GB.
				const bytesModule = JSON.stringify(args.path);
				return {
					contents:
						type === "Data"
							? `import bytes from ${bytesModule};\nexport default bytes.buffer;\n`
							: `import bytes from ${bytesModule};\nexport default new WebAssembly.Module(bytes);\n`,
					loader: "js",
					resolveDir: dirname(args.path),
				};
			});
			buildContext.onResolve({ filter: /.*/, namespace: moduleRuleNamespace }, (args) => ({
				namespace: moduleRuleBytesNamespace,
				path: args.path,
			}));
			buildContext.onLoad({ filter: /.*/, namespace: moduleRuleBytesNamespace }, async (args) => ({
				contents: await readFile(args.path),
				loader: "binary",
			}));
		},
	};
}

function deferredErrorKey(importer: string, specifier: string): string {
	return `${importer}\0${specifier}`;
}

function isBuildFailure(error: unknown): error is BuildFailure {
	return (
		error instanceof Error &&
		Array.isArray(Reflect.get(error, "errors")) &&
		Array.isArray(Reflect.get(error, "warnings"))
	);
}

/** True for an esbuild failure in the Worker's own code, such as a syntax error, and not in an Orange plugin. */
export function isUserBuildFailure(error: unknown): error is BuildFailure {
	return isBuildFailure(error) && error.errors.length > 0 && error.errors.every((message) => message.pluginName === "");
}

/**
 * Maps an esbuild error to an import that workerd rejects lazily, keyed by importer and specifier.
 * Returns undefined for every other build error.
 */
function deferrableModuleError(
	message: Message,
): [key: string, error: DeferredModuleError] | undefined {
	const location = message.location;
	if (
		location === null ||
		(location.namespace !== "" && location.namespace !== "file")
	) {
		return undefined;
	}
	let reason: DeferredModuleError["reason"];
	if (message.text.startsWith("Could not resolve ")) {
		reason = "unresolved";
	} else if (message.text.startsWith("This require call is not allowed because")) {
		reason = "top-level-await";
	} else {
		return undefined;
	}
	// The location spans the quoted specifier of the import or require() call.
	const literal = location.lineText.slice(
		location.column,
		location.column + location.length,
	);
	if (literal.length < 2) {
		return undefined;
	}
	const importer = resolve(location.file);
	const specifier = literal.slice(1, -1);
	return [
		deferredErrorKey(importer, specifier),
		{ importer, reason, specifier },
	];
}

function readDeferredErrorMessage(data: unknown): ReturnType<typeof deferredErrorMessage> {
	if (
		isRecord(data) &&
		(data.name === "Error" || data.name === "TypeError") &&
		typeof data.message === "string"
	) {
		return { name: data.name, message: data.message };
	}
	throw new TypeError("Deferred module error is missing its message");
}

function deferredErrorMessage(
	{ importer, reason, specifier }: DeferredModuleError,
	kind: string,
	root: string,
): { name: "Error" | "TypeError"; message: string } {
	// workerd refuses top-level await in require() since compatibility date 2024-12-02.
	// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/io/compatibility-date.capnp#L629-L632
	// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/jsg/modules.c++#L317-L321
	if (reason === "top-level-await") {
		return {
			name: "Error",
			message: "Top-level await in module is not permitted at this time.",
		};
	}
	// workerd resolves specifiers against the bundle root, and a path that leaves the root is an
	// invalid specifier rather than a missing module. require() omits the importer suffix.
	// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/jsg/modules.c++#L80-L94
	// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/commonjs.c++#L63-L85
	const isRequire = kind === "require-call" || kind === "require-resolve";
	const importerName = relative(root, importer).split(sep).join("/");
	const suffix = isRequire ? "" : `\n  imported from "${importerName}".`;
	const isRelative = specifier.startsWith("./") || specifier.startsWith("../");
	const target = isRelative
		? relative(root, resolve(dirname(importer), specifier))
				.split(sep)
				.join("/")
		: specifier;
	if (target.startsWith("../") || target === "..") {
		return {
			name: "TypeError",
			message: `Invalid module specifier "${specifier}".${suffix}`,
		};
	}
	return {
		name: "Error",
		message: `No such module "${target}".${isRequire ? "" : `\n  imported from "${importerName}"`}`,
	};
}

/** Replaces imports that workerd rejects lazily with modules that throw the workerd error. */
function deferredModuleErrorPlugin(
	deferred: ReadonlyMap<string, DeferredModuleError>,
	root: string,
): Plugin {
	return {
		name: "open-orange-deferred-module-errors",
		setup(buildContext): void {
			if (deferred.size === 0) {
				return;
			}
			buildContext.onResolve({ filter: /.*/ }, (args) => {
				const error = deferred.get(deferredErrorKey(args.importer, args.path));
				if (error === undefined) {
					return undefined;
				}
				return {
					namespace: deferredModuleErrorNamespace,
					path: `${args.importer}:${args.path}`,
					pluginData: deferredErrorMessage(error, args.kind, root),
				};
			});
			buildContext.onLoad(
				{ filter: /.*/, namespace: deferredModuleErrorNamespace },
				(args) => {
					const { name, message } = readDeferredErrorMessage(args.pluginData);
					// The `module.exports` assignment makes esbuild treat the module as CommonJS, so
					// named imports from it link and the throw happens when the importer evaluates.
					return {
						contents: `throw new ${name}(${JSON.stringify(message)});\nmodule.exports = {};\n`,
						loader: "js",
					};
				},
			);
		},
	};
}

export async function bundleWorker(
	options: BundleWorkerOptions,
): Promise<WorkerBundle> {
	const moduleRewrites = options.moduleRewrites ?? {};
	if (options.packagesOnly !== true) validateModuleRewrites(moduleRewrites);
	const entrypoint = resolve(options.entrypoint);
	const outputPath = resolve(options.outputPath);
	const root = dirname(entrypoint);
	// workerd only fails an unresolvable import, or a require() of a module that uses top-level
	// await, when the importing module evaluates. esbuild fails the whole build, so the bundle
	// is rebuilt with throwing stubs for exactly those imports.
	const deferred = new Map<string, DeferredModuleError>();
	const bundle = async () => {
		for (;;) {
			try {
				return await build({
					bundle: true,
					charset: "utf8",
					// Package resolution and JSX handling follow Wrangler's, so packages
					// load their Workers builds instead of their Node.js builds.
					// https://github.com/cloudflare/workers-sdk/blob/be87ff0382c53a294e948e49419d25d653c50e86/packages/wrangler/src/deployment-bundle/bundle.ts#L392-L404
					conditions: ["workerd", "worker", "browser"],
					define: {
						...(moduleRewrites["node:process"] === undefined || options.packagesOnly === true ? {} : processGlobalDefines),
						// A packages-only bundle leaves NODE_ENV to the bundle at start, which sets it.
						...(options.packagesOnly === true || options.nodeEnv === undefined
							? {}
							: {
									"global.process.env.NODE_ENV": JSON.stringify(options.nodeEnv),
									"globalThis.process.env.NODE_ENV": JSON.stringify(options.nodeEnv),
									"process.env.NODE_ENV": JSON.stringify(options.nodeEnv),
								}),
					},
					entryPoints: [entrypoint],
					format: "esm",
					inject: moduleRewrites["node:process"] === undefined || options.packagesOnly === true ? [] : [processGlobalModule],
					legalComments: "none",
					loader: { ".cjs": "jsx", ".js": "jsx", ".mjs": "jsx" },
					logLevel: "silent",
					mainFields: ["browser", "module", "main"],
					outfile: outputPath,
					platform: "node",
					plugins: [
						deferredModuleErrorPlugin(deferred, root),
						moduleRulesPlugin(options.moduleRules ?? []),
						cloudflareModulePlugin(moduleRewrites),
					],
					sourcemap: options.sourcemap === false ? false : "inline",
					target: "node24",
					treeShaking: true,
					write: false,
				});
			} catch (error) {
				if (!isBuildFailure(error)) {
					throw error;
				}
				const found = error.errors.map(deferrableModuleError);
				const fresh = found.filter(
					(entry) => entry !== undefined && !deferred.has(entry[0]),
				);
				if (found.includes(undefined) || fresh.length === 0) {
					throw error;
				}
				for (const entry of fresh) {
					if (entry !== undefined) {
						deferred.set(entry[0], entry[1]);
					}
				}
			}
		}
	};
	const result = await bundle();
	const output = result.outputFiles?.find(
		(file) => resolve(file.path) === outputPath,
	);
	if (output === undefined) {
		throw new Error("esbuild did not produce the requested Worker bundle");
	}
	await mkdir(dirname(outputPath), { recursive: true });
	await writeFile(outputPath, output.contents);
	const warnings = [...deferred.values()].map(
		({ importer, specifier }) =>
			`${relative(root, importer)} imports ${JSON.stringify(specifier)}, which fails when that module evaluates`,
	);
	return { bytes: new Uint8Array(output.contents), outputPath, warnings };
}
