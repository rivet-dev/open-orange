# Contributor guide

## Commits and pull requests

- Commit titles and pull request titles are conventional commits (`feat`, `fix`, `chore`, `docs`, `refactor`), with an optional scope.
- A pull request description is a short, high-level bullet list of what changed.

## Cloudflare conformance workflow

- When updating the pinned Wrangler version or supported compatibility date and
  flags, run the Cloudflare conformance CLI's `generate` command, review the API
  and Wrangler CLI-help diffs, run `check`, and record any confirmed deviations.
- Keep Orange's complete command tree and normalized help output aligned with
  the pinned Wrangler release. Help parity proves only CLI surface parity;
  command behavior must have its own conformance fixtures.
- When implementing a command, global, binding, module export, or other coherent
  API slice, enable it in `support.json` as partial, run `check`, and iterate on
  the implementation and Cloudflare comparison tests without weakening the
  generated types. Mark it implemented only after its behavioral conformance
  tests pass.

## Cloudflare implementation references

- When Cloudflare behavior or an implementation approach is unclear, inspect
  the workerd source and, where useful, the historical Miniflare v2 TypeScript
  source. Treat them as implementation references; the pinned declarations and
  differential conformance checks remain Orange's compatibility contract.
- Prefer workerd for current runtime semantics. Miniflare v2 is useful for its
  JavaScript/TypeScript implementation patterns, but it predates modern Workers
  RPC and is not an oracle for Durable Object method RPC.
- Whenever Orange code materially follows or adapts specific workerd or
  Miniflare v2 behavior, add a concise comment beside that code explaining what
  is mirrored and linking to the exact upstream lines. The URL must be a GitHub
  permalink containing a full commit SHA and line range, never a moving branch
  or tag URL. This applies even when the implementation is adapted rather than
  copied, including protocol details and edge cases such as stream extraction.

## Upstream example corpus

- Manually copy upstream examples into `tests/examples/<area>/<id>/`; tests must
  never fetch mutable examples at runtime.
- Every example has an `example.json` manifest with exactly one stable `id`, a
  repository-relative `source` entrypoint, a repository-relative
  `wranglerConfig`, the upstream `reference` URL it was copied from, and an
  `expectation` of `expected-pass` or `known-broken`.
- A `known-broken` example must include a concise `reason`. Keep its source
  unchanged so it remains evidence of an OpenOrange gap, and update its
  expectation when the gap is fixed.
- Run `tsx tests/validate-example-manifests.ts` after adding or changing an
  example. The validator checks manifest shape, unique IDs, referenced local
  files, valid reference URLs, and required known-broken reasons; it does not
  fetch or execute examples.

## Runnable examples

- Keep `examples/<name>/` as plain Cloudflare Workers projects with no
  OpenOrange imports, a `wrangler.jsonc`, and a `README.md`.
- `examples/` holds only what a user would copy: a starting point, or Orange
  configuration that Cloudflare's own docs cannot teach. An example that only
  proves a feature goes in `tests/fixtures/examples/`. Real proof goes in
  `packages/cloudflare-conformance/real-projects/`.
- Every example and example fixture needs one end-to-end scenario in
  `tests/runnable-examples.test.ts`; the test fails for one without a scenario.
- Upstream copies used as compatibility evidence stay in `tests/examples/`.

## Module documentation

- Keep one public MDX document for each Cloudflare runtime capability tracked by
  the current milestone under `docs/modules/`, including capabilities that are
  still unimplemented. Update it in the same commit whenever configuration,
  behavior, conformance status, or deviations change.
