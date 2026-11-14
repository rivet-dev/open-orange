import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import { copyProject, repositoryRoot, startOrangeDev, type RunningOrangeDev } from "../harness/orange-dev.js";

type Bytes = number[];

function varint(value: number): Bytes {
	const bytes: Bytes = [];
	let rest = value;
	do {
		const low = rest & 0x7f;
		rest >>>= 7;
		bytes.push(rest > 0 ? low | 0x80 : low);
	} while (rest > 0);
	return bytes;
}

const header: Bytes = [0xff, 0x0f];
const hostObject = (tag: number, ...parts: Bytes[]): Bytes => [0x5c, ...varint(tag), ...parts.flat()];
// A length-delimited string, as jsg writes it.
const raw = (value: string): Bytes => {
	const bytes = [...Buffer.from(value)];
	return [...varint(bytes.length), ...bytes];
};
// V8 wire values.
const v8String = (value: string): Bytes => [0x22, ...varint(value.length), ...Buffer.from(value, "latin1")];
const v8Int = (value: number): Bytes => [0x49, ...varint((value << 1) ^ (value >> 31))];
const v8Null: Bytes = [0x30];
const v8Object = (...entries: [string, Bytes][]): Bytes => [
	0x6f,
	...entries.flatMap(([key, value]) => [...v8String(key), ...value]),
	0x7b,
	...varint(entries.length),
];

const headersValue = hostObject(
	4,
	varint(3),
	varint(2),
	varint(17), // content-type
	raw("text/plain"),
	varint(0),
	raw("x-custom"),
	raw("é"),
);

interface Answer {
	result?: { outcome: string; ackAll: boolean; retryBatch: unknown; explicitAcks: string[]; retryMessages: unknown[] };
	seen?: { attempts: number; backlog: number[]; body: Record<string, unknown>; oldest: unknown };
	thrown?: string;
}

async function withDev(run: (dev: RunningOrangeDev) => Promise<void>): Promise<void> {
	const project = await copyProject(join(repositoryRoot, "tests", "fixtures", "service-queue"));
	try {
		const dev = await startOrangeDev(project.directory);
		try {
			await run(dev);
		} finally {
			await dev.close();
		}
	} finally {
		await project.dispose();
	}
}

async function send(dev: RunningOrangeDev, queue: string, payload: Bytes): Promise<Answer> {
	const response = await fetch(`${dev.origin}/serialized?queue=${queue}`, {
		body: new Uint8Array([...header, ...payload]),
		method: "POST",
	});
	return (await response.json()) as Answer;
}

const valid: Record<string, { payload: Bytes; body: Record<string, unknown> }> = {
	headers: {
		payload: headersValue,
		body: { kind: "Headers", entries: [["content-type", "text/plain"], ["x-custom", "é"]] },
	},
	request: {
		payload: hostObject(
			5,
			raw("https://example.com/a?b=1"),
			v8Object(["method", v8String("PUT")], ["headers", headersValue]),
		),
		body: {
			kind: "Request",
			url: "https://example.com/a?b=1",
			method: "PUT",
			headers: [["content-type", "text/plain"], ["x-custom", "é"]],
		},
	},
	response: {
		payload: hostObject(6, v8Null, v8Object(["status", v8Int(404)], ["statusText", v8String("Nope")], ["headers", headersValue])),
		body: {
			kind: "Response",
			status: 404,
			statusText: "Nope",
			type: "default",
			headers: [["content-type", "text/plain"], ["x-custom", "é"]],
		},
	},
	"response error": {
		payload: hostObject(6, v8Null, v8Object(["status", v8Int(0)])),
		body: { kind: "Response", status: 0, statusText: "", type: "error", headers: [] },
	},
	"domException legacy": {
		payload: hostObject(7, raw("AbortError"), v8Object(["message", v8String("stopped")], ["stack", v8String("a stack")])),
		body: { kind: "DOMException", name: "AbortError", message: "stopped", stack: "a stack" },
	},
	domException: {
		payload: hostObject(8, raw("TimeoutError"), raw("too slow"), raw("its stack")),
		body: { kind: "DOMException", name: "TimeoutError", message: "too slow", stack: "its stack" },
	},
	"native error": {
		payload: hostObject(10, varint(2), v8String("bad type"), v8Object(["code", v8Int(7)], ["stack", v8String("secret")])),
		body: { kind: "Error", class: "TypeError", name: "TypeError", message: "bad type", code: 7, stack: "own" },
	},
	"native error with its own name": {
		payload: hostObject(10, varint(0), v8String("MyError"), v8String("custom"), v8Object()),
		body: { kind: "Error", class: "Error", name: "MyError", message: "custom", stack: "own" },
	},
	"plain value": {
		payload: v8Object(["a", v8Int(1)]),
		body: { kind: "value", value: { a: 1 } },
	},
};

