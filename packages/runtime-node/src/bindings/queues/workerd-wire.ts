import { Deserializer } from "node:v8";

import { Headers, Request, Response } from "../../globals/http.js";

// Reads a queue message's `serializedBody`, which is V8 wire format with workerd's host objects.
// Node's v8.deserialize() can't read those, and a crafted one must fail with a DataCloneError.
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/jsg/ser.c%2B%2B#L526

// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/io/worker-interface.capnp#L478
const tag = {
	domException: 7,
	domExceptionV2: 8,
	headers: 4,
	nativeError: 10,
	request: 5,
	response: 6,
} as const;

// The index is the wire ID. ID 0 means that a name follows.
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/headers.c%2B%2B#L14
const commonHeaderNames = [
	"accept-charset", "accept-encoding", "accept-language", "accept-ranges", "accept",
	"access-control-allow-origin", "age", "allow", "authorization", "cache-control",
	"content-disposition", "content-encoding", "content-language", "content-length",
	"content-location", "content-range", "content-type", "cookie", "date", "etag", "expect",
	"expires", "from", "host", "if-match", "if-modified-since", "if-none-match", "if-range",
	"if-unmodified-since", "last-modified", "link", "location", "max-forwards",
	"proxy-authenticate", "proxy-authorization", "range", "referer", "refresh", "retry-after",
	"server", "set-cookie", "strict-transport-security", "transfer-encoding", "user-agent", "vary",
	"via", "www-authenticate",
];
const maxHeaderCount = 1024;
// Immutable, request, response and none. Orange's Headers has no guard to restore.
const maxHeadersGuard = 3;

// The index is workerd's ErrorTag. Unknown (0) carries its own name.
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/jsg/ser.c%2B%2B#L23
// A string names a WebAssembly class, read on use: V8 has no WebAssembly
// global while agentOS builds a module snapshot of the dynamic Worker child.
const errorClasses: readonly (ErrorConstructor | string | undefined)[] = [
	Error, Error, TypeError, RangeError, ReferenceError, SyntaxError,
	"CompileError", "LinkError", "RuntimeError",
	undefined, EvalError, URIError, undefined, undefined,
];
const errorClass = (tag: number): ErrorConstructor | undefined => {
	const entry = errorClasses[tag];
	return typeof entry === "string"
		? (Reflect.get(Reflect.get(globalThis, "WebAssembly") as object, entry) as ErrorConstructor)
		: entry;
};
const errorNames: Readonly<Record<number, string>> = {
	9: "SuspendError",
	12: "AggregateError",
	13: "SuppressedError",
};

function cloneError(message: string): DOMException {
	return new DOMException(`Deserialization failed: ${message}`, "DataCloneError");
}

function isObject(value: unknown): value is object {
	return (typeof value === "object" && value !== null) || typeof value === "function";
}

class WorkerdWireDeserializer extends Deserializer {
	#string(): string {
		const [high, low] = this.readUint64();
		if (high !== 0) throw cloneError("string length is out of range");
		return this.readRawBytes(low).toString("utf8");
	}

	// A dictionary may be absent, as with jsg's dictionary wrapping. Anything else must be an object.
	#dictionary(what: string): object | undefined {
		const value: unknown = this.readValue();
		if (value === undefined || value === null) return undefined;
		if (!isObject(value)) throw cloneError(`could not deserialize ${what}`);
		return value;
	}

	#headers(): Headers {
		if (this.readUint32() > maxHeadersGuard) throw cloneError("unknown Headers guard");
		const count = this.readUint32();
		if (count > maxHeaderCount) throw cloneError(`header count exceeds maximum (${count})`);
		const headers = new Headers();
		for (let index = 0; index < count; index++) {
			const id = this.readUint32();
			const name = id === 0 ? this.#string() : commonHeaderNames[id - 1];
			if (name === undefined) throw cloneError(`unknown common header ID (${id})`);
			headers.append(name, this.#string());
		}
		return headers;
	}

	#domException(legacy: boolean): DOMException {
		const name = this.#string();
		let message: unknown;
		let stack: unknown;
		if (legacy) {
			const error: unknown = this.readValue();
			if (!isObject(error)) throw cloneError("DOMException payload is not an object");
			message = Reflect.get(error, "message");
			stack = Reflect.get(error, "stack");
			if (typeof message !== "string") throw cloneError("DOMException message is not a string");
			if (typeof stack !== "string") throw cloneError("DOMException stack is not a string");
		} else {
			message = this.#string();
			stack = this.#string();
		}
		const exception = new DOMException(String(message), name);
		Object.defineProperty(exception, "stack", { configurable: true, value: stack, writable: true });
		return exception;
	}

	#nativeError(): Error {
		const errorTag = this.readUint32();
		if (errorTag >= errorClasses.length) throw cloneError(`unknown error tag (${errorTag})`);
		const name: unknown = errorTag === 0 ? this.readValue() : errorNames[errorTag];
		const message: unknown = this.readValue();
		if (typeof message !== "string") throw cloneError("error message is not a string");
		const error = new (errorClass(errorTag) ?? Error)(message);
		if (name !== undefined) Object.defineProperty(error, "name", { configurable: true, value: name, writable: true });
		const properties: unknown = this.readValue();
		if (isObject(properties)) {
			for (const key of Object.keys(properties)) {
				// As workerd's default, which doesn't restore a serialized stack.
				if (key !== "stack") {
					Object.defineProperty(error, key, {
						configurable: true,
						enumerable: true,
						value: Reflect.get(properties, key),
						writable: true,
					});
				}
			}
		}
		return error;
	}

	#request(): Request {
		const url = this.#string();
		const init = this.#dictionary("Request initializer");
		return new Request(url, init);
	}

	#response(): Response {
		const body: unknown = this.readValue();
		if (body !== undefined && body !== null) throw cloneError("could not deserialize Response body");
		const init = this.#dictionary("Response initializer");
		if (init !== undefined && Reflect.get(init, "status") === 0) return Response.error();
		return new Response(null, init);
	}

	_readHostObject(): object {
		const hostTag = this.readUint32();
		switch (hostTag) {
			case tag.headers:
				return this.#headers();
			case tag.request:
				return this.#request();
			case tag.response:
				return this.#response();
			case tag.domException:
				return this.#domException(true);
			case tag.domExceptionV2:
				return this.#domException(false);
			case tag.nativeError:
				return this.#nativeError();
			default:
				// Streams, stubs and abort signals name a live handle, which a stored message can't carry.
				throw cloneError(`host object ${hostTag} is not supported in serializedBody`);
		}
	}
}

export function deserializeWorkerdWire(bytes: Uint8Array): unknown {
	const reader = new WorkerdWireDeserializer(bytes);
	reader.readHeader();
	return reader.readValue();
}
