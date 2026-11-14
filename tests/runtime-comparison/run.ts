import { readAgentOsSourceEngineBuild } from "../../src/runtime/source-engine-build.js";
import { createHash } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { glob, mkdir, readFile, writeFile } from "node:fs/promises";
import { appendFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { isBuiltin } from "node:module";
import { createRequire } from "node:module";
import { build, transform } from "esbuild";
import ts from "typescript";
import { hostCases, guestCases, validRun, matchedPasses, type Case } from "./results.js";
import { discoverInstalledRivetKitBuild, assertPinnedRivetKitBuild } from "../../packages/runtime-node/src/internal/rivetkit-build.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
const { values } = parseArgs({ options: {
	filter: { type: "string", default: "" }, name: { type: "string", default: "comparison" },
	lane: { type: "string", default: "runtime" }, timeout: { type: "string", default: "30000" },
	"host-only": { type: "boolean", default: false },
	"node-reference": { type: "string" },
	application: { type: "boolean", default: false },
	"test-pattern": { type: "string" },
} });
if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,80}$/.test(values.name!)) throw new Error("Comparison name must be a simple directory name");
const directory = resolve(root, ".open-orange/runtime-comparison", values.name!);
await mkdir(dirname(directory), { recursive: true });
await mkdir(directory);
const timeoutMs = Number(values.timeout), outputLimit = 2 * 1024 * 1024;
if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 1800000) throw new Error("Invalid timeout (expected 100 through 1800000 ms)");
const native = process.env.AGENTOS_SIDECAR_BIN;
if (values["test-pattern"] && !values.application && !values["host-only"]) throw new Error("Test patterns are supported by the host-controlled application lane");
const hash = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
if (values["host-only"] && values["node-reference"]) throw new Error("A Node reference cannot be combined with host-only execution");
const nodeReferencePath = values["node-reference"] ? resolve(values["node-reference"]) : undefined;
const nodeReferenceBytes = nodeReferencePath ? await readFile(nodeReferencePath) : undefined;
const nodeReference = nodeReferenceBytes ? JSON.parse(nodeReferenceBytes.toString()) : undefined;
const revision = (cwd: string) => execFileSync("jj", ["log", "-r", "@", "--no-graph", "-T", "commit_id"], { cwd, encoding: "utf8" }).trim();
async function codeDigest(directory: string) {
	const files: string[] = [];
	for await (const file of glob(["**/*.js", "**/*.cjs", "**/*.mjs"], { cwd: directory })) files.push(file);
	const digest = createHash("sha256");
	for (const file of files.sort()) { digest.update(file); digest.update("\0"); digest.update(await readFile(join(directory, file))); }
	return { directory, files: files.length, sha256: digest.digest("hex") };
}
async function runtimeArtifacts() {
	const client = process.env.OPENORANGE_AGENTOS_MODULE;
	const localClient = client && (client.startsWith("/") || client.startsWith("file:")) ? (client.startsWith("file:") ? fileURLToPath(client) : client) : undefined;
	const defaultSoftware: { path: string; sha256: string }[] = [];
	if (localClient) for await (const path of glob(join(dirname(localClient), "default-software", "*.aospkg"))) defaultSoftware.push({ path, sha256: hash(await readFile(path)) });
	const sdk = process.env.OPENORANGE_AGENTOS_RIVETKIT_PACKAGE;
	const require = sdk ? createRequire(join(sdk, "package.json")) : undefined;
	return {
		client: client && (client.startsWith("/") || client.startsWith("file:")) ? await codeDigest(dirname(client.startsWith("file:") ? fileURLToPath(client) : client)) : undefined,
		defaultSoftware: defaultSoftware.sort((a, b) => a.path.localeCompare(b.path)),
		workerLoaderManifestSha256: hash(await readFile(join(root, "dist/runtime/worker-loader-vm/manifest.json"))),
		portableSdk: sdk ? await codeDigest(join(sdk, "dist")) : undefined,
		portableWasmSha256: require ? hash(await readFile(require.resolve("@rivetkit/rivetkit-wasm/rivetkit_wasm_bg.wasm"))) : undefined,
		runner: await codeDigest(join(root, "dist/runtime")),
	};
}
const artifacts = await runtimeArtifacts();
const sourceRemoteEngine = readAgentOsSourceEngineBuild();
async function installedNativeDependencies() {
	const require = createRequire(join(root, "packages/runtime-node/package.json"));
	const file = async (path: string) => ({ path, sha256: hash(await readFile(path)) });
	const dependencies: Record<string, unknown> = {};
	try {
		const build = discoverInstalledRivetKitBuild(); assertPinnedRivetKitBuild(build);
		const sdkRequire = createRequire(require.resolve("rivetkit"));
		const nativeRequire = createRequire(sdkRequire.resolve("@rivetkit/rivetkit-napi"));
		const platform = build.packages.find(item => item.name.startsWith("@rivetkit/rivetkit-napi-"));
		dependencies.rivetkit = { packages: build.packages, engine: await file(build.engineBinaryPath),
			...(platform ? { napi: await file(nativeRequire.resolve(platform.name)) } : {}) };
	} catch (error) { dependencies.rivetkit = { unavailable: String(error) }; }
	try {
		const entry = require.resolve("@rivet-dev/agentos-core");
		const coreRequire = createRequire(entry);
		const manifest = JSON.parse(await readFile(join(dirname(entry), "../package.json"), "utf8"));
		const override = process.env.AGENTOS_SIDECAR_BIN;
		let sidecar: string;
		// The package resolver also honors the override; discover the same
		// installed binary that the Node lane will use with that variable unset.
		delete process.env.AGENTOS_SIDECAR_BIN;
		try { sidecar = coreRequire("@rivet-dev/agentos-runtime-sidecar").getSidecarPath(); }
		finally { if (override === undefined) delete process.env.AGENTOS_SIDECAR_BIN; else process.env.AGENTOS_SIDECAR_BIN = override; }
		dependencies.nodeWorkerLoader = { version: manifest.version, client: await file(entry), sidecar: await file(sidecar) };
	} catch (error) { dependencies.nodeWorkerLoader = { unavailable: String(error) }; }
	return dependencies;
}
const nativeApplicationDependencies = await installedNativeDependencies();
const agentosRoot = process.env.OPENORANGE_AGENTOS_ROOT;
const nativeManifest = process.env.OPENORANGE_AGENTOS_NATIVE_MANIFEST
	? JSON.parse(await readFile(process.env.OPENORANGE_AGENTOS_NATIVE_MANIFEST, "utf8")) : undefined;
