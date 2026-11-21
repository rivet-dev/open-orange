import {
	createHash,
	timingSafeEqual as nodeTimingSafeEqual,
} from "node:crypto";

import { WritableStream } from "./native.js";

const nodeWebCrypto = globalThis.crypto;

export interface DigestStreamOptions {
	toWellFormed?: boolean;
}

export interface SubtleCryptoHashAlgorithm {
	name: string;
}

function digestAlgorithm(
	algorithm: string | SubtleCryptoHashAlgorithm,
): string {
	const name = typeof algorithm === "string" ? algorithm : algorithm.name;
	switch (name.toUpperCase()) {
		case "SHA-1":
			return "sha1";
		case "SHA-256":
			return "sha256";
		case "SHA-384":
			return "sha384";
		case "SHA-512":
			return "sha512";
		default:
			throw new DOMException(`Unsupported digest algorithm: ${name}`, "NotSupportedError");
	}
}

function bytes(value: ArrayBuffer | ArrayBufferView): Uint8Array {
	return value instanceof ArrayBuffer
		? new Uint8Array(value)
		: new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
}

interface DigestState {
	bytesWritten: number;
}

export class DigestStream extends WritableStream<
	ArrayBuffer | ArrayBufferView
> {
	readonly #state: DigestState;
	readonly digest: Promise<ArrayBuffer>;

	constructor(
		algorithm: string | SubtleCryptoHashAlgorithm,
		_options?: DigestStreamOptions,
	) {
		const hash = createHash(digestAlgorithm(algorithm));
		const completion = Promise.withResolvers<ArrayBuffer>();
		const state: DigestState = { bytesWritten: 0 };
		super({
			abort(reason: unknown) {
				completion.reject(reason);
			},
			close() {
				completion.resolve(Uint8Array.from(hash.digest()).buffer);
			},
			write(chunk: ArrayBuffer | ArrayBufferView) {
				const view = bytes(chunk);
				state.bytesWritten += view.byteLength;
				hash.update(view);
			},
		});
		this.#state = state;
		this.digest = completion.promise;
	}

	get bytesWritten(): number | bigint {
		return this.#state.bytesWritten;
	}
}

function timingSafeEqual(
	left: ArrayBuffer | ArrayBufferView,
	right: ArrayBuffer | ArrayBufferView,
): boolean {
	return nodeTimingSafeEqual(bytes(left), bytes(right));
}

type CryptoArray =
	| Int8Array
	| Uint8Array
	| Int16Array
	| Uint16Array
	| Int32Array
	| Uint32Array
	| BigInt64Array
	| BigUint64Array;

export interface CryptoKeyValue {
	readonly type: string;
	readonly extractable: boolean;
	readonly algorithm: { name: string };
	readonly usages: string[];
}

export interface CryptoKeyPairValue {
	readonly publicKey: CryptoKeyValue;
	readonly privateKey: CryptoKeyValue;
}

export interface JsonWebKeyValue {
	kty: string;
}

export interface SubtleCryptoValue {
	encrypt(
		algorithm: unknown,
		key: unknown,
		plainText: ArrayBuffer | ArrayBufferView,
	): Promise<ArrayBuffer>;
	decrypt(
		algorithm: unknown,
		key: unknown,
		cipherText: ArrayBuffer | ArrayBufferView,
	): Promise<ArrayBuffer>;
	sign(
		algorithm: unknown,
		key: unknown,
		data: ArrayBuffer | ArrayBufferView,
	): Promise<ArrayBuffer>;
	verify(
		algorithm: unknown,
		key: unknown,
		signature: ArrayBuffer | ArrayBufferView,
		data: ArrayBuffer | ArrayBufferView,
	): Promise<boolean>;
	digest(
		algorithm: unknown,
		data: ArrayBuffer | ArrayBufferView,
	): Promise<ArrayBuffer>;
	generateKey(
		algorithm: unknown,
		extractable: boolean,
		keyUsages: string[],
	): Promise<CryptoKeyValue | CryptoKeyPairValue>;
	deriveKey(
		algorithm: unknown,
		baseKey: unknown,
		derivedKeyAlgorithm: unknown,
		extractable: boolean,
		keyUsages: string[],
	): Promise<CryptoKeyValue>;
	deriveBits(
		algorithm: unknown,
		baseKey: unknown,
		length?: number | null,
	): Promise<ArrayBuffer>;
	importKey(
		format: string,
		keyData: unknown,
		algorithm: unknown,
		extractable: boolean,
		keyUsages: string[],
	): Promise<CryptoKeyValue>;
	exportKey(
		format: string,
		key: unknown,
	): Promise<ArrayBuffer | JsonWebKeyValue>;
	wrapKey(
		format: string,
		key: unknown,
		wrappingKey: unknown,
		wrapAlgorithm: unknown,
	): Promise<ArrayBuffer>;
	unwrapKey(
		format: string,
		wrappedKey: ArrayBuffer | ArrayBufferView,
		unwrappingKey: unknown,
		unwrapAlgorithm: unknown,
		unwrappedKeyAlgorithm: unknown,
		extractable: boolean,
		keyUsages: string[],
	): Promise<CryptoKeyValue>;
	timingSafeEqual(
		left: ArrayBuffer | ArrayBufferView,
		right: ArrayBuffer | ArrayBufferView,
	): boolean;
}

