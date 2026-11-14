// Records every queue() delivery in KV so tests can read what the consumer saw.

function failure(error) {
	return { message: error.message, name: error.name };
}

function describeBody(body) {
	if (body instanceof Uint8Array) {
		let sum = 0;
		for (const byte of body) sum = (sum + byte) % 65_521;
		return { byteLength: body.byteLength, sum, type: "Uint8Array" };
	}
	return body;
}

async function record(env, batch, message) {
	const delivery = {
		at: Date.now(),
		attempts: message.attempts,
		batchSize: batch.messages.length,
		body: describeBody(message.body),
		id: message.id,
		queue: batch.queue,
		timestamp: message.timestamp.getTime(),
	};
	await env.LOG.put(`delivery:${batch.queue}:${crypto.randomUUID()}`, JSON.stringify(delivery));
}

async function readDeliveries(env, queue) {
	const deliveries = [];
	let cursor;
	do {
		const page = await env.LOG.list({ cursor, prefix: `delivery:${queue}:` });
		for (const key of page.keys) {
			deliveries.push(JSON.parse(await env.LOG.get(key.name)));
		}
		cursor = page.list_complete ? undefined : page.cursor;
	} while (cursor !== undefined);
	return deliveries.sort((left, right) => left.at - right.at);
}

function bytes(size) {
	const value = new Uint8Array(size);
	for (let index = 0; index < size; index += 1) value[index] = index % 251;
	return value;
}

export default {
	async fetch(request, env) {
		const url = new URL(request.url);
		if (url.pathname === "/send") {
			const queue = env[url.searchParams.get("binding")];
			const { delaySeconds, messages } = await request.json();
			try {
				if (messages.length === 1) {
					const [{ body, ...options }] = messages;
					await queue.send(body, options);
				} else {
					await queue.sendBatch(messages, delaySeconds === undefined ? {} : { delaySeconds });
				}
				return Response.json({ sent: messages.length });
			} catch (error) {
				return Response.json({ error: failure(error) });
			}
		}
		if (url.pathname === "/send-bytes") {
			const size = Number(url.searchParams.get("size"));
			try {
				await env.DELAYED.send(bytes(size), { contentType: "bytes" });
				return Response.json({ sent: 1 });
			} catch (error) {
				return Response.json({ error: failure(error) });
			}
		}
		if (url.pathname === "/send-invalid") {
			const settle = (operation) => operation().then(() => null, failure);
			return Response.json({
				badContentType: await settle(() => env.DELAYED.send("x", { contentType: "xml" })),
				badDelay: await settle(() => env.DELAYED.send("x", { delaySeconds: -1 })),
				emptyBatch: await settle(() => env.DELAYED.sendBatch([])),
				textNotString: await settle(() => env.DELAYED.send(1, { contentType: "text" })),
				undefinedBody: await settle(() => env.DELAYED.send(undefined)),
			});
		}
		if (url.pathname === "/deliveries") {
			return Response.json(await readDeliveries(env, url.searchParams.get("queue")));
		}
		return new Response("not found", { status: 404 });
	},

	async queue(batch, env) {
		for (const message of batch.messages) {
			await record(env, batch, message);
		}
		if (batch.queue === "jobs" && batch.messages.some((message) => message.body.fail)) {
			throw new Error("queue handler failed");
		}
		for (const message of batch.messages) {
			const retryDelay = message.body?.retryDelay;
			if (retryDelay !== undefined && message.attempts === 1) {
				message.retry({ delaySeconds: retryDelay });
			}
		}
		// The first delivery of a `hang` message never finishes, so a test can
		// kill `orange dev` while queue() runs.
		if (batch.queue === "slow" && batch.messages.some((message) => message.body.hang)) {
			const earlier = await readDeliveries(env, "slow");
			if (earlier.length === batch.messages.length) await new Promise(() => {});
		}
	},
};
