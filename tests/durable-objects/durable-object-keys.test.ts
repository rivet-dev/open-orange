import assert from "node:assert/strict";
import { glob, readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { durableObjectActorName } from "../../packages/runtime-node/src/bindings/durable-objects/actor-routing.js";

import { resolveDeploymentStorage } from "../../src/runtime/deployment.js";
import {
	copyProject,
	repositoryRoot,
	startOrangeDev,
	type RunningOrangeDev,
} from "../harness/orange-dev.js";

interface ObjectView {
	id: string;
	name: string | null;
	value: string | null;
}

const workerName = "orange-test-readable-keys";
const engineHeaders = { authorization: "Bearer default", "content-type": "application/json" };

async function call(dev: RunningOrangeDev, query: Record<string, string>): Promise<ObjectView> {
	const response = await fetch(`${dev.origin}/?${new URLSearchParams(query)}`);
	assert.equal(response.status, 200, `${await response.clone().text()}\n${dev.output()}`);
	return (await response.json()) as ObjectView;
}

async function engineEndpoint(projectDirectory: string): Promise<string> {
	for await (const path of glob(".open-orange/rivetkit/*/.rivetkit/var/engine/runtime.json", {
		cwd: projectDirectory,
	})) {
		const runtime = JSON.parse(await readFile(join(projectDirectory, path), "utf8")) as {
			endpoint: string;
		};
		return runtime.endpoint;
	}
	throw new Error("The project has no running Rivet Engine");
}

async function engineActorKeys(endpoint: string, name: string): Promise<string[]> {
	const url = new URL("/actors", endpoint);
	url.searchParams.set("namespace", "default");
	url.searchParams.set("name", name);
	const response = await fetch(url, { headers: engineHeaders });
	assert.equal(response.status, 200, await response.clone().text());
	const body = (await response.json()) as { actors: { key: string }[] };
	return body.actors.map((actor) => actor.key).sort();
}

// The actor names the Engine lists. The v3 Engine drops each name's metadata, display name included.
async function engineActorNames(endpoint: string): Promise<string[]> {
	const url = new URL("/actors/names", endpoint);
	url.searchParams.set("namespace", "default");
	const response = await fetch(url, { headers: engineHeaders });
	assert.equal(response.status, 200, await response.clone().text());
	const body = (await response.json()) as { names: Record<string, unknown> };
	return Object.keys(body.names);
}

test(
	"Durable Object IDs reach the same object by name, by ID string, after a restart, and from another Worker",
	{ timeout: 180_000 },
	async () => {
		const project = await copyProject(join(repositoryRoot, "tests", "fixtures", "readable-keys"));
		try {
			const { deploymentIdentity } = await resolveDeploymentStorage({
				environment: undefined,
				projectRoot: project.directory,
				workerName,
			});
			const names = ["World", "a/b\\c", "", "héllo 🌍"];
			const ids = new Map<string, string>();
			let unique: ObjectView;
			let euWorld: ObjectView;
			const first = await startOrangeDev(project.directory);
			try {
				for (const name of names) {
					const written = await call(first, { name, value: `v:${name}` });
					ids.set(name, written.id);
					// An ID passed around as a string reaches the named object, which keeps its name.
					assert.deepEqual(await call(first, { id: written.id }), {
						id: written.id,
						name,
						value: `v:${name}`,
					});
				}
				// The same name in a jurisdiction is another object.
				euWorld = await call(first, { eu: "", name: "World" });
				assert.notEqual(euWorld.id, ids.get("World"));
				assert.equal(euWorld.value, null);
				await call(first, { eu: "", name: "World", value: "eu" });
				assert.equal((await call(first, { name: "World" })).value, "v:World");
				unique = await call(first, { value: "unique" });

				// The Engine lists only readable names, and Orange's own actors say so.
				const actorNames = await engineActorNames(await engineEndpoint(project.directory));
				assert.deepEqual(actorNames.filter((name) => name.startsWith("openorange_")), []);
				const greeter = durableObjectActorName(deploymentIdentity, "Greeter");
				assert.match(greeter, /^greeter-/);
				assert.ok(actorNames.includes(greeter), actorNames.join());
				const facets = durableObjectActorName(deploymentIdentity, "#facet");
				assert.match(facets, /^facet-/);
				assert.ok(actorNames.includes(facets), actorNames.join());
				const cache = durableObjectActorName(deploymentIdentity, "openorange:cache");
				assert.match(cache, /^openorange-cache-/);
				assert.ok(actorNames.includes(cache), actorNames.join());
			} finally {
				await first.close();
			}

			const second = await startOrangeDev(project.directory);
			try {
				for (const name of names) {
					const id = ids.get(name) ?? "";
					// A new process reaches each object by its ID string and by its name.
					assert.equal((await call(second, { id })).value, `v:${name}`);
					assert.deepEqual(await call(second, { name }), { id, name, value: `v:${name}` });
				}
				assert.equal((await call(second, { id: unique.id })).value, "unique");
				assert.equal((await call(second, { eu: "", id: euWorld.id })).value, "eu");

				const endpoint = await engineEndpoint(project.directory);
				const actorName = durableObjectActorName(deploymentIdentity, "Greeter");
				assert.match(actorName, /^greeter-[0-9a-f]{8}$/);
				// The actor key is the ID, after the jurisdiction when there is one.
				assert.deepEqual(
					await engineActorKeys(endpoint, actorName),
					[...ids.values(), unique.id, `eu/${euWorld.id}`].sort(),
				);
			} finally {
				await second.close();
			}

			// In a session the caller Worker reaches the Greeter Worker's objects through
			// `script_name`, by ID strings that the Greeter Worker made.
			const sessionConfigs = ["caller/wrangler.jsonc", "wrangler.jsonc"];
			let sessionId: string;
			const third = await startOrangeDev(project.directory, sessionConfigs);
			try {
				sessionId = (await call(third, { direct: "", name: "Shared", value: "shared" })).id;
				assert.deepEqual(await call(third, { id: sessionId }), {
					id: sessionId,
					name: "Shared",
					value: "shared",
				});
			} finally {
				await third.close();
			}
			const fourth = await startOrangeDev(project.directory, sessionConfigs);
			try {
				assert.equal((await call(fourth, { id: sessionId })).value, "shared");
				assert.equal((await call(fourth, { name: "Shared" })).value, "shared");
			} finally {
				await fourth.close();
			}
		} finally {
			await project.dispose();
		}
	},
);
