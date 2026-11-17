// `ctx.container` for Durable Object classes listed under wrangler
// `containers`. On Cloudflare it controls a Container built from the class's
// image. On Orange it controls one sandbox per Durable Object instance on the
// ORANGE_SANDBOX_PROVIDER backend, so it can run only Cloudflare Sandbox
// images. API shape: https://developers.cloudflare.com/durable-objects/api/container/
import { runtimeSettings } from "../../internal/runtime-settings.js";
import {
	type SandboxBackend,
	SandboxConfigurationError,
	type SandboxProvider,
	sandboxProviderFromEnvironment,
	sandboxProviderNamed,
} from "./providers.js";

export interface ContainerImage {
	reference: string;
	sandbox: boolean;
}

interface ContainerClass {
	className: string;
	container?: { images: Record<string, ContainerImage> };
}

interface ContainerStorage {
	get<T>(key: string): Promise<T | undefined>;
	put(key: string, value: unknown): Promise<void>;
	delete(key: string): Promise<boolean>;
}

interface ContainerRecord {
	id: string;
	provider: string;
}

const containerRecordKey = "__orange_container";
const containerClasses = new Map<string, Record<string, ContainerImage>>();

/** Lets `Files` reach the sandbox behind an Orange container. */
// A registered symbol, because `@cloudflare/sandbox` loads as a separate bundle.
export const containerBackend = Symbol.for("open-orange.container-backend");

export function configureContainerClasses(classes: readonly ContainerClass[]): void {
	containerClasses.clear();
	for (const configuredClass of classes) {
		if (configuredClass.container !== undefined) {
			containerClasses.set(configuredClass.className, configuredClass.container.images);
		}
	}
}

