import { connect } from "cloudflare:sockets";

// The test resolves this hostname to two addresses.
const hostname = "two-addresses.test";
const request = `GET / HTTP/1.1\r\nhost: ${hostname}\r\nconnection: close\r\n\r\n`;

// Each route connects to <hostname>:<port> and returns the response body, or the error it caught.
// GET /fetch?port=N&scheme=http|https uses fetch(). GET /socket?port=N sends `GET /` over
// cloudflare:sockets. GET /socket-cancel?port=N cancels the socket while it connects.
export default {
	async fetch(incoming) {
		const url = new URL(incoming.url);
		const port = Number(url.searchParams.get("port"));
		try {
			if (url.pathname === "/fetch") {
				const scheme = url.searchParams.get("scheme") ?? "http";
				const response = await fetch(`${scheme}://${hostname}:${port}/`);
				return Response.json({ body: await response.text() });
			}
			if (url.pathname === "/socket") {
				const socket = connect({ hostname, port });
				await socket.opened;
				const writer = socket.writable.getWriter();
				await writer.write(new TextEncoder().encode(request));
				const response = await new Response(socket.readable).text();
				return Response.json({ body: response.slice(response.indexOf("\r\n\r\n") + 4) });
			}
			if (url.pathname === "/socket-cancel") {
				const socket = connect({ hostname, port });
				// Long enough for both addresses' attempts to start.
				await new Promise((resolve) => setTimeout(resolve, 300));
				await socket.readable.cancel();
				await socket.closed;
				return Response.json({ closed: true });
			}
			return new Response("ready");
		} catch (error) {
			return Response.json({
				error: {
					name: error.name,
					message: error.message,
					cause: error.cause && { name: error.cause.name, code: error.cause.code },
				},
			});
		}
	},
};