const crafted: Record<string, Bytes> = {
	"headers guard out of range": hostObject(4, varint(4), varint(0)),
	"headers count over 1024": hostObject(4, varint(0), varint(1025)),
	"headers unknown common ID": hostObject(4, varint(0), varint(1), varint(48), raw("x")),
	"headers cut short": hostObject(4, varint(0), varint(1), varint(0)),
	"request init is not a dictionary": hostObject(5, raw("https://example.com/"), v8Int(0)),
	"request URL is not valid": hostObject(5, raw("/"), v8Object()),
	"response body is not a stream": hostObject(6, v8Int(0)),
	"response init is not a dictionary": hostObject(6, v8Null, v8Int(0)),
	"domException payload is not an object": hostObject(7, raw("Test"), v8Int(0)),
	"domException message is not a string": hostObject(7, raw("Test"), v8Object(["message", v8Int(0)], ["stack", v8String("")])),
	"domException stack is not a string": hostObject(7, raw("Test"), v8Object(["message", v8String("")], ["stack", v8Int(0)])),
	"error message is another error": hostObject(10, varint(1), hostObject(10, varint(1), v8String(""), v8Object()), v8Object()),
	"error tag out of range": hostObject(10, varint(99), v8String(""), v8Object()),
	"stream host object": hostObject(3, varint(0)),
	"stub host object": hostObject(1, varint(0)),
	"unknown host object": hostObject(99),
};

test("a service binding's queue() reads every supported host object in serializedBody", { timeout: 120_000 }, async () => {
	await withDev(async (dev) => {
		for (const [name, { payload, body }] of Object.entries(valid)) {
			const answer = await send(dev, "ackall", payload);
			assert.equal(answer.result?.outcome, "ok", `${name}: ${JSON.stringify(answer)}`);
			assert.deepEqual(answer.seen?.body, body, name);
		}
	});
});

test("a crafted serializedBody fails the event, and the handler never runs", { timeout: 120_000 }, async () => {
	await withDev(async (dev) => {
		for (const [name, payload] of Object.entries(crafted)) {
			const answer = await send(dev, `crafted`, payload);
			assert.equal(answer.result?.outcome, "exception", `${name}: ${JSON.stringify(answer)}`);
			assert.equal(answer.seen, undefined, `${name} reached the handler`);
		}
		// The Worker still serves a valid message afterwards.
		assert.equal((await send(dev, "ackall", v8Int(1))).result?.outcome, "ok");
	});
});

test("queue() reports what the handler did, and overlapping calls don't see each other's result", { timeout: 120_000 }, async () => {
	await withDev(async (dev) => {
		const call = async (queue: string, id: string): Promise<Answer> => {
			const options = encodeURIComponent(JSON.stringify({ body: { id }, id }));
			return (await (await fetch(`${dev.origin}/body?queue=${queue}&options=${options}`)).json()) as Answer;
		};
		const [ack, ackAll, retry, retryAll, thrown] = await Promise.all([
			call("ack", "m-ack"),
			call("ackall", "m-ackall"),
			call("retry-5", "m-retry"),
			call("retryall-6", "m-retryall"),
			call("throw", "m-throw"),
		]);
		assert.deepEqual(ack.result, { ackAll: false, explicitAcks: ["m-ack"], outcome: "ok", retryBatch: { retry: false }, retryMessages: [] });
		assert.equal(ackAll.result?.ackAll, true);
		assert.deepEqual(ackAll.result?.explicitAcks, []);
		assert.deepEqual(retry.result?.retryMessages, [{ delaySeconds: 5, msgId: "m-retry" }]);
		assert.deepEqual(retryAll.result?.retryBatch, { delaySeconds: 6, retry: true });
		assert.equal(thrown.result?.outcome, "exception");
		assert.deepEqual(ack.seen?.body, { kind: "value", value: { id: "m-ack" } });
		assert.equal(ack.seen?.attempts, 3);
		assert.equal(ack.seen?.oldest, 9);
		assert.deepEqual(ack.seen?.backlog, [7, 8]);
	});
});

test("queue() rejects a message with both or neither of body and serializedBody", { timeout: 120_000 }, async () => {
	await withDev(async (dev) => {
		for (const path of ["/both", "/neither"]) {
			const answer = (await (await fetch(`${dev.origin}${path}`)).json()) as Answer;
			assert.equal(answer.thrown, "TypeError", path);
		}
	});
});
