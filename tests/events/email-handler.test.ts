import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import { copyProject, repositoryRoot, startOrangeDev } from "../harness/orange-dev.js";

const mail = (subject: string, messageId = "Message-ID: <1@example.net>\r\n") =>
	`From: a@example.net\r\nTo: b@example.com\r\nBcc: hidden@example.com\r\n${messageId}Subject: ${subject}\r\nX-Folded: one\r\n two\r\n\r\nbody\r\n`;

// Expected values are `wrangler dev` 4.129.0's output for the same fixture.
test("POST /cdn-cgi/handler/email runs a Worker's email() handler in orange dev", { timeout: 120_000 }, async () => {
	const project = await copyProject(join(repositoryRoot, "tests", "fixtures", "email-handler"));
	try {
		const dev = await startOrangeDev(project.directory, "wrangler.jsonc", { environment: { ORANGE_EMAIL_SMTP_URL: "" } });
		const send = async (query: string, body: string): Promise<[number, string]> => {
			const response = await fetch(`${dev.origin}/cdn-cgi/handler/email${query}`, { body, method: "POST" });
			return [response.status, await response.text()];
		};
		const addresses = "?from=a%40example.net&to=b%40example.com";
		try {
			assert.deepEqual(await send(addresses, mail("hi")), [200, "Worker successfully processed email"], dev.output());
			const delivered = "From: a@example.net\r\nTo: b@example.com\r\nMessage-ID: <1@example.net>\r\nSubject: hi\r\nX-Folded: one\r\n two\r\n\r\nbody\r\n";
			assert.deepEqual(await (await fetch(dev.origin)).json(), {
				reachedFetch: "/",
				last: {
					bccHeader: null,
					folded: "one two",
					from: "a@example.net",
					raw: delivered,
					rawSize: delivered.length,
					subject: "hi",
					to: "b@example.com",
				},
			});

			assert.deepEqual(await send(addresses, mail("reject")), [400, "Worker rejected email with the following reason: not wanted"]);
			const [thrownStatus, thrown] = await send(addresses, mail("throw"));
			assert.equal(thrownStatus, 500);
			assert.match(thrown, /handler failed/);
			// Without an SMTP server, unlike Wrangler, which reports success and delivers nothing: this
			// mail would be lost.
			for (const method of ["forward", "reply"]) {
				const [status, body] = await send(addresses, mail(method));
				assert.equal(status, 500);
				assert.match(body, new RegExp(`message\\.${method}\\(\\) needs ORANGE_EMAIL_SMTP_URL`));
			}
			assert.deepEqual(await send("?from=a%40example.net", mail("hi")), [
				400,
				"Invalid email. Your request must include URL parameters specifying the `from` and `to` addresses, as well as an email in the body",
			]);
			assert.deepEqual(await send(addresses, mail("hi", "")), [400, "Email could not be parsed: invalid or no message id provided"]);
		} finally {
			await dev.close();
		}
	} finally {
		await project.dispose();
	}
});
