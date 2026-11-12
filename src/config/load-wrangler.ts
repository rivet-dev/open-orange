import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";

import type { AdditionalModuleSearch } from "../build/additional-modules.js";
import type { ModuleRule } from "../build/bundle-worker.js";
import { parseHyperdriveConnectionString } from "../../packages/runtime-node/src/bindings/hyperdrive.js";
import { unsupportedBindingMessage } from "../../packages/runtime-node/src/bindings/unsupported.js";
import {
	nextCloudflareCronTime,
	parseCloudflareCron,
} from "../../packages/runtime-node/src/internal-actors/cron-expression.js";
import type {
	RuntimeAssetsConfiguration,
	RuntimeAssetsHtmlHandling,
	RuntimeAssetsNotFoundHandling,
	RuntimeQueueConsumer,
} from "../../packages/runtime-node/src/process-protocol.js";
import {
	SUPPORTED_COMPATIBILITY_DATE,
	SUPPORTED_COMPATIBILITY_FLAGS,
} from "./profile.js";
import { isRecord } from "../unknown-values.js";

export interface GenerateWranglerTypesOptions {
	config?: string;
	env?: string;
	envFile?: string[];
	envInterface?: string;
	includeEnv?: boolean;
	includeRuntime?: boolean;
	path?: string;
	strictVars?: boolean;
}

// One entry of a Wrangler binding collection. Every variant has a `type`; the
// other fields depend on it.
interface WranglerBinding {
	readonly type: string;
	readonly [field: string]: unknown;
}

export interface WranglerApi {
	experimental_readRawConfig(args: { config?: string; env?: string; script?: string }): {
		rawConfig: Record<string, unknown>;
	};
	experimental_generateTypes(options: GenerateWranglerTypesOptions): Promise<unknown>;
	unstable_convertConfigBindingsToStartWorkerBindings(
		config: Record<string, unknown>,
	): Record<string, WranglerBinding>;
	unstable_getVarsForDev(
		configPath: string | undefined,
		envFiles: string[] | undefined,
		vars: unknown,
		env: string | undefined,
		silent?: boolean,
		secrets?: unknown,
	): Record<string, WranglerBinding>;
	unstable_readConfig(
		args: {
			config?: string;
			env?: string;
			script?: string;
		},
		options: { hideWarnings: boolean },
	): unknown;
}

export interface SecretsStoreBindingConfiguration {
	binding: string;
	secretName: string;
	storeId: string;
	type: "secrets_store_secret";
}

export interface VersionMetadataBindingConfiguration {
	binding: string;
	type: "version_metadata";
}

// A service binding to this Worker's own default or named entrypoint, or to
// another Worker of the `orange dev` session when `service` names it.
export interface ServiceBindingConfiguration {
	binding: string;
	entrypoint?: string;
	props?: unknown;
	service?: string;
	type: "service";
}

// `env.LOADER` for a `worker_loaders` entry.
export interface WorkerLoaderBindingConfiguration {
	binding: string;
	type: "worker_loader";
}

// A Durable Object binding to a class that another Worker exports.
export interface CrossScriptDurableObjectBindingConfiguration {
	binding: string;
	className: string;
	scriptName: string;
	type: "durable_object_namespace";
}

export interface DispatchNamespaceBindingConfiguration {
	binding: string;
	namespace: string;
	type: "dispatch_namespace";
}

export interface UnsafeEvalBindingConfiguration {
	binding: string;
	type: "unsafe_eval";
}

export interface PlainTextBindingConfiguration {
	binding: string;
	type: "plain_text";
	value: string;
}

export interface JsonBindingConfiguration {
	binding: string;
	type: "json";
	value: unknown;
}

export interface KvNamespaceBindingConfiguration {
	binding: string;
	namespaceId: string;
	type: "kv_namespace";
}

export interface R2BucketBindingConfiguration {
	binding: string;
	bucketName: string;
	type: "r2_bucket";
}

export interface AssetsBindingConfiguration {
	binding: string;
	type: "assets";
}

// Workers AI, served by an OpenAI-compatible provider.
export interface AiBindingConfiguration {
	binding: string;
	type: "ai";
}

export interface AnalyticsEngineBindingConfiguration {
	binding: string;
	type: "analytics_engine";
}

// A Hyperdrive binding that connects straight to the local database.
export interface HyperdriveBindingConfiguration {
	binding: string;
	connectionString: string;
	type: "hyperdrive";
}

export interface D1DatabaseBindingConfiguration {
	binding: string;
	databaseId: string;
	type: "d1";
}

// A Rate Limiting binding from `ratelimits` or a `ratelimit` entry in
// `unsafe.bindings`. Bindings with the same namespace ID share counters.
export interface RateLimitBindingConfiguration {
	binding: string;
	namespaceId: string;
	simple: { limit: number; period: number };
	type: "ratelimit";
}

export interface WorkflowBindingConfiguration {
	binding: string;
	className: string;
	name: string;
	// The Worker of the `orange dev` session that runs the Workflow.
	scriptName?: string;
	type: "workflow";
}

// A Queues producer. Bindings with the same queue name send to one queue.
export interface QueueBindingConfiguration {
	binding: string;
	deliveryDelay?: number;
	queueName: string;
	type: "queue";
}

// A Browser Rendering binding.
export interface BrowserBindingConfiguration {
	binding: string;
	type: "browser";
}

// A Send Email binding, with the address limits of its Wrangler configuration.
export interface SendEmailBindingConfiguration {
	allowedDestinationAddresses?: string[];
	allowedSenderAddresses?: string[];
	binding: string;
	destinationAddress?: string;
	type: "send_email";
}

// A binding the Worker can reference but OpenOrange cannot back. It loads as a
// stub that throws `message` when used.
export interface UnsupportedBindingConfiguration {
	binding: string;
	bindingType: string;
	message: string;
	type: "unsupported";
}

export type SupportedBindingConfiguration =
	| AiBindingConfiguration
	| AnalyticsEngineBindingConfiguration
	| AssetsBindingConfiguration
	| BrowserBindingConfiguration
	| CrossScriptDurableObjectBindingConfiguration
	| D1DatabaseBindingConfiguration
	| DispatchNamespaceBindingConfiguration
	| HyperdriveBindingConfiguration
	| JsonBindingConfiguration
	| KvNamespaceBindingConfiguration
	| PlainTextBindingConfiguration
	| RateLimitBindingConfiguration
	| R2BucketBindingConfiguration
	| QueueBindingConfiguration
	| SecretsStoreBindingConfiguration
	| SendEmailBindingConfiguration
	| ServiceBindingConfiguration
	| UnsafeEvalBindingConfiguration
	| UnsupportedBindingConfiguration
	| VersionMetadataBindingConfiguration
	| WorkerLoaderBindingConfiguration
	| WorkflowBindingConfiguration;

export interface DurableObjectBindingManifest {
	binding: string;
	className: string;
}

export interface DurableObjectClassManifest {
	className: string;
	migrationTag: string;
	// The name that derives the class's IDs and actor name, when it is not `className`.
	storageName?: string;
	storageBackend: "sqlite";
	container?: ContainerClassManifest;
}

/** The images of a wrangler `containers` entry, keyed by image name. */
export interface ContainerClassManifest {
	images: Record<string, { reference: string; sandbox: boolean }>;
}

export interface DurableObjectRuntimeManifest {
	bindings: DurableObjectBindingManifest[];
	classes: DurableObjectClassManifest[];
	latestMigrationTag: string;
}

// A D1 database that `orange d1` commands can address by binding or name.
export interface D1DatabaseConfiguration {
	binding: string;
	// The local database ID, which is the same as the binding's in `orange dev`.
	databaseId: string;
	databaseName?: string;
	migrationsDir?: string;
	migrationsPattern?: string;
	migrationsTable?: string;
}

export interface CustomBuildConfiguration {
	command: string;
	cwd: string;
}

export interface ResolvedWranglerConfiguration {
	assets?: RuntimeAssetsConfiguration;
	bindings: SupportedBindingConfiguration[];
	build?: CustomBuildConfiguration;
	compatibilityDate: string;
	compatibilityFlags: string[];
	configPath?: string;
	// `triggers.crons` expressions in Cloudflare syntax.
	crons: string[];
	d1Databases: D1DatabaseConfiguration[];
	durableObjects?: DurableObjectRuntimeManifest;
	// Undefined for an assets-only Worker.
	entrypoint?: string;
	environment?: string;
	// Where `find_additional_modules` looks. Undefined when it is off or there is no entrypoint.
	additionalModuleSearch?: AdditionalModuleSearch;
	moduleRules: ModuleRule[];
	noBundle: boolean;
	normalizedConfiguration: string;
	requestSignalPassthrough: boolean;
	projectRoot: string;
	queueConsumers: RuntimeQueueConsumer[];
	// `routes` and `route`, as patterns. A custom domain is its host followed by `/*`.
	routes: string[];
	// The `service` names of `tail_consumers`.
	tailConsumers: string[];
	warnings: string[];
	workerName?: string;
}

