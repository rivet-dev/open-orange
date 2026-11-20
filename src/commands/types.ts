import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import {
	loadWranglerApi,
	loadWranglerConfiguration,
	type GenerateWranglerTypesOptions,
} from "../config/load-wrangler.js";

interface TypesCommandIo {
	log(message: string): void;
	error(message: string): void;
}

interface ParsedTypesArguments extends GenerateWranglerTypesOptions {
	check: boolean;
	cwd?: string;
	installSkills: boolean;
	path: string;
}

function booleanValue(name: string, value: string | undefined): boolean {
	if (value === undefined || value === "true") {
		return true;
	}
	if (value === "false") {
		return false;
	}
	throw new Error(`${name} must be true or false`);
}

function splitOption(token: string): { name: string; value?: string } {
	const separator = token.indexOf("=");
	return separator === -1
		? { name: token }
		: { name: token.slice(0, separator), value: token.slice(separator + 1) };
}

function requiredOptionValue(
	args: readonly string[],
	index: number,
	name: string,
	inlineValue: string | undefined,
): { index: number; value: string } {
	if (inlineValue !== undefined) {
		if (inlineValue.length === 0) {
			throw new Error(`${name} requires a value`);
		}
		return { index, value: inlineValue };
	}
	const value = args[index + 1];
	if (value === undefined || value.startsWith("-")) {
		throw new Error(`${name} requires a value`);
	}
	return { index: index + 1, value };
}

export function parseTypesArguments(args: readonly string[]): ParsedTypesArguments {
	const parsed: ParsedTypesArguments = {
		check: false,
		includeEnv: true,
		includeRuntime: true,
		installSkills: false,
		path: "worker-configuration.d.ts",
		strictVars: true,
	};
	const positionals: string[] = [];
	let afterSeparator = false;

	for (let index = 0; index < args.length; index += 1) {
		const token = args[index];
		if (token === undefined || token === "types") {
			continue;
		}
		if (token === "--") {
			afterSeparator = true;
			continue;
		}
		if (afterSeparator || !token.startsWith("-")) {
			positionals.push(token);
			continue;
		}

		const { name, value } = splitOption(token);
		if (name === "-c" || name === "--config") {
			const option = requiredOptionValue(args, index, name, value);
			parsed.config = option.value;
			index = option.index;
		} else if (name === "-e" || name === "--env") {
			const option = requiredOptionValue(args, index, name, value);
			parsed.env = option.value;
			index = option.index;
		} else if (name === "--cwd") {
			const option = requiredOptionValue(args, index, name, value);
			parsed.cwd = option.value;
			index = option.index;
		} else if (name === "--env-file") {
			const option = requiredOptionValue(args, index, name, value);
			parsed.envFile = [...(parsed.envFile ?? []), option.value];
			index = option.index;
		} else if (name === "--env-interface") {
			const option = requiredOptionValue(args, index, name, value);
			parsed.envInterface = option.value;
			index = option.index;
		} else if (name === "--profile") {
			const option = requiredOptionValue(args, index, name, value);
			index = option.index;
		} else if (name === "--include-runtime") {
			parsed.includeRuntime = booleanValue(name, value);
		} else if (name === "--no-include-runtime") {
			parsed.includeRuntime = false;
		} else if (name === "--include-env") {
			parsed.includeEnv = booleanValue(name, value);
		} else if (name === "--no-include-env") {
			parsed.includeEnv = false;
		} else if (name === "--strict-vars") {
			parsed.strictVars = booleanValue(name, value);
		} else if (name === "--no-strict-vars") {
			parsed.strictVars = false;
		} else if (name === "--check") {
			parsed.check = booleanValue(name, value);
		} else if (name === "--install-skills") {
			parsed.installSkills = booleanValue(name, value);
		} else if (name !== "--help" && name !== "-h") {
			throw new Error(`Unknown orange types option: ${name}`);
		}
	}

	if (positionals.length > 1) {
		throw new Error("orange types accepts at most one output path");
	}
	if (positionals[0] !== undefined) {
		parsed.path = positionals[0];
	}
	return parsed;
}

interface GeneratedTypesResult {
	content: string;
	runtime: string | null;
}

function generatedTypesResult(value: unknown): GeneratedTypesResult {
	if (
		typeof value !== "object" ||
		value === null ||
		!("content" in value) ||
		typeof value.content !== "string" ||
		!("runtime" in value) ||
		(value.runtime !== null && typeof value.runtime !== "string")
	) {
		throw new TypeError("Wrangler returned invalid generated type output");
	}
	return { content: value.content, runtime: value.runtime };
}

