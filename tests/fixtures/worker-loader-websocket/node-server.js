// A node:http server with the `ws` package, for a dynamic Worker. The test bundles it with `ws`
// into one module, since dynamic Workers cannot resolve npm packages. It answers a WebSocket like
// the WebSocketPair Worker in worker.js.
import http from "node:http";

import { httpServerHandler } from "cloudflare:node";
import { WebSocketServer } from "ws";

const instance = crypto.randomUUID();
let lastClose = null;

const sockets = new WebSocketServer({ noServer: true });
const server = http.createServer((req, res) => {
	res.setHeader("content-type", "application/json");
	res.end(JSON.stringify(req.url.endsWith("/last-close") ? lastClose : null));
});
server.on("upgrade", (req, socket, head) => {
	if (req.url.endsWith("/refuse")) {
		socket.end("HTTP/1.1 403 Forbidden\r\ncontent-length: 2\r\n\r\nno");
		return;
	}
	const name = req.cloudflare.env.NAME;
	sockets.handleUpgrade(req, socket, head, (ws) => {
		ws.send(`hello ${name}`);
		ws.on("message", (data, isBinary) => {
			const text = data.toString();
			if (isBinary) ws.send(`binary ${[...data].join(",")}`);
			else if (text.startsWith("close:")) ws.close(Number(text.split(":")[1]), text.split(":")[2]);
			else if (text === "instance") ws.send(`instance:${instance}`);
			else if (text === "binary") ws.send(new Uint8Array([0, 255, 1]));
			else if (text === "exit") setTimeout(() => process.exit(1));
			else ws.send(`${name}:${text}`);
		});
		ws.on("close", (code, reason) => {
			lastClose = { code, reason: reason.toString() };
		});
	});
});
server.listen(8080);

export default httpServerHandler({ port: 8080 });
