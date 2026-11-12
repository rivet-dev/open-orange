import { createReadStream } from "node:fs";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { z } from "zod";

import { ExpectedFailure } from "../cli/issue-report.js";

// A client for the cluster endpoints of the Rivet Cloud API that `orange deploy` calls.
// https://cloud-api.rivet.dev/v2/openapi.json

export interface RivetCloudOptions {
	apiUrl: string;
	cluster: string;
	// The organization a login token acts in, because a login token names only the user.
	organization?: string;
	token(force?: boolean): Promise<string>;
}

const failureSchema = z.object({
	code: z.string(),
	fault: z.string(),
	message: z.string(),
});

const buildSchema = z.object({
	build_id: z.string(),
	failure: failureSchema.nullable(),
	status: z.string(),
});
export type RivetBuild = z.infer<typeof buildSchema>;

const createdBuildSchema = z.object({
	build_id: z.string(),
	upload_url: z.string(),
});

const regionsSchema = z.object({
	items: z.array(z.object({ endpoints: z.object({ public: z.string() }), region: z.string() })),
});
export type RivetRegion = z.infer<typeof regionsSchema>["items"][number];

const envValueSchema = z.union([
	z.object({ string: z.string() }),
	// `pinned_version` is null while the pool takes the latest version, and set after a rollback.
	z.object({ secret: z.object({ name: z.string(), pinned_version: z.number().nullable().optional() }) }),
]);
export type RunnerEnvValue = z.infer<typeof envValueSchema>;

const poolSchema = z.object({
	build_id: z.string().nullable(),
	cidr_allowlist: z.array(z.string()),
	env: z.record(z.string(), envValueSchema).optional(),
	endpoints: z.object({ public: z.string().nullable() }),
	status: z.object({
		fault: z.string().nullable(),
		message: z.string().nullable(),
		replicas: z.object({ desired: z.number(), ready: z.number(), updated: z.number() }).nullable(),
		state: z.string(),
	}),
});
export type RivetPool = z.infer<typeof poolSchema>;

export interface PoolUpdate {
	build_id: string;
	cidr_allowlist: readonly string[];
	// Replaces the pool's variables when sent, and keeps them when left out.
	env?: Record<string, RunnerEnvValue>;
	machine_type?: string;
	node_count?: number;
}

const secretsSchema = z.object({ items: z.array(z.object({ name: z.string() })) });
const rolloutSchema = z.object({ changed: z.boolean(), latest_version: z.number(), name: z.string() });

const apiErrorSchema = z.object({
	errors: z.array(z.object({ field: z.string().optional(), message: z.string() })).optional(),
	message: z.string(),
});

const requestTimeoutMs = 60_000;

export interface RivetCloudClient {
	completeBuild(buildId: string): Promise<void>;
	createBuild(body: { content_length: number; content_md5: string; image: string }): Promise<{ build_id: string; upload_url: string }>;
	getBuild(buildId: string): Promise<RivetBuild>;
	// Undefined when the pool does not exist yet.
	getPool(region: string, pool: string): Promise<RivetPool | undefined>;
	listRegions(): Promise<RivetRegion[]>;
	// Names only. The Cloud API never returns a secret's value.
	listSecrets(): Promise<string[]>;
	putPool(region: string, pool: string, body: PoolUpdate): Promise<RivetPool>;
	// Stores the value as the secret's next version, creating it, and rolls every pool that names it.
	// The latest value again changes nothing.
	rolloutSecret(name: string, value: string): Promise<{ changed: boolean; latest_version: number }>;
}

