import {createRequire} from "node:module";
import type {IncomingMessage, ServerResponse} from "node:http";
import {Readable, type Duplex} from "node:stream";
import type {Socket} from "node:net";
import type {Client, Dispatcher} from "undici";

const requireFromOrange=createRequire(import.meta.url);
/** Bun's node:http ignores createConnection. Keep its HTTP parser attached to
 * the already-authorized guest stream, without resolving a host destination.
 */
export async function forwardGuestHttpOnBun(request: IncomingMessage,response: ServerResponse,stream: Duplex,maxRequestBytes: number): Promise<void> {
 // The pinned HTTP-only entry avoids initializing Undici's unrelated Web APIs
 // on Bun. Its parser accepts Duplex even though the connector type names Socket.
 const HttpClient=requireFromOrange("undici/lib/dispatcher/client.js") as typeof Client;
 const client=new HttpClient("http://openorange-guest.invalid",{connect:(_options,callback)=>queueMicrotask(()=>callback(null,stream as Socket))});
 const finished=Promise.withResolvers<void>(),sent=Promise.withResolvers<void>();
 let controller:Dispatcher.DispatchController|undefined;
 const closed=()=>{if(!response.writableFinished){const error=new Error("Client closed the request");controller?.abort(error);finished.reject(error);sent.reject(error);}};
 const aborted=()=>{const error=new Error("Client aborted the request");controller?.abort(error);finished.reject(error);sent.reject(error);};
 const drain=()=>controller?.resume();
 response.once("close",closed);request.once("aborted",aborted);response.on("drain",drain);response.once("finish",finished.resolve);
 const headers={...request.headers};
 // Framing belongs to this hop. The native server has already handled Expect.
 delete headers["transfer-encoding"];delete headers["keep-alive"];delete headers.expect;delete headers.upgrade;
 const hasBody=request.headers["transfer-encoding"]!==undefined||Number(request.headers["content-length"]??0)>0;
 const body=hasBody?Readable.from((async function*(){let bytes=0;for await(const chunk of request){bytes+=chunk.length;if(bytes>maxRequestBytes)throw new Error(`agentOS request body exceeds ${maxRequestBytes} bytes; raise OPENORANGE_AGENTOS_MAX_REQUEST_BYTES`);yield chunk;}})(),{objectMode:false}):undefined;
 try{
  client.dispatch({method:(request.method??"GET") as Dispatcher.HttpMethod,path:request.url??"/",headers,body},{
   onRequestStart(current){controller=current;},
   onRequestSent(){sent.resolve();},
   onResponseStart(current,status,headers,message){
    if(status<200)return;
    const raw=current.rawHeaders;
    if(Array.isArray(raw))response.writeHead(status,message??"",raw.map(value=>typeof value==="string"?value:Buffer.from(value).toString("latin1")));
    else response.writeHead(status,message??"",headers);
   },
   onResponseData(current,bytes){if(!response.write(bytes))current.pause();},
   onResponseEnd(_current,trailers){if(Object.keys(trailers).length)response.addTrailers(trailers);response.end();},
   onResponseError(_current,error){finished.reject(error);sent.reject(error);},
  });
  await Promise.all([sent.promise,finished.promise]);
 }finally{
  response.off("close",closed);response.off("drain",drain);response.off("finish",finished.resolve);request.off("aborted",aborted);
  await client.destroy();body?.destroy();stream.destroy();
 }
}
