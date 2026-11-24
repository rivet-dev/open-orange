import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { parseArgs, promisify } from "node:util";

import { readOrangeBuild, readRunSnapshot } from "../results/save.js";
import { readWorkerdMetadata } from "../runners/workerd.js";
import { areaOf, fileName, summarizeResults } from "../upstream/classify.js";
import {
	compareWithRunDirectory,
	formatComparison,
	formatSummary,
	summaryFileName,
} from "../upstream/report.js";
import {
	type BindingKind,
	bindingKinds,
	runUpstreamFile,
	stopAllUpstreamProcesses,
	type UpstreamFileResult,
} from "../upstream/run-file.js";
import {
	prepareUpstreamSources,
	readUpstreamPin,
	type UpstreamTestFile,
} from "../upstream/sources.js";
import {
	hostChanges,
	pathVocabulary,
	snapshotHost,
	watchedHost,
} from "../upstream/tmp-remap.js";
import { packageRoot } from "./generate.js";

const execFileAsync = promisify(execFile);

const defaultBindings: readonly BindingKind[] = [
	"service",
	"entrypoints",
	"vars",
	"unsafeEval",
	"loader",
	"kv",
	"r2",
	"queues",
	"analyticsEngine",
];

export const upstreamUsage = `Usage: cloudflare-conformance upstream [options]

Runs the pinned upstream workerd .wd-test files against orange dev.

Options:
  --filter <regex>        Only run files whose id matches, for example "api-tests--actor"
  --jobs <n>              Files to run at once (default 4)
  --out <dir>             Results directory (default .upstream/runs/<timestamp>)
  --compare <dir>         Print tests that changed against an earlier results directory
  --baseline <file>       Exit with an error when a test fails that does not fail in this saved
                          results file, such as results/latest.json
  --bindings <list>       Binding kinds to configure (default ${defaultBindings.join(",")})
                          Kinds: ${bindingKinds.join(", ")}
  --engine-binary <path>  rivet-engine to run (default: RIVET_ENGINE_BINARY, then RivetKit's bundled engine)`;

const fileTimeoutMs = 1_500_000;
const upstreamDirectory = join(packageRoot, ".upstream");
const repositoryRoot = join(packageRoot, "../..");

interface UpstreamIo {
	log(message: string): void;
	error(message: string): void;
}

function parseBindings(value: string): Set<BindingKind> {
	const kinds = new Set<BindingKind>();
	for (const kind of value.split(",").filter(Boolean)) {
		if (!(bindingKinds as readonly string[]).includes(kind)) {
			throw new Error(
				`Unknown binding kind "${kind}". Use: ${bindingKinds.join(", ")}`,
			);
		}
		kinds.add(kind as BindingKind);
	}
	return kinds;
}

function isPortFree(port: number): Promise<boolean> {
	return new Promise((resolvePort) => {
		const server = createServer();
		server.once("error", () => resolvePort(false));
		server.listen(port, "127.0.0.1", () =>
			server.close(() => resolvePort(true)),
		);
	});
}

// Orange dev ports come from 10081-19999. The Rivet Engine picks its ports in 20000-60010, the
// kernel hands out ephemeral ports from 32768 (Linux) or 49152 (macOS), and fetch() refuses 10080,
// the highest port on the Fetch spec bad-port list. Each file gets its own port.
function createPortAllocator(
	first = 10_081,
	last = 19_999,
): () => Promise<number> {
	let next = first;
	return async () => {
		while (next <= last) {
			const port = next++;
			if (await isPortFree(port)) {
				return port;
			}
		}
		throw new Error(`No free orange dev port left in ${first}-${last}`);
	};
}

async function requireCapnp(): Promise<void> {
	try {
		await execFileAsync("capnp", ["--version"]);
	} catch {
		throw new Error(
			"The upstream suite needs the capnp CLI to read .wd-test configs. Install Cap'n Proto 1.x (apt install capnproto, or brew install capnp).",
		);
	}
}

