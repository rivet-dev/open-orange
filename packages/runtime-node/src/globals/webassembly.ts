type BufferSource = ArrayBuffer | ArrayBufferView;

type ValueType =
	| "anyfunc"
	| "externref"
	| "f32"
	| "f64"
	| "i32"
	| "i64"
	| "v128";

interface GlobalDescriptor {
	value: ValueType;
	mutable?: boolean;
}

interface WebAssemblyGlobal {
	value: unknown;
	valueOf(): unknown;
}

interface WebAssemblyGlobalConstructor {
	readonly prototype: WebAssemblyGlobal;
	new (descriptor: GlobalDescriptor, value?: unknown): WebAssemblyGlobal;
}

interface WebAssemblyMemory {
	readonly buffer: ArrayBuffer;
	grow(delta: number): number;
}

interface MemoryDescriptor {
	initial: number;
	maximum?: number;
	shared?: boolean;
}

interface WebAssemblyMemoryConstructor {
	readonly prototype: WebAssemblyMemory;
	new (descriptor: MemoryDescriptor): WebAssemblyMemory;
}

type TableKind = "anyfunc" | "externref";

interface TableDescriptor {
	element: TableKind;
	initial: number;
	maximum?: number;
}

interface WebAssemblyTable {
	readonly length: number;
	get(index: number): unknown;
	grow(delta: number, value?: unknown): number;
	set(index: number, value?: unknown): void;
}

interface WebAssemblyTableConstructor {
	readonly prototype: WebAssemblyTable;
	new (descriptor: TableDescriptor, value?: unknown): WebAssemblyTable;
}

interface WebAssemblyModule {}

type ImportExportKind = "function" | "global" | "memory" | "table";

interface ModuleExportDescriptor {
	kind: ImportExportKind;
	name: string;
}

interface ModuleImportDescriptor {
	kind: ImportExportKind;
	module: string;
	name: string;
}

interface WebAssemblyModuleConstructor {
	readonly prototype: WebAssemblyModule;
	new (bytes?: BufferSource): WebAssemblyModule;
	customSections(module: WebAssemblyModule, sectionName: string): ArrayBuffer[];
	exports(module: WebAssemblyModule): ModuleExportDescriptor[];
	imports(module: WebAssemblyModule): ModuleImportDescriptor[];
}

type ExportValue =
	| Function
	| WebAssemblyGlobal
	| WebAssemblyMemory
	| WebAssemblyTable;
type Imports = Record<string, Record<string, ExportValue | number>>;

interface WebAssemblyInstance {
	readonly exports: Record<string, ExportValue>;
}

interface WebAssemblyInstanceConstructor {
	readonly prototype: WebAssemblyInstance;
	new (
		module: WebAssemblyModule,
		imports?: Imports,
	): WebAssemblyInstance;
}

interface WebAssemblyErrorConstructor {
	readonly prototype: Error;
	new (message?: string): Error;
	isError(value: unknown): value is Error;
}

export interface WebAssemblyNamespace {
	CompileError: WebAssemblyErrorConstructor;
	Global: WebAssemblyGlobalConstructor;
	Instance: WebAssemblyInstanceConstructor;
	Memory: WebAssemblyMemoryConstructor;
	Module: WebAssemblyModuleConstructor;
	RuntimeError: WebAssemblyErrorConstructor;
	Table: WebAssemblyTableConstructor;
	instantiate(
		module: WebAssemblyModule,
		imports?: Imports,
	): Promise<WebAssemblyInstance>;
	validate(bytes: BufferSource): boolean;
}

function isWebAssemblyNamespace(value: unknown): value is WebAssemblyNamespace {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	return [
		"CompileError",
		"Global",
		"Instance",
		"Memory",
		"Module",
		"RuntimeError",
		"Table",
		"instantiate",
		"validate",
	].every((name) => typeof Reflect.get(value, name) === "function");
}

// Preserve Node's full namespace (including host-only helpers used by Undici),
// while exposing only the Cloudflare-visible contract to Orange code. Read on
// use, not at module load: V8 has no WebAssembly global while agentOS builds
// a module snapshot of the dynamic Worker child.
export function nativeWebAssembly(): WebAssemblyNamespace {
	const value: unknown = Reflect.get(globalThis, "WebAssembly");
	if (!isWebAssemblyNamespace(value)) {
		throw new Error("Node.js does not provide the required WebAssembly global");
	}
	return value;
}
