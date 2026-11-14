import { relative } from "node:path";

import { type Color, padVisible, type Theme } from "../cli/theme.js";
import type {
	ResolvedWranglerConfiguration,
	SupportedBindingConfiguration,
} from "../config/load-wrangler.js";
import {
	unsupportedBindingAlternative,
	unsupportedBindingLabel,
} from "../../packages/runtime-node/src/bindings/unsupported.js";
import { aiBaseUrlVariable, openRouterApiKeyVariable } from "../../packages/runtime-node/src/bindings/ai/backend.js";
import type { RuntimeRequestMessage } from "../../packages/runtime-node/src/process-protocol.js";
import { orangeVersion } from "../version.js";

const labelWidth = 14;

// One aligned row: a two-character gutter, a muted label, and a value.
function row(theme: Theme, gutter: string, label: string, value: string): string {
	return `${padVisible(gutter, 2)}${padVisible(theme.fg("subtle", label), labelWidth)}${value}`;
}

// The open-orange name in Rivet orange, its version, and the Rivet byline.
export function renderBrand(theme: Theme): string {
	return `🍊 ${theme.bold(theme.fg("orange", "open-orange"))} ${theme.fg("subtle", `v${orangeVersion}`)}  ${theme.fg("border", "·")}  ${theme.fg("subtle", "by")} ${theme.bold(theme.fg("white", "rivet.dev"))}`;
}

// How Orange backs a binding: `local` runs in this process or on a Rivet Actor,
// `pluggable` runs locally or on a backend set through environment variables,
// and `stub` loads but has no backend, so its calls throw or its writes are dropped.
export type BindingStatus = "local" | "pluggable" | "stub";

// Whether a binding moves from Cloudflare to Rivet: `runs_as_is` needs nothing,
// `needs_service` needs a service that the user supplies, and `not_supported`
// has no backend, so its calls throw or its data is dropped.
export type BindingSupport = "needs_service" | "not_supported" | "runs_as_is";

// Each binding's `docs` is this URL and a path such as `docs/modules/kv.mdx`.
export const docsRootUrl = "https://github.com/rivet-dev/open-orange/blob/main/";
export const moduleDocsUrl = `${docsRootUrl}docs/modules/`;

export interface BindingDescription {
	// The configured name, such as `CACHE` for `env.CACHE`.
	binding: string;
	// The Wrangler binding type, such as `kv_namespace`.
	type: string;
	resource: string;
	runsOn: string;
	status: BindingStatus;
	support: BindingSupport;
	// The documentation page of the binding.
	docs: string;
	// The one thing to set. Set only for bindings that need a service.
	setup?: string;
	// What to use instead. Set only for some bindings that are not supported.
	alternative?: string;
	// The variable that points the binding at its service, such as `ORANGE_EMAIL_SMTP_URL`.
	setting?: string;
	// The other Worker that serves the binding. It works only when the same `orange dev`
	// session runs that Worker.
	worker?: string;
	// The R2 bucket name. Set only for R2 buckets.
	bucketName?: string;
	className?: string;
}

