import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs, parseEnv } from "node:util";

import { type AdditionalModuleSearch, findAdditionalModules } from "../build/additional-modules.js";
import { bundleWorker, type ModuleRule } from "../build/bundle-worker.js";
import { runCustomBuild } from "./dev.js";
import { customBuildDoneVariable } from "./serve.js";
import { unresolvedRuntimeModules } from "../build/rewrite-module-imports.js";
import { ExpectedFailure, exitWithOutcome } from "../cli/issue-report.js";
import { startSpinner } from "../cli/spinner.js";
import { createTheme, type Theme } from "../cli/theme.js";
import { loadWranglerConfiguration } from "../config/load-wrangler.js";
import {
	createRivetCloudClient,
	type RivetBuild,
	type RivetCloudClient,
	type RivetPool,
	type RivetRegion,
	type RunnerEnvValue,
	uploadFile,
} from "./rivet-cloud-api.js";
import { type CloudAuth, defaultCloudApi, findLink, resolveCloudAuth } from "./rivet-account.js";
import {
	type EnvironmentChange,
	maxClusterSecrets,
	mergePoolEnvironment,
	readEnvironmentChange,
	samePoolEnvironment,
} from "./deploy-environment.js";

export interface DeployCommandIo {
	error(message: string): void;
	log(message: string): void;
}

// Local state and secrets never enter the image. `.dev.vars` and `.env` files hold local secrets.
const excludedNames = new Set([".git", ".open-orange", ".rivet", ".wrangler", "node_modules"]);
const isLocalSecretsFile = (name: string): boolean =>
	name.startsWith(".dev.vars") || name === ".env" || name.startsWith(".env.");
const isExcluded = (name: string): boolean => excludedNames.has(name) || isLocalSecretsFile(name);

const orangeContext = "orange";

// `orange serve` listens on PORT. A self-hosted container publishes it.
const imagePort = 8080;

const defaultPool = "default";
// The Cloud API refuses a larger `docker image save` tarball.
const maxImageBytes = 5 * 1024 ** 3;
const pollIntervalMs = 2_000;
// Preparing a build usually takes 3 to 5 minutes.
const buildTimeoutMs = 20 * 60_000;
const rolloutTimeoutMs = 20 * 60_000;

// Docker reference grammar for a repository path and a tag.
// https://github.com/distribution/reference/blob/v0.6.0/regexp.go
const imagePattern = /^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*(?:\/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*)*$/;
const tagPattern = /^[\w][\w.-]{0,127}$/;

const deployOptions = {
	build: { type: "string" },
	"cloud-api": { type: "string" },
	cluster: { type: "string" },
	config: { multiple: true, short: "c", type: "string" },
	"dry-run": { type: "boolean" },
	env: { short: "e", type: "string" },
	image: { type: "string" },
	"machine-type": { type: "string" },
	"node-count": { type: "string" },
	org: { type: "string" },
	outdir: { type: "string" },
	pool: { type: "string" },
	region: { type: "string" },
	secret: { multiple: true, type: "string" },
	"secrets-file": { multiple: true, type: "string" },
	tag: { type: "string" },
	token: { type: "string" },
	var: { multiple: true, type: "string" },
} as const;

export function renderDeployHelp(theme: Theme): string {
	const option = (flags: string, description: string): string =>
		`  ${theme.fg("orange", flags.padEnd(26))}${description}`;
	return [
		theme.bold("open-orange deploy"),
		"",
		"Build an image that runs `orange serve` and roll it out to a runner pool on a Rivet cluster.",
		`\n${theme.bold("Options")}`,
		option("-c, --config <path>", "Wrangler configuration file. One Worker per deploy."),
		option("-e, --env <name>", "Wrangler environment from the configuration. Not a variable."),
		option("--dry-run", "Write the Dockerfile and build context and print the plan. Calls no API."),
		option("--outdir <dir>", "Write the build context here. Default .open-orange/deploy."),
		`\n${theme.bold("Rivet cluster")}`,
		option("--cluster <name>", "Cluster to deploy to. Default RIVET_CLUSTER, then the linked cluster."),
		option("--org <slug>", "Organization of the cluster. Default RIVET_ORG, then the linked one."),
		option("--region <region>", "Region of the pool. Default the cluster's only region."),
		option("--pool <name>", `Runner pool. Default ${defaultPool}.`),
		option("--token <token>", "Rivet Cloud API token. Default RIVET_CLOUD_TOKEN, then `orange login`."),
		option("--cloud-api <url>", `Rivet Cloud API. Default ${defaultCloudApi}.`),
		option("--build <id>", "Roll out this ready build. Builds and uploads nothing."),
		option("--image <name>", "Image name recorded on the build. Default the Worker name."),
		option("--tag <tag>", "Image tag. Default the UTC time, such as 20261028-213000."),
		option("--machine-type <type>", "Machine type of the pool's nodes, such as e2-small"),
		option("--node-count <count>", "Number of nodes in the pool"),
		`\n${theme.bold("Variables and secrets")}`,
		option("--var <NAME:value>", "Set a variable in the pool. Overrides `vars` of the same name."),
		option("--secret <KEY[=SECRET]>", "Set KEY to a cluster secret, named KEY unless SECRET is given."),
		option("--secrets-file <path>", "Roll out secrets from a JSON object or .env file, such as .dev.vars."),
		theme.dim("`vars` from the configuration ship inside the image. Local .dev.vars and .env files do not."),
		theme.dim("These flags add to the pool's variables, as `rivet deploy --env` does."),
		theme.dim("Remove one with `rivet cluster env unset`."),
		`\n${theme.bold("Self-host")}`,
		"  orange deploy --dry-run --outdir out    Write the build and print the docker commands",
		"  docker run -e RIVET_ENDPOINT=https://<namespace>:<token>@<engine-host> ...",
		`\n${theme.bold("Exit codes")}`,
		`  ${theme.dim("0 deployed, or the dry run finished · 1 failed, including invalid arguments")}`,
	].join("\n");
}

