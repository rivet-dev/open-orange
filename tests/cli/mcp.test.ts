import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const cliEntrypoint = fileURLToPath(new URL("../../src/bin.ts", import.meta.url));
const tsxLoader = import.meta.resolve("tsx");
const url = "https://mcp.rivet.dev/mcp";

interface Run {
	code: number | null;
	stdout: string;
	stderr: string;
}

interface Machine {
	home: string;
	project: string;
	// Writes `text` to `path`, which is relative to the temporary root.
	write(path: string, text: string): Promise<void>;
	// Puts an executable `name` on PATH. PATH has nothing else.
	install(...names: string[]): Promise<void>;
	// Runs `orange mcp <args>` in the project.
	mcp(args?: string[], env?: Record<string, string>): Promise<Run>;
	// The files that `orange mcp --json` says name the Rivet MCP.
	status(env?: Record<string, string>): Promise<string>;
}

// A temporary home directory, a PATH folder, and a project two folders below a parent folder. HOME,
// PATH, XDG_CONFIG_HOME, CLAUDE_CONFIG_DIR, and CODEX_HOME point inside it, so the agents and the
// agent configuration of the machine that runs the tests never reach the CLI.
async function withMachine(run: (machine: Machine) => Promise<void>): Promise<void> {
	// The real path, because the CLI sees its working directory without symbolic links.
	const root = await realpath(await mkdtemp(join(tmpdir(), "open-orange-mcp-test-")));
	const home = join(root, "home");
	const bin = join(root, "bin");
	const project = join(root, "work", "app");
	await mkdir(home, { recursive: true });
	await mkdir(bin, { recursive: true });
	await mkdir(project, { recursive: true });
	const write: Machine["write"] = async (path, text) => {
		await mkdir(dirname(join(root, path)), { recursive: true });
		await writeFile(join(root, path), text);
	};
	const install: Machine["install"] = async (...names) => {
		for (const name of names) {
			await writeFile(join(bin, name), "#!/bin/sh\nexit 1\n");
			await chmod(join(bin, name), 0o755);
		}
	};
	const mcp: Machine["mcp"] = async (args = [], env = {}) => {
		const child = spawn(process.execPath, ["--import", tsxLoader, cliEntrypoint, "mcp", ...args], {
			cwd: project,
			env: {
				...process.env,
				CLAUDE_CONFIG_DIR: "",
				CODEX_HOME: "",
				HOME: home,
				NO_COLOR: "1",
				PATH: bin,
				XDG_CONFIG_HOME: join(home, ".config"),
				...env,
			},
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		const code = await new Promise<number | null>((resolveExit) => child.once("exit", resolveExit));
		return { code, stderr, stdout };
	};
	const status: Machine["status"] = async (env = {}) => {
		const run = await mcp(["--json"], env);
		assert.equal(run.code, 0, run.stderr);
		const report = JSON.parse(run.stdout) as { agents: { configuredIn: { path: string }[] }[] };
		const files = report.agents.flatMap((agent) => agent.configuredIn.map((file) => file.path));
		return files.length === 0 ? notSetUp : `set up in ${files.join(", ")}`;
	};
	try {
		await run({ home, install, mcp, project, status, write });
	} finally {
		await rm(root, { force: true, recursive: true });
	}
}

// The human output of `orange mcp`, which must exit 0.
async function human(machine: Machine, args: string[] = [], env: Record<string, string> = {}): Promise<string> {
	const run = await machine.mcp(args, env);
	assert.equal(run.code, 0, run.stderr);
	return run.stdout.trimEnd();
}

const notSetUp = "not set up for this project";
const server = (entry: Record<string, unknown>): string => JSON.stringify({ mcpServers: { rivet: entry } });
const vsCodeUser =
	process.platform === "darwin" ? "home/Library/Application Support/Code/User/mcp.json" : "home/.config/Code/User/mcp.json";
const claudeCommand = `claude mcp add --transport http rivet "${url}"`;
const codexCommand = `codex mcp add rivet --url "${url}"`;

test("orange mcp finds the Rivet MCP in each agent's user configuration", async () => {
	await withMachine(async ({ status, write }) => {
		await write("home/.claude.json", JSON.stringify({ mcpServers: { rivet: { type: "http", url } } }));
		assert.equal(await status(), "set up in ~/.claude.json");
	});
	await withMachine(async ({ project, status, write }) => {
		await write("home/.claude.json", JSON.stringify({ projects: { [project]: { mcpServers: { rivet: { type: "http", url } } } } }));
		assert.equal(await status(), "set up in ~/.claude.json");
	});
	await withMachine(async ({ home, status, write }) => {
		// With CLAUDE_CONFIG_DIR set, Claude Code reads .claude.json there and not in the home directory.
		await write("home/.claude.json", JSON.stringify({ mcpServers: { rivet: { url } } }));
		await write("claude/.claude.json", JSON.stringify({ mcpServers: {} }));
		assert.equal(await status({ CLAUDE_CONFIG_DIR: join(home, "..", "claude") }), notSetUp);
		await write("claude/.claude.json", JSON.stringify({ mcpServers: { rivet: { url } } }));
		assert.match(await status({ CLAUDE_CONFIG_DIR: join(home, "..", "claude") }), /^set up in .*\/claude\/\.claude\.json$/);
	});
	await withMachine(async ({ status, write }) => {
		await write("home/.cursor/mcp.json", server({ url }));
		assert.equal(await status(), "set up in ~/.cursor/mcp.json");
	});
	await withMachine(async ({ status, write }) => {
		await write(vsCodeUser, JSON.stringify({ servers: { rivet: { type: "http", url } } }));
		assert.match(await status(), /^set up in ~\/.*Code\/User\/mcp\.json$/);
	});
	await withMachine(async ({ home, status, write }) => {
		await write("codex/config.toml", `[mcp_servers.rivet]\nurl = "${url}"\n`);
		assert.match(await status({ CODEX_HOME: join(home, "..", "codex") }), /^set up in .*\/codex\/config\.toml$/);
		await write("home/.codex/config.toml", `[mcp_servers.rivet]\nurl = "${url}"\n`);
		assert.equal(await status(), "set up in ~/.codex/config.toml");
	});
});

test("orange mcp finds the Rivet MCP in project files of the project and its parent folders", async () => {
	await withMachine(async ({ status, write }) => {
		// Claude Code reads .mcp.json in the folder it starts in and in each parent folder.
		await write("work/.mcp.json", server({ type: "http", url }));
		assert.match(await status(), /^set up in .*\/work\/\.mcp\.json$/);
	});
	await withMachine(async ({ status, write }) => {
		// VS Code accepts comments and trailing commas.
		await write("work/app/.vscode/mcp.json", `{\n  // Rivet\n  "servers": { "rivet": { "type": "http", "url": "${url}", }, },\n}\n`);
		assert.match(await status(), /^set up in .*\/work\/app\/\.vscode\/mcp\.json$/);
	});
	await withMachine(async ({ status, write }) => {
		await write("work/app/.cursor/mcp.json", server({ args: ["-y", "mcp-remote", url], command: "npx" }));
		assert.match(await status(), /^set up in .*\/work\/app\/\.cursor\/mcp\.json$/);
	});
});

test("orange mcp does not count a malformed file, a comment, a disabled server, or another host", async () => {
	await withMachine(async ({ project, status, write }) => {
		await write("work/app/.mcp.json", `{ "mcpServers": { "rivet": { "url": "${url}" } }`);
		await write("work/app/.vscode/mcp.json", `{\n  "servers": {\n    // "rivet": { "type": "http", "url": "${url}" }\n  }\n}\n`);
		await write("work/app/.cursor/mcp.json", server({ disabled: true, url }));
		await write("home/.cursor/mcp.json", server({ url: "https://mcp.rivet.dev.example.com/mcp" }));
		await write("home/.codex/config.toml", `[mcp_servers.rivet]\n# url = "${url}"\nurl = "https://example.com/mcp"\n\n[mcp_servers.old]\nurl = "${url}"\nenabled = false\n`);
		await write(vsCodeUser, `{ "servers": { "docs": { "url": "https://example.com/?ref=mcp.rivet.dev" } } }`);
		// Claude Code has the server for this project, but /mcp disabled it.
		await write(
			"home/.claude.json",
			JSON.stringify({ projects: { [project]: { disabledMcpServers: ["rivet"], mcpServers: { rivet: { type: "http", url } } } } }),
		);
		assert.equal(await status(), notSetUp);
	});
	await withMachine(async ({ project, status, write }) => {
		// The user rejected the project's .mcp.json server.
		await write("work/app/.mcp.json", server({ type: "http", url }));
		await write("home/.claude.json", JSON.stringify({ projects: { [project]: { disabledMcpjsonServers: ["rivet"] } } }));
		assert.equal(await status(), notSetUp);
	});
});

test("orange mcp says in one line which agents have the Rivet MCP, and prints no install command", async () => {
	await withMachine(async (machine) => {
		await machine.install("claude");
		await machine.write("home/.claude.json", JSON.stringify({ mcpServers: { rivet: { type: "http", url } } }));
		assert.equal(await human(machine), "✓ Rivet MCP is set up for Claude Code");
		// A flag pins only the command for an agent that lacks the server.
		assert.equal(await human(machine, ["--cluster", "prod"]), "✓ Rivet MCP is set up for Claude Code");
	});
	await withMachine(async (machine) => {
		await machine.write("work/app/.mcp.json", server({ type: "http", url: `${url}?cluster=prod` }));
		await machine.write("home/.codex/config.toml", `[mcp_servers.rivet]\nurl = "${url}?cluster=prod"\n`);
		assert.equal(await human(machine), "✓ Rivet MCP is set up for Claude Code and Codex · cluster prod");
	});
});

test("orange mcp without the Rivet MCP prints one command, for the agent this machine or project uses", async () => {
	await withMachine(async (machine) => {
		await machine.install("codex");
		assert.equal(
			await human(machine),
			[
				"! Rivet MCP is not set up. Connect Codex:",
				`  ${codexCommand}`,
				"",
				"  Other agents: orange mcp --json · https://rivet.dev/docs/mcp/",
			].join("\n"),
		);
		// An agent folder in the project beats a CLI on PATH.
		await machine.write("work/.cursor/rules/style.mdc", "");
		const cursor = await human(machine);
		assert.match(cursor, /^! Rivet MCP is not set up\. Connect Cursor:\n {2}Add a server named rivet with this URL to \.cursor\/mcp\.json:\n {2}https:\/\/mcp\.rivet\.dev\/mcp\n/);
	});
	await withMachine(async (machine) => {
		assert.equal(
			await human(machine),
			[
				"! Rivet MCP is not set up. Connect Claude Code:",
				`  ${claudeCommand}`,
				"",
				"  No coding agent found. Other agents: orange mcp --json · https://rivet.dev/docs/mcp/",
			].join("\n"),
		);
	});
});

test("orange mcp names the agents that have the Rivet MCP and gives a command only to the detected ones that lack it", async () => {
	await withMachine(async (machine) => {
		await machine.install("claude", "codex");
		// VS Code is detected by its MCP file, which names another server.
		await machine.write(vsCodeUser, JSON.stringify({ servers: { docs: { type: "http", url: "https://example.com/mcp" } } }));
		await machine.write("home/.claude.json", JSON.stringify({ mcpServers: { rivet: { type: "http", url } } }));
		assert.equal(
			await human(machine, ["--cluster", "prod"]),
			[
				"✓ Rivet MCP is set up for Claude Code",
				"! Not set up for Codex:",
				`  codex mcp add rivet --url "${url}?cluster=prod"`,
				"! Not set up for VS Code:",
				`  code --add-mcp '{"name":"rivet","type":"http","url":"${url}?cluster=prod"}'`,
			].join("\n"),
		);
	});
});

test("orange mcp --json gives every agent's status and install step, pinned to the cluster", async () => {
	await withMachine(async (machine) => {
		await machine.install("codex");
		await machine.write("home/.claude.json", JSON.stringify({ mcpServers: { rivet: { type: "http", url: `${url}?cluster=prod` } } }));
		// RIVET_CLUSTER pins the commands as the flag does.
		const run = await machine.mcp(["--json"], { RIVET_CLUSTER: "prod" });
		assert.equal(run.code, 0, run.stderr);
		const pinned = `${url}?cluster=prod`;
		assert.deepEqual(JSON.parse(run.stdout), {
			agents: [
				{
					configured: true,
					configuredIn: [{ cluster: "prod", path: "~/.claude.json" }],
					detected: false,
					id: "claude-code",
					install: { command: `claude mcp add --transport http rivet "${pinned}"` },
					name: "Claude Code",
				},
				{
					cli: join(dirname(machine.home), "bin", "codex"),
					configured: false,
					configuredIn: [],
					detected: true,
					id: "codex",
					install: { command: `codex mcp add rivet --url "${pinned}"` },
					name: "Codex",
				},
				{
					configured: false,
					configuredIn: [],
					detected: false,
					id: "cursor",
					install: { config: { mcpServers: { rivet: { url: pinned } } }, file: ".cursor/mcp.json" },
					name: "Cursor",
				},
				{
					configured: false,
					configuredIn: [],
					detected: false,
					id: "vscode",
					install: { command: `code --add-mcp '{"name":"rivet","type":"http","url":"${pinned}"}'` },
					name: "VS Code",
				},
			],
			cluster: "prod",
			configured: true,
			type: "mcp",
			url: pinned,
		});
		// The linked cluster pins them when there is no flag and no RIVET_CLUSTER.
		await machine.write("work/app/.rivet/project.json", JSON.stringify({ cluster: "staging" }));
		assert.equal(JSON.parse((await machine.mcp(["--json"])).stdout).url, `${url}?cluster=staging`);
	});
});

test("orange mcp output fits 100 columns, and a command too long for one line still pastes as one", async () => {
	// A long cluster name. A quoted word stays whole, so a much longer one can still run past.
	const cluster = ["--cluster", "production-us-east-1"];
	await withMachine(async (machine) => {
		const outputs = [await human(machine, cluster), (await machine.mcp(["--help"])).stdout];
		await machine.install("claude", "codex", "code");
		await machine.write("home/.cursor/mcp.json", "{}");
		outputs.push(await human(machine, cluster));
		await machine.write("home/.claude.json", JSON.stringify({ mcpServers: { rivet: { url } } }));
		outputs.push(await human(machine, cluster));
		const lines = outputs.flatMap((output) => output.split("\n"));
		assert.deepEqual(lines.filter((line) => line.length > 100), []);
		// A shell reads the wrapped VS Code command as the same two arguments.
		const start = lines.indexOf("  code --add-mcp \\");
		assert.notEqual(start, -1, outputs.join("\n"));
		const pasted = lines.slice(start, start + 2).join("\n").replace(/^ {2}code /, "printf '%s\\n' ");
		assert.equal(
			execFileSync("/bin/sh", ["-c", pasted], { encoding: "utf8" }),
			`--add-mcp\n{"name":"rivet","type":"http","url":"${url}?cluster=production-us-east-1"}\n`,
		);
	});
});

test("orange mcp rejects an unknown flag with exit 2, as a JSON failure under --json", async () => {
	await withMachine(async (machine) => {
		const run = await machine.mcp(["--bogus"]);
		assert.equal(run.code, 2);
		assert.match(run.stderr, /Run `orange mcp --help`/);
		const json = await machine.mcp(["--json", "--bogus"]);
		assert.equal(json.code, 2);
		assert.equal(JSON.parse(json.stdout).type, "failure");
	});
});