function describeBinding(binding: SupportedBindingConfiguration): BindingDescription {
	const local = (resource: string, runsOn: string, page: string): BindingDescription => ({
		binding: binding.binding,
		docs: `${docsRootUrl}docs/modules/${page}`,
		resource,
		runsOn,
		status: "local",
		support: "runs_as_is",
		type: binding.type,
	});
	const needsService = (
		resource: string,
		runsOn: string,
		page: string,
		setup: string | undefined,
		status: BindingStatus = "pluggable",
	): BindingDescription => ({ ...local(resource, runsOn, page), ...(setup === undefined ? {} : { setup }), status, support: "needs_service" });
	switch (binding.type) {
		case "ai":
			return needsService(
				"Workers AI",
				"OpenAI-compatible API",
				"workers-ai.mdx",
				`Set ${openRouterApiKeyVariable}, or ${aiBaseUrlVariable} for another provider.`,
			);
		// writeDataPoint() works, as in `wrangler dev`, but no store keeps the data.
		case "analytics_engine":
			return {
				...local("Analytics Engine", "drops writes", "bindings.mdx"),
				alternative: "Send data points to your own analytics store with fetch().",
				status: "stub",
				support: "not_supported",
			};
		case "assets":
			return local("Assets", "local files", "assets.mdx");
		case "browser":
			return {
				...needsService(
					"Browser Rendering",
					"Chrome DevTools",
					"browser-rendering.mdx",
					"Set ORANGE_BROWSER_CDP_URL to a Chrome DevTools Protocol endpoint, such as Browserbase or Browserless.",
				),
				setting: "ORANGE_BROWSER_CDP_URL",
			};
		case "d1":
			return local("D1 Database", "Rivet Actor", "d1.mdx");
		case "dispatch_namespace":
			return local("Dispatch Namespace", `session Workers · ${binding.namespace}`, "multi-worker.mdx");
		case "durable_object_namespace":
			return {
				...local("Durable Object", `Rivet Actor · ${binding.scriptName} · ${binding.className}`, "multi-worker.mdx"),
				className: binding.className,
				worker: binding.scriptName,
			};
		case "hyperdrive":
			return needsService(
				"Hyperdrive",
				"Direct connection",
				"hyperdrive.mdx",
				// The config does not load without a connection string, so there is nothing left to set.
				undefined,
				"local",
			);
		case "json":
			return local("JSON Variable", "local", "bindings.mdx");
		case "kv_namespace":
			return local("KV Namespace", "Rivet Actor", "kv.mdx");
		case "plain_text":
			return local("Variable", "local", "bindings.mdx");
		case "queue":
			return local("Queue", `Rivet Actor · ${binding.queueName}`, "queues.mdx");
		case "r2_bucket":
			return {
				...local("R2 Bucket", `Rivet Actor · ${binding.bucketName}`, "r2.mdx"),
				bucketName: binding.bucketName,
				status: "pluggable",
			};
		case "ratelimit":
			return local("Rate Limiter", "Rivet Actor", "rate-limiting.mdx");
		case "secrets_store_secret":
			return local("Secrets Store", "local", "secrets-store.mdx");
		case "send_email":
			return {
				...needsService("Send Email", "SMTP", "email.mdx", "Set ORANGE_EMAIL_SMTP_URL to your SMTP server, such as Amazon SES, Resend, or Postmark."),
				setting: "ORANGE_EMAIL_SMTP_URL",
			};
		case "service":
			return {
				...local(
					"Service",
					`${binding.service ?? "this Worker"}${binding.entrypoint === undefined ? "" : ` · ${binding.entrypoint}`}`,
					binding.service === undefined ? "bindings.mdx" : "multi-worker.mdx",
				),
				...(binding.service === undefined ? {} : { worker: binding.service }),
			};
		case "unsafe_eval":
			return local("Unsafe Eval", "local", "bindings.mdx");
		case "unsupported":
			return {
				alternative: unsupportedBindingAlternative(binding.bindingType),
				binding: binding.binding,
				docs: `${docsRootUrl}docs/modules/bindings.mdx`,
				resource: unsupportedBindingLabel(binding.bindingType),
				runsOn: "stub · calls throw",
				status: "stub",
				support: "not_supported",
				type: binding.bindingType,
			};
		case "version_metadata":
			return local("Version Metadata", "local", "version-metadata.mdx");
		case "worker_loader":
			return local("Worker Loader", "local", "worker-loader.mdx");
		case "workflow":
			return binding.scriptName === undefined
				? local("Workflow", `Rivet Actor · ${binding.className}`, "workflows.mdx")
				: {
						...local("Workflow", `Rivet Actor · ${binding.scriptName} · ${binding.className}`, "multi-worker.mdx"),
						worker: binding.scriptName,
					};
	}
}

// Every binding of the Worker, Durable Objects first, in the order the header lists them.
export function describeBindings(config: ResolvedWranglerConfiguration): BindingDescription[] {
	return [
		...(config.durableObjects?.bindings ?? []).map(
			(binding): BindingDescription => ({
				binding: binding.binding,
				className: binding.className,
				docs: `${docsRootUrl}docs/modules/durable-objects.mdx`,
				resource: "Durable Object",
				runsOn: `Rivet Actor · ${binding.className}`,
				status: "local",
				support: "runs_as_is",
				type: "durable_object_namespace",
			}),
		),
		...config.bindings.map(describeBinding),
	];
}

export function renderBindingTable(theme: Theme, config: ResolvedWranglerConfiguration): string[] {
	// The header has no hint rows, so it names the variable that points the binding at its service.
	const rows = describeBindings(config).map((entry) => ({
		...entry,
		name: `env.${entry.binding}`,
		runsOn: entry.setting === undefined ? entry.runsOn : `${entry.runsOn} · ${entry.setting}`,
	}));
	if (rows.length === 0) return [];
	const nameWidth = Math.max("Binding".length, ...rows.map((entry) => entry.name.length)) + 3;
	const resourceWidth =
		Math.max("Resource".length, ...rows.map((entry) => entry.resource.length)) + 3;
	const line = (gutter: string, name: string, resource: string, runsOn: string): string =>
		`${padVisible(gutter, 2)}${padVisible(name, nameWidth)}${padVisible(resource, resourceWidth)}${runsOn}`;
	return [
		"",
		theme.fg("subtle", line("", "Binding", "Resource", "Runs on")),
		...rows.flatMap((entry) =>
			entry.status === "stub"
				? [
						line(
							theme.fg("yellow", "!"),
							theme.fg("white", entry.name),
							theme.fg("muted", entry.resource),
							theme.fg("yellow", entry.runsOn),
						),
						...(entry.alternative === undefined
							? []
							: [line("", "", "", theme.fg("subtle", entry.alternative))]),
					]
				: [
						line(
							"",
							theme.fg("white", entry.name),
							theme.fg("muted", entry.resource),
							theme.fg("muted", entry.runsOn),
						),
					],
		),
	];
}

