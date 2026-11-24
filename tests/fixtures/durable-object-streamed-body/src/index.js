import { DurableObject } from "cloudflare:workers";

const text = new TextEncoder();

// Reads the whole body and says what arrived: its size and SHA-256, or the error that ended it.
async function describeBody(body) {
	const chunks = [];
	let size = 0;
	try {
		for await (const chunk of body) {
			chunks.push(chunk);
			size += chunk.byteLength;
		}
	} catch (error) {
		return `error after ${size} bytes: ${error}`;
	}
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
	return `${size} ${[...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export class Counter extends DurableObject {
	fetch(request) {
		const { pathname } = new URL(request.url);
		// Answers with the request body as the response body.
		if (pathname === "/echo") return new Response(request.body);
		// Answers without reading the body, and drops it.
		if (pathname === "/cancel") {
			void request.body?.cancel();
			return new Response("cancelled\n");
		}
		// Answers first, then reads the body while the answer streams, as `git http-backend` does.
		const { readable, writable } = new TransformStream();
		const writer = writable.getWriter();
		void writer.write(text.encode("started\n"));
		void describeBody(request.body).then(async (line) => {
			await writer.write(text.encode(`${line}\n`));
			await writer.close();
		});
		return new Response(readable);
	}
}

export default {
	fetch(request, env) {
		return env.COUNTER.getByName("a").fetch(request);
	},
};
