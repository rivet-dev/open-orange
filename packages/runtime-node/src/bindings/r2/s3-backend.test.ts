import assert from "node:assert/strict";
import test from "node:test";

import { objectVersion } from "./s3-backend.js";

test("uses the S3 version ID as the R2 version, and the ETag when there is none", () => {
	const etag = "5eb63bbbe01eeed093cb22bb8f5acdc3";
	assert.equal(objectVersion("3HL4kqtJlcpXroDTDmJ+rmSpXd3dIbrHY", etag), "3HL4kqtJlcpXroDTDmJ+rmSpXd3dIbrHY");
	assert.equal(objectVersion(undefined, etag), etag);
	// Unversioned objects, and every object on Neon Object Storage.
	assert.equal(objectVersion("null", etag), etag);
});
