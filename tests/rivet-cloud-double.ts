import { createHash, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

// A hand-written Rivet Cloud API for `orange deploy` tests. It implements the cluster
// endpoints that deploy calls, with the request and response shapes of
// https://cloud-api.rivet.dev/v2/openapi.json, and a signed-URL upload that checks the
// size and Content-MD5 as cloud storage does.

export interface CloudFailure {
	code: string;
	fault: "platform" | "user";
	message: string;
}

export interface CloudPool {
	build_id: string | null;
	cidr_allowlist: string[];
	machine_type: string | null;
	node_count: number;
}

export interface RivetCloudDoubleOptions {
	cluster: string;
	// Builds that exist before the deploy, by ID, with their status.
	builds?: Record<string, "failed" | "ready">;
	// What a completed build becomes after one `preparing` read. Default `ready`.
	buildOutcome?: "ready" | CloudFailure;
	// Pools that exist before the deploy, keyed `<region>/<pool>`.
	pools?: Record<string, CloudPool>;
	// What a rolled-out pool becomes after one `updating` read. Default `ready`.
	poolOutcome?: "ready" | { fault: "platform" | "user"; message: string; state: "degraded" | "down" };
	regions: string[];
	token: string;
	// `token` is a cluster token, which Rivet Cloud lets update a pool but not create one.
	tokenIsClusterToken?: boolean;
	// Cloud storage refuses the upload with this S3-style error.
	// `html` answers as the storage front end does, with a page instead of the XML error.
	uploadRejection?: { code: string; message: string; status: number } | { html: string; status: number };
}

export interface ReceivedUpload {
	bytes: number;
	// The bytes match the build's declared content_length and content_md5.
	matchesBuild: boolean;
	// The bytes are a `docker image save` tarball.
	isImageTarball: boolean;
}

export interface RivetCloudDouble {
	readonly url: string;
	readonly pools: Map<string, CloudPool>;
	// `<METHOD> <path>` of every API call, in order. Uploads are listed as `PUT /upload`.
	readonly requests: string[];
	readonly uploads: ReceivedUpload[];
	// Bodies of PUT runner-pool calls.
	readonly poolUpdates: Record<string, unknown>[];
	// `x-rivet-organization` of each API call that sent one.
	readonly organizations: string[];
	// The device sign-in session that the API currently accepts.
	readonly session: { accessToken: string | undefined; refreshToken: string | undefined };
	// Starts a session without the browser, as if `rivet login` had run before.
	issueSession(): { accessToken: string; refreshToken: string };
	// Holds the next API call to a path until `release()`, as a slow network does.
	holdNext(path: string): { reached: Promise<void>; release(): void };
	close(): Promise<void>;
}

interface BuildRecord {
	contentLength: number;
	contentMd5: string;
	failure: CloudFailure | null;
	id: string;
	image: string;
	reads: number;
	status: string;
	uploaded: boolean;
}

interface PoolState {
	reads: number;
	rolling: boolean;
}

export async function startRivetCloudDouble(options: RivetCloudDoubleOptions): Promise<RivetCloudDouble> {
	const builds = new Map<string, BuildRecord>();
	for (const [id, status] of Object.entries(options.builds ?? {})) {
		builds.set(id, {
			contentLength: 1,
			contentMd5: "",
			failure: status === "failed" ? { code: "image_invalid", fault: "user", message: "not an image" } : null,
			id,
			image: "existing:1",
			reads: 0,
			status,
			uploaded: true,
		});
	}
	const pools = new Map<string, CloudPool>(Object.entries(options.pools ?? {}));
	const poolStates = new Map<string, PoolState>();
	const requests: string[] = [];
	const uploads: ReceivedUpload[] = [];
	const poolUpdates: Record<string, unknown>[] = [];
	const organizations: string[] = [];
	const session: RivetCloudDouble["session"] = { accessToken: undefined, refreshToken: undefined };
	let tokenPolls = 0;
	const holds = new Map<string, { reached(): void; released: Promise<void> }>();
	let origin = "";
	const issueSession = (): { accessToken: string; refreshToken: string } => {
		const tokens = { accessToken: `access-${randomUUID()}`, refreshToken: `refresh-${randomUUID()}` };
		Object.assign(session, tokens);
		return tokens;
	};
	const tokenResponse = (): Record<string, unknown> => {
		const { accessToken, refreshToken } = issueSession();
		return {
			access_token: accessToken,
			expires_in: 3600,
			refresh_token: refreshToken,
			user: { email: "ada@example.com", id: "user_1", name: "Ada" },
		};
	};

	const send = (response: ServerResponse, status: number, body: unknown): void => {
		response.writeHead(status, { "content-type": "application/json" });
		response.end(JSON.stringify(body));
	};
	const error = (response: ServerResponse, status: number, tag: string, message: string): void =>
		send(response, status, { _tag: tag, message, ...(tag === "BadRequest" ? { errors: [] } : {}) });

	const buildView = (build: BuildRecord): Record<string, unknown> => ({
		build_id: build.id,
		cluster: options.cluster,
		completed_at: null,
		content_length: build.contentLength,
		content_md5: build.contentMd5,
		created_at: new Date(0).toISOString(),
		failure: build.failure,
		image: build.image,
		status: build.status,
		upload_expires_at: new Date(Date.now() + 3_600_000).toISOString(),
	});
	const regionPublicUrl = (region: string): string => `https://${region}.${options.cluster}.rivet.test`;
	// A rolled-out pool reads as `updating` once, then as its outcome.
	const poolView = (key: string, pool: CloudPool, read: boolean): Record<string, unknown> => {
		const [region = "", name = ""] = key.split("/");
		const state = poolStates.get(key);
		const desired = pool.node_count;
		let status: Record<string, unknown> = {
			action_needed: false,
			fault: null,
			message: null,
			replicas: { desired, ready: desired, updated: desired },
			state: "ready",
			state_since: 0,
			waiting_on: null,
		};
		if (state?.rolling === true) {
			if (read) state.reads += 1;
			const outcome = options.poolOutcome ?? "ready";
			if (state.reads <= 1) {
				status = { ...status, replicas: { desired, ready: desired, updated: 0 }, state: "updating", waiting_on: "runners" };
			} else if (outcome !== "ready") {
				status = { ...status, action_needed: true, fault: outcome.fault, message: outcome.message, replicas: { desired, ready: 0, updated: 0 }, state: outcome.state };
			} else {
				state.rolling = false;
			}
		}
		return {
			...pool,
			cluster: options.cluster,
			endpoints: { public: `https://${name}.${regionPublicUrl(region).slice("https://".length)}` },
			pool: name,
			region,
			status,
		};
	};

	const handleUpload = async (request: IncomingMessage, response: ServerResponse, buildId: string): Promise<void> => {
		const build = builds.get(buildId);
		const hash = createHash("md5");
		let bytes = 0;
		let tail = "";
		let isImageTarball = false;
		// Streams the body, as a large image would not fit in memory.
		for await (const chunk of request) {
			const buffer = chunk as Buffer;
			hash.update(buffer);
			bytes += buffer.length;
			const text = tail + buffer.toString("latin1");
			if (text.includes("manifest.json")) isImageTarball = true;
			tail = text.slice(-32);
		}
		const md5 = hash.digest("base64");
		const declaredLength = Number(request.headers["content-length"]);
		const matchesBuild =
			build !== undefined &&
			bytes === build.contentLength &&
			declaredLength === build.contentLength &&
			md5 === build.contentMd5 &&
			request.headers["content-md5"] === build.contentMd5;
		uploads.push({ bytes, isImageTarball, matchesBuild });
		const rejection =
			options.uploadRejection ??
			(matchesBuild ? undefined : { code: "BadDigest", message: "The Content-MD5 you specified did not match what we received.", status: 400 });
		if (rejection !== undefined) {
			if ("html" in rejection) {
				response.writeHead(rejection.status, { "content-type": "text/html; charset=UTF-8" });
				response.end(rejection.html);
				return;
			}
			response.writeHead(rejection.status, { "content-type": "application/xml" });
			response.end(`<?xml version="1.0" encoding="UTF-8"?><Error><Code>${rejection.code}</Code><Message>${rejection.message}</Message></Error>`);
			return;
		}
		if (build !== undefined) build.uploaded = true;
		response.writeHead(200).end();
	};

	const readJson = async (request: IncomingMessage): Promise<Record<string, unknown>> => {
		let text = "";
		for await (const chunk of request) text += (chunk as Buffer).toString("utf8");
		const value: unknown = JSON.parse(text);
		return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
	};

	const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
		const url = new URL(request.url ?? "/", origin);
		const method = request.method ?? "GET";
		const upload = /^\/upload\/([^/]+)$/.exec(url.pathname);
		if (upload !== null && method === "PUT") {
			requests.push("PUT /upload");
			await handleUpload(request, response, decodeURIComponent(upload[1] ?? ""));
			return;
		}
		requests.push(`${method} ${url.pathname}`);
		// The device sign-in endpoints that `rivet login` uses. The first poll is still pending.
		if (method === "POST" && url.pathname === "/api/auth/device/code") {
			send(response, 200, {
				device_code: "device-code",
				expires_in: 60,
				interval: 1,
				user_code: "ABCD1234",
				verification_uri: `${origin}/device`,
			});
			return;
		}
		if (method === "POST" && url.pathname === "/api/auth/device/token") {
			tokenPolls += 1;
			if (tokenPolls === 1) send(response, 400, { error: "authorization_pending" });
			else send(response, 200, tokenResponse());
			return;
		}
		if (method === "POST" && url.pathname === "/api/auth/device/refresh") {
			const { refresh_token: refreshToken } = await readJson(request);
			if (session.refreshToken === undefined || refreshToken !== session.refreshToken) {
				send(response, 401, { error: "invalid_grant" });
			} else {
				send(response, 200, tokenResponse());
			}
			return;
		}
		if (method === "POST" && url.pathname === "/api/auth/device/logout") {
			session.accessToken = undefined;
			session.refreshToken = undefined;
			send(response, 200, {});
			return;
		}
		const hold = holds.get(url.pathname);
		if (hold !== undefined) {
			holds.delete(url.pathname);
			hold.reached();
			await hold.released;
		}
		const bearer = request.headers.authorization;
		if (bearer !== `Bearer ${options.token}` && (session.accessToken === undefined || bearer !== `Bearer ${session.accessToken}`)) {
			error(response, 401, "Unauthorized", "The bearer token is invalid or expired.");
			return;
		}
		const organization = request.headers["x-rivet-organization"];
		if (typeof organization === "string") organizations.push(organization);
		const prefix = `/v2/clusters/${options.cluster}`;
		if (!url.pathname.startsWith(`${prefix}/`)) {
			error(response, 404, "NotFound", "Cluster not found.");
			return;
		}
		const path = url.pathname.slice(prefix.length);
		if (method === "GET" && path === "/regions") {
			send(response, 200, {
				items: options.regions.map((region) => ({
					cidr_allowlist: [],
					cloud: "gcp",
					cluster: options.cluster,
					endpoints: { private: null, public: regionPublicUrl(region) },
					machine_type: "e2-small",
					node_count: 1,
					region,
					status: { action_needed: false, fault: null, message: null, replicas: null, state: "ready", state_since: 0, waiting_on: null },
				})),
			});
			return;
		}
		if (method === "POST" && path === "/builds") {
			const body = await readJson(request);
			const { content_length: contentLength, content_md5: contentMd5, image } = body;
			if (typeof image !== "string" || typeof contentLength !== "number" || typeof contentMd5 !== "string" || contentLength > 5 * 1024 ** 3) {
				error(response, 400, "BadRequest", "Invalid build.");
				return;
			}
			const id = `bld_${randomUUID().slice(0, 8)}`;
			builds.set(id, { contentLength, contentMd5, failure: null, id, image, reads: 0, status: "uploading", uploaded: false });
			send(response, 201, {
				build_id: id,
				expires_at: new Date(Date.now() + 3_600_000).toISOString(),
				upload_url: `${origin}/upload/${id}?signature=test`,
			});
			return;
		}
		const complete = /^\/builds\/([^/]+)\/complete$/.exec(path);
		if (method === "POST" && complete !== null) {
			const build = builds.get(decodeURIComponent(complete[1] ?? ""));
			if (build === undefined) {
				error(response, 404, "NotFound", "Build not found.");
				return;
			}
			build.status = "completing";
			send(response, 202, buildView(build));
			return;
		}
		const buildPath = /^\/builds\/([^/]+)$/.exec(path);
		if (method === "GET" && buildPath !== null) {
			const build = builds.get(decodeURIComponent(buildPath[1] ?? ""));
			if (build === undefined) {
				error(response, 404, "NotFound", "Build not found.");
				return;
			}
			if (build.status === "completing" || build.status === "preparing") {
				build.reads += 1;
				const outcome = options.buildOutcome ?? "ready";
				if (build.reads === 1) build.status = "preparing";
				else if (!build.uploaded) {
					build.status = "failed";
					build.failure = { code: "upload_missing", fault: "user", message: "No upload was received." };
				} else if (outcome === "ready") build.status = "ready";
				else {
					build.status = "failed";
					build.failure = outcome;
				}
			}
			send(response, 200, buildView(build));
			return;
		}
		const poolPath = /^\/regions\/([^/]+)\/runner-pools\/([^/]+)$/.exec(path);
		if (poolPath !== null) {
			const region = decodeURIComponent(poolPath[1] ?? "");
			const key = `${region}/${decodeURIComponent(poolPath[2] ?? "")}`;
			if (!options.regions.includes(region)) {
				error(response, 404, "NotFound", "Region not found.");
				return;
			}
			if (method === "GET") {
				const pool = pools.get(key);
				if (pool === undefined) error(response, 404, "NotFound", "Runner pool not found.");
				else send(response, 200, poolView(key, pool, true));
				return;
			}
			if (method === "PUT") {
				const body = await readJson(request);
				poolUpdates.push(body);
				const build = typeof body.build_id === "string" ? builds.get(body.build_id) : undefined;
				if (build?.status !== "ready" || !Array.isArray(body.cidr_allowlist)) {
					send(response, 400, { _tag: "BadRequest", errors: [{ field: "build_id", message: "must name a ready build" }], message: "Invalid runner pool." });
					return;
				}
				const existing = pools.get(key);
				if (existing === undefined && options.tokenIsClusterToken === true) {
					error(response, 403, "Forbidden", `Cluster tokens cannot create runner pool '${key.split("/")[1]}'. Create it from the dashboard first.`);
					return;
				}
				const pool: CloudPool = {
					build_id: build.id,
					cidr_allowlist: body.cidr_allowlist as string[],
					machine_type: (body.machine_type as string | undefined) ?? existing?.machine_type ?? "e2-small",
					node_count: (body.node_count as number | undefined) ?? existing?.node_count ?? 1,
				};
				pools.set(key, pool);
				poolStates.set(key, { reads: 0, rolling: true });
				send(response, 200, poolView(key, pool, false));
				return;
			}
		}
		error(response, 404, "NotFound", `No route for ${method} ${url.pathname}.`);
	};

	const server = createServer((request, response) => {
		handle(request, response).catch((cause: unknown) => {
			if (!response.headersSent) error(response, 500, "InternalServerError", String(cause));
		});
	});
	await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("the Rivet Cloud double has no port");
	origin = `http://127.0.0.1:${address.port}`;
	return {
		close: () =>
			new Promise<void>((resolveClose) => {
				server.closeAllConnections();
				server.close(() => resolveClose());
			}),
		holdNext(path) {
			const reached = Promise.withResolvers<void>();
			const released = Promise.withResolvers<void>();
			holds.set(path, { reached: reached.resolve, released: released.promise });
			return { reached: reached.promise, release: released.resolve };
		},
		issueSession,
		organizations,
		poolUpdates,
		pools,
		requests,
		session,
		uploads,
		url: origin,
	};
}
