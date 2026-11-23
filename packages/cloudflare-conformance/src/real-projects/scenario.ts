import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";

/**
 * What a step proves. `do-*` kinds, `websocket`, `alarm`, and `sleep`/`restart` exercise a Durable Object.
 * `worker-loader` exercises a dynamic Worker that a `worker_loaders` binding starts.
 */
export const stepKinds = [
	"http",
	"do-state",
	"websocket",
	"alarm",
	"sleep",
	"restart",
	"binding",
	"worker-loader",
] as const;
export type StepKind = (typeof stepKinds)[number];

export type StepStatus = "pass" | "fail" | "needs-secrets";

export interface StepResult {
	name: string;
	kind: StepKind;
	status: StepStatus;
	seconds: number;
	/** The exact error of a failed step. */
	error?: string;
	/** Credentials a `needs-secrets` step would need. */
	secrets?: string[];
}

export interface TestSocket {
	send(data: string | Uint8Array): void;
	/** The next message, as text. Throws after `timeoutMs` or when the socket closes first. */
	next(timeoutMs?: number): Promise<string>;
	/** The next message, as bytes. */
	nextBytes(timeoutMs?: number): Promise<Uint8Array>;
	/** The next message that `match` accepts. Skips the others. */
	until(match: (text: string) => boolean, timeoutMs?: number): Promise<string>;
	close(): Promise<void>;
	readonly closed: boolean;
}

export interface ScenarioContext {
	/** Current origin. It changes after `restart()`. */
	readonly origin: string;
	/** The project's Worker directory. */
	readonly directory: string;
	/** Runs one recorded step. A throw records the failure, and the scenario goes on. */
	step(name: string, kind: StepKind, body: () => Promise<void>): Promise<void>;
	/** Records a flow that this run cannot exercise without a real credential. */
	needsSecrets(name: string, kind: StepKind, secrets: readonly string[]): void;
	/** `fetch` against the current origin, with a 30 s limit. */
	fetch(path: string, init?: RequestInit): Promise<Response>;
	/** Fetches and returns the parsed body. Throws on an unexpected status, with the body. */
	json<T = any>(path: string, init?: RequestInit, status?: number): Promise<T>;
	/** Fetches and returns the text. Throws on an unexpected status, with the body. */
	text(path: string, init?: RequestInit, status?: number): Promise<string>;
	webSocket(path: string, options?: { headers?: Record<string, string>; protocols?: string[] }): Promise<TestSocket>;
	/**
	 * Waits until every actor that ran is asleep, as RivetKit's log reports. Throws when one is still
	 * awake after `timeoutMs`. The default is 45 s.
	 */
	waitForSleep(timeoutMs?: number): Promise<void>;
	/** Stops `orange dev` and its Rivet Engine and starts both again on the same local data. */
	restart(): Promise<void>;
	/** Kills `orange dev` and its Rivet Engine with SIGKILL, as a crash would, and starts both again. */
	crash(): Promise<void>;
	delay(milliseconds: number): Promise<void>;
	/** Everything `orange dev` printed since the last start. */
	output(): string;
	/** Ids of the actors that started since the last start, from RivetKit's log. */
	actorIds(): string[];
}

export type Scenario = (context: ScenarioContext) => Promise<void>;

function messageBytes(value: unknown): Uint8Array {
	if (typeof value === "string") return new TextEncoder().encode(value);
	if (value instanceof ArrayBuffer) return new Uint8Array(value);
	if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
	if (Array.isArray(value)) return Buffer.concat(value as Uint8Array[]);
	throw new TypeError("WebSocket returned an invalid message");
}

/** `ws` lets a client set upgrade headers, which the global WebSocket cannot. */
export async function openTestSocket(
	url: string,
	options: { headers?: Record<string, string>; protocols?: string[] } = {},
): Promise<TestSocket> {
	const WebSocketClient = createRequire(import.meta.url)("ws") as new (
		url: string,
		protocols: string[] | undefined,
		options: { headers?: Record<string, string> },
	) => {
		binaryType: string;
		readyState: number;
		close(code?: number, reason?: string): void;
		on(type: string, listener: (...parameters: any[]) => void): void;
		send(data: string | Uint8Array): void;
	};
	const socket = new WebSocketClient(url.replace(/^http/, "ws"), options.protocols, {
		...(options.headers === undefined ? {} : { headers: options.headers }),
	});
	socket.binaryType = "arraybuffer";
	const messages: Uint8Array[] = [];
	let failure: Error | undefined;
	let wake: (() => void) | undefined;
	const notify = () => {
		wake?.();
		wake = undefined;
	};
	await new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`WebSocket open timed out: ${url}`)), 20_000);
		socket.on("open", () => {
			clearTimeout(timer);
			resolve();
		});
		socket.on("unexpected-response", (_request: unknown, response: { statusCode: number }) => {
			clearTimeout(timer);
			reject(new Error(`WebSocket upgrade got HTTP ${response.statusCode}: ${url}`));
		});
		socket.on("error", (error: Error) => {
			clearTimeout(timer);
			failure = error;
			reject(error);
			notify();
		});
		socket.on("message", (data: unknown) => {
			messages.push(messageBytes(data));
			notify();
		});
		socket.on("close", (code: number, reason: Buffer) => {
			failure ??= new Error(`WebSocket closed (${code} ${reason.toString()})`);
			notify();
		});
	});
	const nextBytes = async (timeoutMs = 20_000): Promise<Uint8Array> => {
		const deadline = Date.now() + timeoutMs;
		while (messages.length === 0) {
			if (failure !== undefined) throw failure;
			const remaining = deadline - Date.now();
			if (remaining <= 0) throw new Error(`No WebSocket message within ${timeoutMs}ms`);
			await new Promise<void>((resolve) => {
				const timer = setTimeout(resolve, remaining);
				wake = () => {
					clearTimeout(timer);
					resolve();
				};
			});
		}
		return messages.shift()!;
	};
	const next = async (timeoutMs?: number) => new TextDecoder().decode(await nextBytes(timeoutMs));
	return {
		send: (data) => socket.send(data),
		next,
		nextBytes,
		async until(match, timeoutMs = 20_000) {
			const deadline = Date.now() + timeoutMs;
			for (;;) {
				const text = await next(Math.max(1, deadline - Date.now()));
				if (match(text)) return text;
			}
		},
		async close() {
			if (socket.readyState === 3) return;
			socket.close(1000, "scenario done");
			const deadline = Date.now() + 5_000;
			while (socket.readyState !== 3 && Date.now() < deadline) await delay(25);
		},
		get closed() {
			return socket.readyState === 3;
		},
	};
}
