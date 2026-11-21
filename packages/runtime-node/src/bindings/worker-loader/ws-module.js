// A plain JS re-export lets the agentOS build bundle `ws` statically while TypeScript reads
// `ws-module.d.ts`. Orange does not depend on @types/ws.
export { Receiver, Sender } from "ws";
