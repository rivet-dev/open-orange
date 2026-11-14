import { chmod, copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build, type Plugin } from "esbuild";

import { imageLockfile } from "./image-lockfile.js";
import {
	runtimeModuleArtifacts,
	runtimeModuleEntrypoints,
} from "./rewrite-module-imports.js";

// Node.js 22 lacks URLPattern. Bundling the small polyfill keeps the runtime
// modules free of package imports, like the node: built-ins they replace.
const bundleUrlPatternPolyfill: Plugin = {
	name: "bundle-urlpattern-polyfill",
	setup(build) {
		build.onResolve({ filter: /^urlpattern-polyfill$/ }, () => ({
			path: fileURLToPath(import.meta.resolve("urlpattern-polyfill")),
		}));
	},
};

// The agentOS Worker Loader backend runs the dynamic Worker child inside a VM
// with no node_modules, so this build bundles every package. The runtime
// modules share chunks with the child, as in `dist/runtime`.
export async function buildWorkerLoaderVmBundle(
	outputDirectory: string,
): Promise<void> {
	await rm(outputDirectory, { force: true, recursive: true });
	await build({
		// Bundled CommonJS packages such as undici require Node.js built-ins.
		banner: {
			js: 'import { createRequire as __openOrangeCreateRequire } from "node:module";\nconst require = __openOrangeCreateRequire(import.meta.url);',
		},
		bundle: true,
		chunkNames: "chunks/[name]-[hash]",
		entryPoints: {
			...Object.fromEntries(
				Object.entries(runtimeModuleEntrypoints).map(([name, source]) => [
					name,
					resolve(source),
				]),
			),
			// The VM's node:http cannot serve the host shim's Server subclass.
			"node-http": resolve(
				"packages/runtime-node/src/bindings/worker-loader/vm-http.ts",
			),
			"worker-loader-child": resolve(
				"packages/runtime-node/src/bindings/worker-loader/child.ts",
			),
		},
		// The child never boots an agentOS VM itself.
		external: ["@rivet-dev/agentos-core"],
		format: "esm",
		inject: [
			resolve("packages/runtime-node/src/bindings/worker-loader/vm-shims.ts"),
		],
		legalComments: "none",
		logLevel: "silent",
		outExtension: { ".js": ".mjs" },
		outdir: outputDirectory,
		platform: "node",
		splitting: true,
		target: "node22",
	});
	const manifest = Object.fromEntries(
		Object.entries(runtimeModuleArtifacts).map(([specifier, artifact]) => [
			specifier,
			`${artifact}.mjs`,
		]),
	);
	await writeFile(
		join(outputDirectory, "manifest.json"),
		`${JSON.stringify(manifest, null, "\t")}\n`,
	);
	// The process entry agentOS runs for each dynamic Worker (`childEntry` in
	// worker-loader/agentos.ts). It stays this small so agentOS can boot it
	// from a snapshot of everything it imports, and only these two lines run
	// in each process.
	await writeFile(
		join(outputDirectory, "worker-loader-child-main.mjs"),
		'import { startChild } from "./worker-loader-child.mjs";\nstartChild();\n',
	);
}

export async function buildPackage(
	outputDirectory = resolve("dist"),
): Promise<void> {
	const cliOutput = join(outputDirectory, "bin.js");
	await mkdir(join(outputDirectory, "runtime"), { recursive: true });
	await mkdir(join(outputDirectory, "image"), { recursive: true });
	await Promise.all([
		build({
			banner: { js: "#!/usr/bin/env node" },
			bundle: true,
			entryPoints: [resolve("src/bin.ts")],
			format: "esm",
			legalComments: "none",
			logLevel: "silent",
			outfile: cliOutput,
			packages: "external",
			platform: "node",
			target: "node24",
		}),
		// The runner and the runtime modules share chunks, so a Worker and the
		// runtime see one instance of each class and stub registry.
		build({
			bundle: true,
			chunkNames: "chunks/[name]-[hash]",
			entryPoints: {
				...Object.fromEntries(
					Object.entries(runtimeModuleEntrypoints).map(([name, source]) => [
						name,
						resolve(source),
					]),
				),
				runner: resolve("packages/runtime-node/src/runner.ts"),
			},
			format: "esm",
			legalComments: "none",
			logLevel: "silent",
			outdir: join(outputDirectory, "runtime"),
			packages: "external",
			platform: "node",
			plugins: [bundleUrlPatternPolyfill],
			splitting: true,
			target: "node24",
		}),
		buildWorkerLoaderVmBundle(join(outputDirectory, "runtime", "worker-loader-vm")),
		writeFile(
			join(outputDirectory, "image", "pnpm-lock.yaml"),
			imageLockfile(await readFile(resolve("pnpm-lock.yaml"), "utf8")),
		),
	]);
	// `orange migrate prepare` imports this file into the Worker it generates, from next to the CLI.
	await copyFile(resolve("src/commands/d1-cloudflare-worker.js"), join(outputDirectory, "d1-cloudflare-worker.js"));
	await chmod(cliOutput, 0o755);
}

// `pnpm build <directory>` builds somewhere other than `dist`, as a source-checkout deploy does.
if (process.argv[1] === new URL(import.meta.url).pathname) {
	const [outputDirectory] = process.argv.slice(2);
	await buildPackage(outputDirectory === undefined ? undefined : resolve(outputDirectory));
}
