import type { TestEvent } from "node:test/reporters";

// Separate reporter output from application stdout. Never infer success from exit alone.
export default async function* reporter(source: AsyncIterable<TestEvent>) {
	for await (const event of source) {
		yield `${JSON.stringify(event, (_key, value) => value instanceof Error
			? { message: value.message, stack: value.stack, ...value } : value)}\n`;
	}
}
