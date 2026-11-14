import { DurableObject } from "cloudflare:workers";

function captureError(callback) {
	try {
		callback();
		return null;
	} catch (error) {
		return {
			message: error instanceof Error ? error.message : String(error),
			name: error instanceof Error ? error.name : typeof error,
		};
	}
}

function captureErrorName(callback) {
	return captureError(callback)?.name ?? null;
}

let nextGeneration = 0;
let physicalCloseEvents = 0;

export class SocketRegistry extends DurableObject {
	constructor(ctx, env) {
		super(ctx, env);
		this.generation = ++nextGeneration;
	}

	async alarm(alarmInfo) {
		const alarmTest = this.alarmTest;
		if (alarmTest === undefined) return;
		const attempt = {
			isRetry: alarmInfo.isRetry,
			retryCount: alarmInfo.retryCount,
			scheduledTimeMatches:
				alarmInfo.scheduledTime === alarmTest.scheduledTime,
			visibleAlarm: await this.ctx.storage.getAlarm(),
		};
		alarmTest.attempts.push(attempt);
		alarmTest.complete =
			!alarmTest.failFirst || alarmTest.attempts.length > 1;
		if (!alarmTest.complete) throw new Error("alarm fixture first attempt");
	}

	async fetch(request) {
		const url = new URL(request.url);
		if (url.searchParams.has("alarm-dispatch-start")) {
			const scheduledTime = Date.now() + 100;
			this.alarmTest = {
				attempts: [],
				complete: false,
				failFirst: url.searchParams.has("alarm-dispatch-retry"),
				scheduledTime,
			};
			await this.ctx.storage.setAlarm(scheduledTime);
			return Response.json({ scheduled: true });
		}
		if (url.searchParams.has("alarm-dispatch-status")) {
			const alarmTest = this.alarmTest;
			return Response.json({
				attempts: alarmTest?.attempts ?? [],
				complete: alarmTest?.complete ?? false,
				currentAlarm: await this.ctx.storage.getAlarm(),
			});
		}
		if (url.searchParams.has("alarm-storage")) {
			const firstTime = 2_000_000_000_000;
			const secondTime = firstTime + 1_000;
			const initial = await this.ctx.storage.getAlarm();
			await this.ctx.storage.setAlarm(firstTime);
			const first = await this.ctx.storage.getAlarm();
			await this.ctx.storage.transaction(async (transaction) => {
				await transaction.setAlarm(secondTime);
				transaction.rollback();
			});
			const afterRollback = await this.ctx.storage.getAlarm();
			await this.ctx.storage.transaction(async (transaction) => {
				await transaction.setAlarm(secondTime);
			});
			const afterCommit = await this.ctx.storage.getAlarm();
			await this.ctx.storage.deleteAlarm();
			const afterDelete = await this.ctx.storage.getAlarm();
			return Response.json({
				afterCommit,
				afterDelete,
				afterRollback,
				first,
				initial,
			});
		}
		if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
			const id = url.searchParams.get("id") ?? "socket";
			const physical = url.searchParams.has("physical");
			this.ctx.setWebSocketAutoResponse(
				new WebSocketRequestResponsePair("ping", "pong"),
			);
			const pair = new WebSocketPair();
			this.ctx.acceptWebSocket(pair[1], [id]);
			pair[1].serializeAttachment({
				connectionGeneration: this.generation,
				count: 0,
				physical,
			});
			pair[1].addEventListener("message", () => {
				pair[1].send("ordinary-message-listener-fired");
			});
			return new Response(null, { status: 101, webSocket: pair[0] });
		}
		if (url.searchParams.has("physical-inspect")) {
			return Response.json({
				active: this.ctx.getWebSockets("physical").length,
				closeEvents: physicalCloseEvents,
			});
		}

		const initialTimeout = this.ctx.getHibernatableWebSocketEventTimeout();
		this.ctx.setHibernatableWebSocketEventTimeout(12_345);
		const configuredTimeout = this.ctx.getHibernatableWebSocketEventTimeout();
		this.ctx.setHibernatableWebSocketEventTimeout(0);
		const clearedTimeout = this.ctx.getHibernatableWebSocketEventTimeout();

