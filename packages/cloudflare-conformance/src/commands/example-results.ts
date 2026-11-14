import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { packageRoot } from "./generate.js";

export const exampleResultsUsage = `Usage: cloudflare-conformance example-results

Runs tests/examples/runnable-examples.test.ts and saves each scenario's outcome to results/runnable-examples.json.`;

/** Reads each subtest's outcome and first error from node:test's TAP output. */
export function parseExampleTap(tap: string): Record<string, { status: "pass" | "fail"; error?: string }> {
	const examples: Record<string, { status: "pass" | "fail"; error?: string }> = {};
	const lines = tap.split("\n");
	for (const [index, line] of lines.entries()) {
		const match = /^\s{4}(ok|not ok) \d+ - (\S+)$/.exec(line);
		if (match === null) continue;
		const name = match[2]!;
		if (match[1] === "ok") {
			examples[name] = { status: "pass" };
			continue;
		}
		const following = lines.slice(index + 1, index + 40);
		const errorLine = following.findIndex((candidate) => /^\s+error: /.test(candidate));
		// A long error is a YAML block: `error: |-` with the text on the next lines.
		const inline = following[errorLine]?.replace(/^\s+error: /, "").replace(/^'|'$/g, "");
		const error = inline === "|-" || inline === "-" ? following[errorLine + 1]?.trim() : inline;
		examples[name] = {
			status: "fail",
			...(error === undefined ? {} : { error: error.slice(0, 400) }),
		};
	}
	return examples;
}

export async function exampleResults(io: { log(message: string): void }): Promise<void> {
	const root = join(packageRoot, "../..");
	const child = spawn(
		process.execPath,
		[
			"--import",
			"tsx",
			"--import",
			"./tests/harness/isolated-env.ts",
			"--test",
			"--test-timeout=1200000",
			"--test-reporter=tap",
			"tests/examples/runnable-examples.test.ts",
		],
		{ cwd: root, stdio: ["ignore", "pipe", "inherit"] },
	);
	let tap = "";
	child.stdout?.on("data", (chunk: Buffer) => {
		tap += chunk.toString("utf8");
	});
	await new Promise((resolve) => child.once("exit", resolve));
	const examples = parseExampleTap(tap);
	if (Object.keys(examples).length === 0) throw new Error(`No scenario outcome in the test output:\n${tap.slice(-2000)}`);
	await writeFile(
		join(packageRoot, "results/runnable-examples.json"),
		`${JSON.stringify({ orange: process.env.ORANGE_SHA ?? "unknown", ranAt: new Date().toISOString(), examples }, null, "\t")}\n`,
	);
	const failed = Object.entries(examples).filter(([, example]) => example.status === "fail").map(([name]) => name);
	io.log(`${Object.keys(examples).length} scenarios, failed: ${failed.join(", ") || "none"}`);
}
