import { compileFunction, runInThisContext } from "node:vm";

import { nativeWebAssembly } from "../globals/webassembly.js";

function bytesFrom(source: unknown): Uint8Array {
	if (source instanceof ArrayBuffer) return new Uint8Array(source);
	if (ArrayBuffer.isView(source)) {
		return new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
	}
	throw new TypeError(
		"Failed to execute 'newWasmModule' on 'UnsafeEval': parameter 1 is not of type 'ArrayBuffer or ArrayBufferView'.",
	);
}

function setFunctionName(fn: Function, name: string): void {
	Object.defineProperty(fn, "name", { configurable: true, value: name });
}

// Mirrors workerd's UnsafeEval binding: scripts run in the global scope, and
// generated functions take the given name, which defaults to "anonymous".
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/unsafe.c%2B%2B#L127-L213
export class UnsafeEval {
	eval(script: string, name?: string): unknown {
		return runInThisContext(String(script), { filename: name ?? "eval" });
	}

	newFunction(script: string, name?: string, ...args: string[]): Function {
		const functionName = name ?? "anonymous";
		const fn = compileFunction(String(script), args.map(String), {
			filename: functionName,
		});
		setFunctionName(fn, functionName);
		return fn;
	}

	newAsyncFunction(script: string, name?: string, ...args: string[]): Function {
		const functionName = name ?? "anonymous";
		// Workerd compiles `async function {name}({args}) { {script} }; {name}`
		// because V8 has no async variant of CompileFunction.
		const fn: unknown = runInThisContext(
			`async function ${functionName}(${args.map(String).join(",")}) {${String(script)}}; ${functionName}`,
			{ filename: functionName },
		);
		if (typeof fn !== "function") {
			throw new TypeError("UnsafeEval.newAsyncFunction did not produce a function");
		}
		return fn;
	}

	newWasmModule(source: unknown): unknown {
		return new (nativeWebAssembly().Module)(bytesFrom(source));
	}
}

export function createUnsafeEval(): UnsafeEval {
	return new UnsafeEval();
}