// Builds an image that runs `orange serve`, uploads it to a Rivet cluster, and rolls
// a runner pool out to it through the Rivet Cloud API.
export async function runDeployCommand(
	args: readonly string[],
	io: DeployCommandIo,
): Promise<number> {
	try {
		return await executeDeployCommand(args, io);
	} catch (error: unknown) {
		io.error(error instanceof Error ? error.message : String(error));
		return error instanceof ExpectedFailure ? exitWithOutcome(1) : 1;
	}
}

async function executeDeployCommand(args: readonly string[], io: DeployCommandIo): Promise<number> {
	const { values } = parseArgs({ args: args.slice(1), options: deployOptions, strict: true });
	// Other deploy CLIs set a variable with `--env KEY=VAL`, so a user may pass one here.
	if (values.env?.includes("=") === true) {
		throw new Error(
			"-e, --env selects a Wrangler environment, not a variable. Set a variable with --var NAME:value.",
		);
	}
	const existingBuild = values.build;
	if (existingBuild !== undefined) {
		const conflicting = (["outdir", "image", "tag"] as const).filter((flag) => values[flag] !== undefined);
		if (conflicting.length > 0) {
			throw new Error(
				`--build rolls out an existing build, so it takes no ${conflicting.map((flag) => `--${flag}`).join(" or ")}. Pass only one of them.`,
			);
		}
	}
	if ((values.config?.length ?? 0) > 1) {
		throw new Error(
			"orange deploy supports one Worker for now. Pass a single --config and deploy each Worker on its own.",
		);
	}
	const nodeCount = values["node-count"] === undefined ? undefined : Number(values["node-count"]);
	if (nodeCount !== undefined && (!Number.isInteger(nodeCount) || nodeCount < 1)) {
		throw new Error(`--node-count must be a whole number of at least 1, not ${values["node-count"]}`);
	}
	const link = findLink();
	const apiUrl = values["cloud-api"] ?? defaultCloudApi;
	const namedCluster = values.cluster ?? nonEmpty(process.env.RIVET_CLUSTER);
	// A link's organization belongs to its cluster, so it does not apply to any other cluster.
	// https://github.com/rivet-dev/actors/blob/587132c26994d9358b1ed1633641f023cb8f3942/engine/packages/cli/src/target.rs#L100-L125
	const organization = values.org ?? nonEmpty(process.env.RIVET_ORG) ?? (namedCluster === undefined ? link?.org : undefined);
	const target: DeployTarget = {
		apiUrl,
		auth: await resolveCloudAuth(values.token, apiUrl),
		cluster: namedCluster ?? link?.cluster,
		...(values["machine-type"] === undefined ? {} : { machineType: values["machine-type"] }),
		...(nodeCount === undefined ? {} : { nodeCount }),
		pool: values.pool ?? defaultPool,
		...(organization === undefined ? {} : { organization }),
		...(values.region === undefined ? {} : { region: values.region }),
	};
	const dryRun = values["dry-run"] === true;
	if (!dryRun) requireCredentials(target);

	const configPath = values.config?.[0];
	const config = await loadWranglerConfiguration({
		deployed: true,
		...(configPath === undefined ? {} : { configPath }),
		...(values.env === undefined ? {} : { environment: values.env }),
	});
	if (config.assets !== undefined && !isInside(config.projectRoot, config.assets.directory)) {
		throw new Error(
			`orange deploy copies the project directory only, so assets must be inside it: ${config.assets.directory}`,
		);
	}
	const image = values.image ?? (config.workerName ?? "orange-worker").toLowerCase();
	if (!imagePattern.test(image)) {
		throw new Error(
			`${values.image === undefined ? "The Worker name" : "--image"} ${JSON.stringify(image)} is not a valid image name. Pass --image with lowercase letters, digits, and . _ - separators.`,
		);
	}
	const tag = values.tag ?? utcTimestamp(new Date());
	if (!tagPattern.test(tag)) {
		throw new Error(`--tag ${JSON.stringify(tag)} is not a valid image tag. Use letters, digits, _ . and -, up to 128 characters.`);
	}
	const reference = `${image}:${tag}`;
	const flags = { secrets: values.secret ?? [], secretsFiles: values["secrets-file"] ?? [], vars: values.var ?? [] };
	const otherBindings = new Set(
		config.bindings.filter((binding) => binding.type !== "plain_text" && binding.type !== "json").map((binding) => binding.binding),
	);
	const change = await readEnvironmentChange(flags, otherBindings);
	for (const warning of await undeployedSecretWarnings(config.projectRoot, change)) io.error(warning);

	const writeBuild = async (): Promise<BuildContext> => {
		// As `wrangler deploy` does. Its output must not mix with this command's own lines on stdout.
		if (config.build !== undefined) await runCustomBuild(config.build, process.stderr, createTheme(process.stderr));
		return await writeBuildContext(
			config.projectRoot,
			values.outdir === undefined ? join(config.projectRoot, ".open-orange", "deploy") : resolve(values.outdir),
			{
				...(config.configPath === undefined
					? {}
					: { configPath: relative(config.projectRoot, config.configPath) }),
				...(values.env === undefined ? {} : { environment: values.env }),
				...(config.build === undefined ? {} : { builtOnHost: true }),
			},
			{
				...(config.additionalModuleSearch === undefined ? {} : { additionalModules: config.additionalModuleSearch }),
				configPath: config.configPath,
				entrypoint: config.entrypoint,
				moduleRules: config.moduleRules,
				warn: (message) => io.error(message),
			},
			// A secrets file can sit in the project, and its values never enter the image.
			new Set(flags.secretsFiles.map((path) => resolve(path))),
		);
	};

	if (dryRun) {
		const build = existingBuild === undefined ? await writeBuild() : undefined;
		printDryRun(io, createTheme(process.stdout), { build, change, existingBuild, otherBindings, reference, target });
		return 0;
	}

	const { auth, cluster } = requireCredentials(target);
	const cloud = createRivetCloudClient({
		apiUrl: target.apiUrl,
		cluster,
		...(target.organization === undefined ? {} : { organization: target.organization }),
		token: (force) => auth.token(force),
	});
	const theme = createTheme(process.stdout);
	// Reading the regions checks the token and the cluster before anything is built.
	const region = resolveRegion(await cloud.listRegions(), cluster, target.region);
	io.log(`Deploying ${theme.bold(image)} to cluster ${theme.bold(cluster)}, region ${theme.bold(region.region)}, pool ${theme.bold(target.pool)}`);
	// Checked before the build, so a missing secret or a full cluster refuses in seconds.
	if (change !== undefined) await checkSecrets(cloud, cluster, change);

	let buildId: string;
	if (existingBuild === undefined) {
		const build = await writeBuild();
		buildId = await buildAndUpload(io, theme, cloud, build, reference);
	} else {
		const build = await cloud.getBuild(existingBuild);
		if (build.status !== "ready") throw new Error(buildNotReady(build, cluster));
		buildId = build.build_id;
	}

	const previous = await cloud.getPool(region.region, target.pool);
	const next = mergePoolEnvironment(previous?.env, change, otherBindings);
	// Without a change the pool keeps its `env`, and with it any versions a rollback pinned.
	const sendEnvironment = !samePoolEnvironment(previous?.env, next.env);
	for (const name of next.shadowed) {
		io.error(`! The pool sets ${name}, which is a binding in the Wrangler configuration, so the Worker keeps the binding.`);
	}
	// A secret's new value rolls every pool that names it, as `rivet cluster secret set` does, so
	// this waits until the build is ready and the pool rolls to it next.
	for (const [secret, value] of change?.uploads ?? []) {
		const result = await cloud.rolloutSecret(secret, value);
		io.log(`${result.changed ? "Rolled out" : "Unchanged:"} secret ${secret} (version ${result.latest_version})`);
	}
	if (sendEnvironment && next.unpinned.length > 0) {
		io.log(`Unpinning ${next.unpinned.join(", ")}, so the pool takes their latest versions`);
	}
	const rollout = previous === undefined ? "Creating" : "Rolling out";
	io.log(`${rollout} pool ${target.pool} with build ${buildId}…`);
	await cloud.putPool(region.region, target.pool, {
		build_id: buildId,
		// A rollout changes the build and the environment only, so the pool keeps who may reach it.
		cidr_allowlist: previous?.cidr_allowlist ?? [],
		...(sendEnvironment ? { env: next.env } : {}),
		...(target.machineType === undefined ? {} : { machine_type: target.machineType }),
		...(target.nodeCount === undefined ? {} : { node_count: target.nodeCount }),
	});
	const pool = await waitForRollout(cloud, theme, region.region, target.pool, () =>
		rollbackHint(cluster, region.region, target.pool, previous?.build_id ?? undefined, buildId),
	);
	io.log(`${theme.fg("green", "✓")} Deployed ${reference} to pool ${target.pool} in ${region.region}`);
	io.log(`  ${"Build".padEnd(8)}${buildId}`);
	const url = pool.endpoints.public ?? region.endpoints.public;
	io.log(`  ${"URL".padEnd(8)}${theme.link(url)}`);
	return 0;
}