export interface LoadWranglerConfigurationOptions {
	configPath?: string;
	/**
	 * Binds R2 `bucket_name`, KV `id`, and D1 `database_id`, as `wrangler deploy` does. Otherwise
	 * their preview variants win when set, as in `wrangler dev`, local or remote.
	 */
	deployed?: boolean;
	environment?: string;
	/**
	 * A runner's own environment, for `orange serve`. `orange deploy` names the variables and secrets
	 * it gave the runner pool in `ORANGE_WORKER_VARS` and `ORANGE_WORKER_SECRETS`, and their values
	 * become the Worker's `vars` and secrets here, as `wrangler secret` values do on Cloudflare.
	 */
	runnerEnvironment?: Readonly<Record<string, string | undefined>>;
	scriptPath?: string;
}

/** Names `orange deploy` lists in a runner pool's environment. Values never travel in them. */
export const workerVarsVariable = "ORANGE_WORKER_VARS";
export const workerSecretsVariable = "ORANGE_WORKER_SECRETS";

// The variables and secrets a runner pool gave this runner, by the names `orange deploy` listed.
// A listed name the runner lacks was removed from the pool after the deploy, as with `rivet cluster
// env unset`, so the Worker goes without it.
function bindingsFromRunnerEnvironment(environment: Readonly<Record<string, string | undefined>>): {
	missing: string[];
	secrets: Record<string, string>;
	vars: Record<string, string>;
} {
	const missing: string[] = [];
	const take = (listVariable: string): Record<string, string> => {
		const names = (environment[listVariable] ?? "").split(",").map((name) => name.trim()).filter((name) => name !== "");
		const values: Record<string, string> = {};
		for (const name of names) {
			const value = environment[name];
			if (value === undefined) missing.push(name);
			else values[name] = value;
		}
		return values;
	};
	return { missing, secrets: take(workerSecretsVariable), vars: take(workerVarsVariable) };
}

// In Wrangler 4.129.0, `convertConfigToBindings` takes the preview name with `usePreviewIds: true`,
// as `wrangler dev` (`resolveBindings`) and the exported start-worker conversion call it. `wrangler
// deploy` (`deployWorker`) calls it with `usePreviewIds: false`, which Wrangler does not export, so
// a deployed Worker drops the preview names before the exported conversion.
const previewNames: Readonly<Record<string, string>> = {
	d1_databases: "preview_database_id",
	kv_namespaces: "preview_id",
	r2_buckets: "preview_bucket_name",
};

function withoutPreviewNames(raw: Record<string, unknown>): Record<string, unknown> {
	const deployed = { ...raw };
	for (const [field, previewName] of Object.entries(previewNames)) {
		const bindings = raw[field];
		if (!Array.isArray(bindings)) continue;
		deployed[field] = bindings.map((binding: unknown) => {
			if (!isRecord(binding)) return binding;
			const { [previewName]: _preview, ...rest } = binding;
			return rest;
		});
	}
	return deployed;
}

function isWranglerApi(value: unknown): value is WranglerApi {
	return (
		isRecord(value) &&
		typeof value.experimental_generateTypes === "function" &&
		typeof value.unstable_readConfig === "function" &&
		typeof value.unstable_convertConfigBindingsToStartWorkerBindings ===
			"function" &&
		typeof value.unstable_getVarsForDev === "function"
	);
}

let wranglerApiPromise: Promise<WranglerApi> | undefined;

// The version of the Wrangler that Orange reads configs with, for errors about fields it does not know.
function wranglerVersion(): string {
	const manifest: unknown = createRequire(import.meta.url)("wrangler/package.json");
	return isRecord(manifest) && typeof manifest.version === "string" ? manifest.version : "(unknown version)";
}

export async function loadWranglerApi(): Promise<WranglerApi> {
	wranglerApiPromise ??= (async () => {
		// A non-literal import keeps Wrangler's unpublished internal type package
		// out of Orange's public declarations while using Wrangler's own resolver.
		const moduleName: string = "wrangler";
		const moduleValue: unknown = await import(moduleName);
		if (!isWranglerApi(moduleValue)) {
			throw new Error("The pinned Wrangler package does not expose its config API");
		}
		return moduleValue;
	})();
	return wranglerApiPromise;
}

// The fields of Wrangler's resolved configuration that Orange reads, parsed once
// from what `unstable_readConfig` returns.
interface WranglerConfig {
	readonly assets?: WranglerAssetsConfig;
	readonly build?: { readonly command: string; readonly cwd?: string };
	readonly compatibilityDate?: string;
	readonly compatibilityFlags: readonly string[];
	readonly configPath?: string;
	readonly containers: readonly WranglerContainerConfig[];
	readonly crons: readonly string[];
	readonly d1Databases: readonly WranglerD1DatabaseConfig[];
	// Undefined when `durable_objects` is not set. Cross-script bindings are left out.
	readonly durableObjectBindings?: readonly DurableObjectBindingManifest[];
	readonly main?: string;
	readonly migrations?: readonly WranglerMigrationConfig[];
	// Undefined unless `find_additional_modules` is on.
	readonly additionalModules?: { baseDirectory: string | undefined; globs: string[] };
	readonly moduleRules: ModuleRule[];
	readonly noBundle: boolean;
	readonly name?: string;
	readonly queueConsumers: RuntimeQueueConsumer[];
	// The whole resolved configuration, for Wrangler's own binding APIs.
	readonly raw: Record<string, unknown>;
	readonly requiredSecrets: readonly string[];
	readonly tailConsumers: string[];
	readonly targetEnvironment?: string;
	readonly unsupportedFields: readonly string[];
	readonly vars: Record<string, unknown>;
}

interface WranglerAssetsConfig {
	readonly directory: string;
	readonly hasBinding: boolean;
	readonly htmlHandling: RuntimeAssetsHtmlHandling;
	readonly notFoundHandling: RuntimeAssetsNotFoundHandling;
	readonly runWorkerFirst?: boolean | readonly unknown[];
}

interface WranglerContainerConfig {
	readonly className: string;
	// Image name to its reference: an image, or a Dockerfile path.
	readonly images: ReadonlyMap<string, string>;
}

interface WranglerD1DatabaseConfig {
	readonly binding: string;
	readonly databaseName?: string;
	readonly migrationsDir?: string;
	readonly migrationsPattern?: string;
	readonly migrationsTable?: string;
}

interface WranglerMigrationConfig {
	// The new_sqlite_classes and new_classes of the migration.
	readonly classNames: readonly string[];
	readonly deletedClasses: readonly string[];
	readonly renamedClasses: readonly { readonly from: string; readonly to: string }[];
	readonly tag: string;
}

function parseWranglerConfig(value: unknown): WranglerConfig {
	if (!isRecord(value)) {
		throw new TypeError("Wrangler returned an invalid resolved configuration");
	}
	const name = optionalString(value, "name");
	const main = optionalString(value, "main");
	const rules = resolveModuleRules(value.rules);
	const compatibilityDate = optionalString(value, "compatibility_date");
	const configPath = optionalString(value, "configPath");
	const targetEnvironment = optionalString(value, "targetEnvironment");
	const assets = parseAssets(value.assets);
	const build = parseBuild(value.build);
	const durableObjectBindings = parseDurableObjectBindings(value.durable_objects, name);
	const migrations = parseMigrations(value.migrations);
	const secrets = value.secrets;
	return {
		...(assets === undefined ? {} : { assets }),
		...(build === undefined ? {} : { build }),
		...(compatibilityDate === undefined ? {} : { compatibilityDate }),
		compatibilityFlags: stringArray(value, "compatibility_flags"),
		...(configPath === undefined ? {} : { configPath }),
		containers: parseContainers(value.containers),
		crons: parseCrons(value.triggers),
		d1Databases: parseD1DatabaseConfigs(value.d1_databases),
		...(durableObjectBindings === undefined ? {} : { durableObjectBindings }),
		...(main === undefined ? {} : { main }),
		...(migrations === undefined ? {} : { migrations }),
		...(value.find_additional_modules === true
			? { additionalModules: { baseDirectory: optionalString(value, "base_dir"), globs: rules.additionalModuleGlobs } }
			: {}),
		moduleRules: rules.moduleRules,
		noBundle: value.no_bundle === true,
		...(name === undefined ? {} : { name }),
		queueConsumers: parseQueueConsumers(value.queues),
		raw: value,
		tailConsumers: parseTailConsumers(value.tail_consumers),
		requiredSecrets:
			isRecord(secrets) && Array.isArray(secrets.required)
				? secrets.required.filter((secret): secret is string => typeof secret === "string")
				: [],
		...(targetEnvironment === undefined ? {} : { targetEnvironment }),
		unsupportedFields: collectUnsupportedConfiguration(value),
		vars: isRecord(value.vars) ? value.vars : {},
	};
}

