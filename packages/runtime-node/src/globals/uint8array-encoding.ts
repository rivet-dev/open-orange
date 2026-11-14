// `Uint8Array` hex and base64 methods from tc39/proposal-arraybuffer-base64. workerd has them, and
// Node 24 does not. Native methods are retained when their read counts match workerd.
// Node's `--js-base-64` flag is not an option: on Node 24 its `toHex()` returns wrong bytes for
// subarrays and pooled Buffers.
//
// These act as built-ins, so they read the view through captured intrinsics. A subclass's `length`,
// or a Worker's patch of `slice` or `Buffer`, cannot change the bytes they see or the type they return.
// Ported from https://github.com/rivet-dev/agentos/blob/aff1cd93/packages/build-tools/bridge-src/builtins/uint8array-encoding.ts

const BASE64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const BASE64URL_CHARS = `${BASE64_CHARS.slice(0, 62)}-_`;
const HEX_CHARS = "0123456789abcdef";
const HEX_PAIRS = Array.from({ length: 256 }, (_, byte) => byte.toString(16).padStart(2, "0"));
const EQUALS_CODE = 61;

// Concatenating a piece per byte is the fastest path for a short string, such as a digest. Each piece
// allocates a heap node until V8 flattens the string, so a long input must not take this path: it can
// exhaust the heap and end the process.
const HEX_CONCAT_MAX_BYTES = 1024;
// A multiple of the 2 and 4 characters that one encoding step writes.
const ENCODE_CHUNK_CHARS = 0x2000;

type Base64Alphabet = "base64" | "base64url";
type LastChunkHandling = "loose" | "strict" | "stop-before-partial";

interface DecodeResult {
	read: number;
	written: number;
}

function createCharCodes(chars: string): Uint8Array {
	return Uint8Array.from(chars, (char) => char.charCodeAt(0));
}

function createDecodeTable(chars: string): Int8Array {
	const table = new Int8Array(128).fill(-1);
	for (let value = 0; value < chars.length; value++) {
		table[chars.charCodeAt(value)] = value;
	}
	return table;
}

const BASE64_CODES = createCharCodes(BASE64_CHARS);
const BASE64URL_CODES = createCharCodes(BASE64URL_CHARS);
const HEX_CODES = createCharCodes(HEX_CHARS);
const BASE64_VALUES = createDecodeTable(BASE64_CHARS);
const BASE64URL_VALUES = createDecodeTable(BASE64URL_CHARS);
const HEX_VALUES = createDecodeTable(HEX_CHARS);
HEX_VALUES.set([10, 11, 12, 13, 14, 15], "A".charCodeAt(0));

const NO_OPTIONS: object = Object.freeze(Object.create(null) as object);
const apply = Reflect.apply;
const fromCharCode = String.fromCharCode;
const typedArrayPrototype: object = Object.getPrototypeOf(Uint8Array.prototype);
const typedArrayIntrinsic = (name: string | symbol): PropertyDescriptor | undefined =>
	Object.getOwnPropertyDescriptor(typedArrayPrototype, name);
const getTypedArrayName = typedArrayIntrinsic(Symbol.toStringTag)?.get as () => unknown;
const getTypedArrayLength = typedArrayIntrinsic("length")?.get as () => number;
const typedArrayValues = typedArrayIntrinsic("values")?.value as () => unknown;
const typedArraySet = typedArrayIntrinsic("set")?.value as (source: Uint8Array) => void;

function assertUint8Array(value: unknown, method: string): asserts value is Uint8Array {
	if (apply(getTypedArrayName, value, []) !== "Uint8Array") {
		throw new TypeError(`Uint8Array.prototype.${method} requires a Uint8Array receiver`);
	}
}

// `values` is the shortest built-in that throws a TypeError when the buffer is
// detached or the view is out of bounds. Those views otherwise read as empty.
function readableLength(view: Uint8Array): number {
	apply(typedArrayValues, view, []);
	return apply(getTypedArrayLength, view, []);
}

