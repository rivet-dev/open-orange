// The Cap'n Web 0.12 exports Orange uses. Cap'n Web's own declarations need the
// DOM lib, so this file describes only the parts Orange calls.
export interface CapnWebRpcTransport {
	abort?(reason: unknown): void;
	receive(): Promise<string>;
	send(message: string): void | Promise<void>;
}

// A stub is a proxy: every string property is a remote method.
export interface CapnWebStub {
	[method: string]: (...args: unknown[]) => Promise<unknown>;
	[Symbol.dispose](): void;
}

declare const capnweb: {
	newHttpBatchRpcResponse(request: Request, localMain: object): Promise<Response>;
	newHttpBatchRpcSession(urlOrRequest: string | Request): CapnWebStub;
	newWebSocketRpcSession(webSocket: object, localMain?: object): CapnWebStub;
	RpcSession: new (
		transport: CapnWebRpcTransport,
		localMain?: object,
	) => { getRemoteMain(): CapnWebStub; getStats(): { exports: number; imports: number } };
	RpcStub: abstract new (...args: never[]) => object;
	RpcTarget: abstract new () => object;
};
export default capnweb;