export function createRivetCloudClient(options: RivetCloudOptions): RivetCloudClient {
	const cluster = encodeURIComponent(options.cluster);
	const call = async <T>(
		action: string,
		method: "GET" | "POST" | "PUT",
		path: string,
		schema: z.ZodType<T>,
		{
			body,
			forbiddenHint,
			missingIsUndefined = false,
		}: { body?: unknown; forbiddenHint?: string; missingIsUndefined?: boolean } = {},
	): Promise<{ value: T | undefined }> => {
		const url = new URL(`/v2/clusters/${cluster}${path}`, options.apiUrl);
		const send = async (token: string): Promise<Response> =>
			await fetch(url, {
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
				headers: {
					authorization: `Bearer ${token}`,
					...(body === undefined ? {} : { "content-type": "application/json" }),
					...(options.organization === undefined ? {} : { "x-rivet-organization": options.organization }),
				},
				method,
				signal: AbortSignal.timeout(requestTimeoutMs),
			});
		// A network failure is the machine's or Rivet Cloud's, not a bug in Orange.
		const reach = async (token: string): Promise<Response> => {
			try {
				return await send(token);
			} catch (error: unknown) {
				throw new ExpectedFailure(`Failed to ${action}. Couldn't reach Rivet Cloud at ${url.origin}: ${causeOf(error)}`);
			}
		};
		// A token error, such as an expired session, already says what failed and what to do.
		let token = await options.token();
		let response = await reach(token);
		// A login token can expire between the check and the call, so retry once with a new one.
		if (response.status === 401) {
			const refreshed = await options.token(true);
			if (refreshed !== token) {
				token = refreshed;
				response = await reach(refreshed);
			}
		}
		const text = await response.text();
		if (response.status === 404 && missingIsUndefined) return { value: undefined };
		if (!response.ok) {
			throw apiError(action, options.cluster, response.status, text, token, forbiddenHint);
		}
		if (text.length === 0) return { value: undefined };
		let json: unknown;
		try {
			json = JSON.parse(text);
		} catch {
			throw new Error(`Failed to ${action}. Rivet Cloud returned a response that is not JSON: ${text.slice(0, 200)}`);
		}
		const parsed = schema.safeParse(json);
		if (!parsed.success) {
			throw new Error(`Failed to ${action}. Rivet Cloud returned an unexpected response: ${z.prettifyError(parsed.error)}`);
		}
		return { value: parsed.data };
	};
	const required = <T>(result: { value: T | undefined }, action: string): T => {
		if (result.value === undefined) throw new Error(`Failed to ${action}. Rivet Cloud returned an empty response.`);
		return result.value;
	};
	const poolPath = (region: string, pool: string): string =>
		`/regions/${encodeURIComponent(region)}/runner-pools/${encodeURIComponent(pool)}`;
	return {
		async completeBuild(buildId) {
			await call(`complete build ${buildId}`, "POST", `/builds/${encodeURIComponent(buildId)}/complete`, z.unknown());
		},
		async createBuild(body) {
			const action = `register a build on cluster ${options.cluster}`;
			return required(await call(action, "POST", "/builds", createdBuildSchema, { body }), action);
		},
		async getBuild(buildId) {
			const action = `read build ${buildId}`;
			return required(await call(action, "GET", `/builds/${encodeURIComponent(buildId)}`, buildSchema), action);
		},
		async getPool(region, pool) {
			const action = `read pool ${pool} in region ${region}`;
			return (await call(action, "GET", poolPath(region, pool), poolSchema, { missingIsUndefined: true })).value;
		},
		async listRegions() {
			const action = `list the regions of cluster ${options.cluster}`;
			return required(await call(action, "GET", "/regions", regionsSchema), action).items;
		},
		async listSecrets() {
			const action = `list the secrets of cluster ${options.cluster}`;
			return required(await call(action, "GET", "/secrets", secretsSchema), action).items.map((item) => item.name);
		},
		async rolloutSecret(name, value) {
			const action = `roll out secret ${name}`;
			return required(await call(action, "POST", "/secrets/rollout", rolloutSchema, { body: { name, value } }), action);
		},
		async putPool(region, pool, body) {
			const action = `roll out pool ${pool} in region ${region}`;
			// A cluster token can update a pool but not create one, and a login token can do both.
			const forbiddenHint = `Create pool ${pool} in the dashboard at https://dashboard.rivet.dev, or deploy once after \`orange login\`.`;
			return required(await call(action, "PUT", poolPath(region, pool), poolSchema, { body, forbiddenHint }), action);
		},
	};
}

function sentence(text: string): string {
	return /[.!?]$/.test(text) ? text : `${text}.`;
}