function readOptions(options: unknown): object {
	if (options === undefined) return NO_OPTIONS;
	if ((typeof options === "object" && options !== null) || typeof options === "function") {
		return options;
	}
	throw new TypeError("Uint8Array base64 options must be an object or undefined");
}

function readAlphabet(options: object): Base64Alphabet {
	const alphabet: unknown = Reflect.get(options, "alphabet");
	if (alphabet === undefined) return "base64";
	if (alphabet !== "base64" && alphabet !== "base64url") {
		throw new TypeError('Uint8Array base64 option "alphabet" must be "base64" or "base64url"');
	}
	return alphabet;
}

function readLastChunkHandling(options: object): LastChunkHandling {
	const handling: unknown = Reflect.get(options, "lastChunkHandling");
	if (handling === undefined) return "loose";
	if (handling !== "loose" && handling !== "strict" && handling !== "stop-before-partial") {
		throw new TypeError(
			'Uint8Array base64 option "lastChunkHandling" must be "loose", "strict", or "stop-before-partial"',
		);
	}
	return handling;
}

function assertString(value: unknown, method: string): asserts value is string {
	if (typeof value !== "string") {
		throw new TypeError(`Uint8Array ${method} requires a string`);
	}
}

// Forgiving-base64 whitespace. It excludes the vertical tab that `\s` accepts.
function skipBase64Whitespace(string: string, start: number): number {
	let index = start;
	while (index < string.length) {
		const code = string.charCodeAt(index);
		if (code !== 9 && code !== 10 && code !== 12 && code !== 13 && code !== 32) break;
		index++;
	}
	return index;
}

// Each chunk becomes one flat string, so an encoding allocates few heap nodes.
function charsToString(storage: ArrayBuffer, count: number): string {
	return apply(fromCharCode, null, new Uint8Array(storage, 0, count) as unknown as number[]);
}

function encodeHex(bytes: Uint8Array, length: number): string {
	if (length <= HEX_CONCAT_MAX_BYTES) {
		let encoded = "";
		for (let index = 0; index < length; index++) {
			encoded += HEX_PAIRS[bytes[index] as number];
		}
		return encoded;
	}
	const storage = new ArrayBuffer(ENCODE_CHUNK_CHARS);
	const chars = new Uint8Array(storage);
	let encoded = "";
	let count = 0;
	for (let index = 0; index < length; index++) {
		if (count === ENCODE_CHUNK_CHARS) {
			encoded += charsToString(storage, count);
			count = 0;
		}
		const byte = bytes[index] as number;
		chars[count++] = HEX_CODES[byte >>> 4] as number;
		chars[count++] = HEX_CODES[byte & 15] as number;
	}
	return encoded + charsToString(storage, count);
}

function encodeBase64(bytes: Uint8Array, length: number, codes: Uint8Array, omitPadding: boolean): string {
	const fullChunksEnd = length - (length % 3);
	const paddedLength = ((length + 2 - ((length + 2) % 3)) / 3) * 4;
	const storage = new ArrayBuffer(paddedLength < ENCODE_CHUNK_CHARS ? paddedLength : ENCODE_CHUNK_CHARS);
	const chars = new Uint8Array(storage);
	let encoded = "";
	let count = 0;
	for (let index = 0; index < fullChunksEnd; index += 3) {
		if (count === ENCODE_CHUNK_CHARS) {
			encoded += charsToString(storage, count);
			count = 0;
		}
		const bits =
			((bytes[index] as number) << 16) | ((bytes[index + 1] as number) << 8) | (bytes[index + 2] as number);
		chars[count++] = codes[bits >>> 18] as number;
		chars[count++] = codes[(bits >>> 12) & 63] as number;
		chars[count++] = codes[(bits >>> 6) & 63] as number;
		chars[count++] = codes[bits & 63] as number;
	}
	const remainder = length - fullChunksEnd;
	if (remainder > 0) {
		if (count === ENCODE_CHUNK_CHARS) {
			encoded += charsToString(storage, count);
			count = 0;
		}
		const bits =
			remainder === 1
				? (bytes[fullChunksEnd] as number) << 16
				: ((bytes[fullChunksEnd] as number) << 16) | ((bytes[fullChunksEnd + 1] as number) << 8);
		chars[count++] = codes[bits >>> 18] as number;
		chars[count++] = codes[(bits >>> 12) & 63] as number;
		if (remainder === 2) chars[count++] = codes[(bits >>> 6) & 63] as number;
		if (!omitPadding) {
			if (remainder === 1) chars[count++] = EQUALS_CODE;
			chars[count++] = EQUALS_CODE;
		}
	}
	return encoded + charsToString(storage, count);
}