if (!values["host-only"] && (!native || !nativeManifest)) throw new Error("Guest comparisons require AGENTOS_SIDECAR_BIN and OPENORANGE_AGENTOS_NATIVE_MANIFEST");
if (nativeManifest && (!native || hash(await readFile(native)) !== nativeManifest.sha256)) throw new Error("Native binary does not match its build manifest");
const versions = {
	node: process.version, nodeVersions: process.versions, nodeSha256: hash(await readFile(process.execPath)), openOrangeRevision: revision(root),
	agentosRevision: agentosRoot ? revision(agentosRoot) : null,
	native: native ? { ...nativeManifest, path: native, sha256: hash(await readFile(native)) } : null,
	client: process.env.OPENORANGE_AGENTOS_MODULE,
	artifacts,
	nativeApplicationDependencies,
	agentosSourceRemoteEngine: sourceRemoteEngine,
	temporaryDirectory: process.env.TMPDIR,
	hostControllerUmask: "0022",
	hostControllerNetworkGrants: "owned live fixture listeners only; per-lane policy receipt",
	testPattern: values["test-pattern"],
	...(nodeReferencePath ? { nodeReference: { path: nodeReferencePath, sha256: hash(nodeReferenceBytes!) } } : {}),
};
if (nodeReference) {
	for (const key of ["nodeSha256", "native", "artifacts", "nativeApplicationDependencies", "agentosSourceRemoteEngine", "testPattern"] as const) {
		if (JSON.stringify(nodeReference.versions[key]) !== JSON.stringify(versions[key])) throw new Error(`Node reference has different ${key}; execute a fresh baseline`);
	}
}
// These assert host compiler/package output. They never launch an application
// VM, so worker-runtime environment selection would change their test inputs.
const controllerOnlyFiles = new Set(["src/build/build-package.test.ts", "src/build/bundle-worker.test.ts"]);
const inventory = [];
for await (const file of glob(["src/**/*.test.ts", "tests/**/*.test.ts", "packages/*/src/**/*.test.ts"], { cwd: root })) {
	const text = await readFile(join(root, file), "utf8");
	const ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
	const declarations: { name: string; line: number; method: string }[] = [];
	const visit = (node: ts.Node) => {
		if (ts.isCallExpression(node) && /^(test|it)(\.(skip|todo|only))?$/.test(node.expression.getText(ast))) {
			const argument = node.arguments[0];
			declarations.push({ name: argument && ts.isStringLiteralLike(argument) ? argument.text : "<dynamic>",
				line: ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1, method: node.expression.getText(ast) });
		}
		ts.forEachChild(node, visit);
	};
	visit(ast);
	inventory.push({ file, sha256: hash(text), declarations,
		controllerOnly: controllerOnlyFiles.has(file),
        lane: file.startsWith("packages/runtime-node/") ? "runtime" : file.startsWith("packages/") || controllerOnlyFiles.has(file) ? "tooling" : "application" });
}
inventory.sort((a, b) => a.file.localeCompare(b.file));
await writeFile(join(directory, "inventory.json"), JSON.stringify({ versions, inventory }, null, 2));

