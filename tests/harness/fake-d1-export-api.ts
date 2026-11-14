import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

// Cloudflare's D1 database and export API, as `orange migrate d1` calls them, with the export's
// signed URL served here too. It serves a dump that real D1 wrote (tests/fixtures/migrate-d1-export/
// exports), not one it makes up: the network and the polling are fake, the SQL is Cloudflare's.
// https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/export/

export interface FakeD1ExportApiOptions {
	dump: Buffer;
	// The export ends with `status: "error"` and this message.
	exportError?: string;
	// The first signed URL breaks its connection after this many bytes, and answers 403 from then
	// on, as R2 does once a signed URL is past its hour.
	firstUrlBreaksAfter?: number;
	// Bytes per second that a signed URL sends.
	bytesPerSecond?: number;
	// Called as a signed URL sends bytes, with the total so far for that URL.
	onServed?(bytes: number): void;
	// The first polls of each export answer HTTP 500, as Cloudflare's API sometimes does.
	failingPolls?: number;
}

export interface FakeD1ExportApi {
	close(): Promise<void>;
	// Exports that ended with a signed URL.
	exports(): number;
	url: string;
}

// Real D1 gives each export a new bookmark: every move writes a freeze, and every lease renewal
// writes too, before the next export starts.
function bookmarkOf(exportNumber: number): string {
	return `00000001-${exportNumber.toString(16).padStart(8, "0")}-00005120-6f72616e67652d6431`;
}

function json(response: ServerResponse, status: number, body: unknown): void {
	response.writeHead(status, { "content-type": "application/json" });
	response.end(JSON.stringify(body));
}

async function readBody(request: IncomingMessage): Promise<any> {
	let text = "";
	for await (const chunk of request) text += String(chunk);
	return text === "" ? {} : JSON.parse(text);
}

export async function startFakeD1ExportApi(options: FakeD1ExportApiOptions): Promise<FakeD1ExportApi> {
	let completed = 0;
	let started = 0;
	let failedPolls = 0;
	let origin = "";
	const serve = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
		const { pathname } = new URL(request.url ?? "/", "http://fake");
		if (/^\/client\/v4\/accounts\/[^/]+\/d1\/database\/[^/]+$/.test(pathname)) {
			json(response, 200, { errors: [], messages: [], result: { file_size: options.dump.length, name: "fake", uuid: pathname.split("/").at(-1) }, success: true });
			return;
		}
		if (/^\/client\/v4\/accounts\/[^/]+\/d1\/database\/[^/]+\/export$/.test(pathname) && request.method === "POST") {
			const body = await readBody(request);
			if (body.output_format !== "polling") {
				json(response, 400, { errors: [{ code: 7400, message: "output_format must be polling" }], success: false });
				return;
			}
			// The first request starts the export, and a poll with its bookmark ends it.
			if (body.current_bookmark === undefined) {
				started += 1;
				failedPolls = 0;
				json(response, 200, { errors: [], messages: [], result: { at_bookmark: bookmarkOf(started), messages: ["Generating"], status: "active", success: true, type: "export" }, success: true });
				return;
			}
			const bookmark = String(body.current_bookmark);
			if (failedPolls < (options.failingPolls ?? 0)) {
				failedPolls += 1;
				json(response, 500, { errors: [{ code: 7500, message: "Internal Server Error" }], success: false });
				return;
			}
			if (options.exportError !== undefined) {
				json(response, 200, { errors: [], messages: [], result: { at_bookmark: bookmark, error: options.exportError, status: "error", success: false, type: "export" }, success: true });
				return;
			}
			completed += 1;
			const filename = `export-${completed}.sql`;
			json(response, 200, {
				errors: [],
				messages: [],
				result: { at_bookmark: bookmark, result: { filename, signed_url: `${origin}/signed/${completed}/${filename}?X-Amz-Expires=3600` }, status: "complete", success: true, type: "export" },
				success: true,
			});
			return;
		}
		const signed = /^\/signed\/(\d+)\//.exec(pathname);
		if (signed !== null && request.method === "GET") {
			const first = signed[1] === "1";
			if (first && options.firstUrlBreaksAfter !== undefined && firstUrlBroken) {
				response.writeHead(403, { "content-type": "application/xml" });
				response.end("<Error><Code>AccessDenied</Code><Message>Request has expired</Message></Error>");
				return;
			}
			const range = /^bytes=(\d+)-$/.exec(request.headers.range ?? "");
			const start = range === null ? 0 : Number(range[1]);
			const body = options.dump.subarray(start);
			response.writeHead(range === null ? 200 : 206, {
				"accept-ranges": "bytes",
				"content-length": String(body.length),
				...(range === null ? {} : { "content-range": `bytes ${start}-${options.dump.length - 1}/${options.dump.length}` }),
			});
			const chunk = 16 * 1024;
			let sent = 0;
			for (let at = 0; at < body.length; at += chunk) {
				if (first && options.firstUrlBreaksAfter !== undefined && sent >= options.firstUrlBreaksAfter) {
					firstUrlBroken = true;
					response.destroy();
					return;
				}
				const piece = body.subarray(at, at + chunk);
				if (!response.write(piece)) await new Promise((resolve) => response.once("drain", resolve));
				sent += piece.length;
				options.onServed?.(sent);
				if (options.bytesPerSecond !== undefined) await new Promise((resolve) => setTimeout(resolve, (piece.length / options.bytesPerSecond!) * 1000));
				if (response.destroyed) return;
			}
			response.end();
			return;
		}
		json(response, 404, { errors: [{ code: 7003, message: `No route for ${request.method} ${pathname}` }], success: false });
	};
	let firstUrlBroken = false;
	const server = createServer((request, response) => {
		serve(request, response).catch(() => response.destroy());
	});
	await new Promise<void>((listening) => server.listen(0, "127.0.0.1", listening));
	origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	return {
		close: () =>
			new Promise((closed) => {
				server.closeAllConnections();
				server.close(() => closed());
			}),
		exports: () => completed,
		url: `${origin}/client/v4`,
	};
}