function isSubtleCrypto(value: unknown): value is SubtleCryptoValue {
	if (typeof value !== "object" || value === null) return false;
	return [
		"decrypt",
		"deriveBits",
		"deriveKey",
		"digest",
		"encrypt",
		"exportKey",
		"generateKey",
		"importKey",
		"sign",
		"timingSafeEqual",
		"unwrapKey",
		"verify",
		"wrapKey",
	].every((method) => typeof Reflect.get(value, method) === "function");
}

const nodeSubtle = nodeWebCrypto.subtle;

// Reads Web IDL dictionary members at most once. Node.js reads them again,
// so value() hands it the source with every member read so far pinned to
// the value Orange saw, and getters with side effects run once.
class MemberSnapshot {
	readonly #source: unknown;
	readonly #values = new Map<string, unknown>();

	constructor(source: unknown) {
		this.#source = source;
	}

	get(member: string): unknown {
		if (typeof this.#source !== "object" || this.#source === null) {
			return undefined;
		}
		if (!this.#values.has(member)) {
			this.#values.set(member, Reflect.get(this.#source, member));
		}
		return this.#values.get(member);
	}

	// Reads each member in order, as workerd does when it converts the
	// algorithm to its JSG_STRUCT before it reads the data buffer.
	readAll(members: readonly string[]): this {
		for (const member of members) this.get(member);
		return this;
	}

	// Returns the upper-cased algorithm name of a string or dictionary.
	name(): string | undefined {
		const name =
			typeof this.#source === "string" ? this.#source : this.get("name");
		return typeof name === "string" ? name.toUpperCase() : undefined;
	}

