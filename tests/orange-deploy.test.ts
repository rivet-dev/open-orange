import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { copyProject, repositoryRoot, type TemporaryProject, withDeadline } from "./orange-dev.js";
import { type RivetCloudDouble, type RivetCloudDoubleOptions, startRivetCloudDouble } from "./rivet-cloud-double.js";

const cliEntrypoint = join(repositoryRoot, "src", "bin.ts");
const token = "cloud-token-value-7f3a";
const cluster = "acme";

// Image builds need a running Docker daemon.
const dockerSkip =
	spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0
		? false
		: "Docker is not running, so orange deploy cannot build an image here";

// The developer's shell must not choose the cluster, token, or Rivet endpoint for a test.
function cleanEnvironment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
	const env = Object.fromEntries(
		Object.entries(process.env).filter(([name]) => !name.startsWith("RIVET_") && !name.startsWith("RIVETKIT_")),
	);
	return { ...env, ...extra };
}

async function orangeDeploy(
	project: TemporaryProject,
	args: readonly string[],
	env: NodeJS.ProcessEnv = {},
): Promise<{ code: number | null; output: string; stdout: string }> {
	const child = spawn(
		process.execPath,
		["--import", "tsx", cliEntrypoint, "deploy", "--config", join(project.directory, "wrangler.jsonc"), ...args],
		{ cwd: repositoryRoot, env: cleanEnvironment(env), stdio: ["ignore", "pipe", "pipe"] },
	);
	let output = "";
	let stdout = "";
	child.stdout.on("data", (chunk: Buffer) => {
		output += chunk.toString();
		stdout += chunk.toString();
	});
	child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
	const code = await withDeadline(
		new Promise<number | null>((resolveExit) => child.once("exit", resolveExit)),
		"orange deploy",
		600_000,
	);
	return { code, output, stdout };
}

// Each call gets its own image tag, and the image that a real build makes is removed afterwards,
// also when the test fails. Each image is about 2 GB.
async function withDeploy(
	options: Partial<RivetCloudDoubleOptions>,
	body: (cloud: RivetCloudDouble, project: TemporaryProject, env: NodeJS.ProcessEnv, tag: string) => Promise<void>,
): Promise<void> {
	const cloud = await startRivetCloudDouble({ cluster, regions: ["iad"], token, ...options });
	const project = await copyProject(join(repositoryRoot, "examples", "hello-durable-object"));
	const tag = `test-${randomBytes(4).toString("hex")}`;
	try {
		await body(cloud, project, { RIVET_CLOUD_TOKEN: token, RIVET_CLUSTER: cluster }, tag);
	} finally {
		spawnSync("docker", ["image", "rm", "--force", `hello-durable-object:${tag}`], { stdio: "ignore" });
		await project.dispose();
		await cloud.close();
	}
}

const deployDirectory = (project: TemporaryProject): string => join(project.directory, ".open-orange", "deploy");

test("orange deploy builds, uploads, and rolls out a new pool, then prints its public URL", { skip: dockerSkip }, async () => {
	await withDeploy({}, async (cloud, project, env, tag) => {
		const { code, output, stdout } = await orangeDeploy(project, ["--cloud-api", cloud.url, "--tag", tag], env);
		assert.equal(code, 0, output);
		assert.equal(cloud.uploads.length, 1, output);
		assert.deepEqual(
			{ ...cloud.uploads[0], bytes: undefined },
			{ bytes: undefined, isImageTarball: true, matchesBuild: true },
			"the upload is the image tarball with the declared size and MD5",
		);
		const pool = cloud.pools.get("iad/default");
		assert.ok(pool?.build_id?.startsWith("bld_") === true, output);
		assert.deepEqual(pool.cidr_allowlist, []);
		assert.match(stdout, new RegExp(`✓ Deployed hello-durable-object:${tag} to pool default in iad`));
		assert.match(stdout, /URL +https:\/\/default\.iad\.acme\.rivet\.test/);
		assert.ok(!output.includes(token), "the token is never printed");
	});
});

test("a build that fails with a user fault stops the deploy with its reason and leaves the pool alone", { skip: dockerSkip }, async () => {
	await withDeploy(
		{ buildOutcome: { code: "image_platform", fault: "user", message: "The image is not built for linux/amd64." } },
		async (cloud, project, env, tag) => {
			const { code, output } = await orangeDeploy(project, ["--cloud-api", cloud.url, "--tag", tag], env);
			assert.equal(code, 1, output);
			assert.match(output, /Build bld_\w+ failed with image_platform: The image is not built for linux\/amd64\. Fix the image and deploy again\./);
			assert.ok(!cloud.requests.some((request) => request.includes("/runner-pools/")), cloud.requests.join("\n"));
			assert.equal(cloud.pools.size, 0);
		},
	);
});