// The brand, the resolved project, and its bindings, printed before the Worker starts.
// A session with several Workers prints the brand once, above the first Worker.
export function renderDevHeader(
	theme: Theme,
	config: ResolvedWranglerConfiguration,
	brand = true,
): string {
	const lines = brand ? [renderBrand(theme), ""] : [];
	if (config.workerName !== undefined) {
		lines.push(row(theme, "", "Worker", theme.bold(theme.fg("white", config.workerName))));
	}
	if (config.configPath !== undefined) {
		lines.push(
			row(theme, "", "Config", theme.fg("white", relative(process.cwd(), config.configPath) || config.configPath)),
		);
	}
	lines.push(row(theme, "", "Compat date", theme.fg("white", config.compatibilityDate)));
	if (config.assets !== undefined) {
		lines.push(
			row(theme, "", "Assets", theme.fg("white", relative(process.cwd(), config.assets.directory) || ".")),
		);
	}
	lines.push(...renderBindingTable(theme, config));
	return lines.join("\n");
}

export interface ReadyDetails {
	cronNextRuns?: { cron: string; nextRunAt: number }[];
	elapsedMs: number;
	// Whether an agent configuration names the Rivet MCP, and its URL.
	mcp?: { configured: boolean; url: string };
	origin: string;
}

export function renderReady(theme: Theme, details: ReadyDetails): string {
	const seconds = (details.elapsedMs / 1000).toFixed(1);
	const lines = [
		`${theme.fg("orange", "●")} ${theme.bold(theme.fg("white", "Ready"))} ${theme.fg("subtle", `in ${seconds}s`)}`,
		row(theme, "", "Local", theme.link(details.origin)),
	];
	// Wrangler prints how to trigger scheduled() by hand because it never runs
	// crons in dev. Orange runs them, and the route works the same way.
	// https://github.com/cloudflare/workers-sdk/blob/be87ff0382c53a294e948e49419d25d653c50e86/packages/wrangler/src/dev/start-dev.ts#L352-L366
	const cronNextRuns = details.cronNextRuns ?? [];
	for (const [index, run] of cronNextRuns.entries()) {
		lines.push(
			row(
				theme,
				"",
				index === 0 ? "Cron" : "",
				`${theme.fg("white", JSON.stringify(run.cron))} ${theme.fg("subtle", `next ${new Date(run.nextRunAt).toISOString()}`)}`,
			),
		);
	}
	const [firstRun] = cronNextRuns;
	if (firstRun !== undefined) {
		lines.push(
			row(
				theme,
				"",
				"",
				theme.fg("subtle", `Run one now: curl "${cronTriggerUrl(details.origin, firstRun.cron)}"`),
			),
		);
	}
	if (details.mcp?.configured === false) {
		lines.push(row(theme, "", "Agent", theme.fg("subtle", "Run orange mcp to connect your coding agent to the Rivet MCP")));
	}
	return lines.join("\n");
}

export function cronTriggerUrl(origin: string, cron: string): string {
	return `${origin}/cdn-cgi/local/scheduled?cron=${encodeURIComponent(cron)}`;
}

export function renderHotkeys(theme: Theme): string {
	const key = (letter: string, action: string): string =>
		`${theme.bold(theme.fg("orange", letter))} ${theme.fg("subtle", action)}`;
	const keys = [key("b", "open"), key("c", "clear"), key("x", "stop")];
	return `  ${keys.join(theme.fg("border", "  ·  "))}`;
}

function statusColor(status: number): Color {
	if (status >= 500) return "red";
	if (status >= 400) return "yellow";
	if (status >= 300) return "muted";
	if (status >= 200) return "green";
	return "orange";
}

// One finished request: method, status, and duration in fixed columns, then the path.
export function renderRequest(theme: Theme, request: RuntimeRequestMessage): string {
	const duration =
		request.durationMs < 10
			? `${request.durationMs.toFixed(1)}ms`
			: `${Math.round(request.durationMs)}ms`;
	const method = theme.fg("muted", request.method.padEnd(7));
	const status = theme.fg(statusColor(request.status), String(request.status));
	return `  ${method}${status}  ${theme.fg("subtle", duration.padStart(7))}  ${theme.fg("white", request.path)}`;
}

