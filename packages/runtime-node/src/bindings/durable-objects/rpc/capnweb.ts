import { errorMessage } from "../../unknown-values.js";
import capnweb, { type CapnWebRpcTransport, type CapnWebStub } from "./capnweb-module.js";

export type { CapnWebRpcTransport, CapnWebStub };

const {
	newHttpBatchRpcResponse,
	newHttpBatchRpcSession,
	newWebSocketRpcSession,
	RpcSession,
	RpcStub,
	RpcTarget,
} = capnweb;

let activeHttpBatchSessions = 0;

export type CapnWebHttpBatchSender = (
	body: string,
) => readonly string[] | Promise<readonly string[]>;

class InjectedHttpBatchTransport {
	#aborted: unknown;
	readonly #batchToReceive: Promise<readonly string[]>;
	readonly #batchToSend: string[] = [];
	#receiveIndex = 0;

	constructor(sendBatch: CapnWebHttpBatchSender) {
		this.#batchToReceive = new Promise<void>((resolve) =>
			setImmediate(resolve),
		).then(async () => {
			if (this.#aborted !== undefined) throw this.#aborted;
			return await sendBatch(this.#batchToSend.join("\n"));
		});
	}

	abort(reason: unknown): void {
		this.#aborted = reason;
	}

	async receive(): Promise<string> {
		const batch = await this.#batchToReceive;
		const message = batch[this.#receiveIndex];
		this.#receiveIndex += 1;
		if (message === undefined) throw new Error("Batch RPC request ended");
		return message;
	}

	send(message: string): void {
		this.#batchToSend.push(message);
	}
}

export function inheritCapnWebRpcTarget(constructor: Function): void {
	Object.setPrototypeOf(constructor.prototype, RpcTarget.prototype);
}

export function isCapnWebRpcStub(value: object): boolean {
	return value instanceof RpcStub;
}

export function isCapnWebRpcTarget(value: object): boolean {
	return value instanceof RpcTarget;
}

export function getCapnWebRpcStubConstructor(): Function {
	return RpcStub;
}

export async function invokeCapnWebHttpBatchResponse(
	request: Request,
	target: object,
): Promise<Response> {
	return await newHttpBatchRpcResponse(request, target);
}

export function invokeCapnWebWebSocketSession(
	webSocket: object,
	target: object,
): CapnWebStub {
	return newWebSocketRpcSession(webSocket, target);
}

export function openCapnWebHttpBatchSession(url: string): CapnWebStub {
	return newHttpBatchRpcSession(url);
}

// Sends Cap'n Web's "abort" message, so the peer fails every pending and
// later call on the session with `error`.
// https://github.com/cloudflare/capnweb/blob/7702075d4122e6808512ee50acc591310b77da7a/protocol.md
export function sendCapnWebAbort(
	webSocket: { send(data: string): void },
	error: unknown,
): void {
	const name =
		error instanceof Error && typeof error.name === "string" ? error.name : "Error";
	const message = errorMessage(error);
	webSocket.send(JSON.stringify(["abort", ["error", name, message]]));
}

export function openCapnWebWebSocketClientSession(webSocket: object): CapnWebStub {
	return newWebSocketRpcSession(webSocket);
}

export async function invokeCapnWebHttpBatchMethod(
	endpoint: Request,
	methodName: string,
	args: readonly unknown[],
): Promise<unknown> {
	const session = newHttpBatchRpcSession(endpoint);
	activeHttpBatchSessions += 1;
	try {
		return await session[methodName](...args);
	} finally {
		try {
			session[Symbol.dispose]();
		} finally {
			activeHttpBatchSessions -= 1;
		}
	}
}

export async function invokeCapnWebInjectedHttpBatchMethod(
	sendBatch: CapnWebHttpBatchSender,
	methodName: string,
	args: readonly unknown[],
): Promise<unknown> {
	const session = openCapnWebRpcSession(new InjectedHttpBatchTransport(sendBatch));
	activeHttpBatchSessions += 1;
	try {
		return await session[methodName](...args);
	} finally {
		try {
			session[Symbol.dispose]();
		} finally {
			activeHttpBatchSessions -= 1;
		}
	}
}

// Opens a Cap'n Web session over a caller-provided text transport and returns
// the peer's main stub. `localMain` is what the peer's main stub calls.
export function openCapnWebRpcSession(
	transport: CapnWebRpcTransport,
	localMain?: object,
): CapnWebStub {
	return new RpcSession(transport, localMain).getRemoteMain();
}

// Like `openCapnWebRpcSession`, plus the session's live import and export counts. A call in
// flight, a held result stub, and a stream being read each hold an import.
export function openCapnWebRpcSessionWithStats(
	transport: CapnWebRpcTransport,
	localMain?: object,
): { main: CapnWebStub; stats(): { exports: number; imports: number } } {
	const session = new RpcSession(transport, localMain);
	return { main: session.getRemoteMain(), stats: () => session.getStats() };
}

export function getActiveCapnWebHttpBatchSessionCount(): number {
	return activeHttpBatchSessions;
}
