import { DurableObject } from "cloudflare:workers";

async function* dataSource() {
  let counter = 0;
  while (true) {
    yield counter++;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}

export class MyDurableObject extends DurableObject<Env> {
  dataSource: AsyncGenerator<number, void, unknown>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.dataSource = dataSource();
  }

  async rpc(): Promise<ReadableStream> {
    const self = this;
    return new ReadableStream({
      async start(controller) {
        for await (const value of self.dataSource) {
          controller.enqueue(new TextEncoder().encode(String(value)));
        }
      },
      cancel() {
        console.log("CANCELLED");
      },
    });
  }
}

export default {
  async fetch(request, env, _ctx): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/rpc") {
      const stub = env.MY_DURABLE_OBJECT.getByName("foo");

      const stream = await stub.rpc();

      request.signal.addEventListener("abort", () => {
        console.log("CLIENT ABORTED REQUEST");
        stream.cancel();
      });

      const headers = new Headers({
        "Content-Type": "application/octet-stream",
      });

      return new Response(stream, { headers });
    }
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