function invalidBase64(): SyntaxError {
	return new SyntaxError("Uint8Array received an invalid base64 string");
}

function writeFinalBase64Chunk(
	target: Uint8Array,
	written: number,
	bits: number,
	chunkLength: number,
	rejectExtraBits: boolean,
): number {
	const extraBits = chunkLength === 2 ? bits & 15 : bits & 3;
	if (rejectExtraBits && extraBits !== 0) throw invalidBase64();
	if (chunkLength === 2) {
		target[written] = bits >>> 4;
		return written + 1;
	}
	target[written] = bits >>> 10;
	target[written + 1] = (bits >>> 2) & 255;
	return written + 2;
}

// Follows the spec's FromBase64 steps, but writes each chunk directly to `target`. A SyntaxError
// therefore keeps the chunks before it, which `setFromBase64` requires. `bits` holds the values of
// the current chunk.
function decodeBase64Into(
	target: Uint8Array,
	string: string,
	alphabet: Base64Alphabet,
	lastChunkHandling: LastChunkHandling,
	maxLength: number,
): DecodeResult {
	if (maxLength === 0) return { read: 0, written: 0 };
	const values = alphabet === "base64url" ? BASE64URL_VALUES : BASE64_VALUES;
	const length = string.length;
	let read = 0;
	let written = 0;
	let bits = 0;
	let chunkLength = 0;
	let index = 0;

	for (;;) {
		index = skipBase64Whitespace(string, index);

		if (index === length) {
			if (chunkLength > 0) {
				if (lastChunkHandling === "stop-before-partial") return { read, written };
				if (lastChunkHandling === "strict" || chunkLength === 1) throw invalidBase64();
				written = writeFinalBase64Chunk(target, written, bits, chunkLength, false);
			}
			return { read: length, written };
		}

		const code = string.charCodeAt(index++);

		if (code === EQUALS_CODE) {
			if (chunkLength < 2) throw invalidBase64();
			index = skipBase64Whitespace(string, index);
			if (chunkLength === 2) {
				if (index === length) {
					if (lastChunkHandling === "stop-before-partial") return { read, written };
					throw invalidBase64();
				}
				if (string.charCodeAt(index) === EQUALS_CODE) {
					index = skipBase64Whitespace(string, index + 1);
				}
			}
			if (index < length) throw invalidBase64();
			written = writeFinalBase64Chunk(target, written, bits, chunkLength, lastChunkHandling === "strict");
			return { read: length, written };
		}

		const value = code < 128 ? (values[code] as number) : -1;
		if (value < 0) throw invalidBase64();
		const remaining = maxLength - written;
		if ((remaining === 1 && chunkLength === 2) || (remaining === 2 && chunkLength === 3)) {
			return { read, written };
		}
		bits = (bits << 6) | value;
		chunkLength++;

		if (chunkLength === 4) {
			target[written++] = bits >>> 16;
			target[written++] = (bits >>> 8) & 255;
			target[written++] = bits & 255;
			bits = 0;
			chunkLength = 0;
			read = index;
			if (written === maxLength) return { read, written };
		}
	}
}

function decodeHexDigit(string: string, index: number): number {
	const code = string.charCodeAt(index);
	const value = code < 128 ? (HEX_VALUES[code] as number) : -1;
	if (value < 0) {
		throw new SyntaxError("Uint8Array received a string with a non-hex character");
	}
	return value;
}

