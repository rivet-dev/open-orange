// Groups the root test files by the Cloudflare area they cover, so each CI job is named after the
// area that failed. `tsx tests/test-areas.ts <area>` runs one area. `--check` fails when a test file
// is in no area or in two, so a new file cannot be skipped by CI.
import { spawnSync } from "node:child_process";
import { globSync } from "node:fs";

const testAreas: Record<string, readonly string[]> = {
	"durable-objects": [
		"src/runtime/durable-object-*.test.ts",
		"tests/durable-object-*.test.ts",
		"tests/class-migrations.test.ts",
		"tests/slow-constructor.test.ts",
	],
	"rpc-and-websockets": [
		"tests/*websockets.test.ts",
		"tests/websocket-close-codes.test.ts",
		"tests/rpc-*.test.ts",
		"tests/capnweb-stubs.test.ts",
		"tests/session-*.test.ts",
	],
	bindings: [
		"src/runtime/{ai-binding,all-bindings,assets,bindings,cache,r2,queues,service-binding,workflows,worker-loader,sandbox,multi-worker}.test.ts",
		"tests/{hyperdrive,service-queue,dev-vars,beyond-cloudflare-quotas}.test.ts",
	],
	events: [
		"src/runtime/cron-triggers.test.ts",
		"tests/{cron-sleep,long-handlers,service-scheduled,email-handler,tail-consumers,execution-context,request-clone-signal}.test.ts",
	],
	"node-compat": [
		"src/runtime/{node-crypto,node-fs,spawn}.test.ts",
		"tests/node-*.test.ts",
		"tests/worker-*.test.ts",
		"tests/{bun-runtime,module-rule-packages,additional-modules,html-rewriter-invalid-utf8,uint8array-encoding}.test.ts",
	],
	cli: [
		"src/*.test.ts",
		"src/{build,commands,config}/**/*.test.ts",
		"tests/orange-!(migrate*).test.ts",
		"tests/{gateway-auth,runtime-build-mismatch}.test.ts",
	],
	migrate: ["tests/orange-migrate*.test.ts"],
	examples: ["tests/{examples,runnable-examples,validate-example-manifests}.test.ts"],
};

function areaFiles(area: string): string[] {
	const patterns = testAreas[area];
	if (patterns === undefined) throw new Error(`Unknown test area ${area}. Areas: ${Object.keys(testAreas).join(", ")}`);
	return globSync([...patterns]).sort();
}

/** Test files that are in no area or in more than one. */
function unassignedTestFiles(): string[] {
	const areasOf = new Map<string, string[]>();
	for (const file of globSync(["src/**/*.test.ts", "tests/**/*.test.ts"])) areasOf.set(file, []);
	for (const area of Object.keys(testAreas)) {
		for (const file of areaFiles(area)) areasOf.get(file)?.push(area);
	}
	return [...areasOf]
		.filter(([, areas]) => areas.length !== 1)
		.map(([file, areas]) => (areas.length === 0 ? `${file} is in no area` : `${file} is in ${areas.join(" and ")}`))
		.sort();
}

const [argument] = process.argv.slice(2);
if (argument === "--check") {
	const problems = unassignedTestFiles();
	for (const problem of problems) console.error(`✗ ${problem}. Add it to one area in tests/test-areas.ts.`);
	process.exit(problems.length === 0 ? 0 : 1);
}
if (argument === undefined) {
	console.error(`Usage: tsx tests/test-areas.ts <${Object.keys(testAreas).join("|")}> | --check`);
	process.exit(2);
}
const files = areaFiles(argument);
const run = spawnSync("tsx", ["--import", "./tests/isolated-env.ts", "--test", ...files], { stdio: "inherit" });
process.exit(run.status ?? 1);
