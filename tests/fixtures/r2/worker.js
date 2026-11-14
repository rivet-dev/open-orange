// Drives env.BUCKET for src/runtime/r2.test.ts. Each route maps one HTTP
// request to one R2 call so the test observes results over real HTTP.

function describe(object) {
	if (object === null) return null;
	return {
		checksums: object.checksums.toJSON(),
		customMetadata: object.customMetadata,
		etag: object.etag,
		hasBody: "body" in object,
		httpEtag: object.httpEtag,
		httpMetadata: object.httpMetadata,
		key: object.key,
		range: object.range,
		size: object.size,
		storageClass: object.storageClass,
		uploaded: object.uploaded.toISOString(),
		version: object.version,
	};
}

function jsonParam(url, name) {
	const value = url.searchParams.get(name);
	return value === null ? undefined : JSON.parse(value);
}

function putOptions(url, request) {
	const options = jsonParam(url, "options") ?? {};
	if (options.onlyIfHeaders) {
		options.onlyIf = new Headers(options.onlyIfHeaders);
		delete options.onlyIfHeaders;
	}
	const contentType = request.headers.get("x-content-type");
	if (contentType !== null) options.httpMetadata = { contentType };
	return options;
}

export default {
	async fetch(request, env) {
		const url = new URL(request.url);
		const key = url.searchParams.get("key") ?? "key";
		const bucket = env.BUCKET;
		try {
			switch (url.pathname) {
				case "/put":
					return Response.json(
						describe(await bucket.put(key, request.body, putOptions(url, request))),
					);
				case "/head":
					return Response.json(describe(await bucket.head(key)));
				case "/get": {
					const options = jsonParam(url, "options") ?? {};
					if (options.rangeHeader) options.range = new Headers({ range: options.rangeHeader });
					if (options.onlyIfHeaders) options.onlyIf = new Headers(options.onlyIfHeaders);
					const object = await bucket.get(key, options);
					if (object === null) return new Response(null, { status: 404 });
					if (!("body" in object)) return Response.json(describe(object), { status: 412 });
					const headers = new Headers();
					object.writeHttpMetadata(headers);
					headers.set("etag", object.httpEtag);
					headers.set("x-object", JSON.stringify(describe(object)));
					return new Response(object.body, { headers });
				}
				case "/delete":
					await bucket.delete(jsonParam(url, "keys") ?? key);
					return Response.json(null);
				case "/list": {
					const result = await bucket.list(jsonParam(url, "options"));
					return Response.json({ ...result, objects: result.objects.map(describe) });
				}
				case "/multipart/create": {
					const upload = await bucket.createMultipartUpload(key, jsonParam(url, "options"));
					return Response.json({ key: upload.key, uploadId: upload.uploadId });
				}
				case "/multipart/part": {
					const upload = bucket.resumeMultipartUpload(key, url.searchParams.get("uploadId"));
					const part = Number(url.searchParams.get("part"));
					return Response.json(await upload.uploadPart(part, await request.arrayBuffer()));
				}
				case "/multipart/complete": {
					const upload = bucket.resumeMultipartUpload(key, url.searchParams.get("uploadId"));
					return Response.json(describe(await upload.complete(await request.json())));
				}
				case "/multipart/abort": {
					const upload = bucket.resumeMultipartUpload(key, url.searchParams.get("uploadId"));
					await upload.abort();
					return Response.json(null);
				}
				case "/ssec":
					await bucket.put(key, "value", { ssecKey: "0".repeat(64) });
					return Response.json(null);
				default:
					return new Response(null, { status: 404 });
			}
		} catch (error) {
			return Response.json(
				{ error: { message: error.message, name: error.name } },
				{ status: 500 },
			);
		}
	},
};
