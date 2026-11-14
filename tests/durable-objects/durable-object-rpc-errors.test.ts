import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import { copyProject, repositoryRoot, startOrangeDev } from "../harness/orange-dev.js";

test(
	"an error thrown or returned by a Durable Object method reaches the Worker with its name and own fields",
	{ timeout: 180_000 },
	async () => {
		const project = await copyProject(join(repositoryRoot, "tests", "fixtures", "rpc-errors"));
		try {
			const dev = await startOrangeDev(project.directory);
			try {
				for (const path of ["/thrown", "/returned"]) {
					const response = await fetch(new URL(path, dev.origin));
					assert.equal(response.status, 200, `${await response.clone().text()}\n${dev.output()}`);
					assert.deepEqual(
						await response.json(),
						{ code: "ENOENT", message: "no such file", name: "FileError" },
						path,
					);
				}
			} finally {
				await dev.close();
			}
		} finally {
			await project.dispose();
		}
	},
);
