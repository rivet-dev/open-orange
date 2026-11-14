async function failure(operation) {
	try {
		await operation();
		return null;
	} catch (error) {
		return { message: error.message, name: error.name };
	}
}

export default {
	async fetch(request, env) {
		const url = new URL(request.url);
		if (url.pathname === "/limit") {
			const binding = env[url.searchParams.get("binding")];
			return Response.json(await binding.limit({ key: url.searchParams.get("key") }));
		}
		if (url.pathname === "/errors") {
			return Response.json({
				extraOption: await failure(() => env.LIMITER.limit({ key: "a", window: 5 })),
				missingOptions: await failure(() => env.LIMITER.limit()),
				numberKey: await failure(() => env.LIMITER.limit({ key: 1 })),
				unsupportedPeriod: await failure(() => env.LIMITER.limit({ key: "a", period: 30 })),
			});
		}
		return new Response("not found", { status: 404 });
	},
};