export function renderWarning(theme: Theme, message: string): string {
	return `${theme.fg("yellow", "!")} ${theme.fg("muted", message)}`;
}

// Frames from Node.js, Orange's runtime, and installed packages such as
// RivetKit, which the Worker author does not own.
const runtimeFramePattern = /node:|\/dist\/runtime\/|\/packages\/runtime-node\/src\/|\/node_modules\//;

// An error with its type, as in `TypeError: x is not iterable`, and only the
// stack frames from the Worker's own code, relative to the project.
export function renderError(theme: Theme, message: string, stack?: string): string {
	const lines = (stack ?? "").split("\n");
	const headline = lines[0]?.includes(message) === true ? lines[0] : message;
	const cwd = `${process.cwd()}/`;
	const frames = lines
		.filter((line) => /^\s+at /.test(line) && !runtimeFramePattern.test(line))
		.map((line) =>
			line
				.replace("file://", "")
				.replace(" /private/", " /")
				.replace("(/private/", "(/")
				.replace(cwd, ""),
		);
	const details = frames.length === 0 ? "" : `\n${theme.fg("subtle", frames.join("\n"))}`;
	return `${theme.fg("red", "×")} ${theme.bold(theme.fg("white", headline))}${details}`;
}

// A failure that stops the command, with an optional next step.
export function renderFailure(theme: Theme, message: string, hint?: string): string {
	const next = hint === undefined ? "" : `\n  ${theme.fg("muted", hint)}`;
	return `${theme.fg("red", "×")} ${theme.bold(theme.fg("white", message))}${next}`;
}

export function renderStopping(theme: Theme): string {
	return theme.fg("subtle", "  Stopping…");
}

// Help for `open-orange dev`. It lists only the options Orange implements, so
// people and agents never try a Wrangler flag that does nothing here.
export function renderDevHelp(theme: Theme): string {
	const section = (title: string): string => `\n${theme.bold(title)}`;
	const option = (flags: string, description: string): string =>
		`  ${theme.fg("orange", flags.padEnd(24))}${description}`;
	const event = (json: string): string => `  ${theme.dim(json)}`;
	return [
		`${theme.bold("open-orange dev")} ${theme.dim("[script]")}`,
		"",
		"Run the Worker in this directory. Durable Objects, KV, and D1 run as Rivet Actors.",
		section("Options"),
		option("-c, --config <path>", "Wrangler configuration file"),
		option("-e, --env <name>", "Environment from the configuration"),
		option("--cwd <dir>", "Run as if started in <dir>"),
		option("--port <port>", "Port to listen on. Default 8787. 0 picks a free port."),
		option("--runtime <runtime>", "node or agentos. Default OPENORANGE_RUNTIME, then node."),
		option("--ip <host>", "Host to listen on. Default 127.0.0.1."),
		option("--log-level <level>", "RivetKit logs: debug, info, warn, error, or none. Default error."),
		option("--json", "Print JSON Lines events instead of the terminal view"),
		option("--test-scheduled", "Serve /__scheduled to run the scheduled() handler"),
		theme.dim(
			"  Also accepted for Wrangler compatibility: --local, --latest, --profile,\n  --inspector-port, --inspector-ip, --show-interactive-dev-session, and\n  --local-protocol http.",
		),
		section("Keys"),
		`  ${theme.dim("In a terminal: b opens the Worker, c clears, x or Ctrl-C stops.\n  Press Ctrl-C twice to stop without waiting.")}`,
		section("JSON events"),
		event('{"type":"config","worker":"app","compatibilityDate":"2026-09-03","bindings":[...]}'),
		theme.dim('  Each binding has a status: local, pluggable (env-configured backend), or stub (calls throw).'),
		event('{"type":"warning","message":"..."}'),
		event('{"type":"ready","url":"http://127.0.0.1:8787","elapsedMs":912,"crons":[...],"mcp":{...}}'),
		theme.dim("  mcp.configured is whether an agent configuration names the Rivet MCP. See orange mcp."),
		event('{"type":"request","method":"GET","path":"/","status":200,"durationMs":7.1}'),
		event('{"type":"log","stream":"stdout","text":"..."}'),
		event('{"type":"error","message":"...","stack":"..."}'),
		event('{"type":"stopping"}  {"type":"stopped","exitCode":0}'),
		event('{"type":"failure","message":"...","hint":"..."}'),
		section("Exit codes"),
		`  ${theme.dim("0 stopped cleanly · 1 failed to start · 130 stopped by a second Ctrl-C")}`,
	].join("\n");
}
