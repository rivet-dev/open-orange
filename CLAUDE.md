# Contributor guide

## Project intent

OpenOrange runs an existing Cloudflare Workers project in production on
infrastructure the user picks (AWS, Google Cloud, Azure, their own servers),
on Node.js with Rivet underneath. It is for teams that leave Cloudflare for
its limits, bills, or lock-in, and keep their code, their Wrangler
configuration, and the `wrangler dev` workflow. OpenOrange is a Workers
runtime and platform, not a local simulator like Miniflare, a workerd host, or
a Cloudflare fork. `README.md` and `website/src/data/site.ts` hold the
positioning.

### Compatibility contract

- Match what a Worker can observe on Cloudflare: the pinned declarations and
  the behavior that working code relies on. The user changes no app code. When
  their code needs a change to run on Orange, the fix goes in Orange.
- Cloudflare's and workerd's limits, quotas, and refusals are not part of the
  contract. Only Rivet's limits and the user's machines apply. When Cloudflare
  or workerd rejects input that Orange handles correctly (a size cap, a depth
  limit, a `DataCloneError` for a value Orange can pass), Orange accepts it,
  even though that code then fails on Cloudflare. This covers quotas and API
  refusals only; Orange's own access control and isolation stay.
- Record each place where Orange is more permissive as a deviation in the
  Limits or Deviations section of its `docs/modules/` page. When an upstream
  test asserts the refusal, list it in `upstream.json` `cloudflareQuotaTests`
  with the limit it checks. Tests assert that Orange accepts the input, never
  that it refuses it.
- workerd is the reference for semantics, not for limits. A scored upstream
  test that fails on Orange is a bug when Orange breaks behavior that works on
  workerd, and a deviation when Orange does more than workerd allows.
- Workers get stock Node.js with Node's defaults, not the `nodejs_compat`
  subset. Shim only what the Workers API needs. A test that passes only on
  workerd's subset is workerd-only and counts in no score.

### When Cloudflare, workerd, and Orange disagree

Take the first rule that applies:

1. Code that works on Cloudflare breaks on Orange: match Cloudflare.
2. The difference is a limit, quota, or refusal: drop it, and record the
   deviation.
3. Orange needs a limit of its own to protect the host or other tenants (for
   example, dynamic Workers never run on the host): keep it, make it an
   `ORANGE_*` variable, and name that variable in the error.
4. Orange cannot do it yet: fail with an `OpenOrange ...` error that says what
   to do instead, and list the gap on the module page.
5. None fits, or the change contradicts a public claim: stop and ask the user.

### Rivet

- Build on Rivet's primitives instead of new Orange machinery.
- Behavior that every Rivet runner has is by design, not a finding. Each
  OpenOrange deployment runs in a Rivet namespace of its own.

## Commits and pull requests

- Commit titles and pull request titles are conventional commits (`feat`, `fix`,
  `chore`, `docs`, `refactor`), with an optional scope.
- A pull request description is a short, high-level bullet list of what changed.

## Conformance

- When updating the pinned Wrangler version or supported compatibility date and
  flags, run the Cloudflare conformance CLI's `generate` command, review the API
  and Wrangler CLI-help diffs, run `check`, and record any confirmed deviations.
- Keep Orange's complete command tree and normalized help output aligned with
  the pinned Wrangler release. Help parity proves only CLI surface parity;
  command behavior needs its own conformance fixtures.
- When implementing a command, global, binding, module export, or other coherent
  API slice, enable it in `support.json` as partial, run `check`, and iterate on
  the implementation and Cloudflare comparison tests without weakening the
  generated types. Mark it implemented only after its behavioral conformance
  tests pass.
- A module is complete only when one commit holds all three: its implementation
  under `packages/runtime-node/src/` (globals, modules, bindings, or events), its
  `docs/modules/` page, and its type and behavioral conformance tests with an
  accurate `support.json` status. The page changes in the same commit as the
  module's configuration, behavior, conformance status, or deviations.
- Test workerd behavior with a `.wd-test` file in
  `packages/cloudflare-conformance/synthetic/`. `pnpm upstream` scores it on
  workerd first, so only behavior that workerd shows counts.

## workerd and Miniflare references

- When Cloudflare behavior or an implementation approach is unclear, read the
  workerd source and tests. Keep a clone at the commit that
  `packages/cloudflare-conformance/upstream.json` pins, and search it with `rg`:

  ```sh
  git clone --filter=blob:none https://github.com/cloudflare/workerd.git .workerd-ref
  git -C .workerd-ref checkout "$(jq -r .commit packages/cloudflare-conformance/upstream.json)"
  rg -n "DataCloneError" .workerd-ref/src/workerd/api
  rg -l "getEntrypoint" .workerd-ref/src/workerd/api/tests
  ```

- workerd is the reference for current runtime semantics, not for its limits.
  The historical Miniflare v2 TypeScript source is useful for implementation
  patterns, but it predates modern Workers RPC and is not an oracle for Durable
  Object method RPC.
