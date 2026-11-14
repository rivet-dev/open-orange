import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import { copyProject, repositoryRoot, startOrangeDev } from "../harness/orange-dev.js";

const fixture = join(repositoryRoot, "tests", "fixtures", "hyperdrive");
const variable = "CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE";

test("a Worker reads env.HYPERDRIVE fields from the environment variable over localConnectionString, decoded like Miniflare", async () => {
	const project = await copyProject(fixture);
	process.env[variable] = "postgresql://env-user:s3cret@127.0.0.1/envdb";
	try {
		const dev = await startOrangeDev(project.directory);
		try {
			const fromEnv = await fetch(`${dev.origin}/?binding=HYPERDRIVE`);
			assert.equal(fromEnv.status, 200, dev.output());
			assert.deepEqual(await fromEnv.json(), {
				connectionString: "postgresql://env-user:s3cret@127.0.0.1/envdb",
				database: "envdb",
				host: "127.0.0.1",
				password: "s3cret",
				port: 5432,
				user: "env-user",
			});
			const fromConfig = await fetch(`${dev.origin}/?binding=FROM_CONFIG`);
			assert.equal(fromConfig.status, 200, dev.output());
			assert.deepEqual(await fromConfig.json(), {
				connectionString: "mysql://app%40team:p%40ss%3Aw%2Frd%20%25@db.internal/shop%20db",
				database: "shop db",
				host: "db.internal",
				password: "p@ss:w/rd %",
				port: 3306,
				user: "app@team",
			});
			assert.match(dev.output(), /env\.HYPERDRIVE\s+Hyperdrive\s+Direct connection/);
		} finally {
			await dev.close();
		}
	} finally {
		delete process.env[variable];
		await project.dispose();
	}
});

test("orange dev fails to start with the Wrangler error when a Hyperdrive binding has no connection string", async () => {
	const project = await copyProject(fixture);
	try {
		await assert.rejects(
			startOrangeDev(project.directory, "wrangler.missing.jsonc"),
			(error: Error) => {
				assert.match(
					error.message,
					/When developing locally, you should use a local Postgres connection string to emulate Hyperdrive functionality\. Please setup Postgres locally and set the value of the 'CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE' variable or "HYPERDRIVE"'s "localConnectionString" to the Postgres connection string\./,
				);
				return true;
			},
		);
	} finally {
		await project.dispose();
	}
});