/** The `.wd-test` file and every module it embeds, for the host safety net. */
async function embeddedSources(file: UpstreamTestFile): Promise<string[]> {
	const config = await readFile(file.path, "utf8");
	const embedded = [...config.matchAll(/embed\s+"([^"]+)"/g)].map((match) =>
		readFile(join(dirname(file.path), match[1] ?? ""), "utf8"),
	);
	return [config, ...(await Promise.all(embedded))];
}

async function prepareOutputDirectory(path: string): Promise<void> {
	if (existsSync(path) && (await readdir(path)).length > 0) {
		throw new Error(
			`Results directory ${path} is not empty. Pass a new --out directory.`,
		);
	}
	await mkdir(join(path, "logs"), { recursive: true });
}

export async function upstream(
	args: readonly string[],
	io: UpstreamIo,
): Promise<void> {
	const { values } = parseArgs({
		args: [...args],
		options: {
			filter: { type: "string" },
			jobs: { type: "string", default: "4" },
			out: { type: "string" },
			compare: { type: "string" },
			baseline: { type: "string" },
			bindings: { type: "string", default: defaultBindings.join(",") },
			"engine-binary": { type: "string" },
		},
		strict: true,
		allowPositionals: false,
	});
	const jobs = Number(values.jobs);
	if (!Number.isInteger(jobs) || jobs < 1) {
		throw new Error(`--jobs must be a positive integer, got "${values.jobs}"`);
	}
	const filter =
		values.filter === undefined ? undefined : new RegExp(values.filter);
	const bindings = parseBindings(values.bindings);
	const env: NodeJS.ProcessEnv = { ...process.env };
	if (values["engine-binary"] !== undefined) {
		const engineBinary = resolve(values["engine-binary"]);
		if (!existsSync(engineBinary)) {
			throw new Error(`--engine-binary ${engineBinary} does not exist`);
		}
		env.RIVET_ENGINE_BINARY = engineBinary;
	}
	const compareDirectory =
		values.compare === undefined ? undefined : resolve(values.compare);
	if (compareDirectory !== undefined && !existsSync(compareDirectory)) {
		throw new Error(`--compare ${compareDirectory} does not exist`);
	}
	const baselinePath =
		values.baseline === undefined ? undefined : resolve(values.baseline);
	if (baselinePath !== undefined && !existsSync(baselinePath)) {
		throw new Error(`--baseline ${baselinePath} does not exist`);
	}
	const outputDirectory = resolve(
		values.out ??
			join(
				upstreamDirectory,
				"runs",
				new Date().toISOString().replace(/[:.]/g, "-"),
			),
	);

	await requireCapnp();
	await prepareOutputDirectory(outputDirectory);
	const pin = await readUpstreamPin(join(packageRoot, "upstream.json"));
	io.error(
		`fetching workerd ${pin.tag} (${pin.commit.slice(0, 12)}) test sources`,
	);
	const sources = await prepareUpstreamSources(
		pin,
		join(upstreamDirectory, "cache"),
		packageRoot,
	);
	const unknownIds = [
		...Object.keys(pin.notSupported),
		...Object.keys(pin.tmpWriters),
		...[
			...Object.keys(pin.notRunTests),
			...Object.keys(pin.unguaranteedTests),
			...Object.keys(pin.cloudflareQuotaTests),
		].map(
			(key) => key.split(" > ")[0] ?? key,
		),
	].filter((id) => !sources.files.some((file) => file.id === id));
	if (unknownIds.length > 0) {
		throw new Error(
			`upstream.json names files that are not in workerd ${pin.tag}: ${unknownIds.join(", ")}`,
		);
	}
	const notRunTests = (id: string): Record<string, string> =>
		Object.fromEntries(
			Object.entries(pin.notRunTests)
				.filter(([key]) => key.startsWith(`${id} > `))
				.map(([key, reason]) => [key.slice(id.length + 3), reason]),
		);
	const files = sources.files.filter(
		(file) => filter === undefined || filter.test(file.id),
	);
	if (files.length === 0) {
		throw new Error(
			`--filter ${values.filter} matches none of ${sources.files.length} upstream files`,
		);
	}
	const workerd = readWorkerdMetadata();
	const build = await readOrangeBuild(repositoryRoot);
	const nextPort = createPortAllocator();

	const onSignal = (signal: NodeJS.Signals) => {
		stopAllUpstreamProcesses();
		process.exit(signal === "SIGINT" ? 130 : 143);
	};
	process.once("SIGINT", onSignal);
	process.once("SIGTERM", onSignal);

	const startedAt = Date.now();
	const results: UpstreamFileResult[] = [];
	const runFile = async (file: UpstreamTestFile): Promise<void> => {
		const fileStartedAt = Date.now();
		let result: UpstreamFileResult;
		try {
			result = await runUpstreamFile({
				file,
				capnpImportPath: sources.capnpImportPath,
				repositoryRoot,
				workerdBinaryPath: workerd.binaryPath,
				compatibilityDate: workerd.compatibilityDate,
				bindings,
				env,
				port: await nextPort(),
				logDirectory: join(outputDirectory, "logs"),
				timeoutMs: fileTimeoutMs,
				writesTmp: Object.hasOwn(pin.tmpWriters, file.id),
				notRunTests: notRunTests(file.id),
			});
		} catch (error: unknown) {
			// A harness bug in one file must not stop the run. The file reports no scored tests.
			const detail = error instanceof Error ? error.message : String(error);
			io.error(`${file.id}: harness error: ${detail}`);
			result = {
				id: file.id,
				file: file.relativePath,
				service: null,
				dropped: [],
				boot: { ok: false, reason: "harness-error", detail },
				tests: {},
			};
		}
		await writeFile(
			join(outputDirectory, `${file.id}.json`),
			`${JSON.stringify(result, null, 1)}\n`,
		);
		results.push(result);
		const tests = Object.values(result.tests).filter(
			(test) => test.status !== "other-service",
		);
		io.error(
			`[${results.length}/${files.length}] ${file.id}  ${tests.filter((test) => test.status === "pass").length}/${tests.length} pass  ${Math.round((Date.now() - fileStartedAt) / 1000)}s`,
		);
	};
	const pooled = files.filter((file) => !Object.hasOwn(pin.tmpWriters, file.id));
	const tmpWriters = files.filter((file) => Object.hasOwn(pin.tmpWriters, file.id));
	const host = watchedHost(repositoryRoot);
	const hostChangesByFile: Array<{ id: string; changes: string[] }> = [];
	let nextFile = 0;
	try {
		// Files that write /tmp run first and one at a time, with nothing else of this run in flight,
		// so a host change in the window points at the file. Any change stops the run: on Orange a
		// Worker's /tmp is private, and on plain Node.js the file's /tmp is a scratch directory.
		for (const file of tmpWriters) {
			const vocabulary = pathVocabulary(await embeddedSources(file));
			const before = await snapshotHost(host);
			await runFile(file);
			const changes = hostChanges(host, before, await snapshotHost(host), vocabulary);
			if (changes.unattributed.length > 0) {
				io.error(
					`host safety net: ${file.id}: changes that the file cannot have made, from other processes:\n${changes.unattributed.map((change) => `  ${change}`).join("\n")}`,
				);
			}
			if (changes.blocking.length > 0) {
				hostChangesByFile.push({ id: file.id, changes: changes.blocking });
				io.error(
					`HOST SAFETY NET: ${file.id} writes /tmp, and the host changed:\n${changes.blocking.map((change) => `  ${change}`).join("\n")}`,
				);
				break;
			}
		}
		if (hostChangesByFile.length === 0) {
			await Promise.all(
				Array.from({ length: Math.min(jobs, pooled.length) }, async () => {
					while (nextFile < pooled.length) {
						const file = pooled[nextFile++];
						if (file === undefined) break;
						await runFile(file);
					}
				}),
			);
		}
	} finally {
		process.off("SIGINT", onSignal);
		process.off("SIGTERM", onSignal);
		stopAllUpstreamProcesses();
	}
	const wallSeconds = Math.round((Date.now() - startedAt) / 1000);

	results.sort((a, b) => a.id.localeCompare(b.id));
	const rows = summarizeResults(results, pin.notSupported, pin.unguaranteedTests, pin.cloudflareQuotaTests);
	await writeFile(join(outputDirectory, summaryFileName), JSON.stringify(rows));
	await writeFile(
		join(outputDirectory, "run.json"),
		`${JSON.stringify(
			{
				workerd: { tag: pin.tag, commit: pin.commit },
				files: files.length,
				filter: values.filter ?? null,
				jobs,
				bindings: [...bindings],
				engineBinary: env.RIVET_ENGINE_BINARY ?? null,
				orange: build.orange,
				rivetkit: build.rivetkit,
				startedAt: new Date(startedAt).toISOString(),
				wallSeconds,
			},
			null,
			"\t",
		)}\n`,
	);

	io.log(formatSummary(results.length, rows));
	if (tmpWriters.length > 0) {
		io.log(
			`\nhost safety net: watched ${[...new Set(Object.values(host))].join(", ")} around ${tmpWriters.length} files that write /tmp: ${hostChangesByFile.length === 0 ? "no changes" : "CHANGED, see above"}`,
		);
	}
	const harnessErrors = results.filter(
		(result) => result.boot?.reason === "harness-error",
	);
	if (harnessErrors.length > 0) {
		io.log(
			`\nharness errors, not scored: ${harnessErrors.map((result) => result.id).join(", ")}`,
		);
	}
	io.log(
		`\nwall time ${Math.floor(wallSeconds / 60)}m ${wallSeconds % 60}s, results in ${outputDirectory}`,
	);
	if (filter === undefined) {
		io.log(
			`save it with: pnpm results:save ${outputDirectory} --label <name>`,
		);
	}
	if (compareDirectory !== undefined) {
		io.log(`\ncompared with ${compareDirectory}`);
		io.log(
			formatComparison(
				await compareWithRunDirectory(compareDirectory, results),
			),
		);
	}
	if (baselinePath !== undefined) {
		const newFailures = await failuresMissingFrom(baselinePath, results, rows);
		// run() turns the error into exit code 1. An exit code set here would be overwritten.
		if (newFailures.length > 0) {
			throw new Error(
				`${newFailures.length} tests fail that do not fail in ${baselinePath}:\n${newFailures.map((test) => `  ${test}`).join("\n")}`,
			);
		}
	}
	if (hostChangesByFile.length > 0) {
		throw new Error(
			`Host safety net: ${hostChangesByFile.map(({ id }) => id).join(", ")} changed the host. The run stopped. Check every change listed above before running again.`,
		);
	}
}

// Failed tests, as `<file id> > <test>`, that the saved run at `baselinePath` does not record as
// failed. A test new since that run counts too, so a new test must pass.
async function failuresMissingFrom(
	baselinePath: string,
	results: readonly UpstreamFileResult[],
	rows: ReturnType<typeof summarizeResults>,
): Promise<string[]> {
	const baseline = await readRunSnapshot(baselinePath);
	const known = new Set(
		baseline.tests
			.filter((test) => test.status === "fail")
			.map((test) => `${test.file} > ${test.test}`),
	);
	// Summary rows name files without the directory prefix, so map them back by name and area.
	const idByRowKey = new Map(
		results.map((result) => [`${fileName(result.id)}|${areaOf(result.id)}`, result.id]),
	);
	return rows
		.filter((row) => row.status === "fail")
		.map((row) => `${idByRowKey.get(`${row.file}|${row.area}`) ?? row.file} > ${row.test}`)
		.filter((test) => !known.has(test));
}