// As with base64, a SyntaxError keeps the bytes before it.
function decodeHexInto(target: Uint8Array, string: string, maxLength: number): DecodeResult {
	const length = string.length;
	if (length % 2 !== 0) {
		throw new SyntaxError("Uint8Array received a hex string with an odd length");
	}
	let read = 0;
	let written = 0;
	while (read < length && written < maxLength) {
		target[written++] = (decodeHexDigit(string, read) << 4) | decodeHexDigit(string, read + 1);
		read += 2;
	}
	return { read, written };
}

function defineMissingMethods(target: object, methods: object): void {
	for (const [name, value] of Object.entries(methods)) {
		const native = Reflect.get(target, name);
        if (typeof native === "function") {
            if (target !== Uint8Array.prototype || name !== "setFromBase64") continue;
            // Native V8 versions differ on consuming trailing whitespace after
            // the destination fills. Preserve workerd's consumed-character count.
            try {
                const result = apply(native, new Uint8Array(3), [" A Q I D "]) as DecodeResult;
                if (result.read === 8 && result.written === 3) continue;
            } catch {
                // An incompatible native method uses the same portable decoder.
            }
        }
		Reflect.defineProperty(target, name, { configurable: true, value, writable: true });
	}
}

export function installUint8ArrayEncoding(): void {
	// Methods are object-literal shorthand so they have no [[Construct]]. A default
	// parameter keeps a method's `length` as the spec requires.
	defineMissingMethods(Uint8Array.prototype, {
		toHex(this: unknown): string {
			assertUint8Array(this, "toHex");
			return encodeHex(this, readableLength(this));
		},
		toBase64(this: unknown, options: unknown = undefined): string {
			assertUint8Array(this, "toBase64");
			const opts = readOptions(options);
			const alphabet = readAlphabet(opts);
			const omitPadding = !!Reflect.get(opts, "omitPadding");
			// After the option reads: an option getter can detach the buffer.
			const length = readableLength(this);
			return encodeBase64(this, length, alphabet === "base64url" ? BASE64URL_CODES : BASE64_CODES, omitPadding);
		},
		setFromHex(this: unknown, string: unknown): DecodeResult {
			assertUint8Array(this, "setFromHex");
			assertString(string, "setFromHex");
			return decodeHexInto(this, string, readableLength(this));
		},
		setFromBase64(this: unknown, string: unknown, options: unknown = undefined): DecodeResult {
			assertUint8Array(this, "setFromBase64");
			assertString(string, "setFromBase64");
			const opts = readOptions(options);
			const alphabet = readAlphabet(opts);
			const lastChunkHandling = readLastChunkHandling(opts);
			// After the option reads: an option getter can detach the buffer.
			return decodeBase64Into(this, string, alphabet, lastChunkHandling, readableLength(this));
		},
	});

	defineMissingMethods(Uint8Array, {
		fromHex(string: unknown): Uint8Array {
			assertString(string, "fromHex");
			const output = new Uint8Array(string.length >>> 1);
			decodeHexInto(output, string, output.byteLength);
			return output;
		},
		fromBase64(string: unknown, options: unknown = undefined): Uint8Array {
			assertString(string, "fromBase64");
			const opts = readOptions(options);
			const alphabet = readAlphabet(opts);
			const lastChunkHandling = readLastChunkHandling(opts);
			// Whitespace and padding can leave this larger than the result.
			const capacity = ((string.length + 3) >>> 2) * 3;
			const storage = new ArrayBuffer(capacity);
			const { written } = decodeBase64Into(new Uint8Array(storage), string, alphabet, lastChunkHandling, capacity);
			if (written === capacity) return new Uint8Array(storage);
			const output = new Uint8Array(written);
			apply(typedArraySet, output, [new Uint8Array(storage, 0, written)]);
			return output;
		},
	});
}
