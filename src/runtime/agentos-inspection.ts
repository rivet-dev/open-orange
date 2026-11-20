import {createServer} from "node:http";
import {lstat,realpath,writeFile,unlink} from "node:fs/promises";
import {dirname,isAbsolute} from "node:path";
import {once} from "node:events";

/** A private controller probe; the guest receives neither its token nor its host port. */
export async function openAgentOsHeapInspection(measure:()=>Promise<number>):Promise<undefined|(()=>Promise<void>)>{
 const path=process.env.OPENORANGE_AGENTOS_INSPECTION_FILE;
 if(path===undefined)return undefined;
 const token=process.env.OPENORANGE_AGENTOS_INSPECTION_TOKEN;
 if(!token||!/^[a-f0-9-]{36}$/i.test(token)||!isAbsolute(path))throw Error("Invalid private agentOS inspection configuration");
 const parent=dirname(path),metadata=await lstat(parent);
 if(await realpath(parent)!==parent||!metadata.isDirectory()||metadata.uid!==process.getuid?.()||(metadata.mode&0o077)!==0)throw Error("Inspection parent must be a canonical owned private directory");
 let active=false;
 const server=createServer((request,response)=>{
  response.setHeader("connection","close");
  if(request.method!=="GET"||request.url!=="/heap"||request.headers.authorization!==`Bearer ${token}`){response.writeHead(403).end();return;}
  if(active){response.writeHead(503).end();return;}
  active=true;
  void measure().then(heapUsed=>{response.setHeader("content-type","application/json");response.end(JSON.stringify({heapUsed}));},error=>{response.writeHead(500).end(JSON.stringify({error:String(error).slice(0,1024)}));}).finally(()=>{active=false;});
 });
 server.maxConnections=2;server.requestTimeout=10000;server.headersTimeout=10000;
 let identity:Awaited<ReturnType<typeof lstat>>|undefined;
 const close=async()=>{
  server.closeAllConnections();
  if(server.listening)await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
  if(identity){let current;try{current=await lstat(path);}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
   if(current?.ino===identity.ino&&current?.dev===identity.dev)await unlink(path);
  }
 };
 try{
  server.listen(0,"127.0.0.1");await once(server,"listening");const address=server.address();if(!address||typeof address==="string")throw Error("Inspection listener has no port");
  await writeFile(path,JSON.stringify({port:address.port}),{flag:"wx",mode:0o600});identity=await lstat(path);return close;
 }catch(error){try{await close();}catch(cleanup){throw new AggregateError([error,cleanup],"Inspection startup cleanup failed");}throw error;}
}
