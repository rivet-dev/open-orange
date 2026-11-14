// Uses ctx.container as the @cloudflare/sandbox 1.x minimal example does.
// https://github.com/cloudflare/sandbox-sdk/tree/main/examples/minimal
// The pinned Wrangler accepts only one `image` per container, which Orange
// exposes as `images.default`, so `images.sandbox` is undefined here and
// start() falls back to the configured image.
import { Files, SandboxFileError } from "@cloudflare/sandbox";
import { DurableObject } from "cloudflare:workers";

export class Sandbox extends DurableObject {
	ensureRunning() {
		const container = this.ctx.container;
		if (!container.running) container.start({ image: container.images.sandbox, enableInternet: false });
		return container;
	}

	async exec(argv) {
		const process = await this.ensureRunning().exec(argv, { cwd: "/workspace" });
		const output = await process.output();
		const decoder = new TextDecoder();
		return { exitCode: output.exitCode, stderr: decoder.decode(output.stderr), stdout: decoder.decode(output.stdout) };
	}

	async writeFile(path, text) {
		await new Files(this.ensureRunning()).writeFile(path, text);
	}

	async readFile(path) {
		const files = new Files(this.ensureRunning());
		try {
			const stat = await files.stat(path);
			return { size: Number(stat.size), text: await (await files.readFile(path)).text(), type: stat.type };
		} catch (cause) {
			if (SandboxFileError.is(cause)) return { code: cause.code, operation: cause.operation, path: cause.path };
			throw cause;
		}
	}

	async destroy() {
		const container = this.ctx.container;
		if (container.running) await container.destroy();
	}
}

// A Container class whose image is not a Sandbox image.
export class Plain extends DurableObject {
	async start() {
		const container = this.ctx.container;
		container.start({ image: container.images.default, enableInternet: false });
	}
}

export default {
	async fetch(request, env) {
		const url = new URL(request.url);
		const sandbox = env.SANDBOX.getByName(url.searchParams.get("id") ?? "v1");
		try {
			switch (url.pathname) {
				case "/exec":
					return Response.json(await sandbox.exec(await request.json()));
				case "/write":
					await sandbox.writeFile(url.searchParams.get("path"), await request.text());
					return Response.json({ ok: true });
				case "/read":
					return Response.json(await sandbox.readFile(url.searchParams.get("path")));
				case "/start-plain":
					await env.PLAIN.getByName("plain").start();
					return Response.json({ ok: true });
				case "/destroy":
					await sandbox.destroy();
					return Response.json({ ok: true });
				default:
					return new Response("not found", { status: 404 });
			}
		} catch (error) {
			return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
		}
	},
};
