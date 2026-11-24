import { setTimeout as delay } from "node:timers/promises";

import type { RivetActorHandle } from "../../internal/rivetkit.js";
import { generationRetiredError } from "./routes.js";

const admissionRetryLimit = 5;
const admissionRetryDelayMilliseconds = 25;

// Envoy answers 503 with one of these codes when it rejects a request before the actor admits it:
// the routed generation already stopped, or the actor is not on that envoy yet. The object never
// saw the call. RivetKit returns these responses to the caller instead of retrying them, because
// a streamed body may already be partly sent. An RPC batch body is a buffered string, and a fetch
// without a body has none, so Orange resends them, and the gateway routes the retry to the
// object's next generation.
// https://github.com/rivet-dev/rivet/blob/a00b07f483aa3fb07ab403614bcb79d7a8be0322/engine/sdks/rust/envoy-client/src/tunnel.rs#L481-L551
// https://github.com/rivet-dev/rivet/blob/a00b07f483aa3fb07ab403614bcb79d7a8be0322/rivetkit-typescript/packages/rivetkit/src/client/actor-handle.ts#L535-L558
// Orange answers the same way for a generation that ctx.abort(), sleep, or destroy retired.
// The v3 gateway replaces both envoy codes with guard.actor_stopped_while_waiting.
// https://github.com/rivet-dev/rivet/blob/a00b07f483aa3fb07ab403614bcb79d7a8be0322/engine/packages/pegboard-gateway/src/http_tunnel.rs#L313-L340
const admissionRejections: ReadonlySet<string> = new Set([
	"envoy.actor_generation_mismatch",
	"envoy.actor_not_found",
	"guard.actor_stopped_while_waiting",
	generationRetiredError,
]);

// A retired generation answers until RivetKit stops its actor and starts the next one, and the
// gateway answers actor_stopped_while_waiting while that stop runs. The Engine ends a stop that
// takes longer than its stop threshold, 30 seconds by default, plus 5 seconds, so those rejections
// are sent again for as long. A busy host can take longer than the 5 quick attempts to stop one.
// https://github.com/rivet-dev/rivet/blob/7d2fda3749f785619883c46aed963fb7b48994e6/engine/packages/config/src/config/pegboard.rs#L117-L127
const retiredGenerationRetryMilliseconds = 35_000;
const waitsForNextGeneration: ReadonlySet<string> = new Set([
	"guard.actor_stopped_while_waiting",
	generationRetiredError,
]);
const retryDelayCapMilliseconds = 250;

export async function fetchAdmittedDurableObjectCall(
	handle: RivetActorHandle,
	request: Request,
): Promise<Response> {
	const retiredDeadline = Date.now() + retiredGenerationRetryMilliseconds;
	for (let attempt = 1; ; attempt += 1) {
		const response = await handle.fetch(request.clone());
		const rejection = response.headers.get("x-rivet-error") ?? "";
		const exhausted = waitsForNextGeneration.has(rejection)
			? Date.now() >= retiredDeadline
			: attempt >= admissionRetryLimit;
		if (exhausted || response.status !== 503 || !admissionRejections.has(rejection)) {
			return response;
		}
		await response.body?.cancel();
		await delay(
			Math.min(admissionRetryDelayMilliseconds * attempt, retryDelayCapMilliseconds),
			undefined,
			{ signal: request.signal },
		);
	}
}