		const first = new WebSocketPair();
		const second = new WebSocketPair();
		this.ctx.acceptWebSocket(first[1], ["team", "alice", "team"]);
		this.ctx.acceptWebSocket(second[1], ["team", "bob"]);
		const shared = { value: 7 };
		const attachment = {
			bytes: new Uint8Array([1, 2, 3]),
			left: shared,
			right: shared,
		};
		attachment.self = attachment;
		first[1].serializeAttachment(attachment);
		const decodedAttachment = first[1].deserializeAttachment();
		const decodedAgain = first[1].deserializeAttachment();
		const firstTags = this.ctx.getTags(first[1]);
		firstTags.push("mutated");

		const alreadyAccepted = new WebSocketPair();
		alreadyAccepted[1].accept();
		const peerAccepted = new WebSocketPair();
		peerAccepted[0].accept();
		const unknown = new WebSocketPair();
		const initialAutoResponse = this.ctx.getWebSocketAutoResponse();
		const configuredPair = new WebSocketRequestResponsePair("ping", "pong");
		this.ctx.setWebSocketAutoResponse(configuredPair);
		const configuredAutoResponse = this.ctx.getWebSocketAutoResponse();
		const configuredAutoResponseAgain = this.ctx.getWebSocketAutoResponse();
		const initialAutoResponseTimestamp =
			this.ctx.getWebSocketAutoResponseTimestamp(first[1]);
		this.ctx.setWebSocketAutoResponse();
		const clearedAutoResponse = this.ctx.getWebSocketAutoResponse();

		return Response.json({
			autoResponses: {
				cleared: clearedAutoResponse,
				configured: configuredAutoResponse && {
					request: configuredAutoResponse.request,
					response: configuredAutoResponse.response,
				},
				fresh:
					configuredAutoResponse !== configuredAutoResponseAgain &&
					configuredAutoResponse !== configuredPair,
				initial: initialAutoResponse,
				timestamp: initialAutoResponseTimestamp,
			},
			attachments: {
				aliases: decodedAttachment.left === decodedAttachment.right,
				bytes: [...decodedAttachment.bytes],
				cycle: decodedAttachment.self === decodedAttachment,
				fresh: decodedAttachment !== decodedAgain,
				initial: new WebSocketPair()[1].deserializeAttachment(),
			},
			counts: {
				all: this.ctx.getWebSockets().length,
				alice: this.ctx.getWebSockets("alice").length,
				missing: this.ctx.getWebSockets("missing").length,
				team: this.ctx.getWebSockets("team").length,
			},
			errors: {
				attachmentClone: captureErrorName(() =>
					second[1].serializeAttachment(() => undefined),
				),
				accepted: captureError(() =>
					this.ctx.acceptWebSocket(alreadyAccepted[1]),
				),
				peer: captureError(() => this.ctx.acceptWebSocket(peerAccepted[1])),
				tagsUnknown: captureError(() => this.ctx.getTags(unknown[1])),
			},
			identity: this.ctx.getWebSockets("alice")[0] === first[1],
			tags: {
				first: this.ctx.getTags(first[1]),
				second: this.ctx.getTags(second[1]),
			},
			timeouts: {
				cleared: clearedTimeout,
				configured: configuredTimeout,
				initial: initialTimeout,
			},
		});
	}

	async webSocketMessage(socket, message) {
		await Promise.resolve();
		const attachment = socket.deserializeAttachment();
		attachment.count += 1;
		socket.serializeAttachment(attachment);
		if (attachment.physical) {
			const autoResponse = this.ctx.getWebSocketAutoResponse();
			socket.send(
				JSON.stringify({
					attachmentCount: attachment.count,
					autoResponse: autoResponse && {
						request: autoResponse.request,
						response: autoResponse.response,
					},
					connectionGeneration: attachment.connectionGeneration,
					eventGeneration: this.generation,
					message,
					tags: this.ctx.getTags(socket),
				}),
			);
			return;
		}
		if (typeof message === "string") {
			const autoResponse = this.ctx.getWebSocketAutoResponse();
			const timestamp = this.ctx.getWebSocketAutoResponseTimestamp(socket);
			socket.send(
				JSON.stringify({
					autoResponse: autoResponse && {
						request: autoResponse.request,
						response: autoResponse.response,
					},
					attachmentCount: attachment.count,
					message,
					tags: this.ctx.getTags(socket),
					timestampIsDate: timestamp instanceof Date,
				}),
			);
			return;
		}
		socket.send(message);
	}

	webSocketClose(socket) {
		if (socket.deserializeAttachment()?.physical) physicalCloseEvents += 1;
	}
}

export default {
	async fetch(request, env) {
		const id = new URL(request.url).searchParams.get("id") ?? "registry";
		return await env.SOCKETS.getByName(id).fetch(request);
	},
};
