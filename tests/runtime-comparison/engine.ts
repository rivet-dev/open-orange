import { createHash } from "node:crypto";
import { appendFileSync, createReadStream } from "node:fs";
import { readAgentOsSourceEngineBuild } from "../../src/runtime/source-engine-build.js";

const publishedHashes = new Map<string, Promise<string>>();
async function hashPublishedBinary(path: string): Promise<string> {
 let pending=publishedHashes.get(path);
 if(!pending){pending=(async()=>{const hash=createHash("sha256");for await(const chunk of createReadStream(path))hash.update(chunk);return hash.digest("hex");})();publishedHashes.set(path,pending);}
 return await pending;
}

/** Apply the same explicit Rust backend receipt to standalone comparison fixtures. */
export async function comparisonEngineBinary(publishedPath: string): Promise<string> {
 const runtime=process.env.OPENORANGE_RUNTIME ?? "node";
 const selected=runtime==="agentos"?readAgentOsSourceEngineBuild():undefined;
 const path=selected?.path??publishedPath;
 const receipt=process.env.OPENORANGE_COMPARISON_POLICY_LOG;
 if(receipt)appendFileSync(`${receipt}.engines.jsonl`,JSON.stringify({runtime,path,sha256:selected?.sha256??await hashPublishedBinary(path),sourceRevision:selected?.sourceRevision,selection:selected?"explicit guest Rust backend receipt":"pinned published baseline"})+"\n",{mode:0o600});
 return path;
}
