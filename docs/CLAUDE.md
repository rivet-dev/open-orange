# Docs pages

Rules for every page in `docs/`. The website builds the pages from `docs/*.mdx`
and `docs/modules/*.mdx` at build time, so edit them here, never copies inside
`website/`.

Keep one page in `docs/modules/` for each Cloudflare runtime capability that
the current milestone tracks, including capabilities that are still
unimplemented.

## Page format

Every page in `docs/` is for a person skimming it. In about one screen they
get the concept and a quickstart that works. Everything else (compatibility
tables, limits, differences from Cloudflare, edge cases, internals, errors,
measurements, test evidence) goes in one collapsed `<AiContext>` at the end.
`docs/modules/durable-objects.mdx` is the reference binding page. The docs
components live in `website/src/components/docs/`, and pages use them without
an import.

### A binding page

In this order:

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

### A guide

A guide (migrate, deploy, operations, errors) opens with one or two sentences
and a `## Quickstart` as `<Steps>`, then at most three short task sections of a
sentence and a command each, then `<AiContext>` with the reference: every flag,
refused value, error, and edge case.

## Writing rules

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
- State a deviation or by-design behavior as a plain fact about what Orange
  does, never as a warning, risk, or finding. Leave out internals the reader
  cannot act on.
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

## Migration value

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

## Skeleton

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
