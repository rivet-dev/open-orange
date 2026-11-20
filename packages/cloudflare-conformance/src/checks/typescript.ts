import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import ts from "typescript";

export interface TypeScriptDiagnostic {
	code: number;
	message: string;
}

export interface VirtualTypeScriptSource {
	fileName: string;
	source: string;
}

export function compileTypeScriptSources(
	sources: readonly VirtualTypeScriptSource[],
): TypeScriptDiagnostic[] {
	const options: ts.CompilerOptions = {
		lib: ["lib.esnext.d.ts"],
		module: ts.ModuleKind.ESNext,
		moduleResolution: ts.ModuleResolutionKind.Bundler,
		noEmit: true,
		skipLibCheck: false,
		strict: true,
		target: ts.ScriptTarget.ESNext,
		types: [],
	};
	const host = ts.createCompilerHost(options, true);
	const defaultFileExists = host.fileExists.bind(host);
	const defaultGetSourceFile = host.getSourceFile.bind(host);
	const defaultReadFile = host.readFile.bind(host);
	const virtualSources = new Map(
		sources.map((source) => [source.fileName, source.source]),
	);

	host.fileExists = (path) => virtualSources.has(path) || defaultFileExists(path);
	host.readFile = (path) => virtualSources.get(path) ?? defaultReadFile(path);
	host.getSourceFile = (path, languageVersion, onError, shouldCreateNewSourceFile) =>
		virtualSources.has(path)
			? ts.createSourceFile(
					path,
					virtualSources.get(path) ?? "",
					languageVersion,
					true,
					ts.ScriptKind.TS,
				)
			: defaultGetSourceFile(
					path,
					languageVersion,
					onError,
					shouldCreateNewSourceFile,
				);

	const program = ts.createProgram(
		sources.map((source) => source.fileName),
		options,
		host,
	);
	return ts.getPreEmitDiagnostics(program).map((diagnostic) => ({
		code: diagnostic.code,
		message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
	}));
}

export function compileTypeScript(source: string): TypeScriptDiagnostic[] {
	return compileTypeScriptSources([
		{
			fileName: "/__open_orange_conformance__/fixture.ts",
			source,
		},
	]);
}

function diagnosticsFor(program: ts.Program): TypeScriptDiagnostic[] {
	return ts.getPreEmitDiagnostics(program).map((diagnostic) => ({
		code: diagnostic.code,
		message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
	}));
}

export async function compileConformanceTypeChecks(
	fileName: string,
	repositoryRoot: string,
): Promise<TypeScriptDiagnostic[]> {
	const runtimeSourceRoot = join(repositoryRoot, "packages/runtime-node/src");
	const declarationDirectory = await mkdtemp(
		join(tmpdir(), "open-orange-runtime-types-"),
	);
	try {
		const emitOptions: ts.CompilerOptions = {
			declaration: true,
			emitDeclarationOnly: true,
			lib: ["lib.esnext.d.ts"],
			module: ts.ModuleKind.ESNext,
			moduleResolution: ts.ModuleResolutionKind.Bundler,
			outDir: declarationDirectory,
			rootDir: runtimeSourceRoot,
			// This step only emits the runtime's declarations. The runtime imports agentOS, whose root
			// entry re-exports RivetKit declarations that need lib DOM, so its dependencies are not checked.
			skipLibCheck: true,
			strict: true,
			target: ts.ScriptTarget.ESNext,
			types: ["node"],
		};
		const implementationPaths = [
			join(runtimeSourceRoot, "bindings/durable-objects/index.ts"),
			join(runtimeSourceRoot, "bindings/implementations.ts"),
			join(runtimeSourceRoot, "events/implementations.ts"),
			join(runtimeSourceRoot, "globals/implementations.ts"),
			join(runtimeSourceRoot, "modules/implementations.ts"),
		];
		const emitProgram = ts.createProgram(implementationPaths, emitOptions);
		const emitDiagnostics = diagnosticsFor(emitProgram);
		const emitResult = emitProgram.emit();
		emitDiagnostics.push(
			...emitResult.diagnostics.map((diagnostic) => ({
				code: diagnostic.code,
				message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
			})),
		);
		if (emitDiagnostics.length > 0) {
			return emitDiagnostics;
		}

		const options: ts.CompilerOptions = {
			allowSyntheticDefaultImports: true,
			baseUrl: repositoryRoot,
			lib: ["lib.esnext.d.ts"],
			module: ts.ModuleKind.ESNext,
			moduleResolution: ts.ModuleResolutionKind.Bundler,
			noEmit: true,
			paths: {
				"@open-orange/runtime-node/durable-objects": [
					join(
						declarationDirectory,
						"bindings/durable-objects/index.d.ts",
					),
				],
				"@open-orange/runtime-node/bindings": [
					join(declarationDirectory, "bindings/implementations.d.ts"),
				],
			"@open-orange/runtime-node/globals": [
					join(declarationDirectory, "globals/implementations.d.ts"),
			],
			"@open-orange/runtime-node/events": [
				join(declarationDirectory, "events/implementations.d.ts"),
			],
				"@open-orange/runtime-node/modules": [
					join(declarationDirectory, "modules/implementations.d.ts"),
				],
			},
			resolveJsonModule: true,
			skipLibCheck: false,
			strict: true,
			target: ts.ScriptTarget.ESNext,
			types: [],
		};
		const program = ts.createProgram([fileName], options);
		return diagnosticsFor(program);
	} finally {
		await rm(declarationDirectory, { recursive: true, force: true });
	}
}