function requiredString(
	record: Record<string, unknown>,
	key: string,
	context: string,
): string {
	const value = record[key];
	if (typeof value !== "string" || value.length === 0) {
		throw new TypeError(`${context}.${key} must be a non-empty string`);
	}
	return value;
}

function optionalString(
	record: Record<string, unknown>,
	key: string,
): string | undefined {
	const value = record[key];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function stringArray(
	record: Record<string, unknown>,
	key: string,
): string[] {
	const value = record[key];
	if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
		throw new TypeError(`Resolved Wrangler ${key} must be an array of strings`);
	}
	return [...value];
}

// Flags that turn on Node.js APIs, which Orange always has.
const alwaysOnNodeFlags: ReadonlySet<string> = new Set(["nodejs_als", "nodejs_compat", "nodejs_compat_v2"]);

// Orange runs one runtime profile, so it ignores compatibility_date and warns
// about flags it does not apply instead of rejecting the configuration.
function resolveCompatibilityProfile(config: WranglerConfig): {
	compatibilityDate: string;
	compatibilityFlags: string[];
	warnings: string[];
} {
	const compatibilityDate = config.compatibilityDate ?? SUPPORTED_COMPATIBILITY_DATE;
	const compatibilityFlags = [...config.compatibilityFlags];
	const ignoredFlags = [...new Set(compatibilityFlags)]
		.filter(
			(flag) =>
				!SUPPORTED_COMPATIBILITY_FLAGS.includes(flag) &&
				flag !== navigationPrefersAssetServing.enable &&
				flag !== navigationPrefersAssetServing.disable,
		)
		.sort();
	// Orange always has Node.js APIs, and Cloudflare still needs these flags (the Agents SDK needs
	// nodejs_compat), so Orange accepts them without a warning that reads as "remove this flag".
	const otherFlags = ignoredFlags.filter((flag) => !alwaysOnNodeFlags.has(flag));
	return {
		compatibilityDate,
		compatibilityFlags,
		warnings: [
			...(otherFlags.length === 0 ? [] : [`Orange ignores compatibility_flags ${JSON.stringify(otherFlags)}`]),
		],
	};
}

// Orange runs a Container class on a sandbox provider, which can run only a
// Cloudflare Sandbox image. An image counts as one when its reference or its
// Dockerfile names cloudflare/sandbox.
function withContainerClasses(
	manifest: DurableObjectRuntimeManifest | undefined,
	configuredContainers: readonly WranglerContainerConfig[],
	projectRoot: string,
): DurableObjectRuntimeManifest | undefined {
	if (manifest === undefined) return manifest;
	const containers = new Map<string, ContainerClassManifest>();
	for (const entry of configuredContainers) {
		const images: ContainerClassManifest["images"] = {};
		for (const [name, reference] of entry.images) {
			let source = reference;
			try {
				source = readFileSync(resolve(projectRoot, reference), "utf8");
			} catch {}
			images[name] = { reference, sandbox: /cloudflare\/sandbox/.test(source) };
		}
		containers.set(entry.className, { images });
	}
	return {
		...manifest,
		classes: manifest.classes.map((configuredClass) => {
			const container = containers.get(configuredClass.className);
			return container === undefined ? configuredClass : { ...configuredClass, container };
		}),
	};
}

// Entries without a class name, and images without a reference, are skipped.
function parseContainers(value: unknown): WranglerContainerConfig[] {
	if (!Array.isArray(value)) return [];
	const containers: WranglerContainerConfig[] = [];
	for (const entry of value) {
		if (!isRecord(entry) || typeof entry.class_name !== "string") continue;
		const images = new Map<string, string>();
		const add = (name: string, image: unknown) => {
			const reference =
				typeof image === "string"
					? image
					: isRecord(image) && typeof image.dockerfile === "string"
						? image.dockerfile
						: isRecord(image) && typeof image.image === "string"
							? image.image
							: undefined;
			if (reference !== undefined) images.set(name, reference);
		};
		if (entry.image !== undefined) add("default", entry.image);
		if (isRecord(entry.images)) for (const [name, image] of Object.entries(entry.images)) add(name, image);
		containers.push({ className: entry.class_name, images });
	}
	return containers;
}

function configuredArray(value: unknown): boolean {
	return Array.isArray(value) && value.length > 0;
}

function configuredRecord(value: unknown): boolean {
	return isRecord(value) && Object.keys(value).length > 0;
}

// Orange accepts unsafe bindings: unsafe_eval and ratelimit work, and other
// types load as unsupported binding stubs. Other unsafe settings change the
// runtime itself.
function isSupportedUnsafeConfiguration(unsafe: unknown): boolean {
	if (!isRecord(unsafe)) return false;
	const { bindings, ...rest } = unsafe;
	return Object.keys(rest).length === 0 && Array.isArray(bindings);
}

function collectUnsupportedConfiguration(
	config: Record<string, unknown>,
): string[] {
	const unsupported: string[] = [];
	for (const key of [
		"connect",
		"streaming_tail_consumers",
	]) {
		if (configuredArray(config[key])) {
			unsupported.push(key);
		}
	}
	for (const key of ["legacy_assets", "pages_build_output_dir", "site"]) {
		if (config[key] !== undefined) {
			unsupported.push(key);
		}
	}
	for (const key of ["cloudchamber", "define", "exports"]) {
		if (configuredRecord(config[key])) {
			unsupported.push(key);
		}
	}
	const unsafe = config.unsafe;
	if (configuredRecord(unsafe) && !isSupportedUnsafeConfiguration(unsafe)) {
		unsupported.push("unsafe");
	}
	// Orange accepts `no_bundle`, which build tools such as @cloudflare/vite-plugin
	// set on their output. It still bundles the entry, and esbuild follows the
	// relative imports between the built modules that Wrangler would upload as
	// separate modules.
	// https://github.com/cloudflare/workers-sdk/blob/be87ff0382c53a294e948e49419d25d653c50e86/packages/vite-plugin-cloudflare/src/plugins/output-config.ts#L169-L173
	// https://github.com/cloudflare/workers-sdk/blob/be87ff0382c53a294e948e49419d25d653c50e86/packages/wrangler/src/deployment-bundle/no-bundle-worker.ts#L8-L29
	const triggers = config.triggers;
	if (isRecord(triggers) && configuredArray(triggers.events)) {
		unsupported.push("triggers.events");
	}
	return unsupported;
}

function parseTailConsumers(consumers: unknown): string[] {
	if (consumers === undefined) return [];
	if (
		!Array.isArray(consumers) ||
		!consumers.every((consumer) => isRecord(consumer) && typeof consumer.service === "string")
	) {
		throw new TypeError("tail_consumers must be an array of { service } objects");
	}
	return consumers.map((consumer) => String(consumer.service));
}

function parseCrons(triggers: unknown): string[] {
	if (!isRecord(triggers) || triggers.crons === undefined) return [];
	const crons = triggers.crons;
	if (!Array.isArray(crons) || !crons.every((cron) => typeof cron === "string")) {
		throw new TypeError("triggers.crons must be an array of strings");
	}
	return crons;
}

// An expression that does not parse, or never matches a date, is skipped with
// a warning. It never stops `orange dev`.
function resolveCronTriggers(crons: readonly string[], warnings: string[]): string[] {
	const valid: string[] = [];
	for (const cron of new Set(crons)) {
		let reason: string | undefined;
		try {
			if (nextCloudflareCronTime(parseCloudflareCron(cron), Date.now()) === undefined) {
				reason = "it never matches a date";
			}
		} catch (error: unknown) {
			reason = error instanceof Error ? error.message : String(error);
		}
		if (reason === undefined) valid.push(cron);
		else warnings.push(`Orange skips cron trigger ${JSON.stringify(cron)}: ${reason}`);
	}
	return valid;
}

const defaultModuleRules: readonly ModuleRule[] = [
	{ globs: ["**/*.txt", "**/*.html", "**/*.sql"], type: "Text" },
	{ globs: ["**/*.bin"], type: "Data" },
	{ globs: ["**/*.wasm", "**/*.wasm?module"], type: "CompiledWasm" },
];

