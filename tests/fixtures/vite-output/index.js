// Shaped like @cloudflare/vite-plugin output: an already-built entry that
// imports a code-split chunk at runtime.
export default {
	async fetch() {
		const { greet } = await import("./assets/greet-B1x9qZ.js");
		return new Response(greet("vite"));
	},
};