// As `rivet deploy` does, a `--secret` must name a secret the cluster holds. Uploads must fit its cap.
async function checkSecrets(cloud: RivetCloudClient, cluster: string, change: EnvironmentChange): Promise<void> {
	const existing = new Set(await cloud.listSecrets());
	const missing = [...change.secrets].filter(([, secret]) => !existing.has(secret) && !change.uploads.has(secret));
	if (missing.length > 0) {
		const [name, secret] = missing[0] as [string, string];
		throw new Error(
			`Cluster ${cluster} has no secret ${secret} for ${name}. Set it with \`rivet cluster secret set ${secret}\`, or pass it in --secrets-file. Nothing was deployed.`,
		);
	}
	const added = [...change.uploads.keys()].filter((secret) => !existing.has(secret)).length;
	if (existing.size + added > maxClusterSecrets) {
		throw new Error(
			`Cluster ${cluster} holds ${existing.size} secrets, this deploy adds ${added}, and a cluster holds at most ${maxClusterSecrets}. Delete unused secrets with \`rivet cluster secret delete\`. Nothing was deployed.`,
		);
	}
}

interface DeployTarget {
	apiUrl: string;
	auth: CloudAuth | undefined;
	cluster: string | undefined;
	machineType?: string;
	nodeCount?: number;
	pool: string;
	region?: string;
	organization?: string;
}

