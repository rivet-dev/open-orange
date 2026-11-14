import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { dockerBuild, dockerSkip, imageHolds, withEngine, workerAnswer } from "../harness/deploy-image.js";
import { copyProject, repositoryRoot, type TemporaryProject, withDeadline } from "../harness/orange-dev.js";

const cliEntrypoint = join(repositoryRoot, "src", "bin.ts");
const secretValue = "secret-value-that-must-never-be-printed";

async function dryRun(
	project: TemporaryProject,
	args: readonly string[],
	environment: Record<string, string> = {},
): Promise<{ code: number | null; output: string }> {
	const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("RIVET")));
	const child = spawn(process.execPath, ["--import", "tsx", cliEntrypoint, "deploy", "--config", join(project.directory, "wrangler.jsonc"), "--dry-run", "--tag", "t1", ...args], {
		cwd: repositoryRoot,
		env: { ...env, ...environment, NO_COLOR: "1" },
		stdio: ["ignore", "pipe", "pipe"],
	});
	let output = "";
	child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
	child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
	const code = await withDeadline(new Promise<number | null>((done) => child.once("exit", done)), "orange deploy --dry-run", 120_000);
	return { code, output };
}

// The `-e` flags of the self-host `docker run` line, which carry the pool's environment.
function poolFlags(output: string): string[] {
	const line = output.split("\n").find((candidate) => candidate.trimStart().startsWith("docker run"));
	assert.ok(line !== undefined, output);
	const tokens = line.trim().split(/\s+/);
	return tokens.flatMap((token, index) =>
		tokens[index - 1] === "-e" && !token.startsWith("RIVET_ENDPOINT=") ? ["-e", token] : [],
	);
}

test("a Worker deployed with --var and --secrets-file reads them from its runner's environment, and the image holds neither", { skip: dockerSkip, timeout: 600_000 }, async () => {
	const project = await copyProject(join(repositoryRoot, "tests", "fixtures", "worker-env"));
	const tag = "oo-worker-env-test:1";
	const outdir = join(project.directory, "out");
	try {
		await writeFile(join(project.directory, ".dev.vars"), "API_KEY=local-dev-value\n");
		// Inside the project, which the image copies.
		const secrets = join(project.directory, "secrets.json");
		await writeFile(secrets, JSON.stringify({ API_KEY: secretValue }));
		const deploy = await dryRun(project, ["--secrets-file", secrets, "--var", "GREETING:from-the-pool", "--outdir", outdir]);
		assert.equal(deploy.code, 0, deploy.output);
		assert.ok(!deploy.output.includes(secretValue), deploy.output);
		assert.match(deploy.output, /Secrets\s+API_KEY$/m);
		const flags = poolFlags(deploy.output);

		dockerBuild(outdir, tag);
		for (const value of [secretValue, "local-dev-value", "from-the-pool"]) assert.equal(imageHolds(tag, value), false, value);

		await withEngine(async (endpoint) => {
			// OTHER is in the runner's environment but not the pool's, so the Worker does not see it.
			const answer = await workerAnswer(tag, endpoint, { environment: { API_KEY: secretValue, OTHER: "x" }, flags: [...flags, "-e", "OTHER"] });
			assert.deepEqual(JSON.parse(answer), { API_KEY: secretValue, GREETING: "from-the-pool", OTHER: null });

			// A secret removed from the pool after the deploy, as with `rivet cluster env unset`, leaves the
			// Worker serving without it.
			const unset = await workerAnswer(tag, endpoint, { flags });
			assert.deepEqual(JSON.parse(unset), { API_KEY: null, GREETING: "from-the-pool", OTHER: null });
		});
	} finally {
		spawnSync("docker", ["rmi", "-f", tag], { stdio: "ignore" });
		await project.dispose();
	}
});

test("orange deploy refuses a variable or secret Rivet would not take, before it writes anything, and never prints the value", { timeout: 300_000 }, async () => {
	const project = await copyProject(join(repositoryRoot, "tests", "fixtures", "worker-env"));
	const outdir = join(project.directory, "out");
	const file = async (name: string, content: string): Promise<string> => {
		const path = join(project.directory, name);
		await writeFile(path, content);
		return path;
	};
	const pem = await file("pem.env", 'TLS_KEY="-----BEGIN PRIVATE KEY-----\nkey-body-value\n-----END PRIVATE KEY-----"\n');
	const big = await file("big.json", JSON.stringify({ BIG: `key-body-value${"x".repeat(1011)}` }));
	const greeting = await file("greeting.json", JSON.stringify({ GREETING: "key-body-value" }));
	const empty = await file("empty.env", "API_KEY=\n");
	try {
		for (const [args, reason] of [
			[["--secrets-file", pem], /TLS_KEY has a line break.*base64 -w0 key\.pem.*atob\(env\.TLS_KEY\)/],
			[["--secrets-file", empty], /empty\.env: API_KEY is empty\. Give it a value, or remove the line/],
			[["--secrets-file", big], /BIG is 1025 bytes, and a Rivet cluster secret holds at most 1024/],
			[["--var", "GREETING:a", "--secrets-file", greeting], /GREETING is set by both --var GREETING and .*greeting\.json/],
			[["--var", "RIVET_TOKEN:key-body-value"], /Rivet or Orange sets RIVET_TOKEN on every runner/],
			[["--var", "RIVET_USER_DATA_BUCKET:key-body-value"], /Rivet or Orange sets RIVET_USER_DATA_BUCKET on every runner/],
			[["--var", "CACHE:key-body-value"], /CACHE is already a binding in the Wrangler configuration/],
			[["--secret", "API_KEY=-bad"], /"-bad" is not a secret name/],
			[["--secrets-file", join(outdir, "missing.env")], /--secrets-file .*missing\.env does not exist\. Pass the path to a \.env or JSON file/],
			[["--secrets-file", project.directory], /--secrets-file .* is a directory\. Pass the path to a \.env or JSON file/],
		] as const) {
			const refused = await dryRun(project, [...args, "--outdir", outdir]);
			assert.equal(refused.code, 1, refused.output);
			assert.match(refused.output, reason);
			assert.match(refused.output, /Nothing was deployed/);
			assert.ok(!refused.output.includes("key-body-value"), refused.output);
			await assert.rejects(readFile(join(outdir, "Dockerfile")));
		}
	} finally {
		await project.dispose();
	}
});
