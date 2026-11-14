import { Buffer } from "node:buffer";
import type { SandboxBackend, SandboxProvider } from "./providers.js";
import type { SandboxVmBridge, SandboxVmCommand, SandboxVmReply } from "./host-protocol.js";

export function sandboxVmHostBridge(): SandboxVmBridge | undefined {
	const runtime = Reflect.get(globalThis, "orangeRuntime") as Partial<SandboxVmBridge> | undefined;
	return typeof runtime?.sandboxVmCommand === "function" ? (runtime as SandboxVmBridge) : undefined;
}
const failure = (code: string, message: string) => Object.assign(new Error(message), { code });
export function hostedAgentOsProvider(bridge: SandboxVmBridge): SandboxProvider {
	return {
		name: "agentos",
		async create(owner) {
			const result = await bridge.sandboxVmCommand({ operation: "create", owner });
			if (!result.id) throw failure("EIO", "Sandbox VM creation returned no id");
			return result.id;
		},
		async connect(owner, id) {
			const result = await bridge.sandboxVmCommand({ operation: "connect", owner, id });
			return result.exists ? backend(bridge, owner, id) : undefined;
		},
		async destroy(owner, id) {
			await bridge.sandboxVmCommand({ operation: "destroy", owner, id });
		},
	};
}
function backend(bridge: SandboxVmBridge, owner: string, id: string): SandboxBackend {
	const call = (
		operation: SandboxVmCommand["operation"],
		fields: Omit<SandboxVmCommand, "owner" | "id" | "operation"> = {},
	) => bridge.sandboxVmCommand({ operation, owner, id, ...fields });
	const check = (reply: SandboxVmReply) => {
		if (reply.error) throw failure(reply.error.code, reply.error.message);
		return reply;
	};
	return {
		cwd: "/workspace",
		async exec(command, options) {
			if (options.signal?.aborted)
				throw options.signal.reason ?? failure("ABORT_ERR", "Sandbox command aborted");
			const started = check(
				await call("exec-start", {
					command,
					cwd: options.cwd,
					env: options.env,
					timeoutMs: options.timeoutMs,
				}),
			);
			if (!started.job) throw failure("EIO", "Sandbox execution returned no command id");
			const job = started.job;
			let cancellation: Promise<unknown> | undefined;
			let complete = false;
			let stdout = "",
				stderr = "";
			const out = new TextDecoder(),
				err = new TextDecoder();
			const cancel = () => {
				cancellation ??= call("exec-cancel", { job }).catch((error) => {
					if (!complete) process.stderr.write(`Sandbox cancellation failed: ${String(error)}\n`);
				});
			};
			options.signal?.addEventListener("abort", cancel, { once: true });
			if (options.signal?.aborted) cancel();
			try {
				for (;;) {
					const reply = check(await call("exec-read", { job }));
					if (reply.pending) continue;
					if (reply.exitCode !== undefined) {
						complete = true;
						const tailOut = out.decode(),
							tailErr = err.decode();
						stdout += tailOut;
						stderr += tailErr;
						if (tailOut) options.onStdout?.(tailOut);
						if (tailErr) options.onStderr?.(tailErr);
						return { exitCode: reply.exitCode, stdout, stderr };
					}
					if (!reply.stream || typeof reply.data !== "string")
						throw failure("EIO", "Invalid Sandbox command output");
					const bytes = Buffer.from(reply.data, "base64");
					if (reply.stream === "stdout") {
						const text = out.decode(bytes, { stream: true });
						stdout += text;
						options.onStdout?.(text);
					} else {
						const text = err.decode(bytes, { stream: true });
						stderr += text;
						options.onStderr?.(text);
					}
				}
			} finally {
				options.signal?.removeEventListener("abort", cancel);
				if (!complete) cancel();
				await cancellation;
			}
		},
		async readFile(path) {
			const reply = check(await call("read-start", { path }));
			if (!Number.isSafeInteger(reply.size) || reply.size! < 0)
				throw failure("EIO", "Invalid Sandbox download size");
			try {
				const bytes = Buffer.alloc(reply.size!);
				for (let offset = 0; offset < bytes.length; ) {
					const chunk = check(await call("read-chunk", { offset }));
					if (typeof chunk.data !== "string") throw failure("EIO", "Invalid Sandbox file chunk");
					const part = Buffer.from(chunk.data, "base64");
					if (!part.length || offset + part.length > bytes.length)
						throw failure("EIO", "Invalid Sandbox file chunk length");
					part.copy(bytes, offset);
					offset += part.length;
				}
				return bytes;
			} finally {
				await call("read-close");
			}
		},
		async writeFile(path, content) {
			await call("write-start", { path, size: content.length });
			try {
				for (let offset = 0; offset < content.length; offset += 65536)
					await call("write-chunk", {
						offset,
						data: Buffer.from(content.subarray(offset, offset + 65536)).toString("base64"),
					});
				await call("write-finish");
			} finally {
				await call("write-close");
			}
		},
		async mkdir(path, recursive) {
			await call("mkdir", { path, recursive });
		},
		async exists(path) {
			return (await call("exists", { path })).exists === true;
		},
		async deleteFile(path) {
			await call("remove", { path });
		},
		async rename(from, to) {
			await call("move", { path: from, to });
		},
		async list(path, recursive) {
			const reply = await call("list", { path, recursive });
			if (!reply.entries) throw failure("EIO", "Sandbox directory listing returned no entries");
			return reply.entries;
		},
		async stat(path, follow) {
			const reply = await call("stat", { path, follow });
			if (!reply.info) throw failure("EIO", "Sandbox stat returned no metadata");
			return reply.info;
		},
		async previewFetch(port, request) {
			const reply = await call("preview", { port });
			if (!reply.preview) throw failure("EIO", "Sandbox preview returned no route");
			const route = reply.preview;
			const url = new URL(request.url);
			const target = new URL(url.pathname + url.search, route.origin);
			const headers = new Headers(request.headers);
			headers.set("x-orange-sandbox-token", route.token);
			headers.set("x-orange-sandbox-id", route.id);
			headers.set("x-orange-sandbox-port", String(port));
			try {
				return await fetch(target, {
					method: request.method,
					headers,
					body: request.body,
					signal: request.signal,
					...(request.body ? { duplex: "half" as const } : {}),
				});
			} catch (error) {
				if (request.signal.aborted) throw error;
				process.stderr.write(`Sandbox preview failed: ${String(error)}\n`);
				return new Response(`Nothing answered on port ${port} in the sandbox: ${String(error)}`, {
					status: 502,
					headers: { "x-orange-preview-unreachable": "1" },
				});
			}
		},
	};
}