function nonEmpty(value: string | undefined): string | undefined {
	return value === undefined || value.length === 0 ? undefined : value;
}

function requireCredentials(target: DeployTarget): { auth: CloudAuth; cluster: string } {
	if (target.cluster === undefined) {
		throw new Error("orange deploy needs a cluster. Pass --cluster <name>, set RIVET_CLUSTER, or run `orange link --cluster <name>`.");
	}
	if (target.auth === undefined) {
		throw new Error("orange deploy needs Rivet Cloud credentials. Run `orange login`, or set RIVET_CLOUD_TOKEN or pass --token for CI.");
	}
	return { auth: target.auth, cluster: target.cluster };
}

function resolveRegion(regions: readonly RivetRegion[], cluster: string, requested: string | undefined): RivetRegion {
	const names = regions.map((region) => region.region).join(", ");
	if (requested !== undefined) {
		const region = regions.find((candidate) => candidate.region === requested);
		if (region === undefined) {
			throw new Error(`Cluster ${cluster} has no region ${requested}. Its regions: ${names || "none"}.`);
		}
		return region;
	}
	const [only, ...others] = regions;
	if (only === undefined) {
		throw new Error(`Cluster ${cluster} has no regions. Enable a region on the cluster, then deploy again.`);
	}
	if (others.length > 0) {
		throw new Error(`Cluster ${cluster} has several regions: ${names}. Pass --region <region>.`);
	}
	return only;
}

// Builds the image, uploads its `docker image save` tarball, and waits until Rivet Cloud
// has prepared it. Returns the ready build's ID.
async function buildAndUpload(
	io: DeployCommandIo,
	theme: Theme,
	cloud: RivetCloudClient,
	build: BuildContext,
	reference: string,
): Promise<string> {
	io.log(`Building ${reference} for linux/amd64…`);
	await docker("docker build", ["build", "--platform", "linux/amd64", "-f", build.dockerfilePath, "-t", reference, build.contextDirectory]);
	const temporary = await mkdtemp(join(tmpdir(), "open-orange-deploy-"));
	try {
		const tarball = join(temporary, "image.tar");
		await docker("docker image save", ["image", "save", "-o", tarball, reference]);
		const { size } = await stat(tarball);
		if (size > maxImageBytes) {
			throw new Error(`The image is ${formatBytes(size)}, and Rivet clusters take images up to 5 GiB. Make the image smaller.`);
		}
		const md5 = await md5Base64(tarball);
		const created = await cloud.createBuild({ content_length: size, content_md5: md5, image: reference });
		io.log(`Uploading build ${created.build_id} (${formatBytes(size)})…`);
		await uploadFile(created.upload_url, tarball, size, md5);
		await cloud.completeBuild(created.build_id);
		io.log(`Preparing build ${created.build_id}. This takes a few minutes…`);
		await waitForBuild(cloud, theme, created.build_id);
		io.log(`${theme.fg("green", "✓")} Build ${created.build_id} ready`);
		return created.build_id;
	} finally {
		await rm(temporary, { force: true, recursive: true });
	}
}

