# Real projects

Open-source projects that run on Cloudflare Workers with Durable Objects or Worker Loader, each exercised through real `orange dev` at a pinned commit.

```
real-projects/
  excluded.json        Visible projects screened out, with the reason
  <id>/
    project.json       Pinned commit, install, build, Durable Object or Worker Loader evidence, changes
    scenario.ts        Real requests and WebSockets, one recorded step per behaviour
    changes.patch      Optional. Every change the project needed, applied before install
    result.json        Written by the run. Never by hand
    cloud-result.json  Optional. One run on Rivet Cloud, with no URL, cluster name, or build ID
```

## How the list was built

1. Candidates: the projects the owner named, [awesome-durable-objects](https://github.com/janwilmake/awesome-durable-objects), and GitHub topic, repository, and code searches for Durable Object use. That gave 1,108 repositories.
2. Screen: for each one, read the Wrangler configs and class source at the default branch, and keep it when a Durable Object class calls a storage, SQL, alarm, WebSocket, or Agent state API.
3. Rank by GitHub stars. Read each project's code before adding it. `excluded.json` lists the visible ones that were screened out.

Projects with no Durable Object are added by hand, outside these steps, when their Worker starts dynamic Workers through a `worker_loaders` binding. Their `durableObjects.classes` is empty, and `uses` names `worker_loaders`.

Search finds what it finds, so a project may be missing. The named libraries have no deployable Worker of their own, so a small consumer Worker runs them, listed under `changes`.

## Run

Run on a disposable machine. This runs third-party code.

```sh
pnpm real-projects --filter '^radish$' --keep   # one project, keep the clone
pnpm real-projects --jobs 6                     # all of them
```

Each run clones the pinned commit, installs with install scripts off, runs the project's build, and starts `orange dev`. Processes get a clean environment with no machine credentials.

## Rules

- **The scenario follows the project.** Read its README, routes, and client. Do what a real user or its client does. Never shape a step around what Orange can do.
- **A failed step stays failed.** Do not weaken an assertion, add a retry, or lengthen a wait to get a pass. Record the cause in `knownFailures`.
- **Prove state, not boot.** Write through one request and read through another. Include a Durable Object sleep or a restart where the project keeps state. A Worker Loader project checks output that only its dynamic Workers make.
- **Unmodified first.** Each change goes in `changes.patch` and `changes` with the reason. A project with no Wrangler config needs a `config` change.
- **No real credentials.** A flow that needs one is a `t.needsSecrets(...)` step. Local-only values that the README tells you to choose go in `devVars`.
- **A failed step closes its own sockets.** The runner closes the sockets a throwing step opened, so an object it left awake does not fail later steps for the wrong reason. The step itself stays failed.
- **Mark what did not run.** `notRun` says why. Do not drop the project.

## `project.json`

See `CorpusProject` in `src/real-projects/corpus.ts`. `install` must include `--ignore-scripts`.

## `scenario.ts`

See `ScenarioContext` in `src/real-projects/scenario.ts`.

```ts
import assert from "node:assert/strict";

import type { Scenario } from "../../src/real-projects/scenario.js";

const scenario: Scenario = async (t) => {
	await t.step("a write through one request is read through another", "do-state", async () => {
		await t.json("/counter/a/increment", { method: "POST" });
		assert.deepEqual(await t.json("/counter/a"), { value: 1 });
	});
	await t.step("the value survives the object's sleep", "sleep", async () => {
		await t.waitForSleep();
		assert.deepEqual(await t.json("/counter/a"), { value: 1 });
	});
	await t.step("the value survives a restart", "restart", async () => {
		await t.restart();
		assert.deepEqual(await t.json("/counter/a"), { value: 1 });
	});
	t.needsSecrets("the assistant answers", "binding", ["OPENAI_API_KEY"]);
};

export default scenario;
```

| Step kind | Use it for |
|---|---|
| `http` | A route or an asset with no Durable Object behind it |
| `do-state` | Durable Object state or coordination across requests |
| `websocket` | A WebSocket flow through a Durable Object |
| `alarm` | An alarm or a schedule that fires |
| `sleep` | State or a socket across a Durable Object sleep |
| `restart` | State across an `orange dev` and Engine restart |
| `binding` | Another binding: KV, D1, R2, Queues, Workflows, AI, and others |
| `worker-loader` | Output from a dynamic Worker that a `worker_loaders` binding started |

## Status

`deriveStatus` in `src/real-projects/result.ts` sets it from the recorded phases and steps:

| Status | Meaning |
|---|---|
| `works` | Every step passed, and at least one exercised a Durable Object or a dynamic Worker |
| `partial` | At least one step passed, and at least one failed |
| `fails` | Install, build, or boot failed, or no step passed |
| `needs-secrets` | Nothing failed, and a flow needs a real credential |
| `not-run` | Not exercised. `notRun` says why |
