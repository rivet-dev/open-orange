import { RpcTarget, WorkerEntrypoint } from "cloudflare:workers";

class Counter extends RpcTarget {
	#value;

	constructor(value) {
		super();
		this.#value = value;
	}

	increment(amount) {
		this.#value += amount;
		return this.#value;
	}
}

export class Calculator extends WorkerEntrypoint {
	#calls = 0;

	makeCounter(start) {
		return new Counter(start);
	}

	async countCalls() {
		this.#calls += 1;
		await scheduler.wait(10);
		return this.#calls;
	}

	mutate(map) {
		map.set("callee", true);
		return map.size;
	}

	fail() {
		const error = new TypeError("calculator failed");
		error.code = 7;
		throw error;
	}

	failAll() {
		throw new AggregateError([new Error("first")], "every calculation failed");
	}
}

export default {
	async fetch(request, env) {
		const counter = env.CALCULATOR.makeCounter(5);
		const pipelined = await counter.increment(2);
		counter[Symbol.dispose]();
		const afterDispose = await counter.increment(1).then(
			() => "resolved",
			(error) => error.message,
		);

		const input = new Map([["caller", true]]);
		const calleeSize = await env.CALCULATOR.mutate(input);

		const failure = await env.CALCULATOR.fail().then(
			() => null,
			(error) => ({
				code: error.code,
				message: error.message,
				name: error.name,
				remote: error.remote,
			}),
		);

		const aggregateFailure = await env.CALCULATOR.failAll().then(
			() => null,
			(error) => ({ message: error.message, name: error.name }),
		);

		const overlapping = await Promise.all([
			env.CALCULATOR.countCalls(),
			env.CALCULATOR.countCalls(),
		]);

		return Response.json({
			afterDispose,
			aggregateFailure,
			calleeSize,
			callerSize: input.size,
			failure,
			overlapping,
			pipelined,
		});
	},
};
