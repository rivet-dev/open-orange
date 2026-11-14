import { createServer } from "node:net";

/**
 * A port that a test hands to another process (the Engine, orange serve, MinIO, Docker), which
 * binds it later. `listen(0)` gives a port from Linux's ephemeral range (32768 and up), where an
 * outgoing connection or another `listen(0)` can take it before that process binds it. So the port
 * comes from 10000-19999, below that range and below Orange's Engine ports (20000 and up).
 */
export async function freePort(): Promise<number> {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		const port = 10_000 + Math.floor(Math.random() * 10_000);
		const server = createServer();
		const bound = await new Promise<boolean>((resolveBound) => {
			server.once("error", () => resolveBound(false));
			server.listen(port, "127.0.0.1", () => resolveBound(true));
		});
		if (!bound) continue;
		await new Promise((closed) => server.close(closed));
		return port;
	}
	throw new Error("No free test port in 10000-19999");
}
