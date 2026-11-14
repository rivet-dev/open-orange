# Examples

Small Cloudflare Workers projects that run on OpenOrange. Each one is plain
Cloudflare code with a `wrangler.jsonc` and no OpenOrange imports.

| Example | What it shows |
|---|---|
| [hello-durable-object](./hello-durable-object) | A starting point: a SQLite Durable Object called over RPC |
| [multi-worker](./multi-worker) | Three Workers in one session: service bindings, RPC, `script_name`, a shared queue, a Workflow, and a dispatch namespace |
| [r2](./r2) | A file service on R2, locally or in any S3-compatible store |
| [sandbox](./sandbox) | A per-user code runner with the Sandbox SDK, on your choice of provider |
| [workers-ai](./workers-ai) | Chat, streaming, and tool calling with Workers AI on any OpenAI-compatible provider |

Looking for proof that real code runs? See
[real projects](../packages/cloudflare-conformance/real-projects). Smaller projects
that each prove one feature are test fixtures in
[`tests/fixtures/examples/`](../tests/fixtures/examples).

## Run an example

Run `pnpm install` once from the repository root. Then, in an example's
directory:

```sh
pnpm open-orange dev             # open-orange at http://localhost:8787
pnpm wrangler dev --port 8788    # workerd, on another port so both can run
```

The installed `orange` command is the built package in `dist/`. Run
`pnpm build` from the repository root after you change OpenOrange's source.

When the example uses Durable Objects, KV, D1, R2, Queues, Workflows, or Cron
Triggers, each object runs as a Rivet Actor. The local state goes to
`.open-orange/`, which Git ignores.

For editor types, run `pnpm wrangler types`. It writes
`worker-configuration.d.ts`, which the example's `tsconfig.json` includes.

## Tests

`tests/examples/runnable-examples.test.ts` runs every example and example fixture through
`open-orange dev` and checks its main flow over real HTTP and WebSockets.