- Each module document must state its support status, show Wrangler-compatible
  configuration, explain how Orange implements it, describe its behavioral and
  type conformance coverage, and list every known deviation from Cloudflare,
  in the [docs page format](#docs-page-format).
- Never put secret values, credentials, or private infrastructure details in
  public docs.

### Docs page format

Every page in `docs/` is for a person skimming it. In about one screen they
get the concept and a quickstart that works. Everything else (compatibility
tables, limits, differences from Cloudflare, edge cases, internals, errors,
measurements, test evidence) goes in one collapsed `<AiContext>` at the end.
`docs/modules/durable-objects.mdx` is the reference binding page. The docs
components live in `website/src/components/docs/`, and pages use them without
an import.

A binding page, in this order:

1. **`# Title`**, then **`<BindingStatus>`**. Its status, backend, scaling,
   check counts and migration value come from data. The page writes three
   one-line props: `works`, `differs`, and `missing`.
2. **One or two sentences** on what the binding is on OpenOrange. A diagram
   here only if one already exists (`x.svg` and `x-dark.svg` in
   `docs/images/`).
3. **`## Quickstart`**: `<Steps>` with three to five steps, each titled with an
   imperative verb: the `wrangler.jsonc`, the code, and the run with its
   output. Requirements go above `<Steps>`, never in step 1.
4. **`## How it works`**: at most three short bullets or three sentences.
5. **`<AiContext summary="Compatibility, limits and details">`**: everything
   else, starting with `#### Compatibility` (one `Feature | Status | Notes`
   table) and `#### Limits`, then the rest, ending with `#### Conformance` and
   `<BindingEvidence>`.

A guide (migrate, deploy, operations, errors) opens with one or two sentences
and a `## Quickstart` as `<Steps>`, then at most three short task sections of a
sentence and a command each, then `<AiContext>` with the reference: every flag,
refused value, error, and edge case.

Writing rules:

- Write for a person deciding whether to use it or setting it up. Short
  sentences, present tense, "you".
- The human sections hold no caveats, exceptions, numbers the reader does not
  need to run it, or lists of what is missing. `<BindingStatus>` already says
  what differs and what is missing.
- No `## Compatibility`, `## Limits`, or other reference section outside
  `<AiContext>`. Inside it, use `####` and `#####` headings only, so "On this
  page" lists only the human sections. Keep the heading text of any section
  that other pages link to, so its anchor still works; a link to an anchor
  inside `<AiContext>` opens it.
- Say each fact once.
- Every command shows its real output: copy it from the page or from the CLI
  source in `src/commands/`, or show the command without output. Never invent
  output.
- A terminal session is one `sh` block: each command starts with `$ `, and its
  output follows on the next lines, never in a separate block. The site mutes
  the prompt and dims the output.
- Configuration examples use `wrangler.jsonc`.
- Every diagram has a light and a dark version: `x.svg` and `x-dark.svg` in
  `docs/images/`.

Each binding's migration value (in `website/src/data/binding-migration.ts`) is
one of four, with one line of detail and a link to the guide when there is a
path:

- **Live migration:** the app keeps serving while the data moves, as with
  `orange migrate`'s copy on first request and backfill.
- **Migration with downtime:** a supported path that needs a cutover or a
  maintenance window, such as an export and import.
- **Not supported:** the binding holds data on Cloudflare, and Orange has no
  way to move it yet.
- **Not needed:** stateless or external, so there is nothing to move.

Change a value in the same commit as the migration code or guide.

Skeleton:

```mdx
---
title: KV
description: One sentence on what runs the binding on OpenOrange.
---

# KV

<BindingStatus
  binding="kv"
  works="One line: what runs as on Cloudflare"
  differs="One line: what behaves differently"
  missing="One line: what is not there"
/>

One or two sentences on what it is on OpenOrange.

## Quickstart

<Steps>
<Step title="Bind the namespace">

One or two sentences, then the `wrangler.jsonc`.

</Step>
<Step title="Run it">

The command, then its output.

</Step>
</Steps>

## How it works

- At most three short bullets.

<AiContext summary="Compatibility, limits and details">

#### Compatibility

| Feature | Status | Notes |
| --- | --- | --- |

#### Limits

| What | Limit | What happens over it |
| --- | --- | --- |

#### Conformance

<BindingEvidence bindings={["kv"]} />

</AiContext>
```

### Module completion checklist

A module is not complete until the same commit includes all three:

- Its implementation under `packages/runtime-node/src/` in the appropriate
  globals, modules, bindings, or events folder.
- Its `docs/modules/` MDX page with support status, Wrangler-compatible
  configuration, implementation details, conformance coverage, and known
  deviations.
- Its static type-conformance and behavioral conformance tests, with its status
  accurately registered in `support.json`.

## Agent skill

- The `rivet-open-orange` agent skill lives in `rivet-dev/skills` at
  `skills/rivet-open-orange/`. When a commit changes a command, flag, output line,
  `orange doctor --json` event, or step that the skill names, open a PR there too.

## Website docs

- `website/` builds every docs page from `docs/*.mdx` and `docs/modules/*.mdx`,
  and its compatibility and binding status pages from
  `packages/cloudflare-conformance/` results, at build time. Edit those sources,
  never copies inside `website/`.
- The only hand-written docs page is the introduction,
  `website/src/pages/docs/index.astro`. Its intro and quickstart mirror
  `README.md`. When either changes, update the other in the same commit so both
  show the same steps, commands, and order.

## Development scripts

- Write repository automation scripts in TypeScript and run them with `tsx`.
  Do not add JavaScript, `.mjs`, or `.cjs` scripts.
