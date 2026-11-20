import assert from "node:assert/strict";
import test from "node:test";
import { guestCases, hostCases, matchedPasses, validRun, type Run } from "./results.js";

const run = (names = ["first", "second"]): Run => ({ complete: true, cases: names.map(name => ({ name, status: "pass" })) });

test("comparison refuses missing, extra, duplicate, skipped, capped, or incomplete evidence", () => {
	assert.equal(matchedPasses(run(), run()), 2);
	assert.equal(matchedPasses(run(), run(["first"])), 0);
	assert.equal(matchedPasses(run(), run(["first", "second", "extra"])), 0);
	assert.equal(matchedPasses(run(), run(["first", "first"])), 0);
	assert.equal(matchedPasses(run(), { ...run(), cases: [{ name: "first", status: "skip" }, { name: "second", status: "pass" }] }), 1);
	for (const incomplete of [{ complete: false }, { capped: true }, { timedOut: true }, { error: "module failed to load" }]) {
		assert.equal(matchedPasses(run(), { ...run(), ...incomplete }), 0);
	}
	assert.equal(validRun({ complete: true, cases: [] }), false);
});

test("guest TAP must include every planned case and a completed summary", () => {
	assert.equal(validRun(guestCases("TAP version 13\nok 1 - first\n1..2\n# tests 2\n")), false);
	assert.equal(validRun(guestCases("ok 1 - first\n")), false);
	assert.equal(validRun(guestCases("ok 1 - first\n1..2\n# tests 1\n")), false);
	assert.deepEqual(guestCases("TAP version 13\nok 1 - first\nnot ok 2 - second\n1..2\n# tests 2\n"), {
		complete: true, cases: [{ name: "first", status: "pass" }, { name: "second", status: "fail" }],
	});
});

test("truncated host reports cannot stop the comparison or earn pass credit", () => {
	const parsed = hostCases('{"type":"test:pass","data":');
	assert.equal(validRun(parsed), false);
	assert.equal(matchedPasses(run(), parsed), 0);
	assert.equal(parsed.error, "Malformed JSON Lines test report");
});

test("host suite identity survives the outer file runner reusing its test ID", () => {
	const events = [
		{ type: "test:enqueue", data: { testId: 1, parentId: 0, name: "suite", file: "/file.mjs" } },
		{ type: "test:pass", data: { testId: 2, parentId: 1, name: "case", file: "/file.mjs", details: { type: "test" } } },
		{ type: "test:fail", data: { testId: 1, parentId: 0, name: "/file.mjs", file: "/file.mjs", details: { type: "test" } } },
		{ type: "test:summary", data: { counts: { tests: 1 } } },
	];
	assert.deepEqual(hostCases(events.map(e => JSON.stringify(e)).join("\n")), { complete: true, cases: [{ name: "suite > case", status: "pass" }] });
});


test("credential-gated suites remain explicit when Node registers none of their leaves", () => {
 const parsed=hostCases([
  {type:"test:pass",data:{testId:1,parentId:0,name:"provider",skip:"set provider credential",details:{type:"suite"}}},
  {type:"test:pass",data:{testId:2,parentId:0,name:"local case",details:{type:"test"}}},
  {type:"test:summary",data:{counts:{tests:1}}},
 ].map(e=>JSON.stringify(e)).join("\n"));
 assert.deepEqual(parsed.cases,[{name:"local case",status:"pass"}]);
 assert.deepEqual(parsed.skippedSuites,[{name:"provider",reason:"set provider credential"}]);
});