async function waitForBuild(cloud: RivetCloudClient, theme: Theme, buildId: string): Promise<void> {
	const deadline = Date.now() + buildTimeoutMs;
	const spinner = startSpinner(process.stderr, theme, `Preparing build ${buildId}…`);
	try {
		for (;;) {
			const build = await cloud.getBuild(buildId);
			if (build.status === "ready") return;
			if (build.status === "failed" || build.status === "expired" || build.status === "deleting") {
				throw new Error(buildNotReady(build, undefined));
			}
			if (Date.now() > deadline) {
				throw new Error(
					`Build ${buildId} is still ${build.status} after ${buildTimeoutMs / 60_000} minutes. Rivet Cloud may still prepare it. Roll it out later with --build ${buildId}.`,
				);
			}
			spinner.update(`Preparing build ${buildId} (${build.status})…`);
			await delay(pollIntervalMs);
		}
	} finally {
		spinner.stop();
	}
}

function buildNotReady(build: RivetBuild, cluster: string | undefined): string {
	const failure = build.failure;
	if (build.status === "failed" && failure !== null) {
		const next =
			failure.fault === "user"
				? "Fix the image and deploy again."
				: `This is a Rivet Cloud fault. Deploy again, or contact Rivet support with build ID ${build.build_id}.`;
		return `Build ${build.build_id} failed with ${failure.code}: ${sentence(failure.message)} ${next}`;
	}
	if (build.status === "expired") {
		return `Build ${build.build_id} expired before its upload completed. Deploy again.`;
	}
	const where = cluster === undefined ? "" : ` on cluster ${cluster}`;
	return `Build ${build.build_id}${where} is ${build.status}, and only a ready build can be rolled out.`;
}

async function waitForRollout(
	cloud: RivetCloudClient,
	theme: Theme,
	region: string,
	poolName: string,
	hint: () => string,
): Promise<RivetPool> {
	const deadline = Date.now() + rolloutTimeoutMs;
	const spinner = startSpinner(process.stderr, theme, `Waiting for pool ${poolName} to roll out…`);
	try {
		for (;;) {
			const pool = await cloud.getPool(region, poolName);
			if (pool === undefined) throw new Error(`Pool ${poolName} in region ${region} disappeared during the rollout.`);
			const { replicas, state } = pool.status;
			if (state === "ready" && replicas !== null && replicas.updated === replicas.desired) return pool;
			if (state === "degraded" || state === "down") {
				const fault = pool.status.fault === null ? "" : ` (${pool.status.fault} fault)`;
				throw new Error(
					`Pool ${poolName} in region ${region} is ${state}${fault}: ${sentence(pool.status.message ?? "Rivet Cloud gave no reason")}${hint()}`,
				);
			}
			if (Date.now() > deadline) {
				const progress = replicas === null ? "" : ` with ${replicas.updated} of ${replicas.desired} nodes updated`;
				throw new Error(
					`Pool ${poolName} is still ${state}${progress} after ${rolloutTimeoutMs / 60_000} minutes. The rollout continues on Rivet Cloud.${hint()}`,
				);
			}
			spinner.update(
				`Waiting for pool ${poolName} to roll out (${state}${replicas === null ? "" : `, ${replicas.updated}/${replicas.desired} nodes updated`})…`,
			);
			await delay(pollIntervalMs);
		}
	} finally {
		spinner.stop();
	}
}

function rollbackHint(cluster: string, region: string, pool: string, previous: string | undefined, current: string): string {
	if (previous === undefined || previous === current) return "";
	return `\nRoll back with: orange deploy --cluster ${cluster} --region ${region} --pool ${pool} --build ${previous}`;
}

function printDryRun(
	io: DeployCommandIo,
	theme: Theme,
	plan: {
		build: BuildContext | undefined;
		change: EnvironmentChange | undefined;
		existingBuild: string | undefined;
		otherBindings: ReadonlySet<string>;
		reference: string;
		target: DeployTarget;
	},
): void {
	const { build, target } = plan;
	const row = (label: string, value: string): void => io.log(`${label.padEnd(12)}${value}`);
	io.log(theme.bold("Dry run. Nothing was built or sent to Rivet Cloud."));
	io.log("");
	if (build !== undefined) {
		row("Dockerfile", build.dockerfilePath);
		row("Context", build.contextDirectory);
		row("Image", plan.reference);
	} else if (plan.existingBuild !== undefined) {
		row("Build", plan.existingBuild);
	}
	row("Cluster", target.cluster ?? theme.fg("yellow", "not set. Pass --cluster, set RIVET_CLUSTER, or run `orange link`."));
	row("Region", target.region ?? "the cluster's only region");
	row("Pool", target.pool);
	row("Cloud API", target.apiUrl);
	row("Token", target.auth === undefined ? theme.fg("yellow", "not set. Run `orange login`, set RIVET_CLOUD_TOKEN, or pass --token.") : "<redacted>");
	const { change } = plan;
	if (change === undefined) {
		row("Variables", "the pool keeps its variables and secrets");
	} else {
		row("Variables", [...change.vars.keys()].join(", ") || "none added");
		row("Secrets", [...change.secrets].map(([name, secret]) => (name === secret ? name : `${name} from ${secret}`)).join(", ") || "none added");
	}
	if (build === undefined) return;
	const shell = (command: string[]): string => `  ${command.map(shellQuote).join(" ")}`;
	io.log("");
	io.log(theme.bold("Self-host"));
	io.log(
		shell(["docker", "build", "--platform", "linux/amd64", "-f", build.dockerfilePath, "-t", plan.reference, build.contextDirectory]),
	);
	io.log(
		shell([
			"docker",
			"run",
			"--rm",
			"-p",
			`${imagePort}:${imagePort}`,
			"-e",
			"RIVET_ENDPOINT=https://<namespace>:<token>@<engine-host>",
			...environmentFlags(mergePoolEnvironment(undefined, change, plan.otherBindings).env),
			plan.reference,
		]),
	);
}

