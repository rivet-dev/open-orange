// Uses @cloudflare/sandbox as the Cloudflare Sandbox SDK docs show.
// https://developers.cloudflare.com/sandbox/get-started/
import { getSandbox, parseSSEStream, proxyToSandbox } from "@cloudflare/sandbox";

export { Sandbox } from "@cloudflare/sandbox";

async function collect(stream) {
	const events = [];
	for await (const event of parseSSEStream(stream)) events.push(event);
	return events;
}

export default {
	async fetch(request, env) {
		const proxyResponse = await proxyToSandbox(request, env);
		if (proxyResponse) return proxyResponse;

		const url = new URL(request.url);
		const sandbox = getSandbox(env.Sandbox, url.searchParams.get("id") ?? "my-sandbox");
		const param = (name) => url.searchParams.get(name) ?? undefined;
		try {
			switch (url.pathname) {
				case "/exec":
					return Response.json(await sandbox.exec(param("cmd")));
				case "/exec-stream":
					return Response.json(await collect(await sandbox.execStream(param("cmd"))));
				case "/write":
					await sandbox.writeFile(param("path"), await request.text());
					return Response.json({ ok: true });
				case "/read":
					return Response.json(await sandbox.readFile(param("path")));
				case "/exists":
					return Response.json(await sandbox.exists(param("path")));
				case "/rename":
					return Response.json(await sandbox.renameFile(param("from"), param("to")));
				case "/list":
					return Response.json(await sandbox.listFiles(param("path")));
				case "/start":
					return Response.json(await sandbox.startProcess(param("cmd"), { processId: param("pid") }));
				case "/logs":
					return Response.json(await collect(await sandbox.streamProcessLogs(param("pid"))));
				case "/kill":
					await sandbox.killProcess(param("pid"));
					return Response.json(await sandbox.getProcess(param("pid")));
				case "/process-object": {
					const proc = await sandbox.startProcess("echo listening on 4321; sleep 60");
					const { match } = await proc.waitForLog(/listening on (\d+)/, 5000);
					const before = await proc.getStatus();
					await proc.kill();
					const exit = await proc.waitForExit(5000);
					const listed = await sandbox.listProcesses();
					return Response.json({
						after: await proc.getStatus(),
						before,
						exit,
						logs: await proc.getLogs(),
						matched: match?.[1],
						listedHasKill: listed.every((entry) => typeof entry.kill === "function"),
						startTimeIsDate: proc.startTime instanceof Date,
					});
				}
				case "/wait-port": {
					const proc = await sandbox.getProcess(param("pid"));
					await proc.waitForPort(Number(param("port")), { timeout: 10_000, interval: 50 });
					return Response.json({ ready: true });
				}
				case "/wait-log": {
					const proc = await sandbox.getProcess(param("pid"));
					return Response.json(await proc.waitForLog(param("pattern"), 10_000));
				}
				// Preview hosts are subdomains, so an IP address origin uses localhost.
				case "/expose":
					return Response.json(
						await sandbox.exposePort(Number(param("port")), { hostname: `localhost:${url.port}`, token: param("token") }),
					);
				case "/unexpose":
					await sandbox.unexposePort(Number(param("port")));
					return Response.json({ ok: true });
				case "/exposed":
					return Response.json(await sandbox.getExposedPorts(`localhost:${url.port}`));
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
