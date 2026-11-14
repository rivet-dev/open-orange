// Records every scheduled() run in KV. The cron string picks the outcome, so
// one Worker covers success, a throwing handler, and a rejected waitUntil().
export default {
	async fetch(request, env) {
		const url = new URL(request.url);
		if (url.pathname !== "/runs") return new Response("Not Found", { status: 404 });
		const { keys } = await env.KV.list({ prefix: "run:" });
		const runs = await Promise.all(keys.map(({ name }) => env.KV.get(name, "json")));
		return Response.json(runs);
	},

	async scheduled(controller, env, ctx) {
		await env.KV.put(
			`run:${controller.scheduledTime}:${crypto.randomUUID()}`,
			JSON.stringify({ cron: controller.cron, scheduledTime: controller.scheduledTime }),
		);
		if (controller.cron === "no-retry") controller.noRetry();
		if (controller.cron === "wait-until-rejects") {
			ctx.waitUntil(Promise.reject(new Error("waitUntil() rejected")));
		}
		if (controller.cron === "throws" || controller.cron === "* * * * *") {
			throw new Error(`scheduled() failed for ${controller.cron}`);
		}
	},
};
