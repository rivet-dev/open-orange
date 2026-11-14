import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { CreateBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { freePort } from "./free-port.js";

// A real MinIO server, the S3-compatible store that R2's S3 backend talks to. It runs from
// OPEN_ORANGE_TEST_MINIO_BINARY when set, otherwise as a Docker container. With neither, tests
// that need it skip with `minioSkip`.

export interface S3Store {
	accessKeyId: string;
	endpoint: string;
	secretAccessKey: string;
	stop(): Promise<void>;
}

const minioBinary = process.env.OPEN_ORANGE_TEST_MINIO_BINARY;
const dockerAvailable =
	minioBinary === undefined && spawnSync("docker", ["version"], { stdio: "ignore" }).status === 0;

export const minioSkip: string | false =
	minioBinary === undefined && !dockerAvailable
		? "needs Docker or OPEN_ORANGE_TEST_MINIO_BINARY to run a real MinIO server"
		: false;

function stopChild(child: ChildProcess): Promise<void> {
	return new Promise<void>((resolveStop) => {
		if (child.exitCode !== null || child.signalCode !== null) {
			resolveStop();
			return;
		}
		const timeout = setTimeout(() => child.kill("SIGKILL"), 15_000);
		child.once("exit", () => {
			clearTimeout(timeout);
			resolveStop();
		});
		child.kill("SIGTERM");
	});
}

// Starts a real MinIO server on a free port, as a process from
// OPEN_ORANGE_TEST_MINIO_BINARY or as a uniquely named Docker container.
export async function startMinio(): Promise<S3Store> {
	const port = await freePort();
	const accessKeyId = "orange-test";
	const secretAccessKey = randomBytes(16).toString("hex");
	const credentials = { MINIO_ROOT_PASSWORD: secretAccessKey, MINIO_ROOT_USER: accessKeyId };
	let stop: () => Promise<void>;
	if (minioBinary !== undefined) {
		const dataDirectory = await mkdtemp(join(tmpdir(), "open-orange-minio-"));
		const child = spawn(
			minioBinary,
			["server", dataDirectory, "--address", `127.0.0.1:${port}`, "--console-address", "127.0.0.1:0"],
			{ env: { ...process.env, ...credentials }, stdio: "ignore" },
		);
		stop = async () => {
			await stopChild(child);
			await rm(dataDirectory, { force: true, recursive: true });
		};
	} else {
		const name = `open-orange-r2-minio-${randomBytes(4).toString("hex")}`;
		const run = spawnSync(
			"docker",
			[
				"run",
				"--detach",
				"--rm",
				"--name",
				name,
				"--publish",
				`127.0.0.1:${port}:9000`,
				"--env",
				`MINIO_ROOT_USER=${accessKeyId}`,
				"--env",
				`MINIO_ROOT_PASSWORD=${secretAccessKey}`,
				"cgr.dev/chainguard/minio:latest",
				"server",
				"/data",
			],
			{ encoding: "utf8" },
		);
		if (run.status !== 0) throw new Error(`docker run failed: ${run.stderr}`);
		stop = async () => {
			spawnSync("docker", ["rm", "--force", name], { stdio: "ignore" });
		};
	}
	const endpoint = `http://127.0.0.1:${port}`;
	// MinIO has no readiness signal, so the test polls its health endpoint.
	for (let attempt = 0; ; attempt += 1) {
		try {
			if ((await fetch(`${endpoint}/minio/health/live`)).ok) break;
		} catch {}
		if (attempt >= 300) {
			await stop();
			throw new Error("MinIO did not become ready");
		}
		await delay(100);
	}
	return { accessKeyId, endpoint, secretAccessKey, stop };
}

export function s3Client(store: S3Store): S3Client {
	return new S3Client({
		credentials: { accessKeyId: store.accessKeyId, secretAccessKey: store.secretAccessKey },
		endpoint: store.endpoint,
		forcePathStyle: true,
		region: "us-east-1",
	});
}

// Creates a new bucket and returns the ORANGE_R2_<BUCKET>_S3_* settings that point a binding's
// bucket name at it.
export async function minioBucketSettings(store: S3Store, bucketName: string): Promise<{ bucket: string; env: Record<string, string> }> {
	const bucket = `orange-r2-${randomBytes(4).toString("hex")}`;
	const client = s3Client(store);
	await client.send(new CreateBucketCommand({ Bucket: bucket }));
	client.destroy();
	const prefix = `ORANGE_R2_${bucketName.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_S3_`;
	return {
		bucket,
		env: {
			[`${prefix}ACCESS_KEY_ID`]: store.accessKeyId,
			[`${prefix}BUCKET`]: bucket,
			[`${prefix}ENDPOINT`]: store.endpoint,
			[`${prefix}REGION`]: "us-east-1",
			[`${prefix}SECRET_ACCESS_KEY`]: store.secretAccessKey,
		},
	};
}
