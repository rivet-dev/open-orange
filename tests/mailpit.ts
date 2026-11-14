import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

import { freePort } from "./free-port.js";

// A real SMTP server: Mailpit in Docker. Tests read what it received through its HTTP API.
// https://mailpit.axllent.org/docs/api-v1/

export const mailpitSkip: string | false =
	spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0 ? false : "Docker is not running, so Mailpit cannot start";

export interface MailpitAddress {
	Address: string;
	Name: string;
}

export interface MailpitSummary {
	Bcc: MailpitAddress[];
	Cc: MailpitAddress[];
	From: MailpitAddress;
	ID: string;
	Subject: string;
	To: MailpitAddress[];
}

export interface MailpitMessage extends MailpitSummary {
	Attachments: { ContentType: string; FileName: string }[];
	HTML: string;
	Text: string;
}

export interface Mailpit {
	headers(id: string): Promise<Record<string, string[]>>;
	message(id: string): Promise<MailpitMessage>;
	messages(): Promise<MailpitSummary[]>;
	smtpUrl: string;
	stop(): Promise<void>;
}

export async function startMailpit(): Promise<Mailpit> {
	const [smtpPort, httpPort] = [await freePort(), await freePort()];
	const name = `oo-mailpit-${randomBytes(4).toString("hex")}`;
	const run = spawnSync(
		"docker",
		["run", "--detach", "--rm", "--name", name, "-p", `127.0.0.1:${smtpPort}:1025`, "-p", `127.0.0.1:${httpPort}:8025`, "axllent/mailpit:v1.27"],
		{ encoding: "utf8" },
	);
	assert.equal(run.status, 0, run.stderr);
	const api = `http://127.0.0.1:${httpPort}/api/v1`;
	const stop = async (): Promise<void> => {
		spawnSync("docker", ["rm", "--force", name], { stdio: "ignore" });
	};
	for (let attempt = 0; ; attempt += 1) {
		const ready = await fetch(`${api}/info`).then((response) => response.ok).catch(() => false);
		if (ready) break;
		if (attempt >= 300) {
			await stop();
			throw new Error("Mailpit did not become ready");
		}
		await delay(100);
	}
	return {
		async headers(id) {
			return (await (await fetch(`${api}/message/${id}/headers`)).json()) as Record<string, string[]>;
		},
		async message(id) {
			return (await (await fetch(`${api}/message/${id}`)).json()) as MailpitMessage;
		},
		async messages() {
			return ((await (await fetch(`${api}/messages`)).json()) as { messages: MailpitSummary[] }).messages;
		},
		smtpUrl: `smtp://127.0.0.1:${smtpPort}`,
		stop,
	};
}