// The pool's environment as `docker run` flags. A bare `-e NAME` passes the shell's value, so a
// secret's value never appears in the command.
function environmentFlags(env: Readonly<Record<string, RunnerEnvValue>>): string[] {
	return Object.entries(env).flatMap(([name, value]) => ["-e", "string" in value ? `${name}=${value.string}` : name]);
}

// `.dev.vars` and `.env` hold local values, and the image leaves them out, as `wrangler deploy` does.
async function undeployedSecretWarnings(projectRoot: string, environment: EnvironmentChange | undefined): Promise<string[]> {
	const warnings: string[] = [];
	for (const name of (await readdir(projectRoot)).filter(isLocalSecretsFile).sort()) {
		const keys = Object.keys(parseEnv(await readFile(join(projectRoot, name), "utf8"))).filter(
			(key) => environment === undefined || (!environment.secrets.has(key) && !environment.vars.has(key)),
		);
		if (keys.length === 0) continue;
		warnings.push(
			environment === undefined
				? `! ${name} sets ${keys.join(", ")}, which the image leaves out. The pool keeps the secrets it has. To send these, pass --secrets-file ${name}.`
				: `! ${name} sets ${keys.join(", ")}, which the image leaves out and this deploy does not send. To send them, pass --secrets-file ${name}.`,
		);
	}
	return warnings;
}

async function docker(label: string, args: readonly string[]): Promise<void> {
	let code: number;
	try {
		// Docker's output goes to stderr, so stdout holds only the deploy's own lines.
		code = await run("docker", args, process.cwd(), "stderr");
	} catch (error: unknown) {
		if (error instanceof Error && Reflect.get(error, "code") === "ENOENT") {
			throw new Error("orange deploy needs Docker to build the image. Install Docker, or pass --build <id> to roll out a build that exists.");
		}
		throw error;
	}
	if (code !== 0) throw new Error(`${label} failed with exit code ${code}. See its output above.`);
}

async function md5Base64(path: string): Promise<string> {
	const hash = createHash("md5");
	for await (const chunk of createReadStream(path)) hash.update(chunk);
	return hash.digest("base64");
}

function sentence(text: string): string {
	return /[.!?]$/.test(text) ? text : `${text}.`;
}

function formatBytes(bytes: number): string {
	if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
	if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
	return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
}

// Such as 20261028-213000, in UTC.
function utcTimestamp(date: Date): string {
	const iso = date.toISOString();
	return `${iso.slice(0, 10).replaceAll("-", "")}-${iso.slice(11, 19).replaceAll(":", "")}`;
}

interface BuildContext {
	contextDirectory: string;
	dockerfilePath: string;
}