// OpenOrange's extensions to the runtime types, such as `env.MY_DO.orange.fork()`. They merge into
// Cloudflare's own declarations, so `orange types` adds them after the runtime types it generates.
const orangeExtensionTypes = `
// Begin OpenOrange extension types
// Cloudflare does not have these. See https://openorange.dev/docs/extensions/fork-durable-objects/
interface DurableObjectNamespace<T extends Rpc.DurableObjectBranded | undefined = undefined> {
	readonly orange: {
		/** Copies the object \`source\` into a new object and returns its stub. */
		fork(
			source: DurableObjectId,
			options?: { name?: string; id?: DurableObjectId; input?: unknown },
		): Promise<DurableObjectStub<T>>;
	};
}
interface DurableObjectState<Props = unknown> {
	readonly orange: {
		/** Every object this one was forked from, oldest first. */
		readonly forkChain: readonly { id: DurableObjectId; name?: string; forkedAt: number }[];
	};
}
/** What \`onOrangeFork(fork)\` receives in a forked object. */
interface OrangeForkInfo<Input = unknown> {
	id: DurableObjectId;
	name?: string;
	forkedAt: number;
	input: Input | undefined;
}
`;

async function readExisting(path: string): Promise<string | undefined> {
	try {
		return await readFile(path, "utf8");
	} catch (error: unknown) {
		if (
			typeof error === "object" &&
			error !== null &&
			"code" in error &&
			error.code === "ENOENT"
		) {
			return undefined;
		}
		throw error;
	}
}

async function executeTypesCommand(
	parsed: ParsedTypesArguments,
	io: TypesCommandIo,
): Promise<number> {
	if (parsed.installSkills) {
		throw new Error("orange types --install-skills is not implemented");
	}
	await loadWranglerConfiguration({
		...(parsed.config === undefined ? {} : { configPath: parsed.config }),
		...(parsed.env === undefined ? {} : { environment: parsed.env }),
	});
	const wrangler = await loadWranglerApi();
	const generateOptions: GenerateWranglerTypesOptions = {
		...(parsed.config === undefined ? {} : { config: parsed.config }),
		...(parsed.env === undefined ? {} : { env: parsed.env }),
		...(parsed.envFile === undefined ? {} : { envFile: parsed.envFile }),
		...(parsed.envInterface === undefined
			? {}
			: { envInterface: parsed.envInterface }),
		includeEnv: parsed.includeEnv,
		includeRuntime: parsed.includeRuntime,
		path: parsed.path,
		strictVars: parsed.strictVars,
	};
	const outputPath = resolve(parsed.path);
	const existing = await readExisting(outputPath);
	const generated = generatedTypesResult(
		await wrangler.experimental_generateTypes(generateOptions),
	);
	let content = generated.content;
	if (existing !== undefined && parsed.includeRuntime) {
		const fresh = generatedTypesResult(
			await wrangler.experimental_generateTypes({
				...generateOptions,
				includeEnv: false,
				path: parsed.path.endsWith(".d.ts")
					? `${parsed.path.slice(0, -5)}.orange-fresh-types.d.ts`
					: `${parsed.path}.orange-fresh-types.d.ts`,
			}),
		);
		if (fresh.runtime === null) {
			throw new Error("Wrangler did not return requested runtime types");
		}
		const marker = "// Begin runtime types\n";
		const markerIndex = content.indexOf(marker);
		if (markerIndex === -1) {
			throw new Error("Wrangler generated types without a runtime marker");
		}
		content = `${content.slice(0, markerIndex + marker.length)}${fresh.runtime}`;
	}
	// The extensions refer to the runtime types, so they come only with them.
	if (parsed.includeRuntime) content += orangeExtensionTypes;
	if (parsed.check) {
		if (existing !== content) {
			io.error(`Generated types are out of date: ${outputPath}`);
			return 1;
		}
		io.log(`Generated types are up to date: ${outputPath}`);
		return 0;
	}
	await mkdir(dirname(outputPath), { recursive: true });
	await writeFile(outputPath, content, "utf8");
	io.log(`Generated types: ${outputPath}`);
	return 0;
}

export async function runTypesCommand(
	args: readonly string[],
	io: TypesCommandIo,
): Promise<number> {
	try {
		const parsed = parseTypesArguments(args);
		const workingDirectory = resolve(parsed.cwd ?? process.cwd());
		const originalWorkingDirectory = process.cwd();
		process.chdir(workingDirectory);
		try {
			return await executeTypesCommand(parsed, io);
		} finally {
			process.chdir(originalWorkingDirectory);
		}
	} catch (error: unknown) {
		io.error(error instanceof Error ? error.message : String(error));
		return 1;
	}
}