	// A plain object whose members are all own properties. A subtle crypto
	// implementation that copies only own properties, such as the agentOS
	// guest's bridge to the host, would lose members left on a prototype.
	value(): unknown {
		if (
			typeof this.#source !== "object" ||
			this.#source === null ||
			this.#values.size === 0
		) {
			return this.#source;
		}
		for (const member of Object.keys(this.#source)) this.get(member);
		return Object.fromEntries(this.#values);
	}
}

// Members of workerd's algorithm JSG_STRUCTs, in declaration order.
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/crypto/crypto.h#L355-L450
const encryptAlgorithmMembers = [
	"name",
	"iv",
	"additionalData",
	"tagLength",
	"counter",
	"length",
	"label",
];
const signAlgorithmMembers = ["name", "hash", "dataLength", "saltLength"];
const generateKeyAlgorithmMembers = [
	"name",
	"hash",
	"modulusLength",
	"publicExponent",
	"length",
	"namedCurve",
];
const importKeyAlgorithmMembers = [
	"name",
	"hash",
	"length",
	"namedCurve",
	"compressed",
];

// workerd still accepts the NODE-ED25519 name that predates the standard
// Ed25519 algorithm, and reports it back on the generated keys.
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/crypto/ec.c++#L1138-L1175
const legacyEd25519 = "NODE-ED25519";

function legacyEd25519Algorithm(algorithm: MemberSnapshot): { name: string } {
	const namedCurve = algorithm.get("namedCurve");
	if (namedCurve !== legacyEd25519) {
		throw new DOMException(
			`EDDSA curve "${String(namedCurve)}" isn't supported.`,
			"NotSupportedError",
		);
	}
	return { name: "Ed25519" };
}

function markLegacyEd25519(key: unknown): void {
	Object.defineProperty(key, "algorithm", {
		configurable: true,
		enumerable: false,
		value: { name: legacyEd25519, namedCurve: legacyEd25519 },
	});
}

function signingAlgorithm(algorithm: unknown, key: unknown): unknown {
	const snapshot = new MemberSnapshot(algorithm).readAll(signAlgorithmMembers);
	const keyAlgorithm =
		typeof key === "object" && key !== null
			? new MemberSnapshot(Reflect.get(key, "algorithm")).name()
			: undefined;
	if (snapshot.name() === legacyEd25519 || keyAlgorithm === legacyEd25519) {
		return { name: "Ed25519" };
	}
	return snapshot.value();
}

const rsaAlgorithms = new Set(["RSASSA-PKCS1-V1_5", "RSA-PSS", "RSA-OAEP"]);

// workerd rejects RSA parameters that BoringSSL could loop on or that are unsafe.
// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/crypto/rsa.c++#L440-L476
function checkRsaGeneration(algorithm: MemberSnapshot): void {
	if (!rsaAlgorithms.has(algorithm.name() ?? "")) return;
	const modulusLength = algorithm.get("modulusLength");
	if (
		typeof modulusLength === "number" &&
		(modulusLength % 8 !== 0 || modulusLength < 256 || modulusLength > 16384)
	) {
		throw new DOMException(
			`The modulus length must be a multiple of 8 and between 256 and 16k, but ${modulusLength} was requested.`,
			"OperationError",
		);
	}
	const exponent = algorithm.get("publicExponent");
	if (!(exponent instanceof Uint8Array)) return;
	let value = 0n;
	for (const byte of exponent) value = (value << 8n) | BigInt(byte);
	if (value > 0xffff_ffffn) {
		throw new DOMException(
			'The "publicExponent" must be either 3 or 65537, but got a number larger than 2^32.',
			"OperationError",
		);
	}
	if (value !== 3n && value !== 65537n) {
		throw new DOMException(
			`The "publicExponent" must be either 3 or 65537, but got ${value}.`,
			"OperationError",
		);
	}
}

// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/crypto/rsa.c++#L912-L950
const rsaJwkAlgorithms = new Set([
	"RS1",
	"RS256",
	"RS384",
	"RS512",
	"PS1",
	"PS256",
	"PS384",
	"PS512",
	"RSA-OAEP",
	"RSA-OAEP-256",
	"RSA-OAEP-384",
	"RSA-OAEP-512",
]);
const rsaJwkMembers = ["n", "e", "d", "p", "q", "dp", "dq", "qi"];
const base64UrlPattern = /^[A-Za-z0-9_-]*={0,2}$/;

function checkRsaJwkImport(algorithm: MemberSnapshot, jwk: MemberSnapshot): void {
	if (!rsaAlgorithms.has(algorithm.name() ?? "") || jwk.get("kty") !== "RSA") {
		return;
	}
	const alg = jwk.get("alg");
	if (alg !== undefined && !rsaJwkAlgorithms.has(String(alg))) {
		throw new DOMException(
			`Unrecognized or unimplemented algorithm "${String(alg)}" listed in JSON Web Key Algorithm parameter.`,
			"NotSupportedError",
		);
	}
	for (const member of rsaJwkMembers) {
		const value = jwk.get(member);
		if (
			value !== undefined &&
			(typeof value !== "string" || !base64UrlPattern.test(value))
		) {
			throw new DOMException(
				`Invalid RSA key in JSON Web Key; invalid value for "${member}".`,
				"DataError",
			);
		}
	}
}

function checkAesGcmIv(algorithm: MemberSnapshot): void {
	if (algorithm.name() !== "AES-GCM") return;
	const iv = algorithm.get("iv");
	if (
		(ArrayBuffer.isView(iv) || iv instanceof ArrayBuffer) &&
		iv.byteLength === 0
	) {
		// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/crypto/aes.c++#L211
		throw new DOMException("AES-GCM IV must not be empty.", "OperationError");
	}
}

function byteLengthOf(data: unknown): number | undefined {
	if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
		return data.byteLength;
	}
	return undefined;
}

function keyAllows(key: unknown, algorithmName: string, usage: string): boolean {
	if (typeof key !== "object" || key === null) return false;
	const algorithm = new MemberSnapshot(Reflect.get(key, "algorithm"));
	const usages: unknown = Reflect.get(key, "usages");
	return (
		algorithm.name() === algorithmName &&
		Array.isArray(usages) &&
		usages.includes(usage)
	);
}

const aesGcmTagLengths = new Set([32, 64, 96, 104, 112, 120, 128]);

// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/crypto/aes.c++#L281-L295
function checkAesGcmCiphertext(
	algorithm: MemberSnapshot,
	key: unknown,
	usage: string,
	data: unknown,
): void {
	if (algorithm.name() !== "AES-GCM" || !keyAllows(key, "AES-GCM", usage)) {
		return;
	}
	const tagLength = algorithm.get("tagLength") ?? 128;
	const byteLength = byteLengthOf(data);
	if (
		typeof tagLength !== "number" ||
		!aesGcmTagLengths.has(tagLength) ||
		byteLength === undefined ||
		byteLength >= tagLength / 8
	) {
		return;
	}
	throw new DOMException(
		`Ciphertext length of ${byteLength * 8} bits must be greater than or equal to the size of the AES-GCM tag length of ${tagLength} bits.`,
		"OperationError",
	);
}

const aesUsages: Record<string, readonly string[]> = {
	"AES-CTR": ["encrypt", "decrypt", "wrapKey", "unwrapKey"],
	"AES-CBC": ["encrypt", "decrypt", "wrapKey", "unwrapKey"],
	"AES-GCM": ["encrypt", "decrypt", "wrapKey", "unwrapKey"],
	"AES-KW": ["wrapKey", "unwrapKey"],
};

// https://github.com/cloudflare/workerd/blob/b73ce3ae105c35bafaaad864095079524573a465/src/workerd/api/crypto/aes.c++#L786-L801
function checkAesRawKeyLength(
	format: unknown,
	keyData: unknown,
	algorithm: MemberSnapshot,
	usages: unknown,
): void {
	const allowed = aesUsages[algorithm.name() ?? ""];
	const byteLength = byteLengthOf(keyData);
	if (
		format !== "raw" ||
		allowed === undefined ||
		!Array.isArray(usages) ||
		!usages.every((usage) => allowed.includes(usage)) ||
		byteLength === undefined ||
		[16, 24, 32].includes(byteLength)
	) {
		return;
	}
	throw new DOMException(
		`Imported AES key length must be 128, 192, or 256 bits but provided ${byteLength * 8}.`,
		"DataError",
	);
}

type SubtleMethod = (...args: unknown[]) => Promise<unknown>;

function nodeMethod(name: string): SubtleMethod {
	const method: unknown = Reflect.get(nodeSubtle, name);
	if (typeof method !== "function") {
		throw new Error(`Node.js does not provide SubtleCrypto.${name}`);
	}
	return (...args) => Reflect.apply(method, nodeSubtle, args);
}

// The Worker's SubtleCrypto delegates to Node.js and adds workerd's
// extensions and argument checks.
const nodeSubtlePrototype: object = Object.getPrototypeOf(nodeSubtle);
const workerSubtle: Record<string, unknown> = Object.create(nodeSubtlePrototype);
for (const name of Object.getOwnPropertyNames(nodeSubtlePrototype)) {
	const descriptor = Object.getOwnPropertyDescriptor(nodeSubtlePrototype, name);
	if (name === "constructor" || typeof descriptor?.value !== "function") continue;
	workerSubtle[name] = nodeMethod(name);
}

const nodeDigest = nodeMethod("digest");
const nodeEncrypt = nodeMethod("encrypt");
const nodeDecrypt = nodeMethod("decrypt");
const nodeGenerateKey = nodeMethod("generateKey");
const nodeImportKey = nodeMethod("importKey");
const nodeSign = nodeMethod("sign");
const nodeVerify = nodeMethod("verify");
const nodeUnwrapKey = nodeMethod("unwrapKey");

Object.assign(workerSubtle, {
	// workerd also implements MD5 for compatibility with legacy protocols.
	async digest(algorithm: unknown, data: ArrayBuffer | ArrayBufferView) {
		const snapshot = new MemberSnapshot(algorithm);
		if (snapshot.name() === "MD5") {
			return Uint8Array.from(createHash("md5").update(bytes(data)).digest())
				.buffer;
		}
		return nodeDigest(snapshot.value(), data);
	},
	async encrypt(algorithm: unknown, key: unknown, data: unknown) {
		const snapshot = new MemberSnapshot(algorithm).readAll(
			encryptAlgorithmMembers,
		);
		checkAesGcmIv(snapshot);
		return nodeEncrypt(snapshot.value(), key, data);
	},
	async decrypt(algorithm: unknown, key: unknown, data: unknown) {
		const snapshot = new MemberSnapshot(algorithm).readAll(
			encryptAlgorithmMembers,
		);
		checkAesGcmIv(snapshot);
		checkAesGcmCiphertext(snapshot, key, "decrypt", data);
		return nodeDecrypt(snapshot.value(), key, data);
	},
	async generateKey(algorithm: unknown, extractable: unknown, usages: unknown) {
		const snapshot = new MemberSnapshot(algorithm).readAll(
			generateKeyAlgorithmMembers,
		);
		if (snapshot.name() === legacyEd25519) {
			const pair = await nodeGenerateKey(
				legacyEd25519Algorithm(snapshot),
				extractable,
				usages,
			);
			if (typeof pair !== "object" || pair === null) {
				throw new TypeError("Node.js generateKey did not return a CryptoKeyPair");
			}
			markLegacyEd25519(Reflect.get(pair, "publicKey"));
			markLegacyEd25519(Reflect.get(pair, "privateKey"));
			return pair;
		}
		checkRsaGeneration(snapshot);
		return nodeGenerateKey(snapshot.value(), extractable, usages);
	},
	async importKey(
		format: unknown,
		keyData: unknown,
		algorithm: unknown,
		extractable: unknown,
		usages: unknown,
	) {
		const snapshot = new MemberSnapshot(algorithm).readAll(
			importKeyAlgorithmMembers,
		);
		if (snapshot.name() === legacyEd25519) {
			const key = await nodeImportKey(
				format,
				keyData,
				legacyEd25519Algorithm(snapshot),
				extractable,
				usages,
			);
			markLegacyEd25519(key);
			return key;
		}
		checkAesRawKeyLength(format, keyData, snapshot, usages);
		let data = keyData;
		if (format === "jwk") {
			const jwk = new MemberSnapshot(keyData);
			checkRsaJwkImport(snapshot, jwk);
			data = jwk.value();
		}
		return nodeImportKey(format, data, snapshot.value(), extractable, usages);
	},
	async sign(algorithm: unknown, key: unknown, data: unknown) {
		return nodeSign(signingAlgorithm(algorithm, key), key, data);
	},
	async unwrapKey(
		format: unknown,
		wrappedKey: unknown,
		unwrappingKey: unknown,
		unwrapAlgorithm: unknown,
		unwrappedKeyAlgorithm: unknown,
		extractable: unknown,
		usages: unknown,
	) {
		const unwrap = new MemberSnapshot(unwrapAlgorithm).readAll(
			encryptAlgorithmMembers,
		);
		const unwrapped = new MemberSnapshot(unwrappedKeyAlgorithm).readAll(
			importKeyAlgorithmMembers,
		);
		checkAesGcmIv(unwrap);
		checkAesGcmCiphertext(unwrap, unwrappingKey, "unwrapKey", wrappedKey);
		return nodeUnwrapKey(
			format,
			wrappedKey,
			unwrappingKey,
			unwrap.value(),
			unwrapped.value(),
			extractable,
			usages,
		);
	},
	async verify(
		algorithm: unknown,
		key: unknown,
		signature: unknown,
		data: unknown,
	) {
		return nodeVerify(signingAlgorithm(algorithm, key), key, signature, data);
	},
	timingSafeEqual,
});

if (!isSubtleCrypto(workerSubtle)) {
	throw new Error("Node.js does not provide the required SubtleCrypto surface");
}
const subtle = workerSubtle;

export interface CryptoImplementation {
	readonly DigestStream: typeof DigestStream;
	readonly subtle: SubtleCryptoValue;
	getRandomValues<Buffer extends CryptoArray>(buffer: Buffer): Buffer;
	randomUUID(): string;
}

export const crypto: CryptoImplementation = {
	DigestStream,
	get subtle() {
		return subtle;
	},
	getRandomValues<Buffer extends CryptoArray>(buffer: Buffer): Buffer {
		// workerd's Crypto methods require their receiver, like other Web IDL methods.
		if (this !== crypto) throw new TypeError("Illegal invocation");
		nodeWebCrypto.getRandomValues(buffer);
		return buffer;
	},
	randomUUID(): string {
		return nodeWebCrypto.randomUUID();
	},
};