/** Returns the container of a Durable Object, or undefined when its class has none. */
// Storage is read only for listed classes, so other classes get undefined
// even before storage exists.
export function containerForDurableObject(className: string, owner: string, storage: () => ContainerStorage): object | undefined {
	const images = containerClasses.get(className);
	return images === undefined ? undefined : new SandboxContainer(owner, storage(), images);
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

function unsupported(method: string): never {
	throw new Error(`Container.${method}() is not supported by Orange yet`);
}

interface StartOptions {
	image?: string;
	env?: Record<string, string>;
	entrypoint?: string[];
}

interface ExecOptions {
	cwd?: string;
	env?: Record<string, string>;
	signal?: AbortSignal;
	pty?: unknown;
	stdin?: unknown;
	stdout?: "pipe" | "ignore";
	stderr?: "pipe" | "ignore" | "combined";
}

class SandboxContainer {
	readonly images: Readonly<Record<string, string>>;
	readonly #owner: string;
	readonly #storage: ContainerStorage;
	readonly #imageByReference = new Map<string, ContainerImage>();
	#provider: SandboxProvider | undefined;
	#backend: Promise<SandboxBackend> | undefined;
	#env: Record<string, string> = {};
	#nextPid = 1;
	readonly #processes = new Set<AbortController>();
	#stopped: (() => void) | undefined;
	#monitor: Promise<void> | undefined;

	constructor(owner: string, storage: ContainerStorage, images: Record<string, ContainerImage>) {
		this.#owner = owner;
		this.#storage = storage;
		this.images = Object.freeze(Object.fromEntries(Object.entries(images).map(([name, image]) => [name, image.reference])));
		for (const image of Object.values(images)) this.#imageByReference.set(image.reference, image);
	}

	get running(): boolean {
		return this.#backend !== undefined;
	}

	start(options: StartOptions = {}): void {
		if (this.#backend !== undefined) throw new Error("The container is already running");
		this.#provider ??= sandboxProviderFromEnvironment(runtimeSettings());
		const reference = options.image ?? Object.values(this.images)[0];
		const image = reference === undefined ? undefined : this.#imageByReference.get(reference);
		if (image === undefined || !image.sandbox) {
			throw new SandboxConfigurationError(
				`Container image ${JSON.stringify(reference)} cannot run on the ${this.#provider.name} sandbox provider. Orange runs Container classes on ORANGE_SANDBOX_PROVIDER, which runs only Cloudflare Sandbox images: a Dockerfile or image that names cloudflare/sandbox.`,
			);
		}
		if (options.entrypoint !== undefined && options.entrypoint.length > 0) {
			throw new SandboxConfigurationError(
				`Container.start({ entrypoint }) is not supported on the ${this.#provider.name} sandbox provider. Start the command with exec() instead.`,
			);
		}
		this.#env = { ...options.env };
		const backend = this.#connect(this.#provider);
		// A failed start surfaces in exec() and monitor(), as on Cloudflare.
		backend.catch(() => {
			if (this.#backend === backend) this.#backend = undefined;
		});
		this.#backend = backend;
		this.#monitor = new Promise((resolve) => (this.#stopped = resolve));
	}

	async #connect(provider: SandboxProvider): Promise<SandboxBackend> {
		const record = await this.#storage.get<ContainerRecord>(containerRecordKey);
		if (record !== undefined && record.provider === provider.name) {
			const backend = await provider.connect(this.#owner, record.id);
			if (backend !== undefined) return backend;
		}
		const id = await provider.create(this.#owner);
		await this.#storage.put(containerRecordKey, { id, provider: provider.name } satisfies ContainerRecord);
		const backend = await provider.connect(this.#owner, id);
		if (backend === undefined) throw new Error(`The ${provider.name} sandbox provider created sandbox ${id} but cannot connect to it`);
		return backend;
	}

	async [containerBackend](): Promise<SandboxBackend> {
		if (this.#backend === undefined) throw new Error("The container is not running. Call ctx.container.start() first.");
		return this.#backend;
	}

	async exec(argv: string[], options: ExecOptions = {}) {
		if (!Array.isArray(argv) || argv.length === 0) throw new TypeError("Container.exec() needs a non-empty argv array");
		if (options.pty !== undefined && options.pty !== false) unsupported("exec({ pty })");
		if (options.stdin !== undefined) unsupported("exec({ stdin })");
		const backend = await this[containerBackend]();
		const abort = new AbortController();
		options.signal?.addEventListener("abort", () => abort.abort(), { once: true });
		this.#processes.add(abort);
		const encoder = new TextEncoder();
		const combined = options.stderr === "combined";
		let stdoutController: ReadableStreamDefaultController<Uint8Array> | undefined;
		let stderrController: ReadableStreamDefaultController<Uint8Array> | undefined;
		const stdout =
			options.stdout === "ignore" ? null : new ReadableStream<Uint8Array>({ start: (controller) => void (stdoutController = controller) });
		const stderr =
			options.stderr === "ignore" || combined
				? null
				: new ReadableStream<Uint8Array>({ start: (controller) => void (stderrController = controller) });
		const result = backend
			.exec(argv.map(shellQuote).join(" "), {
				cwd: options.cwd ?? backend.cwd,
				env: { ...this.#env, ...options.env },
				onStderr: (chunk) => (combined ? stdoutController : stderrController)?.enqueue(encoder.encode(chunk)),
				onStdout: (chunk) => stdoutController?.enqueue(encoder.encode(chunk)),
				signal: abort.signal,
			})
			.finally(() => {
				this.#processes.delete(abort);
				stdoutController?.close();
				stderrController?.close();
			});
		const exitCode = result.then((output) => output.exitCode);
		exitCode.catch(() => {});
		return {
			exitCode,
			isPty: false,
			kill: (_signal?: number) => abort.abort(),
			async output() {
				const output = await result;
				// SAFETY: TextEncoder.encode always returns a view over a fresh, non-shared ArrayBuffer, but @types/node types its buffer as ArrayBufferLike.
				const bytes = (text: string) => encoder.encode(text).buffer as ArrayBuffer;
				return {
					exitCode: output.exitCode,
					stderr: bytes(combined ? "" : output.stderr),
					stdout: bytes(combined ? output.stdout + output.stderr : output.stdout),
				};
			},
			pid: this.#nextPid++,
			resize: () => unsupported("ExecProcess.resize"),
			stderr,
			stdin: null,
			stdout,
		};
	}

	monitor(): Promise<void> {
		if (this.#monitor === undefined) return Promise.reject(new Error("The container is not running"));
		return this.#monitor;
	}

	async destroy(_error?: unknown): Promise<void> {
		for (const process of this.#processes) process.abort();
		this.#processes.clear();
		const record = await this.#storage.get<ContainerRecord>(containerRecordKey);
		this.#backend = undefined;
		if (record !== undefined) {
			// The sandbox belongs to the provider that created it, even after
			// ORANGE_SANDBOX_PROVIDER changed.
			await sandboxProviderNamed(record.provider).destroy(this.#owner, record.id);
			await this.#storage.delete(containerRecordKey);
		}
		this.#stopped?.();
		this.#monitor = undefined;
	}

	signal(_signo: number): void {
		for (const process of this.#processes) process.abort();
	}

	// Orange keeps the sandbox until destroy() or until `orange dev` exits.
	async setInactivityTimeout(_durationMs: number | bigint): Promise<void> {}

	getTcpPort(port: number) {
		return {
			fetch: async (input: Request | string | URL, init?: RequestInit): Promise<Response> => {
				const backend = await this[containerBackend]();
				const request = new Request(input, init);
				const url = new URL(request.url);
				if (backend.previewOrigin !== undefined) {
					return fetch(new URL(url.pathname + url.search, backend.previewOrigin(port)), request);
				}
				if (backend.previewFetch !== undefined) return backend.previewFetch(port, request);
				return unsupported("getTcpPort");
			},
		};
	}

	interceptOutboundHttp(): never {
		return unsupported("interceptOutboundHttp");
	}

	interceptAllOutboundHttp(): never {
		return unsupported("interceptAllOutboundHttp");
	}

	interceptOutboundHttps(): never {
		return unsupported("interceptOutboundHttps");
	}

	snapshotContainer(): never {
		return unsupported("snapshotContainer");
	}

	inspect(): never {
		return unsupported("inspect");
	}
}