- When Orange code follows or adapts specific workerd or Miniflare v2 behavior,
  add a concise comment beside it that says what is mirrored and links to the
  exact upstream lines. The link is a GitHub permalink with a full commit SHA
  and a line range, such as the pinned commit above, never a branch or tag URL.
  This applies to adapted code too, including protocol details and edge cases
  such as stream extraction.

## Tests

- Unit tests run in-process, start no process, and sit next to their code as
  `src/**/*.test.ts` or `packages/*/src/**/*.test.ts`. `pnpm test:unit` runs them.
- A test that starts `orange dev`, `orange serve`, workerd, or another process
  is an end-to-end test. It goes in `tests/<area>/<name>.test.ts`, where the
  area is the Cloudflare area it covers. Each folder of `tests/` that holds
  `*.test.ts` files is one CI job, `e2e / <area>`. A new folder gets its own job.
- `tests/harness/` holds the shared helpers. Start and stop `orange dev` with
  `startOrangeDev` from `tests/harness/orange-dev.ts`, and wait with `waitFor`,
  never a fixed sleep. Sleep only for the time the test is about, and say why.
- `tests/fixtures/` holds the Worker projects that tests run, and
  `tests/cloudflare-examples/` holds the unchanged Cloudflare copies. Neither
  holds test files.
- A real-project result describes the newest Orange: run it on the current
  `main` or the latest release. A step that fails because the host lacks a
  tool is a harness failure to fix, not an Orange result.

### Which tests to run

Run the area that covers your change, one area or file at a time. Each area
starts many `orange dev` processes and Rivet Engines, so CI runs the areas on
16-core runners. Let CI run the rest. Run one file with
`pnpm test:e2e tests/<area>/<name>.test.ts`.

| You changed | Run |
| --- | --- |
| `packages/runtime-node/src/bindings/durable-objects/` | `pnpm test:e2e 'tests/durable-objects/*.test.ts'` |
| `bindings/worker-loader/` | `pnpm test:e2e tests/bindings/worker-loader.test.ts` and `pnpm upstream --filter worker-loader` in `packages/cloudflare-conformance` |
| Other `bindings/` | `pnpm test:e2e 'tests/bindings/*.test.ts'` |
| `rpc/`, `session/`, `globals/websocket.ts` | `pnpm test:e2e 'tests/rpc-and-websockets/*.test.ts'` |
| `events/` | `pnpm test:e2e 'tests/events/*.test.ts'` |
| `modules/`, other `globals/` | `pnpm test:e2e 'tests/node-compat/*.test.ts'` |
| Outbound `fetch()` and `connect()` (`internal/global-outbound.ts`, `internal/happy-eyeballs.ts`) | `pnpm test:e2e 'tests/outbound/*.test.ts'` |
| `src/commands/migrate*.ts` | `pnpm test:e2e 'tests/migrate/*.test.ts'` |
| Other `src/` (CLI, config, build, serve) | `pnpm test:e2e 'tests/cli/*.test.ts'` |
| `examples/`, `tests/fixtures/examples/`, `tests/cloudflare-examples/` | `pnpm test:e2e 'tests/examples/*.test.ts'` |

## Examples

- `examples/<name>/` is a plain Cloudflare Workers project with no OpenOrange
  imports, a `wrangler.jsonc`, and a `README.md`. It holds only what a user
  would copy: a starting point, or Orange configuration that Cloudflare's own
  docs cannot teach. An example that only proves a feature goes in
  `tests/fixtures/examples/`. Real proof goes in
  `packages/cloudflare-conformance/real-projects/`.
- Every example and example fixture needs one end-to-end scenario in
  `tests/examples/runnable-examples.test.ts`, which fails for one without a
  scenario.
- Upstream examples used as compatibility evidence are copied by hand into
  `tests/cloudflare-examples/<area>/<id>/`. Tests never fetch them at runtime.
  Each has an `example.json` manifest. Run
  `tsx scripts/validate-example-manifests.ts` after adding or changing one; it
  names any missing or invalid field.
- A `known-broken` example keeps its source unchanged, so it stays evidence of
  an OpenOrange gap. Change its expectation when the gap is fixed.

## Docs and website

- Before you write or edit a page in `docs/`, read `docs/CLAUDE.md`. It holds
  the page format and the writing rules.
- `website/` builds the docs pages from `docs/` and the compatibility and
  binding status pages from `packages/cloudflare-conformance/` results, at
  build time. Edit those sources, never copies inside `website/`.
- The only hand-written docs page is the introduction,
  `website/src/pages/docs/index.astro`. Its intro and quickstart mirror
  `README.md`. When either changes, update the other in the same commit so both
  show the same steps, commands, and order.
- Public docs hold no secret values, credentials, or private infrastructure
  details.

## Agent skill

- The `rivet-open-orange` agent skill lives in `rivet-dev/skills` at
  `skills/rivet-open-orange/`. When a commit changes a command, flag, output
  line, `orange doctor --json` event, or step that the skill names, open a PR
  there too.

## Development scripts

- Write repository automation scripts in TypeScript and run them with `tsx`.
  Do not add JavaScript, `.mjs`, or `.cjs` scripts.
