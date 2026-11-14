import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { copyProject, repositoryRoot, startOrangeDev } from "../harness/orange-dev.js";

const fixture = join(repositoryRoot, "tests", "fixtures", "orange-settings");
const unreachableEndpoint = "http://127.0.0.1:9";

test("an ORANGE_R2_<BUCKET>_S3_* setting in .dev.vars moves the bucket to S3", async () => {
	const project = await copyProject(fixture);
	await writeFile(
		join(project.directory, ".dev.vars"),
		[
			`ORANGE_R2_MEDIA_S3_ENDPOINT=${unreachableEndpoint}`,
			"ORANGE_R2_MEDIA_S3_ACCESS_KEY_ID=key",
			"ORANGE_R2_MEDIA_S3_SECRET_ACCESS_KEY=secret",
			"",
		].join("\n"),
	);
	try {
		const dev = await startOrangeDev(project.directory);
		try {
			// The default SQLite backend would store the object. The S3 endpoint
			// from .dev.vars does not answer, so the put fails.
			const response = await fetch(dev.origin);
			assert.equal(response.status, 500, dev.output());
		} finally {
			await dev.close();
		}
	} finally {
		await project.dispose();
	}
});

test("a shell ORANGE_* setting wins over the same setting in .dev.vars", async () => {
	const project = await copyProject(fixture);
	await writeFile(
		join(project.directory, ".dev.vars"),
		`ORANGE_R2_MEDIA_S3_ENDPOINT=${unreachableEndpoint}\n`,
	);
	process.env.ORANGE_R2_MEDIA_S3_ENDPOINT = "";
	try {
		const dev = await startOrangeDev(project.directory);
		try {
			const response = await fetch(dev.origin);
			assert.equal(response.status, 200, dev.output());
			assert.equal(await response.text(), "stored");
		} finally {
			await dev.close();
		}
	} finally {
		delete process.env.ORANGE_R2_MEDIA_S3_ENDPOINT;
		await project.dispose();
	}
});
