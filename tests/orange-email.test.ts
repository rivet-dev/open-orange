import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";

import { freePort } from "./free-port.js";
import { mailpitSkip, startMailpit } from "./mailpit.js";
import { copyProject, repositoryRoot, startOrangeDev } from "./orange-dev.js";

const sendEmailFixture = join(repositoryRoot, "tests", "fixtures", "send-email");

async function post(origin: string, path: string): Promise<{ status: number; text: string }> {
	const response = await fetch(`${origin}${path}`, { method: "POST" });
	return { status: response.status, text: await response.text() };
}

test("a Worker's mail reaches the configured SMTP server, as an EmailMessage and as a message object, and a recipient the binding does not allow is refused", { skip: mailpitSkip, timeout: 180_000 }, async () => {
	const mailpit = await startMailpit();
	const project = await copyProject(sendEmailFixture);
	try {
		const dev = await startOrangeDev(project.directory, "wrangler.jsonc", {
			environment: { ORANGE_EMAIL_SMTP_URL: mailpit.smtpUrl },
		});
		try {
			const raw = await post(dev.origin, "/raw");
			assert.equal(raw.status, 200, `${raw.text}\n${dev.output()}`);
			assert.deepEqual(JSON.parse(raw.text), { messageId: "<raw-1@example.com>" });

			const object = await post(dev.origin, "/object");
			assert.equal(object.status, 200, `${object.text}\n${dev.output()}`);
			const { messageId } = JSON.parse(object.text) as { messageId: string };
			assert.match(messageId, /^<.+@.+>$/);

			const refused = await post(dev.origin, "/stranger");
			assert.equal(refused.status, 500);
			assert.match(refused.text, /may not send to stranger@example\.com: it is not in allowed_destination_addresses/);
		} finally {
			await dev.close();
		}

		const received = await mailpit.messages();
		assert.deepEqual(received.map((message) => message.Subject).sort(), ["object hello", "raw hello"]);
		const rawMessage = await mailpit.message(received.find((message) => message.Subject === "raw hello")!.ID);
		assert.equal(rawMessage.Text.trim(), "raw body");
		const objectMessage = await mailpit.message(received.find((message) => message.Subject === "object hello")!.ID);
		assert.deepEqual(objectMessage.From, { Address: "sender@example.com", Name: "Sender" });
		assert.deepEqual(objectMessage.To.map((to) => to.Address), ["inbox@example.com"]);
		assert.deepEqual(objectMessage.Cc.map((cc) => cc.Address), ["copy@example.com"]);
		// Bcc reaches its recipient through the SMTP envelope, not as a header.
		assert.deepEqual(objectMessage.Bcc.map((bcc) => bcc.Address), ["hidden@example.com"]);
		assert.equal(objectMessage.Text.trim(), "text body");
		assert.equal(objectMessage.HTML.trim(), "<p>html body</p>");
		assert.deepEqual(objectMessage.Attachments.map((attachment) => attachment.FileName), ["note.txt"]);
	} finally {
		await project.dispose();
		await mailpit.stop();
	}
});

test("without an SMTP server send() fails with the setting to configure, and with the server down it names the server", { timeout: 180_000 }, async () => {
	const project = await copyProject(sendEmailFixture);
	try {
		const unconfigured = await startOrangeDev(project.directory, "wrangler.jsonc", {
			environment: { ORANGE_EMAIL_SMTP_URL: "" },
		});
		try {
			const result = await post(unconfigured.origin, "/raw");
			assert.equal(result.status, 500);
			assert.match(result.text, /Send Email binding "MAIL" is not supported by OpenOrange\. Set ORANGE_EMAIL_SMTP_URL/);
		} finally {
			await unconfigured.close();
		}

		const closedPort = await freePort();
		const down = await startOrangeDev(project.directory, "wrangler.jsonc", {
			environment: { ORANGE_EMAIL_SMTP_URL: `smtp://user:secret@127.0.0.1:${closedPort}` },
		});
		try {
			const result = await post(down.origin, "/raw");
			assert.equal(result.status, 500);
			assert.match(result.text, new RegExp(`Sending email through smtp://127\\.0\\.0\\.1:${closedPort} failed`));
			assert.doesNotMatch(result.text, /secret/);
		} finally {
			await down.close();
		}
	} finally {
		await project.dispose();
	}
});