test("an upload that storage refuses fails with the storage reason and is never completed", { skip: dockerSkip }, async () => {
	await withDeploy(
		{ uploadRejection: { code: "BadDigest", message: "The Content-MD5 you specified did not match what we received.", status: 400 } },
		async (cloud, project, env, tag) => {
			const { code, output } = await orangeDeploy(project, ["--cloud-api", cloud.url, "--tag", tag], env);
			assert.equal(code, 1, output);
			assert.match(output, /Failed to upload the image\. Storage answered HTTP 400 BadDigest: The Content-MD5 you specified did not match what we received\./);
			assert.ok(!cloud.requests.some((request) => request.endsWith("/complete")), cloud.requests.join("\n"));
			assert.equal(cloud.pools.size, 0);
		},
	);
});

test("an upload that storage times out fails with that reason, and its HTML error page is never printed", { skip: dockerSkip }, async () => {
	const html = "<!DOCTYPE html>\n<html lang=en>\n  <title>Error 408 (Request Timeout)!!1</title>\n  <p>Your client has taken too long to issue its request.</p>\n</html>\n";
	await withDeploy({ uploadRejection: { html, status: 408 } }, async (cloud, project, env) => {
		const { code, output } = await orangeDeploy(project, ["--cloud-api", cloud.url], env);
		assert.equal(code, 1, output);
		assert.match(output, /Failed to upload the image\. Storage stopped receiving it and timed the upload out \(HTTP 408\)\. Check the connection, then deploy again\./);
		assert.ok(!/DOCTYPE|Request\+?Timeout|%3Chtml/i.test(output), output);
		assert.ok(!cloud.requests.some((request) => request.endsWith("/complete")), cloud.requests.join("\n"));
		assert.equal(cloud.pools.size, 0);
	});
});