// Writes `<directory>/Dockerfile` and `<directory>/context`, which hold the
// Worker project and the running Orange.
async function writeBuildContext(
	projectRoot: string,
	directory: string,
	image: Omit<DockerfileOptions, "packageManager">,
	worker: {
		additionalModules?: AdditionalModuleSearch;
		configPath?: string | undefined;
		entrypoint: string | undefined;
		moduleRules: readonly ModuleRule[];
		warn(message: string): void;
	},
	excludedPaths: ReadonlySet<string>,
): Promise<BuildContext> {
	const contextDirectory = join(directory, "context");
	const dockerfilePath = join(directory, "Dockerfile");
	// A second run replaces Orange's own output and nothing else.
	const foreign = existsSync(directory)
		? (await readdir(directory)).filter(
				(entry) => entry !== "context" && !(entry === "Dockerfile" && isGeneratedDockerfile(dockerfilePath)),
			)
		: [];
	if (foreign.length > 0) {
		throw new Error(
			`--outdir ${directory} holds files that orange deploy did not write: ${foreign.join(", ")}. Pass an empty or new directory.`,
		);
	}
	await rm(dockerfilePath, { force: true });
	await rm(contextDirectory, { force: true, recursive: true });
	await mkdir(contextDirectory, { recursive: true });
	// `main` can sit outside the project, as in `../worker/src/index.ts`. The image then keeps the
	// project and the entrypoint where they are relative to each other, below their common parent,
	// so the config's `main` still names the bundle. `find_additional_modules` searches from the
	// entrypoint's directory or `base_dir`, which can be outside the project too.
	const moduleRoot = worker.additionalModules?.root;
	const imageRoot = commonParent(projectRoot, [
		...(worker.entrypoint === undefined ? [] : [worker.entrypoint]),
		...(moduleRoot === undefined ? [] : [moduleRoot]),
	]);
	const projectInImage = relative(imageRoot, projectRoot);
	const workerContext = join(contextDirectory, "worker");
	const projectContext = join(workerContext, projectInImage);
	// The output directory can be inside the project, so entries are copied one
	// by one and the output directory itself is skipped.
	const copied = (source: string): boolean =>
		source !== directory && !isExcluded(basename(source)) && !excludedPaths.has(resolve(source));
	for (const entry of await readdir(projectRoot)) {
		if (!copied(join(projectRoot, entry))) continue;
		await cp(join(projectRoot, entry), join(projectContext, entry), {
			filter: copied,
			recursive: true,
		});
	}
	await writeRuntimePackageJson(projectRoot, projectContext);
	// `orange serve` finds these again in the image, in the same place, so a search root outside
	// the project needs its files copied. One inside the project was copied with it.
	if (worker.additionalModules !== undefined && !isInside(projectRoot, worker.additionalModules.root)) {
		const modules = await findAdditionalModules(worker.additionalModules, [
			...(worker.entrypoint === undefined ? [] : [worker.entrypoint]),
			...(worker.configPath === undefined ? [] : [worker.configPath]),
		]);
		for (const module of modules) {
			const target = join(workerContext, relative(imageRoot, module.path));
			await mkdir(dirname(target), { recursive: true });
			await cp(module.path, target);
		}
	}
	// Packages resolve here, where they are installed. `workspace:` and `file:../` dependencies would
	// not resolve inside the image, which holds only this directory.
	if (worker.entrypoint !== undefined) {
		const bundle = await bundleWorker({
			entrypoint: worker.entrypoint,
			moduleRewrites: unresolvedRuntimeModules(),
			moduleRules: worker.moduleRules,
			outputPath: join(workerContext, relative(imageRoot, worker.entrypoint)),
			packagesOnly: true,
		});
		for (const warning of bundle.warnings) worker.warn(`! ${warning}`);
	}
	const { packageManager } = await copyRunningOrange(contextDirectory);
	await writeFile(
		dockerfilePath,
		dockerfile({ ...image, packageManager, projectDirectory: projectInImage.split(sep).join("/") }),
	);
	return { contextDirectory, dockerfilePath };
}

const generatedDockerfileHeader = "# Generated by orange deploy.";

function isGeneratedDockerfile(path: string): boolean {
	return readFileSync(path, "utf8").startsWith(generatedDockerfileHeader);
}

// The nearest directory that holds the project and each of the paths.
function commonParent(projectRoot: string, paths: readonly string[]): string {
	let parent = projectRoot;
	while (!paths.every((path) => isInside(parent, path)) && dirname(parent) !== parent) parent = dirname(parent);
	return parent;
}

function isInside(root: string, path: string): boolean {
	const fromRoot = relative(root, path);
	return fromRoot === "" || (!fromRoot.startsWith("..") && !isAbsolute(fromRoot));
}

// The image installs only runtime dependencies. Development dependencies such as
// `workspace:` links cannot resolve outside the project.
async function writeRuntimePackageJson(projectRoot: string, workerDirectory: string): Promise<void> {
	const path = join(projectRoot, "package.json");
	if (!existsSync(path)) return;
	const manifest: unknown = JSON.parse(await readFile(path, "utf8"));
	const record = typeof manifest === "object" && manifest !== null ? manifest : {};
	await writeFile(
		join(workerDirectory, "package.json"),
		`${JSON.stringify(
			{
				private: true,
				type: Reflect.get(record, "type") ?? "module",
			},
			null,
			2,
		)}\n`,
	);
}

