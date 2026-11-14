import { createServer } from "node:http";
import { once } from "node:events";
import assert from "node:assert/strict";
import test from "node:test";

import { createRivetActorClient, sleepActorsOfExitedHosts } from "./rivetkit.js";

test("creates stateless get-or-create handles with the pinned RivetKit client", async () => {
	const client = createRivetActorClient({
		endpoint: "http://127.0.0.1:1",
		namespace: "default",
	});
	const handle = client.getOrCreate("openorange_fixture", [
		"deployment",
		"Counter",
		"",
		"canonical-id",
	]);

	assert.equal(typeof handle, "object");
	await client.dispose();
});

// Real Engine-shaped HTTP pages: v3 deliberately has no connectable timestamp.
test("local recovery handles absent connectable timestamps while respecting pool and startup boundaries", async () => {
    const slept: string[] = [];
    const actor = (id: string, pool: string, create: number, connectable: number | null) => ({ actor_id: id, pool, create_ts: create, connectable_ts: connectable });
    const server = createServer((request, response) => {
        const url = new URL(request.url!, "http://fixture");
        assert.equal(url.searchParams.get("namespace"), "fixture");
        response.setHeader("content-type", "application/json");
        if (request.method === "GET") {
            assert.equal(url.searchParams.get("name"), "fixtureActor");
            response.end(JSON.stringify({ actors: url.searchParams.has("cursor") ? [] : [
                actor("old-v3", "owned", 10, null),
                actor("old-modern", "owned", 10, 20),
                actor("new-v3", "owned", 101, null),
                actor("reconnected-modern", "owned", 10, 101),
                actor("other-pool", "other", 10, null),
            ], pagination: { cursor: "next" } }));
        } else {
            assert.equal(request.method, "POST");
            slept.push(url.pathname);
            request.resume();response.end("{}");
        }
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();assert.ok(address && typeof address === "object");
    try {
        await sleepActorsOfExitedHosts({ actorNames: ["fixtureActor"], endpoint: `http://127.0.0.1:${address.port}`, namespace: "fixture", poolName: "owned", startedAt: 100 });
        assert.deepEqual(slept.sort(), ["/actors/old-modern/sleep", "/actors/old-v3/sleep"]);
    } finally { server.closeAllConnections();await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test("runtime control: local recovery bounds concurrent HTTP work across large actor lists", async () => {
 const actors=Array.from({length:300},(_,i)=>({actor_id:`actor-${i}`,pool:"owned",create_ts:10,connectable_ts:20}));
 let active=0,peak=0;const slept=new Set<string>();
 const server=createServer((request,response)=>{
  response.setHeader("content-type","application/json");
  if(request.method==="GET"){response.end(JSON.stringify({actors,pagination:{}}));return;}
  active++;peak=Math.max(peak,active);slept.add(new URL(request.url!,"http://fixture").pathname);request.resume();
  setTimeout(()=>{active--;response.end("{}");},10);
 });
 server.listen(0,"127.0.0.1");await once(server,"listening");const address=server.address();assert.ok(address&&typeof address==="object");
 try{
  await sleepActorsOfExitedHosts({actorNames:["fixtureActor"],endpoint:`http://127.0.0.1:${address.port}`,namespace:"fixture",poolName:"owned",startedAt:100});
  assert.equal(slept.size,300,"every eligible actor must be recovered exactly once");
  assert.ok(peak<=4,`recovery opened ${peak} concurrent requests; preserve the guest socket budget`);
  assert.equal(active,0);
 }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

test("runtime control: local recovery settles admitted requests before propagating failure", async () => {
 const ready=Promise.withResolvers<void>();const release=Promise.withResolvers<void>();const fail=Promise.withResolvers<void>();
 let admitted=0,active=0,settled=false;
 const actors=Array.from({length:12},(_,i)=>({actor_id:`actor-${i}`,pool:"owned",create_ts:10,connectable_ts:20}));
 const server=createServer((request,response)=>{
  response.setHeader("content-type","application/json");
  if(request.method==="GET"){response.end(JSON.stringify({actors,pagination:{}}));return;}
  const index=admitted++;active++;request.resume();if(admitted===4)ready.resolve();
  void(index===0?fail.promise:release.promise).then(()=>{active--;response.statusCode=index===0?503:200;response.end("{}");});
 });
 server.listen(0,"127.0.0.1");await once(server,"listening");const address=server.address();assert.ok(address&&typeof address==="object");
 const result=sleepActorsOfExitedHosts({actorNames:["fixtureActor"],endpoint:`http://127.0.0.1:${address.port}`,namespace:"fixture",poolName:"owned",startedAt:100}).then(()=>{settled=true;return{error:undefined as unknown};},error=>{settled=true;return{error};});
 try{
  await ready.promise;fail.resolve();await new Promise(resolve=>setTimeout(resolve,30));
  assert.equal(settled,false,"cleanup cannot run while admitted recovery requests are still in flight");
  assert.equal(admitted,4,"do not admit the rest of the list after a failure");
  release.resolve();const outcome=await result;assert.match(String(outcome.error),/status 503/);assert.equal(active,0);
 }finally{fail.resolve();release.resolve();await result;server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
