import assert from "node:assert/strict";
import test from "node:test";
import { parseDevArguments } from "../commands/dev.js";
import { runtimeKind } from "./runtime-kind.js";
import { spawnRuntime } from "./spawn.js";

test("runtime selection validates both backends and keeps Node.js as the default", () => {
	const original = process.env.OPENORANGE_RUNTIME;
	try {
		delete process.env.OPENORANGE_RUNTIME;
		assert.equal(runtimeKind(), "node");
		assert.equal(parseDevArguments(["dev"]).runtime, "node");
		assert.equal(parseDevArguments(["dev", "--runtime=agentos"]).runtime, "agentos");
		process.env.OPENORANGE_RUNTIME = "agentos";
		assert.equal(parseDevArguments(["dev"]).runtime, "agentos");
		assert.equal(parseDevArguments(["dev", "--runtime", "node"]).runtime, "node");
		assert.throws(() => runtimeKind("unknown"), /must be node or agentos/);
		assert.throws(() => parseDevArguments(["dev", "--runtime", "unknown"]), /must be node or agentos/);
		process.env.OPENORANGE_RUNTIME = "unknown";
		assert.equal(parseDevArguments(["dev", "--runtime=node"]).runtime, "node");
	} finally {
		if (original === undefined) delete process.env.OPENORANGE_RUNTIME;
		else process.env.OPENORANGE_RUNTIME = original;
	}
});

test("an invalid programmatic runtime fails before starting a Node.js child", async () => {
	await assert.rejects(spawnRuntime({ runtime: "unknown" } as never), /must be node or agentos/);
});
