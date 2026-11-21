// A parent Worker that passes each request to a dynamic Worker that runs a node:http server.
// /<way>?n=<bytes> answers with <bytes> bytes, where byte i is i % 251:
//   /end      one res.end() with the whole body
//   /wrapped  a 64 KiB-at-a-time stream piped to a response that middleware has wrapped
//   /gzip     the same stream, gzipped by the server, with Content-Encoding: gzip

const nodeCode = `
	import http from "node:http";
	import { Readable } from "node:stream";
	import zlib from "node:zlib";
	import { httpServerHandler } from "cloudflare:node";
	function bytes(n, from = 0) {
		const out = new Uint8Array(n);
		for (let i = 0; i < n; i++) out[i] = (from + i) % 251;
		return out;
	}
	const chunk = 64 * 1024;
	// Like fs.createReadStream(), which reads 64 KiB at a time.
	function stream(n) {
		let sent = 0;
		return new Readable({
			read() {
				if (sent >= n) return void this.push(null);
				const size = Math.min(chunk, n - sent);
				this.push(Buffer.from(bytes(size, sent)));
				sent += size;
			},
		});
	}
	// What the compression middleware does, which Next.js and Express apps use: it wraps writeHead()
	// to see the response head, and holds "drain" listeners until then.
	function holdDrainUntilHead(res) {
		const on = res.on.bind(res);
		const writeHead = res.writeHead.bind(res);
		let held = [];
		res.on = (type, listener) => {
			if (held === null || type !== "drain") return on(type, listener);
			held.push(listener);
			return res;
		};
		res.writeHead = (...args) => {
			for (const listener of held ?? []) on("drain", listener);
			held = null;
			return writeHead(...args);
		};
	}
	const server = http.createServer((req, res) => {
		const url = new URL(req.url, "http://dynamic");
		const n = Number(url.searchParams.get("n"));
		const way = url.pathname.split("/").at(-1);
		if (way === "end") {
			res.end(Buffer.from(bytes(n)));
		} else if (way === "wrapped") {
			holdDrainUntilHead(res);
			stream(n).pipe(res);
		} else if (way === "gzip") {
			res.setHeader("content-encoding", "gzip");
			stream(n).pipe(zlib.createGzip()).pipe(res);
		} else {
			res.statusCode = 404;
			res.end("not found");
		}
	});
	server.listen(8080);
	export default httpServerHandler({ port: 8080 });
`;

export default {
	async fetch(request, env) {
		return env.LOADER.get("node", () => ({
			compatibilityDate: "2026-09-03",
			compatibilityFlags: ["nodejs_compat"],
			globalOutbound: null,
			mainModule: "main.js",
			modules: { "main.js": nodeCode },
		})).getEntrypoint().fetch(request);
	},
};
