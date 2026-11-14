import { glob, readFile, stat } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isRecord } from "../tests/harness/orange-dev.js";

const manifestPattern = "tests/cloudflare-examples/*/*/example.json";
const requiredFields = [
	"expectation",
	"id",
	"reference",
	"source",
	"wranglerConfig",
] as const;
const idPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

type ExampleExpectation = "expected-pass" | "known-broken";

export interface ExampleManifest {
	id: string;
	source: string;
	wranglerConfig: string;
	reference: string;
	expectation: ExampleExpectation;
	reason?: string;
}

export interface ExampleManifestValidation {
	errors: string[];
	manifests: ExampleManifest[];
}

function isString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function displayPath(repositoryRoot: string, path: string): string {
	return relative(repositoryRoot, path).split(sep).join("/");
}

function validateFields(
	value: Record<string, unknown>,
	label: string,
	errors: string[],
): void {
	const expected = [
		...requiredFields,
		...(value.expectation === "known-broken" ? ["reason"] : []),
	].sort();
	const actual = Object.keys(value).sort();
	if (
		actual.length !== expected.length ||
		actual.some((field, index) => field !== expected[index])
	) {
		errors.push(
			`${label}: fields must be exactly ${expected.join(", ")}; received ${actual.join(", ")}`,
		);
	}
}

async function validateLocalFile(
	repositoryRoot: string,
	exampleDirectory: string,
	field: "source" | "wranglerConfig",
	value: unknown,
	label: string,
	errors: string[],
): Promise<void> {
	if (!isString(value)) {
		errors.push(`${label}: ${field} must be a non-empty string`);
		return;
	}

	const absolute = resolve(repositoryRoot, value);
	const canonical = displayPath(repositoryRoot, absolute);
	const examplePrefix = `${resolve(exampleDirectory)}${sep}`;
	if (canonical !== value || !absolute.startsWith(examplePrefix)) {
		errors.push(
			`${label}: ${field} must be a repository-relative path within its example directory without traversal`,
		);
		return;
	}

	try {
		if (!(await stat(absolute)).isFile()) {
			errors.push(`${label}: ${field} does not reference a regular file`);
		}
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") {
			errors.push(`${label}: ${field} file does not exist: ${value}`);
			return;
		}
		throw error;
	}
}

function validateReference(
	value: unknown,
	label: string,
	errors: string[],
): void {
	if (!isString(value)) {
		errors.push(`${label}: reference must be a non-empty string`);
		return;
	}

	let url: URL;
	try {
		url = new URL(value);
	} catch {
		errors.push(`${label}: reference must be a valid HTTPS URL`);
		return;
	}
	if (url.protocol !== "https:" || url.username || url.password) {
		errors.push(`${label}: reference must be a credential-free HTTPS URL`);
	} else if (
		url.hostname === "github.com" &&
		!/^\/[^/]+\/[^/]+\/blob\/[0-9a-f]{40}\/.+#L\d+(?:-L\d+)?$/.test(
			`${url.pathname}${url.hash}`,
		)
	) {
		errors.push(
			`${label}: GitHub references must pin a full commit SHA and line range`,
		);
	}
}

async function validateManifest(
	repositoryRoot: string,
	path: string,
	errors: string[],
): Promise<ExampleManifest | undefined> {
	const label = displayPath(repositoryRoot, path);
	let value: unknown;
	try {
		value = JSON.parse(await readFile(path, "utf8")) as unknown;
	} catch (error) {
		errors.push(
			`${label}: invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
		);
		return;
	}
	if (!isRecord(value)) {
		errors.push(`${label}: manifest must be a JSON object`);
		return;
	}

	validateFields(value, label, errors);
	if (!isString(value.id) || !idPattern.test(value.id)) {
		errors.push(`${label}: id must be lowercase kebab-case`);
	} else if (dirname(path).split(sep).at(-1) !== value.id) {
		errors.push(`${label}: directory name must match id ${value.id}`);
	}
	if (
		value.expectation !== "expected-pass" &&
		value.expectation !== "known-broken"
	) {
		errors.push(`${label}: expectation must be expected-pass or known-broken`);
	}
	if (value.expectation === "known-broken" && !isString(value.reason)) {
		errors.push(`${label}: known-broken examples require a non-empty reason`);
	}

	await Promise.all([
		validateLocalFile(
			repositoryRoot,
			dirname(path),
			"source",
			value.source,
			label,
			errors,
		),
		validateLocalFile(
			repositoryRoot,
			dirname(path),
			"wranglerConfig",
			value.wranglerConfig,
			label,
			errors,
		),
	]);
	validateReference(value.reference, label, errors);

	if (
		!isString(value.id) ||
		!isString(value.source) ||
		!isString(value.wranglerConfig) ||
		!isString(value.reference) ||
		(value.expectation !== "expected-pass" &&
			value.expectation !== "known-broken")
	) {
		return;
	}
	return {
		id: value.id,
		source: value.source,
		wranglerConfig: value.wranglerConfig,
		reference: value.reference,
		expectation: value.expectation,
		...(value.expectation === "known-broken" && isString(value.reason)
			? { reason: value.reason }
			: {}),
	};
}

export async function validateExampleManifests(
	repositoryRoot = process.cwd(),
): Promise<ExampleManifestValidation> {
	const root = resolve(repositoryRoot);
	const paths: string[] = [];
	for await (const path of glob(manifestPattern, { cwd: root })) {
		paths.push(resolve(root, path));
	}
	paths.sort();

	const errors: string[] = [];
	if (paths.length === 0) {
		return {
			errors: [`${manifestPattern}: no example manifests found`],
			manifests: [],
		};
	}
	const manifests = (
		await Promise.all(
			paths.map((path) => validateManifest(root, path, errors)),
		)
	).filter((manifest): manifest is ExampleManifest => manifest !== undefined);

	const ids = new Set<string>();
	for (const manifest of manifests) {
		if (ids.has(manifest.id)) errors.push(`duplicate example id: ${manifest.id}`);
		ids.add(manifest.id);
	}
	errors.sort();
	manifests.sort((left, right) => left.id.localeCompare(right.id));
	return { errors, manifests };
}

async function main(): Promise<void> {
	const result = await validateExampleManifests();
	if (result.errors.length > 0) {
		for (const error of result.errors) console.error(error);
		process.exitCode = 1;
	} else {
		console.log(`Validated ${result.manifests.length} example manifests.`);
	}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	await main();
}