// Wrangler appends its default rules to the configured rules. A rule without
// `fallthrough: true` hides every later rule of the same type. JavaScript module
// rules only matter without bundling, so Orange skips them.
// https://github.com/cloudflare/workers-sdk/blob/be87ff0382c53a294e948e49419d25d653c50e86/packages/wrangler/src/deployment-bundle/rules.ts#L24-L50
function resolveModuleRules(configuredRules: unknown): { additionalModuleGlobs: string[]; moduleRules: ModuleRule[] } {
	const configured = configuredRules ?? [];
	if (!Array.isArray(configured)) {
		throw new TypeError("Wrangler rules must be an array");
	}
	const closedTypes = new Set<string>();
	const additionalModuleGlobs: string[] = [];
	const moduleRules: ModuleRule[] = [];
	for (const [index, rule] of [...configured, ...defaultModuleRules].entries()) {
		if (!isRecord(rule) || typeof rule.type !== "string") {
			throw new TypeError(`rules[${index}] must have a type`);
		}
		const { type } = rule;
		if (closedTypes.has(type)) continue;
		if (rule.fallthrough !== true) closedTypes.add(type);
		const globs = stringArray(rule, "globs");
		additionalModuleGlobs.push(...globs);
		if (type === "ESModule" || type === "CommonJS") continue;
		if (type !== "Text" && type !== "Data" && type !== "CompiledWasm") {
			throw new Error(`Orange does not support ${type} module rules`);
		}
		moduleRules.push({ globs, type });
	}
	return { additionalModuleGlobs, moduleRules };
}

// Wrangler runs `build.command` in `build.cwd` before it bundles the Worker.
function parseBuild(build: unknown): WranglerConfig["build"] {
	if (!isRecord(build)) return undefined;
	const command = optionalString(build, "command");
	if (command === undefined) return undefined;
	const cwd = optionalString(build, "cwd");
	return { command, ...(cwd === undefined ? {} : { cwd }) };
}

// A Durable Object binding that names another Worker's class. Orange runs one
// Worker per process, so it has no local target.
function crossScriptDurableObjectTarget(
	definition: Record<string, unknown>,
	workerName: string | undefined,
): string | undefined {
	const scriptName = optionalString(definition, "script_name");
	if (scriptName !== undefined && scriptName !== workerName) {
		return `Worker ${JSON.stringify(scriptName)}`;
	}
	if (definition.environment !== undefined || definition.namespace_id !== undefined) {
		return `Worker ${JSON.stringify(scriptName ?? workerName ?? "")}`;
	}
	return undefined;
}

// A KV namespace and a D1 database are read by ID, the preview ID outside a deployed
// Worker, and fall back to the binding name when the ID is omitted.
function localStorageId(
	definition: Record<string, unknown>,
	key: string,
	binding: string,
): string {
	return optionalString(definition, key) ?? binding;
}

// Wrangler validates `ratelimits` but passes `unsafe.bindings` through, so
// Orange checks both forms like Miniflare's binding schema: any numeric limit,
// and only 10 or 60 second periods.
// https://github.com/cloudflare/workers-sdk/blob/be87ff0382c53a294e948e49419d25d653c50e86/packages/miniflare/src/workers/ratelimit/ratelimit.worker.ts#L17
function parseRateLimitBinding(
	definition: Record<string, unknown>,
	binding: string,
): RateLimitBindingConfiguration {
	const namespaceId = requiredString(definition, "namespace_id", binding);
	const simple = definition.simple;
	if (!isRecord(simple)) {
		throw new TypeError(`Rate Limiting binding ${binding} must have a simple configuration object`);
	}
	const { limit, period } = simple;
	if (typeof limit !== "number") {
		throw new TypeError(
			`Rate Limiting binding ${binding} simple.limit must be a number but got ${JSON.stringify(limit)}`,
		);
	}
	if (period !== 10 && period !== 60) {
		throw new TypeError(
			`Rate Limiting binding ${binding} simple.period must be either 10 or 60 but got ${JSON.stringify(period)}`,
		);
	}
	return { binding, namespaceId, simple: { limit, period }, type: "ratelimit" };
}

