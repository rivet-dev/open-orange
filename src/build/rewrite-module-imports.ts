import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runtimeKind, type RuntimeKind } from "../runtime/runtime-kind.js";

interface RuntimeModule {
	artifact: string;
	source: string;
}

// Workers get stock Node.js built-ins, except these, where stock Node.js would
// break code that works on Cloudflare. Each has a source file under
// `modules/node/` named after the module, with `/` replaced by `-`.
const workerdNodeModules = [
	"assert",
	"assert/strict",
	"buffer",
	"crypto",
	"process",
	"sys",
	"timers",
	"timers/promises",
	"util",
	"worker_threads",
	"zlib",
] as const;

// Each runtime module ships as `dist/runtime/<artifact>.js` and runs from
// source during development.
const runtimeModules: Readonly<Record<string, RuntimeModule>> = {
	// npm packages that wrap a Cloudflare-only platform feature. Orange replaces
	// the whole package so Worker code that imports it runs unchanged.
	"@cloudflare/sandbox": {
		artifact: "cloudflare-sandbox",
		source: "modules/cloudflare-sandbox/index.ts",
	},
	"cloudflare:ai": {
		artifact: "cloudflare-ai",
		source: "modules/cloudflare-ai/index.ts",
	},
	"cloudflare:br": {
		artifact: "cloudflare-br",
		source: "modules/cloudflare-br/index.ts",
	},
	"cloudflare:email": {
		artifact: "cloudflare-email",
		source: "modules/cloudflare-email/index.ts",
	},
	"cloudflare:node": {
		artifact: "cloudflare-node",
		source: "modules/cloudflare-node/index.ts",
	},
	"cloudflare:pipelines": {
		artifact: "cloudflare-pipelines",
		source: "modules/cloudflare-pipelines/index.ts",
	},
	"cloudflare:sockets": {
		artifact: "cloudflare-sockets",
		source: "modules/cloudflare-sockets/index.ts",
	},
	"cloudflare:vectorize": {
		artifact: "cloudflare-vectorize",
		source: "modules/cloudflare-vectorize/index.ts",
	},
	"cloudflare:workers": {
		artifact: "cloudflare-workers",
		source: "modules/cloudflare-workers/index.ts",
	},
	"cloudflare:workflows": {
		artifact: "cloudflare-workflows",
		source: "modules/cloudflare-workflows/index.ts",
	},
	"node:fs": { artifact: "node-fs", source: "modules/node-fs/index.ts" },
	"node:fs/promises": {
		artifact: "node-fs-promises",
		source: "modules/node-fs/promises.ts",
	},
	"node:http": { artifact: "node-http", source: "modules/node-http/index.ts" },
	...Object.fromEntries(
		workerdNodeModules.map((name) => {
			const fileName = name.replaceAll("/", "-");
			return [
				`node:${name}`,
				{ artifact: `node/${fileName}`, source: `modules/node/${fileName}.ts` },
			];
		}),
	),
};

export const runtimeModuleEntrypoints: Readonly<Record<string, string>> =
	Object.fromEntries(
		Object.values(runtimeModules).map(({ artifact, source }) => [
			artifact,
			`packages/runtime-node/src/${source}`,
		]),
	);

// The artifact name of each runtime module, keyed by its import specifier.
export const runtimeModuleArtifacts: Readonly<Record<string, string>> =
	Object.fromEntries(
		Object.entries(runtimeModules).map(([specifier, { artifact }]) => [
			specifier,
			artifact,
		]),
	);

function runtimeModulePath(
	specifier: string,
	artifact: string,
	source: string,
	runtime: RuntimeKind,
): string {
	const packagedPath = fileURLToPath(
		new URL(`./runtime/${artifact}.js`, import.meta.url),
	);
	if (existsSync(packagedPath)) {
		return packagedPath;
	}
	if (runtime === "agentos") {
		const builtPath = fileURLToPath(new URL(`../../dist/runtime/${artifact}.js`, import.meta.url));
		if (existsSync(builtPath)) return builtPath;
		throw new Error("agentOS needs the built OpenOrange runtime. Run pnpm build first.");
	}
	const sourcePath = fileURLToPath(
		new URL(`../../packages/runtime-node/src/${source}`, import.meta.url),
	);
	if (existsSync(sourcePath)) {
		return sourcePath;
	}
	throw new Error(`OpenOrange ${specifier} runtime artifact is missing`);
}

export function runtimeModuleRewrites(runtime: RuntimeKind = runtimeKind()): Readonly<Record<string, string>> {
	return Object.fromEntries(
		Object.entries(runtimeModules).map(([specifier, { artifact, source }]) => [
			specifier,
			runtimeModulePath(specifier, artifact, source, runtime),
		]),
	);
}

/** Keeps every runtime module as its own specifier, for a bundle that an image bundles again. */
export function unresolvedRuntimeModules(): Readonly<Record<string, string>> {
	return Object.fromEntries(Object.keys(runtimeModules).map((specifier) => [specifier, specifier]));
}
