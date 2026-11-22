import { once } from "node:events";
import { createServer, request, type IncomingHttpHeaders } from "node:http";
import { connect, type AddressInfo, type Socket } from "node:net";

/** One call that reached Rivet's gateway through the proxy, with every token it carried. */
export interface GatewayCall {
	actorId: string;
	/** Unix milliseconds. */
	at: number;
	kind: "http" | "websocket";
	tokens: string[];
}

export interface RecordingGatewayProxy {
	/** Calls to `/gateway/...`, in the order they arrived. */
	readonly calls: GatewayCall[];
	/** The Engine endpoint through the proxy, with the upstream's namespace and token. */
	readonly endpoint: string;
	/**
	 * How the proxy answers token issuance, as Rivet does: `unavailable` while its signing service is
	 * down, `disabled` when issuance is off. Undefined passes it through.
	 */
	failTokenIssuance: "disabled" | "unavailable" | undefined;
	/**
	 * Answers the next request that matches with a Rivet error in place of the Engine's answer. With
	 * `afterEngine`, the Engine still gets and runs the request first. Resolves once it answered.
	 */
	answerNextWith(rule: InjectedAnswer): Promise<void>;
	close(): Promise<void>;
}

export interface InjectedAnswer {
	afterEngine?: boolean;
	error: { code: string; group: string; message: string };
	method: string;
	path: RegExp;
	status: number;
}

// Rivet's answers when it does not issue a token. https://rivet.dev/docs/api/tokens/create
const issuanceFailures = {
	disabled: {
		body: JSON.stringify({ code: "issuance_disabled", group: "auth", message: "JWT issuance is not enabled for this deployment." }),
		status: 403,
	},
	unavailable: {
		body: JSON.stringify({
			code: "issuance_unavailable",
			group: "auth",
			message: "The server could not issue an authentication token because the signing service is temporarily unavailable. Retry the request.",
		}),
		status: 503,
	},
} as const;

// Every place Rivet's gateway reads a token from. https://rivet.dev/docs/api/authentication
function gatewayCall(kind: GatewayCall["kind"], path: string, headers: IncomingHttpHeaders): GatewayCall | undefined {
	const url = new URL(path, "http://proxy");
	const match = /^\/gateway\/([^/]+)/.exec(url.pathname);
	if (match === null) return undefined;
	const segment = decodeURIComponent(match[1]!);
	const at = segment.indexOf("@");
	const tokens: string[] = [];
	if (at >= 0) tokens.push(segment.slice(at + 1));
	const query = url.searchParams.get("rvt-token");
	if (query !== null) tokens.push(query);
	const header = headers["x-rivet-token"];
	if (typeof header === "string") tokens.push(header);
	const authorization = headers.authorization;
	if (authorization?.startsWith("Bearer ")) tokens.push(authorization.slice("Bearer ".length));
	for (const protocol of (headers["sec-websocket-protocol"] ?? "").split(",")) {
		const trimmed = protocol.trim();
		if (trimmed.startsWith("rivet_token.")) tokens.push(trimmed.slice("rivet_token.".length));
	}
	return { actorId: at >= 0 ? segment.slice(0, at) : segment, at: Date.now(), kind, tokens };
}

/** An HTTP and WebSocket proxy in front of a Rivet Engine that records the gateway calls through it. */
export async function startRecordingGatewayProxy(upstreamEndpoint: string): Promise<RecordingGatewayProxy> {
	const upstream = new URL(upstreamEndpoint);
	const calls: GatewayCall[] = [];
	const sockets = new Set<Socket>();
	const proxy: { failTokenIssuance: RecordingGatewayProxy["failTokenIssuance"] } = { failTokenIssuance: undefined };
	const injected: { rule: InjectedAnswer; answered: () => void }[] = [];
	const server = createServer((incoming, outgoing) => {
		const call = gatewayCall("http", incoming.url ?? "/", incoming.headers);
		if (call !== undefined) calls.push(call);
		const injection = injected.findIndex(
			({ rule }) => rule.method === incoming.method && rule.path.test(incoming.url ?? ""),
		);
		if (injection >= 0) {
			const [{ answered, rule }] = injected.splice(injection, 1) as [(typeof injected)[number]];
			const answer = (): void => {
				// The error goes in a JSON body only, as RivetKit's actor runtime answers it.
				outgoing.writeHead(rule.status, { "content-type": "application/json" }).end(JSON.stringify(rule.error));
				answered();
			};
			if (rule.afterEngine !== true) {
				incoming.resume();
				answer();
				return;
			}
			const forwarded = request(
				{ headers: incoming.headers, host: upstream.hostname, method: incoming.method, path: incoming.url, port: upstream.port },
				(response) => {
					response.resume();
					response.once("end", answer);
				},
			);
			forwarded.on("error", () => outgoing.destroy());
			incoming.pipe(forwarded);
			return;
		}
		const failure = proxy.failTokenIssuance === undefined ? undefined : issuanceFailures[proxy.failTokenIssuance];
		if (failure !== undefined && incoming.method === "POST" && incoming.url?.startsWith("/auth/tokens")) {
			incoming.resume();
			outgoing.writeHead(failure.status, { "content-type": "application/json" }).end(failure.body);
			return;
		}
		const forwarded = request(
			{
				headers: incoming.headers,
				host: upstream.hostname,
				method: incoming.method,
				path: incoming.url,
				port: upstream.port,
			},
			(response) => {
				outgoing.writeHead(response.statusCode ?? 502, response.headers);
				response.pipe(outgoing);
			},
		);
		forwarded.on("error", () => outgoing.destroy());
		incoming.pipe(forwarded);
	});
	server.on("connection", (socket) => {
		sockets.add(socket);
		socket.once("close", () => sockets.delete(socket));
	});
	server.on("upgrade", (incoming, client: Socket, head: Buffer) => {
		const call = gatewayCall("websocket", incoming.url ?? "/", incoming.headers);
		if (call !== undefined) calls.push(call);
		const server = connect(Number(upstream.port), upstream.hostname, () => {
			const lines = [`${incoming.method} ${incoming.url} HTTP/1.1`];
			for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
				lines.push(`${incoming.rawHeaders[index]}: ${incoming.rawHeaders[index + 1]}`);
			}
			server.write(`${lines.join("\r\n")}\r\n\r\n`);
			server.write(head);
			client.pipe(server).pipe(client);
		});
		sockets.add(server);
		server.once("close", () => sockets.delete(server));
		server.on("error", () => client.destroy());
		client.on("error", () => server.destroy());
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const { port } = server.address() as AddressInfo;
	const endpoint = new URL(upstreamEndpoint);
	endpoint.host = `127.0.0.1:${port}`;
	return {
		calls,
		endpoint: endpoint.href.replace(/\/$/, ""),
		get failTokenIssuance() {
			return proxy.failTokenIssuance;
		},
		set failTokenIssuance(value: RecordingGatewayProxy["failTokenIssuance"]) {
			proxy.failTokenIssuance = value;
		},
		answerNextWith: (rule) =>
			new Promise<void>((answered) => {
				injected.push({ answered, rule });
			}),
		close: async () => {
			for (const socket of sockets) socket.destroy();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}
