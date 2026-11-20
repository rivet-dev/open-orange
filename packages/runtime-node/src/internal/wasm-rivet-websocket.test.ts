import assert from "node:assert/strict";
import test from "node:test";
import { installWasmProtocolWriter } from "./wasm-rivet-websocket.js";

function writer(sync: boolean, applySync: (_receiver: undefined, args: unknown[]) => unknown) {
 const destroyed: Error[] = [];
 const socket = { _socketId: "test-socket", bytesWritten: 0, write: (_chunk: unknown, _encoding?: unknown, _callback?: unknown) => true, destroy(error?: Error) { if (error) destroyed.push(error); } };
 installWasmProtocolWriter(socket, {applySync}, () => sync, queueMicrotask);
 return {socket,destroyed};
}

test("ordinary protocol write failures use callback/error delivery instead of escaping", async () => {
 const error=Object.assign(new Error("Broken pipe"),{code:"EPIPE"});let writes=0;
 const {socket,destroyed}=writer(false,()=>{writes++;throw error;});
 const callbacks:unknown[]=[];
 assert.doesNotThrow(()=>assert.equal(socket.write(new Uint8Array([1]),(failure:unknown)=>callbacks.push(failure)),false));
 assert.equal(callbacks.length,0);assert.equal(destroyed.length,0);
 assert.equal(socket.write(new Uint8Array([2]),(failure:unknown)=>callbacks.push(failure)),false);
 await new Promise<void>(resolve=>setImmediate(resolve));
 assert.equal(writes,1,"retire the failed connection without retrying its bytes");
 assert.deepEqual(callbacks,[error,error]);assert.deepEqual(destroyed,[error]);
});

test("synchronous protocol write failures still throw and defer callbacks", async () => {
 const error=Object.assign(new Error("Broken pipe"),{code:"EPIPE"});const {socket,destroyed}=writer(true,()=>{throw error;});let callbackError:unknown;
 assert.throws(()=>socket.write(new Uint8Array([1]),(failure:unknown)=>{callbackError=failure;}),failure=>failure===error);
 assert.equal(callbackError,undefined);assert.equal(destroyed.length,0);
 await new Promise<void>(resolve=>setImmediate(resolve));
 assert.equal(callbackError,error);assert.deepEqual(destroyed,[error]);
});

test("successful partial frame writes preserve byte order and actual write accounting", () => {
 const actual:number[]=[];const {socket,destroyed}=writer(false,(_receiver,args)=>{const bytes=args[1] as Uint8Array;const count=Math.min(2,bytes.byteLength);actual.push(...bytes.subarray(0,count));return count;});let complete=0;
 assert.equal(socket.write(new Uint8Array([1,2,3,4,5]),()=>{complete++;}),true);
 assert.deepEqual(actual,[1,2,3,4,5]);assert.equal(socket.bytesWritten,5);assert.equal(complete,1);assert.deepEqual(destroyed,[]);
});