test("a rejected token fails before anything is built and names where the token comes from", async () => {
	await withDeploy({}, async (cloud, project, env) => {
		const { code, output } = await orangeDeploy(project, ["--cloud-api", cloud.url], {
			...env,
			RIVET_CLOUD_TOKEN: "stale-token-value",
		});
		assert.equal(code, 1, output);
		assert.match(output, /Couldn't list the regions of cluster acme\. Rivet Cloud rejected the token: The bearer token is invalid or expired\./);
		assert.match(output, /Pass a valid Rivet Cloud token with --token or RIVET_CLOUD_TOKEN\./);
		assert.ok(!output.includes("stale-token-value"), "the token is never printed");
		assert.ok(!existsSync(deployDirectory(project)), "nothing is built for a rejected token");
	});
});

test("a cluster token that cannot create a new pool fails with what to do next, and no bug report link", async () => {
	await withDeploy({ builds: { bld_ready: "ready" }, tokenIsClusterToken: true }, async (cloud, project, env) => {
		const { code, output } = await orangeDeploy(project, ["--cloud-api", cloud.url, "--build", "bld_ready"], env);
		assert.equal(code, 1, output);
		assert.match(output, /Cluster tokens cannot create runner pool 'default'\./);
		assert.match(output, /Create pool default in the dashboard at https:\/\/dashboard\.rivet\.dev, or deploy once after `orange login`\./);
		assert.doesNotMatch(output, /organization that owns the cluster|Looks like a bug/);
		assert.equal(cloud.pools.size, 0);
	});
});

test("a cluster with several regions needs --region and lists them", async () => {
	await withDeploy({ regions: ["iad", "fra"] }, async (cloud, project, env) => {
		const { code, output } = await orangeDeploy(project, ["--cloud-api", cloud.url], env);
		assert.equal(code, 1, output);
		assert.match(output, /Cluster acme has several regions: iad, fra\. Pass --region <region>\./);
		assert.ok(!existsSync(deployDirectory(project)), "nothing is built before the region is known");
	});
});

const existingPool = {
	build_id: "bld_old",
	cidr_allowlist: ["10.0.0.0/8", "203.0.113.7/32"],
	machine_type: "e2-medium",
	node_count: 2,
};

test("--build rolls the pool back to a ready build without building or uploading, and keeps its allowlist", async () => {
	await withDeploy(
		{ builds: { bld_old: "ready", bld_prev: "ready" }, pools: { "iad/web": existingPool }, regions: ["iad", "fra"] },
		async (cloud, project, env) => {
			const { code, output, stdout } = await orangeDeploy(
				project,
				["--cloud-api", cloud.url, "--region", "iad", "--pool", "web", "--build", "bld_prev"],
				env,
			);
			assert.equal(code, 0, output);
			assert.ok(!cloud.requests.some((request) => request === `POST /v2/clusters/${cluster}/builds`), cloud.requests.join("\n"));
			assert.equal(cloud.uploads.length, 0);
			assert.ok(!existsSync(deployDirectory(project)), "a rollback writes no build context");
			assert.deepEqual(cloud.poolUpdates, [{ build_id: "bld_prev", cidr_allowlist: existingPool.cidr_allowlist }]);
			assert.deepEqual(cloud.pools.get("iad/web"), { ...existingPool, build_id: "bld_prev" });
			assert.match(stdout, /URL +https:\/\/web\.iad\.acme\.rivet\.test/);
		},
	);
});

test("--build refuses a build that is not ready and leaves the pool alone", async () => {
	await withDeploy({ builds: { bld_bad: "failed" } }, async (cloud, project, env) => {
		const { code, output } = await orangeDeploy(project, ["--cloud-api", cloud.url, "--build", "bld_bad"], env);
		assert.equal(code, 1, output);
		assert.match(output, /Build bld_bad failed with image_invalid: not an image\./);
		assert.deepEqual(cloud.poolUpdates, []);
	});
});

test("a pool that goes down during the rollout fails with its reason and the rollback command", async () => {
	await withDeploy(
		{
			builds: { bld_new: "ready", bld_old: "ready" },
			poolOutcome: { fault: "user", message: "Runners exit right after they start.", state: "down" },
			pools: { "iad/default": existingPool },
		},
		async (cloud, project, env) => {
			const { code, output } = await orangeDeploy(project, ["--cloud-api", cloud.url, "--build", "bld_new"], env);
			assert.equal(code, 1, output);
			assert.match(output, /Pool default in region iad is down \(user fault\): Runners exit right after they start\./);
			assert.match(output, /Roll back with: orange deploy --cluster acme --region iad --pool default --build bld_old/);
		},
	);
});

test("--dry-run writes a credential-free runner image and calls no API", async () => {
	await withDeploy({}, async (cloud, project) => {
		await writeFile(join(project.directory, ".dev.vars"), "API_KEY=dev-secret-value\n");
		const { code, output, stdout } = await orangeDeploy(project, [
			"--dry-run",
			"--cloud-api",
			cloud.url,
			"--cluster",
			cluster,
			"--token",
			token,
			"--tag",
			"t1",
		]);
		assert.equal(code, 0, output);
		assert.deepEqual(cloud.requests, [], "a dry run sends nothing to Rivet Cloud");
		assert.match(stdout, /^Token +<redacted>$/m);
		assert.ok(!output.includes(token), "a dry run never prints the token");
		assert.ok(!output.includes("dev-secret-value"), "a dry run never prints a secret value");
		assert.match(output, /! \.dev\.vars sets API_KEY, which the image leaves out\. The pool keeps the secrets it has\. To send these, pass --secrets-file \.dev\.vars\./);

		const dockerfile = await readFile(join(deployDirectory(project), "Dockerfile"), "utf8");
		assert.match(dockerfile, /^CMD \["orange","serve","--config","wrangler.jsonc"\]$/m);
		// The cluster sets RIVET_ENDPOINT, RIVET_TOKEN, RIVET_NAMESPACE, and RIVET_POOL when the runner starts.
		assert.doesNotMatch(dockerfile, /RIVET/);
		assert.ok(!dockerfile.includes(token));
		const worker = join(deployDirectory(project), "context", "worker");
		assert.ok(existsSync(join(worker, "src", "index.ts")));
		assert.ok(!existsSync(join(worker, ".dev.vars")), ".dev.vars never enters the image");
		assert.match(
			stdout,
			new RegExp(`docker build --platform linux/amd64 -f ${join(deployDirectory(project), "Dockerfile")} -t hello-durable-object:t1 `),
		);
	});
});

test("orange deploy refuses a variable Rivet sets and -e KEY=VAL before it builds or calls anything", async () => {
	await withDeploy({}, async (cloud, project, env) => {
		const secret = await orangeDeploy(project, ["--cloud-api", cloud.url, "--var", "RIVET_TOKEN:x"], env);
		assert.equal(secret.code, 1, secret.output);
		assert.match(secret.output, /Rivet or Orange sets RIVET_TOKEN on every runner/);

		const variable = await orangeDeploy(project, ["--cloud-api", cloud.url, "-e", "API_KEY=value"], env);
		assert.equal(variable.code, 1, variable.output);
		assert.match(variable.output, /-e, --env selects a Wrangler environment, not a variable/);

		assert.deepEqual(cloud.requests, []);
		assert.ok(!existsSync(deployDirectory(project)));
	});
});

test("--outdir refuses a directory that holds files orange deploy did not write", async () => {
	await withDeploy({}, async (cloud, project) => {
		const outdir = join(dirname(project.directory), "out");
		await mkdir(outdir);
		await writeFile(join(outdir, "notes.txt"), "keep me");
		const { code, output } = await orangeDeploy(project, ["--dry-run", "--cloud-api", cloud.url, "--outdir", outdir]);
		assert.equal(code, 1, output);
		assert.match(output, /--outdir .* holds files that orange deploy did not write: notes\.txt/);
		assert.equal(await readFile(join(outdir, "notes.txt"), "utf8"), "keep me");
		assert.ok(!existsSync(join(outdir, "Dockerfile")));
	});
});
