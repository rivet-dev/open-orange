async function failure(operation) {
	try {
		await operation();
		return null;
	} catch (error) {
		return {
			isRangeError: error instanceof RangeError,
			message: error.message,
			name: error.name,
			remote: error.remote === true,
		};
	}
}

export default {
	async fetch(request, env) {
		const url = new URL(request.url);
		switch (url.pathname) {
			case "/fetch": {
				const response = await env.B.fetch("http://worker-b/echo", { body: "hello", method: "POST" });
				return Response.json({
					from: response.headers.get("x-from"),
					status: response.status,
					text: await response.text(),
				});
			}
			case "/rpc":
				return Response.json({
					failure: await failure(() => env.ADMIN.fail()),
					// The stub keeps working after a failed call.
					sum: await env.ADMIN.add(2, 3),
				});
			case "/count":
				return Response.json(await env.COUNTER.getByName("shared").increment("worker-a"));
			case "/count-in-b": {
				const response = await env.B.fetch("http://worker-b/count");
				return Response.json(await response.json());
			}
			case "/missing": {
				const response = await env.GONE.fetch("http://worker-gone/");
				const stubResponse = await env.GONE_COUNTER.getByName("x").fetch("http://worker-gone/");
				return Response.json({
					durableObjectFetch: { status: stubResponse.status, text: await stubResponse.text() },
					durableObjectRpc: await failure(() => env.GONE_COUNTER.getByName("x").increment()),
					fetch: { status: response.status, text: await response.text() },
					rpc: await failure(() => env.GONE.anything()),
				});
			}
			case "/workflow": {
				const instance = await env.GREET.create({ params: { name: "worker-a" } });
				// The instance runs in the background, so poll its status until it ends.
				let status = await instance.status();
				for (let attempt = 0; attempt < 100 && status.status !== "complete" && status.status !== "errored"; attempt++) {
					await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
					status = await instance.status();
				}
				return Response.json({
					missing: await failure(() => env.GONE_FLOW.create()),
					output: status.output,
					status: status.status,
				});
			}
			default:
				return new Response("not found", { status: 404 });
		}
	},
};
