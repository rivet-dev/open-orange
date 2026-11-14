# Upstream example corpus

This directory holds unchanged copies of Cloudflare's own examples, used as test
evidence. They show that code written for Cloudflare runs on OpenOrange as is.

The runnable examples for users are in [`examples/`](../../examples/README.md).
Those are written for OpenOrange and change freely. These copies never change.

## Layout

Each example lives in `<area>/<id>/` and has:

- The upstream source, copied without edits.
- A `wrangler.jsonc` to run it.
- An `example.json` manifest with the `id`, the `source` entrypoint, the
  `wranglerConfig`, the upstream `reference` it was copied from (a permalink
  with a full commit SHA and line range), and an `expectation` of
  `expected-pass` or `known-broken`.

| Area | Source |
|---|---|
| `durable-objects/` | Examples from the Cloudflare Durable Objects documentation |

## Rules

- Copy examples by hand. Tests never fetch examples at runtime.
- Never edit a copied source. A `known-broken` example stays unchanged as
  evidence of an OpenOrange gap, with a `reason` in its manifest. Change its
  `expectation` when the gap is fixed.
- After adding or changing an example, run
  `tsx scripts/validate-example-manifests.ts`.

`tests/examples/examples.test.ts` runs every example through `orange dev`.