async function execute(args: string[], env: NodeJS.ProcessEnv, prefix: string) {
	// Keep bounded evidence inspectable while long application files run.
	writeFileSync(prefix + ".stdout.partial", ""); writeFileSync(prefix + ".stderr.partial", "");
	const child = spawn(process.execPath, args, { cwd: root, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
	let stdout = "", stderr = "", capped = false, timedOut = false;
	const kill = () => { try { process.kill(-child.pid!, "SIGKILL"); } catch (error: any) { if (error.code !== "ESRCH") throw error; } };
	const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs + 10000);
	const capture = (stream: "stdout" | "stderr", chunk: Buffer) => {
		if (capped) return;
		if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) + chunk.length > outputLimit) { capped = true; kill(); return; }
		appendFileSync(prefix + `.${stream}.partial`, chunk);
		if (stream === "stdout") stdout += chunk.toString(); else stderr += chunk.toString();
	};
	child.stdout.on("data", c => capture("stdout", c)); child.stderr.on("data", c => capture("stderr", c));
	const exit = await new Promise<{ code: number | null; signal: string | null }>((done, reject) => {
		child.once("error", reject); child.once("close", (code, signal) => done({ code, signal }));
	});
	clearTimeout(timer);
	// Reap only this owned process group, including children left by a failing test.
	kill();
	await writeFile(prefix + ".stdout", stdout); await writeFile(prefix + ".stderr", stderr);
	return { ...exit, stdout, stderr, capped, timedOut };
}
const results: any[] = [];
for (const entry of inventory.filter(e => (values.lane === "all" || e.lane === values.lane) && values.filter!.split(",").some(part => e.file.includes(part)))) {
	const id = entry.file.replace(/[^a-zA-Z0-9.-]/g, "_");
	const bundle = join(directory, id + ".mjs");
	try {
		await build({ entryPoints: [join(root, entry.file)], outfile: bundle, bundle: true, platform: "node", format: "esm", target: "node22", logLevel: "silent",
			plugins: [{ name: "preserve-source-locations", setup(b) {
				// Resolve packages from each original importer, including workspace-only
				// dependencies. Moving a bundle must not change package visibility.
				b.onResolve({ filter: /^[^./]/ }, async args => {
					if (args.pluginData?.resolvingPackage || isBuiltin(args.path)) return;
					const found = await b.resolve(args.path, { kind: args.kind, resolveDir: args.resolveDir,
						pluginData: { resolvingPackage: true } });
					return { ...found, external: !args.path.startsWith("@open-orange/") };
				});
				b.onLoad({ filter: /\.ts$/ }, async args => ({
				contents: (await transform(await readFile(args.path, "utf8"), { loader: "ts", format: "esm", define: { "import.meta.url": JSON.stringify(pathToFileURL(args.path).href), "import.meta.dirname": JSON.stringify(dirname(args.path)), "import.meta.filename": JSON.stringify(args.path) } })).code,
				loader: "js", resolveDir: dirname(args.path),
			})); } }],
		});
	} catch (error) { results.push({ file: entry.file, status: "build-blocked", error: String(error) }); continue; }
	const row: any = { file: entry.file, lane: entry.lane, sourceRevision: revision(root), bundleSha256: hash(await readFile(bundle)), runs: {} };
	if (nodeReference) {
		const previous = nodeReference.results.find((candidate: any) => candidate.file === entry.file);
		const baseline = previous?.runs.node;
		if (!baseline?.valid || !baseline.complete || baseline.capped || baseline.timedOut || !baseline.cases.length ||
			baseline.cases.some((candidate: Case) => !["pass", "fail"].includes(candidate.status)) ||
			previous.bundleSha256 !== row.bundleSha256) throw new Error("Node reference is incomplete, unexecuted or uses a different test bundle");
		// A harness-only resume must not reuse a baseline after application, fixture,
		// assertion or setup changes. The byte-identical bundle is checked above too.
		const changed = execFileSync("jj", ["diff", "--from", previous.sourceRevision, "--to", "@", "--summary"], { cwd: root, encoding: "utf8" }).trim();
		if (changed && changed.split("\n").some(line => line !== "M tests/runtime-comparison/run.ts")) throw new Error("Source changed beyond the resume harness; execute a fresh baseline");
		row.runs.node = { ...baseline, referenceEvidence: { resultPath: nodeReferencePath, resultSha256: hash(nodeReferenceBytes!), sourceRevision: previous.sourceRevision, bundleSha256: previous.bundleSha256, execution: "previously executed complete Node baseline; not rerun" } };
	}
	for (const runtime of nodeReference ? ["agentos"] : values["host-only"] ? ["node"] : ["node", "agentos"]) {
		const prefix = join(directory, id + "." + runtime);
		const diagnostics = prefix + ".diagnostics";
		if (runtime === "agentos" && values.application) await mkdir(diagnostics);
		let result: any;
		if (runtime === "node" || values.application) {
			const environment: NodeJS.ProcessEnv = { ...process.env, OPENORANGE_RUNTIME: entry.controllerOnly ? "node" : runtime,
				OPENORANGE_COMPARISON_POLICY_LOG: prefix + ".policy.jsonl",
				...(runtime === "agentos" ? { OPENORANGE_AGENTOS_DIAGNOSTICS_DIR: diagnostics } : {}) };
			// Node's existing Worker Loader owns its locked, matching agentOS
			// dependency. The fresh main-runtime binary override belongs only
			// to this comparison's agentOS lane, not that older client.
			if (runtime === "node") delete environment.AGENTOS_SIDECAR_BIN;
			result = await execute(["--import", "tsx", "--import", "./tests/isolated-env.ts", "--import", "./tests/runtime-comparison/setup.ts", "--test", `--test-timeout=${timeoutMs}`,
				...(values["test-pattern"] ? [`--test-name-pattern=${values["test-pattern"]}`] : []),
				"--test-reporter", "./tests/runtime-comparison/reporter.ts", bundle], environment, prefix);
			Object.assign(result, hostCases(result.stdout));
			result.controllerOnly = entry.controllerOnly;
            result.execution = entry.controllerOnly ? "host Node.js build tooling; no application VM expected" : values.application ? `host controller, ${runtime} application runtime` : "host Node.js";
			if (runtime === "agentos") {
				result.runtimeDiagnostics = [];
				for await (const file of glob("*.jsonl", { cwd: diagnostics })) {
					const contents = await readFile(join(diagnostics, file));
					result.runtimeDiagnostics.push({ file: join(diagnostics, file), sha256: hash(contents) });
				}
				if (values.application && result.runtimeDiagnostics.length === 0) result.execution = "host controller only; no agentOS application runtime started";
			}
		} else {
			const request = { root, bundle, timeoutMs, outputLimit };
			await writeFile(prefix + ".request.json", JSON.stringify(request));
			result = await execute(["--import", "tsx", "tests/runtime-comparison/guest.ts", prefix + ".request.json", prefix + ".result.json"], process.env, prefix + ".controller");
			try { Object.assign(result, JSON.parse(await readFile(prefix + ".result.json", "utf8"))); } catch { result.error ??= "Guest controller did not produce a result"; }
			Object.assign(result, guestCases(result.stdout));
			result.execution = "agentOS guest V8";
			await writeFile(prefix + ".stdout", result.stdout); await writeFile(prefix + ".stderr", result.stderr);
		}
		const duplicates = result.cases.filter((c: Case, i: number, all: Case[]) => all.findIndex(x => x.name === c.name) !== i).map((c: Case) => c.name);
		if (revision(root) !== row.sourceRevision) result.error = "OpenOrange source changed during this file; rerun on frozen sources";
		if (JSON.stringify(await runtimeArtifacts()) !== JSON.stringify(artifacts)) result.error = "Runtime artifacts changed during this run; rerun on frozen artifacts";
		result.duplicates = duplicates;
		result.valid = validRun(result);
		delete result.stdout; delete result.stderr;
		row.runs[runtime] = result;
	}
	if (nodeReferencePath && hash(await readFile(nodeReferencePath)) !== hash(nodeReferenceBytes!)) throw new Error("Node reference changed during execution; no comparison credit");
	const host = row.runs.node, guest = row.runs.agentos;
	if (guest) {
		const expected = host.cases.map((c: Case) => c.name);
		const actual = guest.cases.map((c: Case) => c.name);
		row.missing = expected.filter((n: string) => !actual.includes(n));
		row.extra = actual.filter((n: string) => !expected.includes(n));
		row.parityPasses = matchedPasses(host, guest);
	}
	results.push(row);
	await writeFile(join(directory, "results.json"), JSON.stringify({ versions, results, unrun: inventory.filter(e => !results.some(r => r.file === e.file)).map(e => e.file) }, null, 2));
	console.log(`${entry.file}: node=${host.cases.filter((c: Case) => c.status === "pass").length}/${host.cases.length}${guest ? ` guest=${guest.cases.filter((c: Case) => c.status === "pass").length}/${guest.cases.length} matched=${row.parityPasses} complete=${guest.valid}` : ""}`);
}
await writeFile(join(directory, "results.json"), JSON.stringify({ versions, results, unrun: inventory.filter(e => !results.some(r => r.file === e.file)).map(e => e.file) }, null, 2));