// Wrangler dev reads a Hyperdrive binding's local connection string from
// CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_<BINDING>, then the deprecated
// WRANGLER_ prefix, then `localConnectionString`. Orange also reads the
// variables from `.dev.vars` or `.env`.
// https://github.com/cloudflare/workers-sdk/blob/main/packages/wrangler/src/dev.ts (applyHyperdriveEnvVars)
function parseHyperdriveBinding(
	definition: Record<string, unknown>,
	binding: string,
	devVars: Record<string, WranglerBinding>,
	warnings: string[],
): HyperdriveBindingConfiguration {
	const prefix = "CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_";
	const deprecatedPrefix = "WRANGLER_HYPERDRIVE_LOCAL_CONNECTION_STRING_";
	const variable = (name: string): string | undefined => {
		const fromProcess = process.env[name];
		if (fromProcess !== undefined && fromProcess !== "") return fromProcess;
		const value = devVars[name]?.value;
		return typeof value === "string" && value !== "" ? value : undefined;
	};
	let connectionString = variable(`${prefix}${binding}`);
	if (connectionString === undefined) {
		connectionString = variable(`${deprecatedPrefix}${binding}`);
		if (connectionString !== undefined) {
			warnings.push(
				`Using "${deprecatedPrefix}<BINDING_NAME>" environment variable. This is deprecated. Please use "${prefix}<BINDING_NAME>" instead.`,
			);
		}
	}
	connectionString ??= optionalString(definition, "localConnectionString");
	if (connectionString === undefined) {
		throw new Error(
			`When developing locally, you should use a local Postgres connection string to emulate Hyperdrive functionality. Please setup Postgres locally and set the value of the '${prefix}${binding}' variable or "${binding}"'s "localConnectionString" to the Postgres connection string.`,
		);
	}
	try {
		parseHyperdriveConnectionString(connectionString);
	} catch (error) {
		throw new Error(
			`Hyperdrive binding ${binding} has an invalid local connection string: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	return { binding, connectionString, type: "hyperdrive" };
}

function parseSupportedBindings(
	value: Record<string, WranglerBinding>,
	workerName: string | undefined,
	devVars: Record<string, WranglerBinding>,
): { bindings: SupportedBindingConfiguration[]; warnings: string[] } {
	const bindings: SupportedBindingConfiguration[] = [];
	const warnings: string[] = [];
	const unsupported = (
		binding: string,
		bindingType: string,
		message = unsupportedBindingMessage(bindingType, binding),
	): void => {
		bindings.push({ binding, bindingType, message, type: "unsupported" });
	};
	for (const [binding, definition] of Object.entries(value).sort(([left], [right]) =>
		left.localeCompare(right),
	)) {
		if (definition.type === "secrets_store_secret") {
			bindings.push({
				binding,
				secretName: requiredString(definition, "secret_name", binding),
				storeId: requiredString(definition, "store_id", binding),
				type: "secrets_store_secret",
			});
		} else if (definition.type === "version_metadata") {
			bindings.push({ binding, type: "version_metadata" });
		} else if (definition.type === "service") {
			const service = requiredString(definition, "service", binding);
			const entrypoint = optionalString(definition, "entrypoint");
			bindings.push({
				binding,
				...(entrypoint === undefined ? {} : { entrypoint }),
				...(definition.props === undefined ? {} : { props: definition.props }),
				// A binding to another Worker calls it in the `orange dev` session.
				...(service === workerName ? {} : { service }),
				type: "service",
			});
		} else if (definition.type === "plain_text" || definition.type === "secret_text") {
			const text = definition.value;
			if (typeof text !== "string") {
				throw new TypeError(`Wrangler returned an invalid ${binding} variable`);
			}
			bindings.push({ binding, type: "plain_text", value: text });
		} else if (definition.type === "json") {
			bindings.push({ binding, type: "json", value: definition.value });
		} else if (definition.type === "unsafe_unsafe_eval") {
			bindings.push({ binding, type: "unsafe_eval" });
		} else if (definition.type === "kv_namespace") {
			bindings.push({
				binding,
				namespaceId: localStorageId(definition, "id", binding),
				type: "kv_namespace",
			});
		} else if (definition.type === "d1") {
			bindings.push({
				binding,
				databaseId: localStorageId(definition, "database_id", binding),
				type: "d1",
			});
		} else if (definition.type === "ratelimit" || definition.type === "unsafe_ratelimit") {
			bindings.push(parseRateLimitBinding(definition, binding));
		} else if (definition.type === "browser") {
			bindings.push({ binding, type: "browser" });
		} else if (definition.type === "send_email") {
			const destinationAddress = optionalString(definition, "destination_address");
			const allowedDestinations = definition.allowed_destination_addresses;
			const allowedSenders = definition.allowed_sender_addresses;
			bindings.push({
				binding,
				...(destinationAddress === undefined ? {} : { destinationAddress }),
				...(allowedDestinations === undefined
					? {}
					: { allowedDestinationAddresses: stringArray(definition, "allowed_destination_addresses") }),
				...(allowedSenders === undefined
					? {}
					: { allowedSenderAddresses: stringArray(definition, "allowed_sender_addresses") }),
				type: "send_email",
			});
		} else if (definition.type === "ai") {
			bindings.push({ binding, type: "ai" });
		} else if (definition.type === "r2_bucket") {
			// Outside a deployed Worker, Wrangler has already replaced bucket_name
			// with preview_bucket_name when one is set. Local buckets ignore the jurisdiction.
			bindings.push({
				binding,
				bucketName: localStorageId(definition, "bucket_name", binding),
				type: "r2_bucket",
			});
		} else if (definition.type === "queue") {
			const deliveryDelay = definition.delivery_delay;
			if (deliveryDelay !== undefined && !isQueueDelay(deliveryDelay)) {
				throw new TypeError(
					`Queue producer ${binding}.delivery_delay must be an integer of 0 or more`,
				);
			}
			bindings.push({
				binding,
				...(deliveryDelay === undefined ? {} : { deliveryDelay }),
				queueName: requiredString(definition, "queue_name", binding),
				type: "queue",
			});
		} else if (definition.type === "worker_loader") {
			bindings.push({ binding, type: "worker_loader" });
		} else if (definition.type === "hyperdrive") {
			bindings.push(parseHyperdriveBinding(definition, binding, devVars, warnings));
		} else if (definition.type === "analytics_engine") {
			bindings.push({ binding, type: "analytics_engine" });
		} else if (definition.type === "assets") {
			bindings.push({ binding, type: "assets" });
		} else if (definition.type === "workflow") {
			// A Workflow of another Worker runs in that Worker of the session.
			const scriptName = optionalString(definition, "script_name");
			bindings.push({
				binding,
				className: requiredString(definition, "class_name", binding),
				name: requiredString(definition, "name", binding),
				...(scriptName === undefined || scriptName === workerName ? {} : { scriptName }),
				type: "workflow",
			});
		} else if (definition.type === "durable_object_namespace") {
			const target = crossScriptDurableObjectTarget(definition, workerName);
			const scriptName = optionalString(definition, "script_name");
			if (target !== undefined && scriptName !== undefined && scriptName !== workerName) {
				// The class runs in the Worker named by script_name, in the same
				// `orange dev` session.
				bindings.push({
					binding,
					className: requiredString(definition, "class_name", binding),
					scriptName,
					type: "durable_object_namespace",
				});
			} else if (target !== undefined) {
				unsupported(
					binding,
					"durable_object_namespace",
					unsupportedBindingMessage("durable_object_namespace", binding, target),
				);
			}
		} else if (definition.type === "dispatch_namespace") {
			if (definition.outbound !== undefined) {
				warnings.push(
					`Orange does not run the outbound Worker of dispatch namespace binding ${binding}. Fetch requests from its user Workers go to the network directly.`,
				);
			}
			bindings.push({
				binding,
				namespace: requiredString(definition, "namespace", binding),
				type: "dispatch_namespace",
			});
		} else {
			unsupported(binding, definition.type);
		}
	}
	return { bindings, warnings };
}

// Wrangler dev layers `.dev.vars` (or `.env` files) over the configured vars.
// Their entries become secret text bindings, and `secrets.required` limits
// which keys load.
// https://github.com/cloudflare/workers-sdk/blob/be87ff0382c53a294e948e49419d25d653c50e86/packages/wrangler/src/dev/dev-vars.ts#L33-L110
function resolveDevVars(
	wrangler: WranglerApi,
	config: WranglerConfig,
	configPath: string | undefined,
	environment: string | undefined,
	runnerEnvironment: Readonly<Record<string, string | undefined>> | undefined,
): { secretNames: Set<string>; vars: Record<string, WranglerBinding>; warnings: string[] } {
	const value = wrangler.unstable_getVarsForDev(
		configPath,
		undefined,
		config.vars,
		environment,
		true,
		config.raw.secrets,
	);
	// What the runner pool gave this runner overrides the image's `vars`, as `wrangler deploy
	// --var` and `wrangler secret` do on Cloudflare.
	const warnings: string[] = [];
	if (runnerEnvironment !== undefined) {
		const runner = bindingsFromRunnerEnvironment(runnerEnvironment);
		for (const [name, text] of Object.entries(runner.vars)) value[name] = { type: "plain_text", value: text };
		for (const [name, text] of Object.entries(runner.secrets)) value[name] = { type: "secret_text", value: text };
		if (runner.missing.length > 0) {
			warnings.push(
				`The runner pool no longer sets ${runner.missing.join(", ")}, so the Worker runs without ${runner.missing.length === 1 ? "it" : "them"}. The next orange deploy stops listing ${runner.missing.length === 1 ? "it" : "them"}.`,
			);
		}
	}
	const secretNames = new Set<string>();
	for (const [name, binding] of Object.entries(value)) {
		if (binding.type === "secret_text") secretNames.add(name);
	}
	const missing = config.requiredSecrets.filter((name) => !secretNames.has(name));
	if (missing.length > 0) {
		warnings.push(
			`Missing required secrets: ${missing.join(", ")}. Add them to .dev.vars, .env, or set as environment variables.`,
		);
	}
	return { secretNames, vars: value, warnings };
}

function parseDurableObjectBindings(
	durableObjects: unknown,
	workerName: string | undefined,
): DurableObjectBindingManifest[] | undefined {
	if (durableObjects === undefined) return undefined;
	if (!isRecord(durableObjects) || !Array.isArray(durableObjects.bindings)) {
		throw new Error("Durable Object configuration requires durable_objects.bindings");
	}
	// Cross-script bindings load as unsupported binding stubs instead.
	const rawBindings: unknown[] = durableObjects.bindings.filter(
		(rawBinding) =>
			!isRecord(rawBinding) ||
			crossScriptDurableObjectTarget(rawBinding, workerName) === undefined,
	);
	return rawBindings.map((rawBinding, index) => {
		if (!isRecord(rawBinding)) {
			throw new TypeError(`durable_objects.bindings[${index}] must be an object`);
		}
		return {
			binding: requiredString(rawBinding, "name", `durable_objects.bindings[${index}]`),
			className: requiredString(rawBinding, "class_name", `durable_objects.bindings[${index}]`),
		};
	});
}

function parseMigrations(migrations: unknown): WranglerMigrationConfig[] | undefined {
	if (!Array.isArray(migrations)) return undefined;
	return migrations.map((rawMigration, index) => {
		if (!isRecord(rawMigration)) {
			throw new TypeError(`migrations[${index}] must be an object`);
		}
		const tag = requiredString(rawMigration, "tag", `migrations[${index}]`);
		const supportedKeys = [
			"tag",
			"new_sqlite_classes",
			"new_classes",
			"renamed_classes",
			"deleted_classes",
			"transferred_classes",
		];
		const unsupportedKeys = Object.keys(rawMigration).filter((key) => !supportedKeys.includes(key));
		if (unsupportedKeys.length > 0) {
			throw new Error(
				`Unsupported Durable Object migration fields: ${unsupportedKeys.sort().join(", ")}`,
			);
		}
		const names = (key: string): string[] => {
			const value = rawMigration[key];
			if (value === undefined) return [];
			if (
				!Array.isArray(value) ||
				!value.every(
					(className): className is string =>
						typeof className === "string" && className.length > 0,
				)
			) {
				throw new Error(`migrations[${index}].${key} must contain class names`);
			}
			return value;
		};
		// A class moved in from another Worker with transferred_classes starts here as
		// a SQLite class. Orange does not move the objects that the other Worker
		// already stored, so the class starts empty (CLOUDFLARE_GAPS.md).
		// Wrangler checks the same entry shape.
		// https://github.com/cloudflare/workers-sdk/blob/be87ff0382c53a294e948e49419d25d653c50e86/packages/workers-utils/src/config/validation.ts#L6387-L6412
		const rawTransfers = rawMigration.transferred_classes ?? [];
		if (
			!Array.isArray(rawTransfers) ||
			!rawTransfers.every(
				(transfer) =>
					isRecord(transfer) &&
					typeof transfer.from === "string" &&
					typeof transfer.from_script === "string" &&
					typeof transfer.to === "string" &&
					transfer.to.length > 0,
			)
		) {
			throw new Error(
				`migrations[${index}].transferred_classes must contain from, from_script, and to class names`,
			);
		}
		const transferredClasses = rawTransfers.map((transfer) => String((transfer as { to: string }).to));
		// Orange stores every Durable Object class in SQLite, including classes that
		// Cloudflare creates with the key-value backend through new_classes.
		// One migration may name a class twice, as kody's does with a transfer and a
		// new_sqlite_classes entry. Orange treats that as one creation. Inferred, not
		// verified: kody's live Worker is past that migration, so Cloudflare never ran it
		// on a fresh deploy.
		const classNames = [
			...new Set([...names("new_sqlite_classes"), ...names("new_classes"), ...transferredClasses]),
		];
		const deletedClasses = names("deleted_classes");
		const rawRenames = rawMigration.renamed_classes ?? [];
		if (!Array.isArray(rawRenames)) {
			throw new Error(`migrations[${index}].renamed_classes must contain from and to class names`);
		}
		const renamedClasses = rawRenames.map((rename) => {
			if (!isRecord(rename) || typeof rename.from !== "string" || typeof rename.to !== "string") {
				throw new Error(`migrations[${index}].renamed_classes must contain from and to class names`);
			}
			return { from: rename.from, to: rename.to };
		});
		if (classNames.length + deletedClasses.length + renamedClasses.length === 0) {
			throw new Error(`migrations[${index}].new_sqlite_classes must contain class names`);
		}
		return { classNames, deletedClasses, renamedClasses, tag };
	});
}

function parseDurableObjectManifest(
	config: WranglerConfig,
): DurableObjectRuntimeManifest | undefined {
	// Cloudflare accepts a migrated class without a namespace binding. It stays
	// reachable through ctx.exports.
	const configuredBindings = config.durableObjectBindings ?? [];
	const migrations = config.migrations ?? [];
	if (configuredBindings.length === 0 && migrations.length === 0) {
		return undefined;
	}

	const bindings: DurableObjectBindingManifest[] = [];
	const bindingNames = new Set<string>();
	for (const { binding, className } of configuredBindings) {
		if (bindingNames.has(binding)) {
			throw new Error(`Duplicate Durable Object binding ${binding}`);
		}
		bindingNames.add(binding);
		bindings.push({ binding, className });
	}
	bindings.sort((left, right) => left.binding.localeCompare(right.binding));

	if (migrations.length === 0) {
		throw new Error(
			"Durable Object classes require an initial new_sqlite_classes migration",
		);
	}
	const migrationTags = new Set<string>();
	// Wrangler dev folds the ordered migration history into one class-to-backend
	// map before it configures the local runtime. Orange supports only the SQLite
	// creation branch in this milestone and records that selection explicitly in
	// its runtime manifest.
	// https://github.com/cloudflare/workers-sdk/blob/be87ff0382c53a294e948e49419d25d653c50e86/packages/wrangler/src/dev/class-names-sqlite.ts#L10-L72
	const sqliteClasses = new Map<string, { migrationTag: string; storageName: string }>();
	// A renamed class keeps its storage. A deleted class's rows stay behind, so a later class
	// with a used name gets its own storage instead of the old rows.
	const usedStorageNames = new Set<string>();
	let latestMigrationTag = "";
	for (const { classNames, deletedClasses, renamedClasses, tag } of migrations) {
		if (migrationTags.has(tag)) {
			throw new Error(`Duplicate Durable Object migration tag ${tag}`);
		}
		migrationTags.add(tag);
		latestMigrationTag = tag;
		for (const className of classNames) {
			if (sqliteClasses.has(className)) {
				throw new Error(
					`Durable Object class ${className} has more than one initial migration`,
				);
			}
			const storageName = usedStorageNames.has(className) ? `${className}@${tag}` : className;
			usedStorageNames.add(storageName);
			sqliteClasses.set(className, { migrationTag: tag, storageName });
		}
		for (const { from, to } of renamedClasses) {
			const renamed = sqliteClasses.get(from);
			if (renamed === undefined) {
				throw new Error(`Durable Object migration ${tag} renames unknown class ${from}`);
			}
			if (sqliteClasses.has(to)) {
				throw new Error(`Durable Object migration ${tag} renames ${from} to existing class ${to}`);
			}
			sqliteClasses.delete(from);
			sqliteClasses.set(to, renamed);
		}
		for (const className of deletedClasses) {
			if (!sqliteClasses.delete(className)) {
				throw new Error(`Durable Object migration ${tag} deletes unknown class ${className}`);
			}
		}
	}

	const configuredClasses = new Set(bindings.map((binding) => binding.className));
	for (const className of configuredClasses) {
		if (!sqliteClasses.has(className)) {
			throw new Error(
				`Durable Object class ${className} is missing from new_sqlite_classes`,
			);
		}
	}

	return {
		bindings,
		classes: [...sqliteClasses]
			.map(([className, { migrationTag, storageName }]) => ({
				className,
				migrationTag,
				...(storageName === className ? {} : { storageName }),
				storageBackend: "sqlite" as const,
			}))
			.sort((left, right) => left.className.localeCompare(right.className)),
		latestMigrationTag,
	};
}

// Navigation requests use not_found_handling before the Worker runs. The
// flag is on by default from 2025-04-01.
// https://github.com/cloudflare/workers-sdk/blob/be87ff0382c53a294e948e49419d25d653c50e86/packages/workers-shared/asset-worker/src/compatibility-flags.ts#L9-L46
const navigationPrefersAssetServing = {
	disable: "assets_navigation_has_no_effect",
	enable: "assets_navigation_prefers_asset_serving",
	onByDefaultAfter: "2025-04-01",
};

const htmlHandlingValues: readonly RuntimeAssetsHtmlHandling[] = [
	"auto-trailing-slash",
	"drop-trailing-slash",
	"force-trailing-slash",
	"none",
];
const notFoundHandlingValues: readonly RuntimeAssetsNotFoundHandling[] = [
	"404-page",
	"none",
	"single-page-application",
];

function enumValue<Value extends string>(
	assets: Record<string, unknown>,
	key: string,
	values: readonly Value[],
	defaultValue: Value,
): Value {
	const value = assets[key];
	if (value === undefined) return defaultValue;
	const match = values.find((candidate) => candidate === value);
	if (match === undefined) {
		throw new TypeError(`assets.${key} must be one of ${values.join(", ")}`);
	}
	return match;
}

// Splits run_worker_first patterns into the ones that go to the Worker and the
// negated `!/` ones that go to assets.
// https://github.com/cloudflare/workers-sdk/blob/be87ff0382c53a294e948e49419d25d653c50e86/packages/workers-shared/utils/configuration/parseStaticRouting.ts#L8-L58
function parseStaticRouting(rules: readonly unknown[]): { assetWorker: string[]; userWorker: string[] } {
	if (rules.length === 0) {
		throw new Error(
			"No `run_worker_first` rules were provided; must provide at least 1 rule.",
		);
	}
	const assetWorker: string[] = [];
	const userWorker: string[] = [];
	const invalid: string[] = [];
	for (const rule of rules) {
		if (typeof rule !== "string") {
			invalid.push(`${JSON.stringify(rule)}: rules must be strings`);
		} else if (rule.startsWith("!/")) {
			assetWorker.push(rule.slice(1));
		} else if (rule.startsWith("/")) {
			userWorker.push(rule);
		} else if (rule.startsWith("!")) {
			invalid.push(`'${rule}': negative rules must start with '!/'`);
		} else {
			invalid.push(`'${rule}': rules must start with '/' or '!/'`);
		}
	}
	if (invalid.length > 0) {
		throw new Error(`Invalid routes in \`run_worker_first\`:\n${invalid.join("\n")}`);
	}
	if (userWorker.length === 0) {
		throw new Error(
			"Only negative `run_worker_first` rules were provided; must provide at least 1 non-negative rule",
		);
	}
	return { assetWorker, userWorker };
}

function parseAssets(assets: unknown): WranglerAssetsConfig | undefined {
	if (assets === undefined) return undefined;
	if (!isRecord(assets)) throw new TypeError("assets must be an object");
	if (assets.directory === undefined) {
		throw new Error(
			"The `assets` property in your configuration is missing the required `directory` property.",
		);
	}
	if (typeof assets.directory !== "string" || assets.directory === "") {
		throw new Error("The assets directory cannot be an empty string.");
	}
	const runWorkerFirst = assets.run_worker_first;
	if (
		runWorkerFirst !== undefined &&
		typeof runWorkerFirst !== "boolean" &&
		!Array.isArray(runWorkerFirst)
	) {
		throw new TypeError("assets.run_worker_first must be a boolean or an array of strings");
	}
	return {
		directory: assets.directory,
		hasBinding: assets.binding !== undefined,
		htmlHandling: enumValue(assets, "html_handling", htmlHandlingValues, "auto-trailing-slash"),
		notFoundHandling: enumValue(assets, "not_found_handling", notFoundHandlingValues, "none"),
		...(runWorkerFirst === undefined ? {} : { runWorkerFirst }),
	};
}

// Resolves `assets` like Wrangler. The directory resolves against the
// configuration file, and its existence is checked after the custom build.
// https://github.com/cloudflare/workers-sdk/blob/be87ff0382c53a294e948e49419d25d653c50e86/packages/wrangler/src/assets.ts#L65-L79
// https://github.com/cloudflare/workers-sdk/blob/be87ff0382c53a294e948e49419d25d653c50e86/packages/deploy-helpers/src/deploy/helpers/assets.ts#L511-L548
function resolveAssets(
	assets: WranglerAssetsConfig | undefined,
	projectRoot: string,
	hasUserWorker: boolean,
	compatibilityDate: string,
	compatibilityFlags: readonly string[],
	warnings: string[],
): RuntimeAssetsConfiguration | undefined {
	if (assets === undefined) return undefined;
	// https://github.com/cloudflare/workers-sdk/blob/be87ff0382c53a294e948e49419d25d653c50e86/packages/wrangler/src/assets.ts#L178-L188
	if (!hasUserWorker && assets.hasBinding) {
		throw new Error(
			"Cannot use assets with a binding in an assets-only Worker.\nPlease remove the asset binding from your configuration file, or provide a Worker script in your configuration file (`main`).",
		);
	}
	const invokeUserWorkerAheadOfAssets = assets.runWorkerFirst === true;
	const staticRouting = Array.isArray(assets.runWorkerFirst)
		? parseStaticRouting(assets.runWorkerFirst)
		: undefined;
	if (!hasUserWorker && (invokeUserWorkerAheadOfAssets || staticRouting !== undefined)) {
		throw new Error(
			"Cannot set run_worker_first without a Worker script.\nPlease remove run_worker_first from your configuration file, or provide a Worker script in your configuration file (`main`).",
		);
	}
	if (invokeUserWorkerAheadOfAssets && !assets.hasBinding) {
		warnings.push(
			"run_worker_first=true set without an assets binding. Every request runs the Worker, which cannot fetch assets without assets.binding.",
		);
	}
	return {
		directory: resolve(projectRoot, assets.directory),
		hasUserWorker,
		htmlHandling: assets.htmlHandling,
		invokeUserWorkerAheadOfAssets,
		navigationPrefersAssetServing:
			compatibilityFlags.includes(navigationPrefersAssetServing.enable) ||
			(compatibilityDate >= navigationPrefersAssetServing.onByDefaultAfter &&
				!compatibilityFlags.includes(navigationPrefersAssetServing.disable)),
		notFoundHandling: assets.notFoundHandling,
		...(staticRouting === undefined ? {} : { staticRouting }),
	};
}

function parseD1DatabaseConfigs(databases: unknown): WranglerD1DatabaseConfig[] {
	if (!Array.isArray(databases)) return [];
	return databases.flatMap((database): WranglerD1DatabaseConfig[] => {
		if (!isRecord(database) || typeof database.binding !== "string") return [];
		const databaseName = optionalString(database, "database_name");
		const migrationsDir = optionalString(database, "migrations_dir");
		const migrationsPattern = optionalString(database, "migrations_pattern");
		const migrationsTable = optionalString(database, "migrations_table");
		return [
			{
				binding: database.binding,
				...(databaseName === undefined ? {} : { databaseName }),
				...(migrationsDir === undefined ? {} : { migrationsDir }),
				...(migrationsPattern === undefined ? {} : { migrationsPattern }),
				...(migrationsTable === undefined ? {} : { migrationsTable }),
			},
		];
	});
}

// `orange d1` commands find a database by binding or database_name, like
// Wrangler, and use the local ID that `orange dev` gives its binding.
// https://github.com/cloudflare/workers-sdk/blob/be87ff0382c53a294e948e49419d25d653c50e86/packages/wrangler/src/d1/utils.ts#L14-L37
function resolveD1Databases(
	databases: readonly WranglerD1DatabaseConfig[],
	bindings: readonly SupportedBindingConfiguration[],
): D1DatabaseConfiguration[] {
	return databases.flatMap((database): D1DatabaseConfiguration[] => {
		const binding = bindings.find(
			(candidate) => candidate.type === "d1" && candidate.binding === database.binding,
		);
		if (binding === undefined || binding.type !== "d1") return [];
		const { binding: name, ...settings } = database;
		return [{ binding: name, databaseId: binding.databaseId, ...settings }];
	});
}

function isQueueDelay(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function queueConsumerSetting(
	consumer: Record<string, unknown>,
	key: string,
	queueName: string,
	defaultValue: number,
	{ integer = true, minimum = 0 }: { integer?: boolean; minimum?: number } = {},
): number {
	const value = consumer[key] ?? defaultValue;
	if (
		typeof value !== "number" ||
		!Number.isFinite(value) ||
		(integer && !Number.isInteger(value)) ||
		value < minimum
	) {
		throw new TypeError(
			`Queue consumer ${queueName}.${key} must be ${integer ? "an integer" : "a number"} of ${minimum} or more`,
		);
	}
	return value;
}

// Reads `queues.consumers` with Cloudflare's production defaults. Cloudflare's maximums (100
// messages per batch, a 60 s batch timeout, 100 retries, 24 h delays) are quotas that Orange does
// not copy. Wrangler already rejects consumers that are not Workers.
// https://github.com/cloudflare/cloudflare-docs/blob/e65ba8b1fa64a5dc7c5c42a96c455398945cdf5e/src/content/docs/queues/configuration/batching-retries.mdx#L50-L56
// https://github.com/cloudflare/cloudflare-docs/blob/e65ba8b1fa64a5dc7c5c42a96c455398945cdf5e/src/content/docs/queues/configuration/batching-retries.mdx#L134
function parseQueueConsumers(queues: unknown): RuntimeQueueConsumer[] {
	if (!isRecord(queues) || !Array.isArray(queues.consumers)) return [];
	const consumers: RuntimeQueueConsumer[] = [];
	for (const [index, consumer] of queues.consumers.entries()) {
		if (!isRecord(consumer)) {
			throw new TypeError(`queues.consumers[${index}] must be an object`);
		}
		const queueName = requiredString(consumer, "queue", `queues.consumers[${index}]`);
		if (consumers.some((existing) => existing.queueName === queueName)) {
			throw new Error(`Queue ${queueName} has more than one consumer`);
		}
		const deadLetterQueue = optionalString(consumer, "dead_letter_queue");
		consumers.push({
			...(deadLetterQueue === undefined ? {} : { deadLetterQueue }),
			maxBatchSize: queueConsumerSetting(consumer, "max_batch_size", queueName, 10, { minimum: 1 }),
			maxBatchTimeout: queueConsumerSetting(consumer, "max_batch_timeout", queueName, 5, { integer: false }),
			maxRetries: queueConsumerSetting(consumer, "max_retries", queueName, 3),
			queueName,
			retryDelay: queueConsumerSetting(consumer, "retry_delay", queueName, 0),
		});
	}
	return consumers;
}

let wranglerUpdateCheckStarted = false;

/**
 * True once Wrangler started its npm update check. The check's socket keeps the
 * process alive until npm answers, so the CLI exits explicitly after it.
 */
export function hasWranglerUpdateCheckStarted(): boolean {
	return wranglerUpdateCheckStarted;
}

// Wrangler accepts unknown config fields and only logs a warning, so a typo such
// as `kv_namespace` silently drops a binding. `unstable_readConfig` does not
// return its diagnostics, so Orange captures the rendered warnings for the one
// synchronous call and fails on each "Unexpected fields found" line that has a
// value. An empty field binds nothing, and a newer Wrangler writes some empty,
// such as `k2: []` in 4.147, so Orange ignores those and reports them.
function readConfigRejectingUnknownFields(
	wrangler: WranglerApi,
	args: Parameters<WranglerApi["unstable_readConfig"]>[0],
): { ignoredFields: string[]; value: unknown } {
	const captured: string[] = [];
	const originalWarn = console.warn;
	const originalLevel = process.env.WRANGLER_LOG;
	// Wrangler skips warnings below its log level, so force the level for this call.
	process.env.WRANGLER_LOG = "warn";
	console.warn = (...parts: unknown[]) => {
		captured.push(parts.map(String).join(" "));
	};
	let value: unknown;
	try {
		value = wrangler.unstable_readConfig(args, { hideWarnings: false });
	} finally {
		console.warn = originalWarn;
		if (originalLevel === undefined) delete process.env.WRANGLER_LOG;
		else process.env.WRANGLER_LOG = originalLevel;
	}
	const unknownFields = parseUnknownFieldWarnings(captured.join("\n"));
	if (unknownFields.length === 0) return { ignoredFields: [], value };
	// Unknown fields also start Wrangler's npm update check, which logs a hint
	// later. Keep that hint off standard output, which may carry JSON Lines.
	process.env.WRANGLER_LOG = "error";
	wranglerUpdateCheckStarted = true;
	const { rawConfig } = wrangler.experimental_readRawConfig(args);
	const refused: string[] = [];
	const ignoredFields: string[] = [];
	for (const field of unknownFields) {
		const name = field.path === "" ? field.name : `${field.path}.${field.name}`;
		(isEmptyConfigValue(configValueAt(rawConfig, field.path, field.name)) ? ignoredFields : refused).push(name);
	}
	if (refused.length > 0) {
		throw new Error(
			`Unknown Wrangler configuration fields: ${refused.join(", ")}. Fix their names, or remove them: Orange runs Wrangler ${wranglerVersion()} and cannot use a field a newer Wrangler added.`,
		);
	}
	return { ignoredFields, value };
}

// Reads `kv_namespaces[0]` or `env.staging` from the raw config. An unreadable path
// counts as a value, so the field is refused.
function configValueAt(raw: Record<string, unknown>, path: string, name: string): unknown {
	let current: unknown = raw;
	for (const [, key, index] of path.matchAll(/([^.[\]]+)|\[(\d+)\]/g)) {
		if (index !== undefined) current = Array.isArray(current) ? current[Number(index)] : undefined;
		else current = isRecord(current) ? current[key ?? ""] : undefined;
		if (current === undefined) return true;
	}
	return isRecord(current) ? current[name] : true;
}

function isEmptyConfigValue(value: unknown): boolean {
	return (
		value === undefined ||
		value === null ||
		value === "" ||
		(Array.isArray(value) && value.length === 0) ||
		(isRecord(value) && Object.keys(value).length === 0)
	);
}

// Turns `Unexpected fields found in kv_namespaces[0] field: "a","b"` into
// `kv_namespaces[0].a` and `kv_namespaces[0].b`. Top-level fields keep their bare name.
function parseUnknownFieldWarnings(rendered: string): { name: string; path: string }[] {
	const fields: { name: string; path: string }[] = [];
	for (const match of stripVTControlCharacters(rendered).matchAll(
		/Unexpected fields found in (.+?) field: (.+)/g,
	)) {
		const [, path = "", names = ""] = match;
		for (const [, name] of names.matchAll(/"([^"]*)"/g)) {
			fields.push({ name: name ?? "", path: path === "top-level" ? "" : path });
		}
	}
	return fields;
}

function stableJson(value: unknown): string {
	if (Array.isArray(value)) {
		return `[${value.map(stableJson).join(",")}]`;
	}
	if (isRecord(value)) {
		return `{${Object.entries(value)
			.filter(([, entry]) => entry !== undefined)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}

export async function loadWranglerConfiguration(
	options: LoadWranglerConfigurationOptions = {},
): Promise<ResolvedWranglerConfiguration> {
	const wrangler = await loadWranglerApi();
	const { ignoredFields, value: readConfig } = readConfigRejectingUnknownFields(wrangler, {
		...(options.configPath === undefined
			? {}
			: { config: resolve(options.configPath) }),
		...(options.environment === undefined
			? {}
			: { env: options.environment }),
		...(options.scriptPath === undefined
			? {}
			: { script: resolve(options.scriptPath) }),
	});
	const config = parseWranglerConfig(readConfig);

	const { compatibilityDate, compatibilityFlags, warnings } =
		resolveCompatibilityProfile(config);
	if (ignoredFields.length > 0) {
		warnings.push(
			`Orange runs Wrangler ${wranglerVersion()} and ignores these empty configuration fields that it does not know: ${ignoredFields.join(", ")}.`,
		);
	}
	const entrypoint = config.main;
	const configPathValue = config.configPath;
	if (configPathValue === undefined && entrypoint === undefined) {
		throw new Error(
			`No Wrangler configuration found in ${process.cwd()} or its parent directories. Run this from a Worker project with a wrangler.jsonc, wrangler.json, or wrangler.toml, or pass --config <path>.`,
		);
	}
	if (entrypoint === undefined && config.assets === undefined) {
		throw new Error("Wrangler configuration must resolve a Worker entrypoint");
	}
	const configPath =
		configPathValue === undefined ? undefined : resolve(configPathValue);
	const projectRoot = configPath === undefined ? process.cwd() : dirname(configPath);
	if (config.unsupportedFields.length > 0) {
		throw new Error(
			`Unsupported Wrangler configuration: ${[...config.unsupportedFields].sort().join(", ")}`,
		);
	}
	// Orange runs no container images. A `@cloudflare/sandbox` class works on the
	// ORANGE_SANDBOX_PROVIDER backend instead; other Container classes fail when used.
	if (config.containers.length > 0) {
		warnings.push(
			"Orange does not run container images. Container classes and @cloudflare/sandbox run on ORANGE_SANDBOX_PROVIDER (default: local), which runs only Cloudflare Sandbox images.",
		);
	}
	const assets = resolveAssets(
		config.assets,
		projectRoot,
		entrypoint !== undefined,
		compatibilityDate,
		compatibilityFlags,
		warnings,
	);
	const build =
		config.build === undefined
			? undefined
			: { command: config.build.command, cwd: resolve(projectRoot, config.build.cwd ?? ".") };
	const workerName = config.name;
	const configuredBindings = wrangler.unstable_convertConfigBindingsToStartWorkerBindings(
		options.deployed === true ? withoutPreviewNames(config.raw) : config.raw,
	);
	const devVars = resolveDevVars(
		wrangler,
		config,
		configPath,
		options.environment,
		options.runnerEnvironment,
	);
	// A `.dev.vars` entry named after another binding is that binding's local
	// value, such as a Secrets Store secret, and does not replace it.
	const mergedBindings = { ...configuredBindings };
	for (const [name, variable] of Object.entries(devVars.vars)) {
		const configured = configuredBindings[name];
		if (
			configured === undefined ||
			configured.type === "plain_text" ||
			configured.type === "json"
		) {
			mergedBindings[name] = variable;
		}
	}
	const parsedBindings = parseSupportedBindings(
		mergedBindings,
		workerName,
		devVars.vars,
	);
	const bindings = parsedBindings.bindings;
	warnings.push(...devVars.warnings, ...parsedBindings.warnings);
	const durableObjects = withContainerClasses(
		parseDurableObjectManifest(config),
		config.containers,
		projectRoot,
	);
	const environment = config.targetEnvironment;
	// Secret values identify the version only by name, so they never reach the
	// version metadata input.
	const normalizedConfiguration = stableJson({
		bindings: bindings.map((binding) =>
			binding.type === "plain_text" && devVars.secretNames.has(binding.binding)
				? { binding: binding.binding, type: "secret_text" }
				: binding,
		),
		compatibilityDate,
		compatibilityFlags,
		durableObjects,
		environment,
		workerName,
	});

	return {
		...(assets === undefined ? {} : { assets }),
		bindings,
		...(build === undefined ? {} : { build }),
		compatibilityDate,
		compatibilityFlags,
		...(configPath === undefined ? {} : { configPath }),
		crons: resolveCronTriggers(config.crons, warnings),
		d1Databases: resolveD1Databases(config.d1Databases, bindings),
		...(durableObjects === undefined ? {} : { durableObjects }),
		...(entrypoint === undefined ? {} : { entrypoint: resolve(entrypoint) }),
		...(environment === undefined ? {} : { environment }),
		...(config.additionalModules === undefined || entrypoint === undefined
			? {}
			: {
					additionalModuleSearch: {
						globs: config.additionalModules.globs,
						root:
							config.additionalModules.baseDirectory === undefined
								? dirname(resolve(entrypoint))
								: resolve(projectRoot, config.additionalModules.baseDirectory),
					},
				}),
		moduleRules: config.moduleRules,
		noBundle: config.noBundle,
		normalizedConfiguration,
		requestSignalPassthrough: compatibilityFlags.includes("request_signal_passthrough"),
		projectRoot,
		queueConsumers: config.queueConsumers,
		routes: parseRoutes(config.raw),
		tailConsumers: config.tailConsumers,
		warnings,
		...(workerName === undefined ? {} : { workerName }),
	};
}

// Wrangler's `route` and `routes`: a pattern string, or an object with `pattern` and
// optionally `custom_domain`, which serves the whole host.
// https://github.com/cloudflare/workers-sdk/blob/be87ff0382c53a294e948e49419d25d653c50e86/packages/workers-utils/src/config/environment.ts#L20-L47
function parseRoutes(raw: Record<string, unknown>): string[] {
	const entries: unknown[] = [
		...(raw.route === undefined ? [] : [raw.route]),
		...(Array.isArray(raw.routes) ? raw.routes : []),
	];
	return entries.flatMap((entry): string[] => {
		if (typeof entry === "string") return [entry];
		if (!isRecord(entry) || typeof entry.pattern !== "string") return [];
		if (entry.custom_domain === true) return [`${entry.pattern.replace(/\/.*$/, "")}/*`];
		return [entry.pattern];
	});
}