const inboundEmailFixture = join(repositoryRoot, "tests", "fixtures", "inbound-email");

const inboundMessage = [
	"From: Alice <alice@example.org>",
	"To: inbox@example.com",
	"Subject: Hello",
	"Message-ID: <hello-1@example.org>",
	"Content-Type: text/plain; charset=utf-8",
	"",
	"Hi there.",
	"",
].join("\r\n");

function deliver(origin: string, body: string, init: RequestInit = {}): Promise<Response> {
	return fetch(`${origin}/cdn-cgi/handler/email?from=alice@example.org&to=inbox@example.com`, { body, method: "POST", ...init });
}

test("a raw MIME message POSTed to orange dev reaches email(), whose forward() and reply() go out through the SMTP server, and a malformed message is refused", { skip: mailpitSkip, timeout: 180_000 }, async () => {
	const mailpit = await startMailpit();
	const project = await copyProject(inboundEmailFixture);
	try {
		const dev = await startOrangeDev(project.directory, "wrangler.jsonc", {
			environment: { ORANGE_EMAIL_INBOUND_SECRET: "", ORANGE_EMAIL_SMTP_URL: mailpit.smtpUrl },
		});
		try {
			const delivered = await deliver(dev.origin, inboundMessage);
			assert.equal(delivered.status, 200, `${await delivered.clone().text()}\n${dev.output()}`);

			const malformed = await deliver(dev.origin, "this is not an email");
			assert.equal(malformed.status, 400);
			assert.match(await malformed.text(), /could not be parsed/);
		} finally {
			await dev.close();
		}

		const received = await mailpit.messages();
		// A forward keeps the message as it arrived, so `team@example.com` is only its envelope
		// recipient, which Mailpit lists as Bcc.
		const forwarded = received.find((message) => message.Subject === "Hello");
		assert.ok(forwarded !== undefined, JSON.stringify(received));
		assert.deepEqual(forwarded.To.map((to) => to.Address), ["inbox@example.com"]);
		assert.deepEqual(forwarded.Bcc.map((bcc) => bcc.Address), ["team@example.com"]);
		assert.deepEqual((await mailpit.headers(forwarded.ID))["X-Orange"], ["forwarded"]);
		const reply = received.find((message) => message.To.some((to) => to.Address === "alice@example.org"));
		assert.ok(reply !== undefined, JSON.stringify(received));
		assert.equal(reply.Subject, "Re: Hello");
		assert.equal((await mailpit.message(reply.ID)).Text.trim(), `Got ${Buffer.byteLength(inboundMessage)} bytes.`);
		assert.equal(received.length, 2);
	} finally {
		await project.dispose();
		await mailpit.stop();
	}
});

test("when forward() cannot reach the SMTP server, the inbound POST fails with an error that names the server", { timeout: 120_000 }, async () => {
	const project = await copyProject(inboundEmailFixture);
	try {
		const closedPort = await freePort();
		const dev = await startOrangeDev(project.directory, "wrangler.jsonc", {
			environment: { ORANGE_EMAIL_INBOUND_SECRET: "", ORANGE_EMAIL_SMTP_URL: `smtp://127.0.0.1:${closedPort}` },
		});
		try {
			const delivered = await deliver(dev.origin, inboundMessage);
			assert.equal(delivered.status, 500);
			assert.match(await delivered.text(), new RegExp(`Sending email through smtp://127\\.0\\.0\\.1:${closedPort} failed`));
		} finally {
			await dev.close();
		}
	} finally {
		await project.dispose();
	}
});
