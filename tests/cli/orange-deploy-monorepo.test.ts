import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { dockerBuild, dockerSkip, withEngine, workerAnswer } from "../harness/deploy-image.js";
import { copyProject, repositoryRoot, withDeadline } from "../harness/orange-dev.js";

const cliEntrypoint = join(repositoryRoot, "src", "bin.ts");

async function dryRun(config: string, outdir: string, extra: NodeJS.ProcessEnv): Promise<{ code: number | null; output: string }> {
	const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("RIVET")));
	const child = spawn(process.execPath, ["--import", "tsx", cliEntrypoint, "deploy", "--config", config, "--dry-run", "--tag", "t1", "--outdir", outdir], {
		cwd: repositoryRoot,
		env: { ...env, NO_COLOR: "1", ...extra },
		stdio: ["ignore", "pipe", "pipe"],
	});
	let output = "";
	child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
	child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
	const code = await withDeadline(new Promise<number | null>((done) => child.once("exit", done)), "orange deploy --dry-run", 120_000);
	return { code, output };
}

test("a custom build runs on the host, its output reaches the image, and a failed build stops the deploy", { skip: dockerSkip, timeout: 600_000 }, async () => {
	const project = await copyProject(join(repositoryRoot, "tests", "fixtures", "deploy-custom-build"));
	const tag = "oo-custom-build-test:1";
	const outdir = join(project.directory, "out");
	const config = join(project.directory, "wrangler.jsonc");
	try {
		const failing = await dryRun(config, outdir, { FAIL_THE_BUILD: "1" });
		assert.equal(failing.code, 1, failing.output);
		assert.match(failing.output, /custom build `node build\.mjs` failed/);

		const passing = await dryRun(config, outdir, {});
		assert.equal(passing.code, 0, passing.output);
		dockerBuild(outdir, tag);
		assert.equal(await withEngine((endpoint) => workerAnswer(tag, endpoint)), "from a custom build");
	} finally {
		spawnSync("docker", ["rmi", "-f", tag], { stdio: "ignore" });
		await project.dispose();
	}
});

test("a Worker with workspace: and file: dependencies builds an image, and serves them, its Durable Object, and its module rule file in /bundle", { skip: dockerSkip, timeout: 600_000 }, async () => {
	const project = await copyProject(join(repositoryRoot, "tests", "fixtures", "deploy-monorepo"));
	const tag = "oo-monorepo-test:1";
	const worker = join(project.directory, "apps", "worker");
	const outdir = join(project.directory, "out");
	try {
		// The links an install makes, which exist only on the machine that deploys.
		await mkdir(join(worker, "node_modules", "@acme"), { recursive: true });
		await symlink(join(project.directory, "packages", "lib"), join(worker, "node_modules", "@acme", "lib"));
		await symlink(join(project.directory, "packages", "shared"), join(worker, "node_modules", "@acme", "shared"));

		const deploy = await dryRun(join(worker, "wrangler.jsonc"), outdir, {});
		assert.equal(deploy.code, 0, deploy.output);

		dockerBuild(outdir, tag);
		const answer = await withEngine((endpoint) => workerAnswer(tag, endpoint));
		const note = "from a module rule\n";
		assert.deepEqual(JSON.parse(answer), {
			bundle: [[`${createHash("sha1").update(note).digest("hex")}-note.txt`, note]],
			count: "1",
			lib: "from a workspace: package",
			note: "from a module rule",
			shared: "from a file: package",
		});
	} finally {
		spawnSync("docker", ["rmi", "-f", tag], { stdio: "ignore" });
		await project.dispose();
	}
});

test("a Worker whose main is outside the project directory builds an image that serves that code", { skip: dockerSkip, timeout: 600_000 }, async () => {
	const project = await copyProject(join(repositoryRoot, "tests", "fixtures", "deploy-outside-main"));
	const tag = "oo-outside-main-test:1";
	const outdir = join(project.directory, "out");
	try {
		const deploy = await dryRun(join(project.directory, "app", "wrangler.jsonc"), outdir, {});
		assert.equal(deploy.code, 0, deploy.output);

		dockerBuild(outdir, tag);
		const answer = await withEngine((endpoint) => workerAnswer(tag, endpoint));
		assert.equal(answer, "from a main outside the project");
	} finally {
		spawnSync("docker", ["rmi", "-f", tag], { stdio: "ignore" });
		await project.dispose();
	}
});

test("a Worker whose main and find_additional_modules files are outside the project builds an image that loads them", { skip: dockerSkip, timeout: 600_000 }, async () => {
	const project = await copyProject(join(repositoryRoot, "tests", "fixtures", "deploy-outside-modules"));
	const tag = "oo-outside-modules-test:1";
	const outdir = join(project.directory, "out");
	try {
		const deploy = await dryRun(join(project.directory, "app", "wrangler.jsonc"), outdir, {});
		assert.equal(deploy.code, 0, deploy.output);

		dockerBuild(outdir, tag);
		const answer = await withEngine((endpoint) => workerAnswer(tag, endpoint));
		assert.equal(answer, "from an additional module outside the project");
	} finally {
		spawnSync("docker", ["rmi", "-f", tag], { stdio: "ignore" });
		await project.dispose();
	}
});
