import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { compileConformanceTypeChecks } from "./typescript.js";

const execFileAsync = promisify(execFile);

// `orange types` adds this block after Wrangler's runtime types. See src/commands/types.ts.
const orangeExtensionTypesMarker = "\n// Begin OpenOrange extension types\n";

export interface GeneratedBindingExpectation {
	bindingName: string;
	factoryName: "secrets_store_secret" | "version_metadata";
}

export interface GeneratedTypesFixture {
	bindings: readonly GeneratedBindingExpectation[];
	configPath: string;
	id: string;
}

function renderBindingChecks(
	declarationsPath: string,
	bindings: readonly GeneratedBindingExpectation[],
): string {
	const checks = bindings
		.map(
			(binding, index) => `type ExpectedBinding${index} = ReturnType<
	(typeof bindingFactories)[${JSON.stringify(binding.factoryName)}]
>;
type ActualBinding${index} = Env[${JSON.stringify(binding.bindingName)}];
type BindingCheck${index} = Assert<IsExact<ActualBinding${index}, ExpectedBinding${index}>>;`,
		)
		.join("\n\n");
	return `/// <reference path=${JSON.stringify(declarationsPath)} />

import { bindingFactories } from "@open-orange/runtime-node/bindings";

type IsAny<Value> = 0 extends 1 & Value ? true : false;
type IsExact<Left, Right> = IsAny<Left> extends true
	? IsAny<Right>
	: IsAny<Right> extends true
		? false
		: (<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2
			? (<Value>() => Value extends Right ? 1 : 2) extends <Value>() => Value extends Left ? 1 : 2
				? true
				: false
			: false;
type Assert<Condition extends true> = Condition;

${checks}
`;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export async function checkGeneratedTypesFixtures(
	fixtures: readonly GeneratedTypesFixture[],
	repositoryRoot: string,
): Promise<string[]> {
	const errors: string[] = [];
	const temporaryDirectory = await mkdtemp(
		join(tmpdir(), "open-orange-generated-types-"),
	);
	try {
		for (const fixture of fixtures) {
			const outputPath = join(temporaryDirectory, `${fixture.id}.d.ts`);
			try {
				await execFileAsync(
					process.platform === "win32" ? "wrangler.cmd" : "wrangler",
					["types", outputPath, "--config", fixture.configPath],
					{
						cwd: repositoryRoot,
						env: {
							...process.env,
							CI: "1",
							LANG: "C",
							LC_ALL: "C",
							NO_COLOR: "1",
						},
						maxBuffer: 4 * 1024 * 1024,
					},
				);
				const wranglerOutput = await readFile(outputPath, "utf8");
				await execFileAsync(
					process.platform === "win32" ? "tsx.cmd" : "tsx",
					[
						join(repositoryRoot, "src/bin.ts"),
						"types",
						outputPath,
						"--config",
						fixture.configPath,
					],
					{
						cwd: repositoryRoot,
						env: {
							...process.env,
							CI: "1",
							LANG: "C",
							LC_ALL: "C",
							NO_COLOR: "1",
						},
						maxBuffer: 4 * 1024 * 1024,
					},
				);
				const orangeOutput = await readFile(outputPath, "utf8");
				// Orange writes Wrangler's output unchanged, then its own extension types, such as
				// `orange.fork()`. The binding checks below compile the extensions too.
				if (
					!orangeOutput.startsWith(wranglerOutput) ||
					!orangeOutput.slice(wranglerOutput.length).startsWith(orangeExtensionTypesMarker)
				) {
					errors.push(
						`generated types fixture ${fixture.id} differs between Wrangler and Orange`,
					);
					continue;
				}

				const checkPath = join(temporaryDirectory, `${fixture.id}.check.ts`);
				await writeFile(
					checkPath,
					renderBindingChecks(outputPath, fixture.bindings),
					"utf8",
				);
				for (const diagnostic of await compileConformanceTypeChecks(
					checkPath,
					repositoryRoot,
				)) {
					errors.push(
						`generated types fixture ${fixture.id} failed binding conformance (TS${diagnostic.code}): ${diagnostic.message}`,
					);
				}
			} catch (error: unknown) {
				errors.push(
					`generated types fixture ${fixture.id} could not run: ${errorMessage(error)}`,
				);
			}
		}
	} finally {
		await rm(temporaryDirectory, { force: true, recursive: true });
	}
	return errors;
}