// The image runs the same Orange as this command, so a deploy never depends on
// what the registry has under this version. Its dependencies install from the
// lockfile that the build of this Orange wrote, so the image build resolves
// nothing and gets the tree that this Orange was tested with.
async function copyRunningOrange(contextDirectory: string): Promise<{ packageManager: string }> {
	const file = fileURLToPath(import.meta.url);
	const packageRoot = orangePackageRoot(dirname(file));
	const orangeDirectory = join(contextDirectory, orangeContext);
	// Running from TypeScript means a source checkout, so Orange is built from that source,
	// straight into the image. The checkout's own `dist` is never read: another build or deploy
	// in the same checkout can delete parts of it while this copies. Otherwise the running
	// `dist` is copied as it is.
	const fromSource = file.endsWith(".ts");
	const dist = fromSource ? join(orangeDirectory, "dist") : join(packageRoot, "dist");
	if (fromSource) {
		const code = await run("pnpm", ["run", "build", dist], packageRoot, "ignore");
		if (code !== 0) throw new Error(`pnpm run build failed for open-orange at ${packageRoot}`);
	}
	const lockfile = join(dist, "image", "pnpm-lock.yaml");
	if (!existsSync(lockfile)) {
		throw new Error(`orange deploy found no dependency lockfile at ${lockfile}. Rebuild open-orange.`);
	}
	const manifest: unknown = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
	const record = typeof manifest === "object" && manifest !== null ? manifest : {};
	await mkdir(orangeDirectory, { recursive: true });
	await writeFile(
		join(orangeDirectory, "package.json"),
		`${JSON.stringify(
			{
				...Object.fromEntries(
					["name", "version", "type", "packageManager", "dependencies"].map((key) => [
						key,
						Reflect.get(record, key),
					]),
				),
				// The image is linux/amd64 on glibc, so other native builds stay out.
				pnpm: { supportedArchitectures: { cpu: ["x64"], libc: ["glibc"], os: ["linux"] } },
			},
			null,
			2,
		)}\n`,
	);
	await cp(lockfile, join(orangeDirectory, "pnpm-lock.yaml"));
	if (!fromSource) await cp(dist, join(orangeDirectory, "dist"), { recursive: true });
	const packageManager = Reflect.get(record, "packageManager");
	if (typeof packageManager !== "string" || !packageManager.startsWith("pnpm@")) {
		throw new Error(`open-orange at ${packageRoot} does not name its pnpm version in packageManager`);
	}
	return { packageManager };
}

function orangePackageRoot(directory: string): string {
	for (let current = directory; ; current = dirname(current)) {
		const manifest = join(current, "package.json");
		if (existsSync(manifest) && readPackageName(manifest) === "open-orange") return current;
		if (dirname(current) === current) {
			throw new Error(`orange deploy found no open-orange package.json above ${directory}`);
		}
	}
}

function readPackageName(manifestPath: string): unknown {
	const manifest: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
	return typeof manifest === "object" && manifest !== null ? Reflect.get(manifest, "name") : undefined;
}

interface DockerfileOptions {
	// `orange deploy` ran the Worker's custom build, so `orange serve` does not refuse its config.
	builtOnHost?: boolean;
	configPath?: string;
	environment?: string;
	// The pnpm that wrote the lockfile, such as `pnpm@10.13.1`.
	packageManager: string;
	// The project's place below /app, when `main` is outside the project. Empty otherwise.
	projectDirectory?: string;
}

function dockerfile(options: DockerfileOptions): string {
	const command = [
		"orange",
		"serve",
		...(options.configPath === undefined ? [] : ["--config", options.configPath]),
		...(options.environment === undefined ? [] : ["--env", options.environment]),
	];
	return [
		generatedDockerfileHeader,
		"FROM --platform=linux/amd64 node:24-slim AS orange",
		"WORKDIR /orange",
		// The dependency layer stays cached until Orange's dependencies change.
		`COPY ${orangeContext}/package.json ${orangeContext}/pnpm-lock.yaml ./`,
		// npm times out and retries a stalled download. Corepack waits forever.
		`RUN npm install --global --no-audit --no-fund ${options.packageManager}`,
		"RUN --mount=type=cache,target=/root/.local/share/pnpm/store pnpm install --frozen-lockfile --prod --ignore-scripts",
		`COPY ${orangeContext}/dist ./dist`,
		"",
		"FROM --platform=linux/amd64 node:24-slim",
		"COPY --from=orange /orange /orange",
		"RUN ln -s /orange/dist/bin.js /usr/local/bin/orange",
		"WORKDIR /app",
		"COPY worker/ /app/",
		...(options.projectDirectory === undefined || options.projectDirectory === ""
			? []
			: [`WORKDIR ${posix.join("/app", options.projectDirectory)}`]),
		`ENV NODE_ENV=production PORT=${imagePort}`,
		...(options.builtOnHost === true ? [`ENV ${customBuildDoneVariable}=1`] : []),
		`EXPOSE ${imagePort}`,
		`CMD ${JSON.stringify(command)}`,
		"",
	].join("\n");
}

function run(
	command: string,
	args: readonly string[],
	cwd: string,
	stdout: "ignore" | "stderr",
): Promise<number> {
	return new Promise((resolveRun, rejectRun) => {
		const child = spawn(command, args, {
			cwd,
			stdio: ["ignore", stdout === "stderr" ? process.stderr : "ignore", "inherit"],
		});
		child.once("error", rejectRun);
		child.once("exit", (code) => resolveRun(code ?? 1));
	});
}

function shellQuote(value: string): string {
	return /^[\w./:=@,+-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}