// Rivet Cloud errors are `{ _tag, message, errors? }`. The token is never part of the message.
// A rejected token, a missing permission, or a plan limit is for the user to fix, not a bug in Orange.
// `forbiddenHint` replaces the 403 advice for a call that runs after the token already reached the cluster.
function apiError(action: string, cluster: string, status: number, text: string, token: string, forbiddenHint?: string): Error {
	let parsed: z.infer<typeof apiErrorSchema> | undefined;
	try {
		const result = apiErrorSchema.safeParse(JSON.parse(text));
		parsed = result.success ? result.data : undefined;
	} catch {
		parsed = undefined;
	}
	const reason = parsed?.message ?? (text.trim().slice(0, 200) || `HTTP ${status}`);
	if (status === 401 && token.startsWith("admin_")) {
		return new ExpectedFailure(`Couldn't ${action}. This is a cluster admin token (admin_...), which is for the Rivet Engine, not the Rivet Cloud API. Run \`orange login\`, or pass a Rivet Cloud token with --token or RIVET_CLOUD_TOKEN.`);
	}
	if (status === 404 && /^cluster\b.*\bnot found/i.test(reason)) {
		return new ExpectedFailure(`Couldn't ${action}. ${sentence(reason)} If the cluster exists, this token may belong to another organization. Check --token, RIVET_CLOUD_TOKEN, and the token saved in ~/.rivet/credentials, or run \`orange login\`.`);
	}
	if (status === 401) {
		return new ExpectedFailure(`Couldn't ${action}. Rivet Cloud rejected the token: ${reason}\nPass a valid Rivet Cloud token with --token or RIVET_CLOUD_TOKEN. Or run \`orange login\`.`);
	}
	if (status === 403 && forbiddenHint !== undefined) {
		return new ExpectedFailure(`Couldn't ${action}. ${sentence(reason)}\n${forbiddenHint}`);
	}
	if (status === 403) {
		return new ExpectedFailure(`Couldn't ${action}. The token has no access to cluster ${cluster}: ${reason}\nUse a token from the organization that owns the cluster.`);
	}
	if (status === 402) {
		return new ExpectedFailure(`Couldn't ${action}. The organization's plan or payment method does not cover it: ${reason}\nAdd a payment method or change the plan at https://dashboard.rivet.dev.`);
	}
	const fields = (parsed?.errors ?? []).map(
		(error) => `\n  ${error.field === undefined ? "" : `${error.field}: `}${error.message}`,
	);
	return new Error(`Failed to ${action} (HTTP ${status}): ${reason}${fields.join("")}`);
}

// Sends the file in one PUT with exactly `size` bytes and its Content-MD5, as the
// upload URL requires. The file streams from disk, so a large image is never in memory.
// `fetch` would send a streamed body chunked, without a Content-Length.
export function uploadFile(uploadUrl: string, path: string, size: number, md5: string): Promise<void> {
	const url = new URL(uploadUrl);
	const send = url.protocol === "https:" ? httpsRequest : httpRequest;
	return new Promise((resolveUpload, rejectUpload) => {
		const fail = (error: unknown): void =>
			rejectUpload(new Error(`Failed to upload the image: ${causeOf(error)}`));
		const request = send(
			url,
			{ headers: { "content-length": size, "content-md5": md5 }, method: "PUT" },
			(response: IncomingMessage) => {
				let body = "";
				response.setEncoding("utf8");
				response.on("data", (chunk: string) => {
					if (body.length < 4096) body += chunk;
				});
				response.on("error", fail);
				response.on("end", () => {
					const status = response.statusCode ?? 0;
					if (status >= 200 && status < 300) {
						resolveUpload();
						return;
					}
					rejectUpload(new Error(`Failed to upload the image. ${describeStorageError(status, body)}`));
				});
			},
		);
		request.on("error", fail);
		// A stalled upload fails instead of waiting forever.
		request.setTimeout(5 * 60_000, () => request.destroy(new Error("the upload stalled for 5 minutes")));
		const file = createReadStream(path);
		file.on("error", (error) => request.destroy(error));
		file.pipe(request);
	});
}

// S3 and GCS signed URLs answer with `<Error><Code>…</Code><Message>…</Message></Error>`. Their front
// end answers some failures, such as a timed-out upload, with an HTML page, which is never printed.
function describeStorageError(status: number, body: string): string {
	const code = /<Code>([^<]*)<\/Code>/.exec(body)?.[1];
	const message = /<Message>([^<]*)<\/Message>/.exec(body)?.[1];
	if (code !== undefined || message !== undefined) {
		return `Storage answered HTTP ${status} ${code ?? ""}: ${message ?? "no message"}`.replace(" :", ":");
	}
	if (status === 408) return "Storage stopped receiving it and timed the upload out (HTTP 408). Check the connection, then deploy again.";
	const text = body.trim();
	return `Storage answered HTTP ${status}${text.length > 0 && !text.startsWith("<") ? `: ${text.slice(0, 200)}` : ""}`;
}

function causeOf(error: unknown): string {
	if (!(error instanceof Error)) return String(error);
	const cause: unknown = error.cause;
	return cause instanceof Error ? `${error.message} (${cause.message})` : error.message;
}
