function failure(error) {
	return { message: error.message, name: error.name };
}

async function settle(operation) {
	try {
		await operation();
		return null;
	} catch (error) {
		return failure(error);
	}
}

function stream(text) {
	const bytes = new TextEncoder().encode(text);
	return new ReadableStream({
		start(controller) {
			controller.enqueue(bytes.slice(0, 2));
			controller.enqueue(bytes.slice(2));
			controller.close();
		},
	});
}

const routes = {
	async "/vars"(_request, env) {
		return {
			devSecret: env.DEV_SECRET,
			json: env.JSON_VAR,
			overridden: env.OVERRIDDEN,
			plain: env.PLAIN,
			storeSecret: await env.STORE_SECRET.get(),
		};
	},

	async "/kv/roundtrip"(_request, env) {
		await env.KV.put("text", "hello", { metadata: { owner: "alice" } });
		await env.KV.put("json", JSON.stringify({ count: 2 }));
		await env.KV.put("bytes", new Uint8Array([0, 1, 255]));
		await env.KV.put("stream", stream("streamed"));
		const withMetadata = await env.KV.getWithMetadata("text");
		const streamed = await new Response(await env.KV.get("stream", "stream")).text();
		const bulk = await env.KV.get(["text", "json", "absent"], "json").catch(failure);
		return {
			absent: await env.KV.get("absent"),
			absentWithMetadata: await env.KV.getWithMetadata("absent"),
			bulkText: Object.fromEntries(await env.KV.get(["text", "absent"])),
			bulkJson: bulk instanceof Map ? Object.fromEntries(bulk) : bulk,
			bytes: [...new Uint8Array(await env.KV.get("bytes", { type: "arrayBuffer" }))],
			json: await env.KV.get("json", { type: "json", cacheTtl: 60 }),
			streamed,
			text: await env.KV.get("text"),
			withMetadata,
		};
	},

	async "/kv/list"(_request, env) {
		for (const key of ["list:c", "list:a", "list:b", "other"]) {
			await env.KV.put(key, key);
		}
		const putAt = Math.floor(Date.now() / 1000);
		await env.KV.put("list:expiring", "x", { expirationTtl: 3600, metadata: [1] });
		const pages = [];
		let cursor;
		do {
			const page = await env.KV.list({ prefix: "list:", limit: 2, cursor });
			pages.push(page);
			cursor = page.list_complete ? undefined : page.cursor;
		} while (cursor !== undefined);
		return {
			names: pages.map((page) => page.keys.map((key) => key.name)),
			complete: pages.map((page) => page.list_complete),
			expiring: pages.flatMap((page) => page.keys).find((key) => key.name === "list:expiring"),
			cacheStatus: pages[0].cacheStatus,
			putAt,
		};
	},

	async "/kv/errors"(_request, env) {
		return {
			emptyKey: await settle(() => env.KV.get("")),
			pastExpiration: await settle(() => env.KV.put("exp", "v", { expiration: 1 })),
			objectValue: await settle(() => env.KV.put("object", { not: "allowed" })),
			bulkType: await settle(() => env.KV.get(["text"], "arrayBuffer")),
			unknownType: await settle(() => env.KV.get("text", "blob")),
		};
	},

	async "/kv/alias"(_request, env) {
		await env.KV.put("alias", "shared");
		return {
			alias: await env.KV_ALIAS.get("alias"),
			other: await env.KV_OTHER.get("alias"),
		};
	},

	async "/kv/write"(request, env) {
		const key = new URL(request.url).searchParams.get("key");
		await env.KV.put(key, key);
		return { key };
	},

	async "/kv/read"(request, env) {
		const key = new URL(request.url).searchParams.get("key");
		return { value: await env.KV.get(key) };
	},

	async "/kv/count"(request, env) {
		const prefix = new URL(request.url).searchParams.get("prefix");
		const { keys } = await env.KV.list({ prefix });
		return { count: keys.length };
	},

	async "/d1/setup"(_request, env) {
		const result = await env.DB.exec(
			"CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL UNIQUE, data BLOB, flag INTEGER)\nCREATE TABLE IF NOT EXISTS hits (name TEXT PRIMARY KEY)",
		);
		return { count: result.count };
	},

	async "/d1/crud"(_request, env) {
		const inserted = await env.DB.prepare(
			"INSERT INTO notes (body, data, flag) VALUES (?, ?, ?)",
		)
			.bind("first", new Uint8Array([1, 2, 3]), true)
			.run();
		const batch = await env.DB.batch([
			env.DB.prepare("INSERT INTO notes (body) VALUES (?1)").bind("second"),
			env.DB.prepare("SELECT body FROM notes ORDER BY id"),
		]);
		const statement = env.DB.prepare("SELECT id, body, data, flag FROM notes WHERE body = ?");
		return {
			all: (await env.DB.prepare("SELECT body FROM notes ORDER BY id").all()).results,
			batchRows: batch[1].results,
			bigInteger: await env.DB.prepare("SELECT 9007199254740993 AS big").first("big"),
			batchChanges: batch[0].meta.changes,
			first: await statement.bind("first").first(),
			firstColumn: await statement.bind("second").first("body"),
			firstMissing: await statement.bind("missing").first(),
			insertedMeta: {
				changes: inserted.meta.changes,
				changedDb: inserted.meta.changed_db,
				lastRowId: inserted.meta.last_row_id,
				success: inserted.success,
			},
			raw: await env.DB.prepare("SELECT id, body FROM notes ORDER BY id").raw({
				columnNames: true,
			}),
			session: await (async () => {
				const session = env.DB.withSession("first-primary");
				const before = session.getBookmark();
				await session.prepare("SELECT 1").all();
				return { before, after: typeof session.getBookmark() };
			})(),
		};
	},

	async "/d1/errors"(_request, env) {
		const atomic = await settle(() =>
			env.DB.batch([
				env.DB.prepare("INSERT INTO notes (body) VALUES ('rolled-back')"),
				env.DB.prepare("INSERT INTO notes (body) VALUES ('first')"),
			]),
		);
		const rolledBack = await env.DB.prepare(
			"SELECT count(*) AS count FROM notes WHERE body = 'rolled-back'",
		).first("count");
		return {
			atomic,
			rolledBack,
			missingTable: await settle(() => env.DB.prepare("SELECT * FROM missing").all()),
			badBinding: await settle(() => env.DB.prepare("SELECT ?").bind(undefined)),
			missingColumn: await settle(() => env.DB.prepare("SELECT 1 AS one").first("two")),
			emptyExec: await settle(() => env.DB.exec("   ")),
		};
	},

	async "/d1/hit"(request, env) {
		const name = new URL(request.url).searchParams.get("name");
		await env.DB.prepare("INSERT INTO hits (name) VALUES (?)").bind(name).run();
		return { name };
	},

	async "/d1/count"(_request, env) {
		return {
			hits: await env.DB.prepare("SELECT count(*) AS count FROM hits").first("count"),
			notes: await env.DB.prepare("SELECT count(*) AS count FROM notes").first("count"),
		};
	},

	async "/stubs"(_request, env) {
		return {
			imagesType: typeof env.IMAGES,
			methodType: typeof env.IMAGES.info,
			awaited: (await Promise.resolve(env.IMAGES)) === env.IMAGES,
			images: await settle(() => env.IMAGES.info(new ReadableStream())),
			otherWorker: await settle(() => env.OTHER_WORKER.ping()),
		};
	},
};

export default {
	async fetch(request, env) {
		const route = routes[new URL(request.url).pathname];
		if (route === undefined) return new Response("Not Found", { status: 404 });
		return Response.json(await route(request, env));
	},
};
