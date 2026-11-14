# OpenOrange architecture

Status: execution ready
Last updated: 2026-09-06

## Goal

OpenOrange lets an existing Cloudflare Workers project run on Node.js by using
`orange` in place of `wrangler`. Orange is intended to be compatible with
Wrangler at the CLI, configuration, generated-types, and project-entrypoint
boundaries. The Node.js runtime is intended to expose the same supported
Cloudflare Workers APIs and behavior as the pinned Cloudflare runtime.

The long-term CLI contract is the complete command tree of the pinned Wrangler
release: commands, subcommands, positional arguments, options, aliases, defaults,
help text, and exit behavior. The foundation implements `types` and `dev`
behavior first, while every other generated command remains present and fails
with an explicit unimplemented diagnostic until its behavior is added.
Every command reachable through the pinned Wrangler CLI is in project scope;
the foundation milestone defines implementation order, not a permanently
reduced compatibility claim.

OpenOrange supports one exact compatibility date and flag set at a time. The
CLI rejects projects that do not match that profile, and the project advances
the profile deliberately as Cloudflare publishes new runtime builds.

The first milestone establishes the runtime boundary and deterministic parity
tooling. Cloudflare's generated declarations are the type contract, every API
starts as unimplemented, and implementation proceeds one tested API slice at a
time. Type compatibility and behavioral compatibility are separate checks.

## Foundation MVP

This specification covers only the foundation needed to run a basic module
Worker through `orange dev`:

- Generate and track the complete API surface for one pinned Wrangler version,
  compatibility date, and flag set.
- Generate and track the complete Wrangler CLI help surface.
- Pin the workerd behavioral oracle, TypeScript, Undici, and the latest Node.js
  LTS major that can affect runtime behavior or type assignability. The current
  target is Node.js 24, and it remains pinned until a deliberate conformance
  update moves the project to a newer LTS major. Orange also runs on Node.js 22,
  the RivetKit minimum, with feature-detected polyfills for the gaps.
- Check globals, imported modules, bindings, and Worker event handlers against
  the generated declarations without weakening their types.
- Implement `atob`, `btoa`, `TextEncoder`, and `TextDecoder`, plus the minimum
  partial `Headers`, `Request`, and `Response` behavior needed for HTTP dispatch.
- Implement only the Secrets Store and version metadata bindings.
- Dispatch only the module Worker `fetch` event.
- Provide `orange types` and a basic `orange dev` request-response loop.

Orange exposes the full Wrangler command and help surface from the start. A
command appearing in help does not imply behavioral support: commands, options,
configuration, bindings, events, or module imports not yet implemented must fail
with a clear diagnostic rather than being ignored or approximated. Their status
remains visible in the conformance inventory and public module documentation.

## Project structure

```text
package.json                      # Published `open-orange` package
src/                              # Main package and CLI
  bin.ts                          # Installs `orange` and `open-orange`
  command-registry.ts             # Complete generated Wrangler command tree
  commands/
    dev.ts                        # Wrangler-compatible development command
    types.ts                      # Wrangler-compatible project type generation
  config/
    load-wrangler.ts
    validate-profile.ts
  build/
    bundle-worker.ts
    rewrite-module-imports.ts
    generate-entrypoint.ts
  runtime/
    spawn.ts

packages/
  runtime-node/                # Actual Node.js Workers implementation
    src/
      runner.ts                # Dedicated runtime-process entrypoint
      runtime.ts               # Runtime lifecycle and request dispatch
      context.ts               # Per-request runtime state
      globals/                 # Values installed on `globalThis`
        install.ts
        manifest.ts
        unimplemented.ts
        base64.ts
        encoding.ts
        http.ts
      modules/                 # Values exposed through exact import specifiers
        cloudflare-workers/
          durable-object.ts    # DurableObject base class after the foundation
      bindings/                # Values injected through the user's `env`
        create-env.ts
        secrets-store.ts
        version-metadata.ts
        durable-objects/       # Namespace, stub, Rivet actor, and storage adapters
          config.ts
          id.ts
          namespace.ts
          stub.ts
          registry.ts
          actor.ts
          rpc/                 # Self-contained Workers RPC implementation
            index.ts           # Narrow facade used by Durable Object stubs/actors
            serialization.ts   # V8 value graph encoding and decoding
            externals.ts       # External extraction and reconstruction
            target.ts          # Cap'n Web target and method-path dispatch
            http.ts            # Short-lived Cap'n Web HTTP batches
            websocket.ts       # Cap'n Web adapter for runtime-owned sessions
          fetch.ts
          state.ts
          websockets.ts
          storage.ts
      events/                  # Worker event dispatch
        fetch.ts
      internal/                # Shared machinery with no public API surface

  cloudflare-conformance/      # Private static and behavioral validation
    reference/
      wrangler.jsonc           # OpenOrange's single supported runtime profile
    support.json               # APIs claimed as partial or implemented
    generated/
      cloudflare-runtime.d.ts
      cloudflare-surface.json
      cloudflare-globals.json
      wrangler-help.json
      type-checks.ts
    fixtures/                  # Workers executed by both runtimes
      globals/
      bindings/
      events/
      durable-objects/
    src/
      bin.ts
      commands/
        generate.ts
        check.ts
      runners/
        workerd.ts
        orange.ts
        compare.ts

tests/
  examples/                    # Manually copied upstream end-to-end programs
    durable-objects/
      <example-id>/
        example.json           # Provenance and expected result
        wrangler.jsonc
        src/
  validate-example-manifests.ts

docs-internal/
  specs/
    open-orange.md

docs/
  modules/
    index.mdx
    globals.mdx
    secrets-store.mdx
    version-metadata.mdx
    durable-objects.mdx
```

The repository root is the single public `open-orange` package. It exposes the
preferred `orange` executable and `open-orange` as an alias, both backed by the
same CLI entrypoint. There is no separate CLI package and no public OpenOrange
types package. `runtime-node` is a private workspace build input; the root build
must include its child-process artifact in the published `open-orange` tarball so
an installed CLI never depends on workspace paths.

The `orange types` command generates a self-contained project declaration file
from the resolved Wrangler configuration, matching Wrangler's project workflow.
The private `cloudflare-conformance` package generates the pinned reference
declarations and checks OpenOrange's static and behavioral compatibility.

Full Wrangler compatibility includes both `wrangler.jsonc` and
`wrangler.toml`, named-environment resolution, global flags, command-specific
options, aliases, defaults, and generated output locations. The pinned Wrangler
release is the source of truth whenever documentation and observed CLI behavior
differ.

The private conformance CLI has two commands. `generate` snapshots Wrangler's
declarations, extracts the API inventory, and emits the compile-time checks.
`check` verifies that those artifacts are current and that every claimed
OpenOrange implementation satisfies its generated Cloudflare contract and
registered workerd comparison tests.

`generate` also walks every reachable `wrangler --help` command path in a fixed
locale, terminal width, color mode, and empty fixture project. It stores a
normalized command tree and normalized help output in `wrangler-help.json`.
Normalization may replace only the executable name, version banner, ANSI
sequences, and environment-dependent whitespace; it must preserve command paths,
arguments, aliases, defaults, descriptions, and ordering. The Orange command
registry is built from this artifact.

`check` walks the same command paths through both Wrangler and Orange and fails
on a missing or extra path or any normalized help difference. Help conformance
proves CLI surface parity, not behavioral parity. `support.json` separately
tracks command behavior, and command fixtures verify exit codes, stdout, stderr,
filesystem changes, network calls, and other effects before a command is marked
implemented.

Reference generation uses a minimal Wrangler configuration and
`wrangler types --include-env=false`, so `cloudflare-runtime.d.ts` contains only
the runtime reference and no fixture-specific `Env`. Binding fixtures have their
own Wrangler configurations, and `orange types` is checked separately against
their project-specific output. `generate` must still succeed when upstream APIs
change; it writes the new snapshot so the diff can be reviewed, while `check`
fails stale implementation claims.

`support.json` is the human-maintained source of implementation claims. An
omitted API is unimplemented. A partial API has an exact type-conformant
implementation but incomplete behavior. An API becomes implemented only after
its registered workerd comparison tests pass. Generated declarations, inventory,
and type checks are never edited manually. The generated inventory is syntactic;
`support.json` classifies runtime globals, module exports, binding factories, and
events. Type-only declarations come directly from the reference and are not
reported as runtime implementations.

Static conformance checks exact module keys, both constructor and instance sides
of classes, the explicit global installer manifest, and binding factory results.
The conformance compiler uses `skipLibCheck: false`. Checks reject unsafe type
escape hatches including explicit or nested `any`, unchecked assertions,
`@ts-ignore`, and `@ts-nocheck` unless the exact upstream declaration requires
them. Negative tests must prove each failure mode is detected.

The generated global inventory contains every value-bearing Cloudflare global.
The runtime global manifest must have exactly the same names and statuses, and a
runtime smoke test verifies that each name is installed before the Worker module
loads. Partial and implemented values receive exact type and behavioral checks.
Unimplemented values are installed as generated throwing placeholders and are
never treated as type-conformant implementations. If Node.js already provides an
unverified value with the same name, Orange replaces it with the placeholder so
unsupported behavior cannot appear to work accidentally.

Node-specific globals that have no Cloudflare counterpart are outside the
Cloudflare global manifest. They remain available because this foundation is a
Node.js compatibility runtime rather than a sandbox, stay absent from generated
Worker types, and are documented as a runtime deviation.

## Reference implementation policy

When the intended behavior or implementation approach is unclear, use workerd
and the historical Miniflare v2 TypeScript implementation as source references.
Workerd is the primary reference for current runtime semantics. Miniflare v2 is
useful for studying how Cloudflare APIs were reproduced in TypeScript before
Miniflare moved to workerd, but it predates modern Workers RPC and is not a
reference implementation for Durable Object method RPC, capability passing,
promise pipelining, or RPC stream transport.

Generated declarations and differential tests against the pinned Cloudflare
runtime remain the compatibility contract; upstream source does not replace
conformance. Whenever an Orange implementation materially follows or adapts a
specific behavior from workerd or Miniflare v2, its implementation must include
a nearby comment that names the behavior and links to the exact upstream lines
with a GitHub permalink containing a full commit SHA and line range. Moving
branch and tag links are not acceptable implementation provenance. This rule
includes algorithms, protocol behavior, and edge cases such as extracting and
transferring streams.

## Runtime organization

Runtime implementations live where Cloudflare exposes them:

- `globals/` owns values installed on `globalThis`.
- `modules/` contains one folder per exact Cloudflare import specifier. For
  example, `modules/cloudflare-workers/` implements `cloudflare:workers`.
- `bindings/` owns values constructed from Wrangler configuration and injected
  through the user's `env` object.
- `events/` owns dispatch into the user's Worker handlers.
- `internal/` is only for machinery genuinely shared by multiple public
  surfaces. Code should not be extracted there speculatively.

Type-only declarations do not need runtime exports; they remain in the generated
declaration contract. When one implementation must appear through more than one
surface, one public folder owns it and the other re-exports or installs that
same value.

The entrypoint loader must preserve named exports even though this MVP only
dispatches the default module Worker's `fetch` handler. Binding construction
must use an extensible factory rather than hardcoded `env` values, and
`cloudflare:*` import rewriting must remain generic. These seams are required by
future APIs, but unsupported imports and bindings still fail in this MVP.

The dedicated runtime child owns the HTTP listener. The root CLI owns process
startup, readiness, diagnostics, signals, and shutdown; per-request traffic does
not cross an extra CLI IPC proxy. The initial HTTP acceptance case is a basic GET
with a buffered response. Request streaming, response streaming, outbound
`fetch`, live reload, scheduled events, and other development features are
deferred.

### Binding decisions

Orange reads `secrets_store_secrets` without changing its Wrangler shape. During
local development, each secret value is loaded from `.dev.vars` or the process
environment using the binding name. The Worker receives a
`SecretsStoreSecret` object whose asynchronous `get()` returns that value; the
raw string is never injected directly or printed. A missing value throws an
actionable error naming the binding but not the secret value. This differs from
Wrangler-managed local Secrets Store state and is documented as an MVP
deviation. Behavioral comparison uses Wrangler's local implementation rather
than plain workerd.

Development version metadata uses a deterministic hash of the bundled Worker
and resolved configuration as `id`, the literal `dev` as `tag`, and the bundle
build time as an ISO timestamp. These values remain stable for the lifetime of
one bundle and change on rebuild. Differential tests validate shape, format, and
stability rather than comparing Cloudflare-generated values byte for byte.

## Basic Durable Objects milestone

Durable Objects begin only after the foundation revisions, including the two
initial bindings, pass end to end. This milestone makes ordinary, same-script,
SQLite-backed Durable Object applications run through RivetKit without requiring
the application to import or configure RivetKit itself.

### RivetKit source reference

The full Actors and RivetKit source is available locally under `~/actors`, with
the TypeScript runtime under `~/actors/rivetkit-typescript` and the core runtime
under `~/actors/rivetkit-rust`. Before assuming RivetKit lacks a primitive or
adding an Orange workaround, inspect the source at the exact revision Orange
will consume. The Actors working copy is shared and may not be at that revision,
so use read-only JJ commands such as `jj file show -r <revision>` and
`jj diff -r <revision>` rather than moving its working copy merely to inspect it.

The milestone includes:

- The `DurableObject` superclass from `cloudflare:workers`.
- Wrangler Durable Object bindings and initial `new_sqlite_classes` migration
  configuration.
- Automatic mapping of configured, named Durable Object class exports to
  RivetKit actor definitions.
- RivetKit registry setup, startup readiness, shutdown, and one user class
  instance per actor generation.
- Durable Object IDs, namespaces, lazy stubs, named and unique object
  resolution, RPC methods, and `fetch()` routing.
- Streaming `Request`, `Response`, and RPC values with cancellation and
  backpressure.
- Standard Durable Object WebSockets, followed by hibernatable WebSockets.
- Synchronous SQLite, synchronous and asynchronous key-value storage,
  transactions, storage synchronization, and alarms.

### Class registration and Rivet lifecycle

An exported class is registered only when a resolved Wrangler
`durable_objects.bindings` entry names it with `class_name`. Exporting an
unconfigured class does not create a namespace on Cloudflare and must not create
an actor type in Orange. During controlled entrypoint loading, Orange validates
that every configured class name resolves to a named export extending Orange's
`DurableObject` superclass, then creates one RivetKit actor definition per
Durable Object class.

The generated actor type and key must include the OpenOrange deployment
identity, Durable Object class namespace, jurisdiction metadata, and canonical
Durable Object ID. Multiple binding names that reference the same class share
one namespace. This prevents unrelated deployments or classes from resolving to
the same actor while preserving Cloudflare's one-namespace-per-class behavior.

Orange creates a single RivetKit registry with `setup({ use })`, starts it once,
waits for actual registry readiness before accepting Worker traffic, and shuts
it down with the runtime child. The implementation may use RivetKit's
`startAndWait()` internally rather than relying on fire-and-forget `start()`, but
it must preserve the requested setup/start lifecycle. Each Rivet actor
generation constructs one compatible `DurableObjectState`, one binding
environment, and one instance of the user's exported class before admitting
events. Durable JavaScript instance fields are never inferred or persisted.

For `orange dev`, the runtime owns the local Rivet Engine lifecycle and supplies
the generated registry configuration; Worker applications need only their
standard Wrangler configuration. RivetKit welcome output and signal handlers
are disabled because the Orange runtime child already owns diagnostics and
shutdown. Each project uses the local Engine's built-in `default` Rivet
namespace because RivetKit does not provision arbitrary namespaces on local
startup. The Engine storage path and generated actor types are deterministically
derived from the resolved project and environment so development projects
cannot collide.

### Namespace, stub, and routing model

`DurableObjectId` values are namespace-scoped and validate round trips through
`toString()` and `idFromString()`. `idFromName()` is deterministic;
`newUniqueId()` is random. Obtaining a namespace ID or stub is synchronous and
does not eagerly create an actor. The first stub operation resolves the
canonical ID through a Rivet client get-or-create handle.

Orange uses private, versioned routes on each generated Rivet actor definition:

- A raw HTTP route invokes the user's Durable Object `fetch()` method and keeps
  request and response bodies streaming.
- A private RPC route accepts Cap'n Web HTTP batches and WebSocket upgrades,
  invokes public class methods dynamically, and carries arguments, results,
  errors, capabilities, and streams.
- A WebSocket route upgrades into the standard or hibernatable Durable Object
  connection adapter.

The private routes are runtime implementation details and are never exposed as
application URLs. Method names are validated against the user class at dispatch
time; Orange does not need to generate a separate Rivet action for every method.

These are three separate transport planes. A Durable Object `fetch()` uses
RivetKit `onRequest`; ordinary HTTP `ReadableStream` responses, including SSE,
stay HTTP streams and do not use a WebSocket. A user WebSocket upgrade uses
RivetKit `onWebSocket`; it does not use Cap'n Web. Only arbitrary Durable Object
method calls use the private RPC route, whose WebSocket upgrades are internal
and distinct from user WebSockets. The current pull-request revision already has
streaming request and response plumbing through `ActorHandle.fetch()` and the
native `onRequest` boundary, so Orange first verifies that path end to end
instead of adding another streaming transport.

The remaining WebSocket work is an API adaptation rather than a missing
transport: Orange must translate Cloudflare's `WebSocketPair` plus a `101`
`Response` returned from the user's `fetch()` into RivetKit's actor-side
`onWebSocket` connection. Standard sockets then bridge frames directly.
Hibernatable sockets additionally map Cloudflare's tags, attachments, automatic
responses, fresh-instance wakeup, event callbacks, acknowledgement, replay, and
close behavior onto RivetKit's hibernatable connection lifecycle.

### Workers RPC implementation

[Cloudflare's Cap'n Web](https://github.com/cloudflare/capnweb) is the sole RPC
layer for arbitrary Durable Object method calls. Orange does not implement a
parallel stateless RPC protocol. Cap'n Web supplies method and property paths,
RPC promises and pipelining, capability tables, disposal, errors, and stream
flow control through both its HTTP-batch and WebSocket modes. The Durable Object
stub remains Orange's Cloudflare-compatible proxy, `stub.fetch()` uses the raw
fetch route, and user WebSockets use the separate WebSocket adapter.

The implementation is deliberately contained in
`packages/runtime-node/src/bindings/durable-objects/rpc/` rather than a separate
workspace package or a single catch-all source file. That directory owns the
Workers RPC facade, Cap'n Web adaptation, serialization, external handling,
method dispatch, and both protocol adapters. It accepts runtime-owned HTTP and
WebSocket transports; actor resolution, route registration, socket ownership,
pooling, execution-context cleanup, and shutdown remain responsibilities of the
surrounding Durable Objects runtime.

Orange mirrors workerd's value envelope instead of using Cap'n Web's default
JSON-like value encoding as its compatibility contract. Ordinary pass-by-value
graphs are encoded with Node's V8 serializer. Values that cannot be embedded in
that graph, including streams, functions, `RpcTarget` instances, RPC stubs, and
supported Fetch API host objects, are extracted into an indexed external table
carried by Cap'n Web. Decoding rehydrates those externals into the V8 graph while
preserving supported cycles, aliases, collections, typed arrays, and repeated
references. The codec must reproduce Cloudflare rejection, transfer, ownership,
size-limit, cancellation, and error behavior rather than accepting every value
that either Node or Cap'n Web can transport. Code implementing these semantics
must include the commit-pinned workerd or Miniflare v2 source permalinks required
by the reference implementation policy.

RPC uses a short-lived Cap'n Web HTTP batch whenever the call and its result can
complete without a live session. This is the default path for ordinary
request-response methods and self-contained promise pipelines; the batch tears
down without persistent socket state. Orange opens a private Cap'n Web WebSocket
only when live capabilities, callbacks, calls through a returned stub, or
bidirectional or multiplexed streams must survive the HTTP batch. Cap'n Web is
the RPC protocol in both cases.

Input externals can require a session before dispatch. Output externals are
known only after the user method runs, so HTTP-to-WebSocket promotion must never
retry or re-execute the method. The actor retains the already-produced result
under a single-use, expiring continuation token; the caller establishes the
private session and claims that result. Disconnect, expiry, duplicate claim,
actor-generation change, and failed upgrade must release retained resources and
surface as RPC failures. Runtime-owned sessions close when the associated
execution context and all transferred capabilities, calls, and streams have
ended; they must not keep an otherwise idle actor alive indefinitely.

Conformance must explicitly cover `Map`, `Set`, aliased and cyclic values,
nested and repeated externals, promise pipelining, callbacks and other
capabilities, stub ownership and disposal, disconnect behavior, error identity,
payload limits, stream ownership, cancellation, and backpressure. Cap'n Web-only
behavior that Cloudflare does not expose must not leak through Orange.

### Storage and scheduling model

The initial storage backend is RivetKit's per-actor SQLite database. Orange maps
Cloudflare's synchronous SQL cursor API and synchronous KV API to the pinned
custom RivetKit build, and maps asynchronous storage operations and transactions
to the same database so both views observe one ordered state. The source build
is [RivetKit pull request #5883](https://github.com/rivet-dev/actors/pull/5883),
consumed at commit
`a2b9069f7c48713196f02dd60bdbe667bfd5e4d8`. Orange consumes the immutable
`0.0.0-feat-sqlite-sync.a2b9069` preview packages produced from that commit. Orange
may update that pull request
when integration exposes a missing or incorrect general-purpose RivetKit
primitive. Revision 61 must refresh and pin the exact immutable commit Orange
consumes; it must never depend on the moving pull-request branch.
The selected preview publishes a complete native package set for Linux x64 and
arm64 and macOS x64 and arm64, but not Windows; Orange must reject an unsupported
host before RivetKit loads until a later immutable build supplies both Windows
NAPI and Engine artifacts.

This milestone intentionally runs the synchronous bridge on the single runtime
thread. A synchronous database call may therefore block unrelated Workers and
actors in that process. Worker-thread isolation is a later runtime milestone and
this limitation must be recorded in the public module document. This
tradeoff is accepted for the basic milestone. The next runtime milestones are,
in order, Cloudflare-compatible input and output gates followed by worker-thread
isolation of synchronous SQLite.

One Cloudflare alarm maps to one Rivet scheduled event per actor. The adapter
must persist the scheduled time, invoke the user class's `alarm()` handler with
retry metadata, and match replacement, deletion, at-least-once delivery, and
retry behavior as far as the Rivet scheduler permits.

### Completion and conformance

Every revision that marks a Durable Object slice partial or implemented follows
the repository module checklist: it includes runtime implementation, updates
`docs/modules/durable-objects.mdx`, and adds static and behavioral conformance
coverage. Every numbered item remains one jj revision. No Durable Object
capability may be marked implemented merely because its generated type compiles.

The end-to-end acceptance suite runs representative current
[Cloudflare examples](https://developers.cloudflare.com/durable-objects/examples/)
through `orange dev` without source changes: an RPC counter, a fetch-routed
object, streaming RPC and fetch bodies, a standard WebSocket object, a
hibernatable WebSocket object that sleeps and wakes, a SQLite-backed object, and
an alarm-driven object. It also proves object and class isolation, lazy creation,
restart persistence, shutdown, and failure propagation.

Examples are manually copied under `tests/cloudflare-examples/<area>/<id>/`. Each directory
contains the unchanged example source, its Wrangler configuration, and a small
`example.json` manifest:

```json
{
  "id": "durable-object-rpc-counter",
  "source": "tests/cloudflare-examples/durable-objects/durable-object-rpc-counter/src/index.js",
  "wranglerConfig": "tests/cloudflare-examples/durable-objects/durable-object-rpc-counter/wrangler.jsonc",
  "reference": "https://github.com/cloudflare/cloudflare-docs/blob/e65ba8b1fa64a5dc7c5c42a96c455398945cdf5e/src/content/docs/durable-objects/examples/build-a-counter.mdx#L20-L83",
  "expectation": "expected-pass"
}
```

`expectation` is either `expected-pass` or `known-broken`. A known-broken
example also includes a `reason`; it remains in the suite as an expected failure
until its gap is fixed. Source files are byte-for-byte copies of their referenced
upstream blocks. Their local Wrangler files preserve the relevant binding and
migration while normalizing the compatibility date and flags to Orange's one
supported profile. `tsx scripts/validate-example-manifests.ts` validates only the
strict manifest fields, unique IDs, repository-relative local files, directory
layout, stable GitHub permalinks, and expectation reasons. It performs no network
access and does not run the examples. The stable `reference` field is the seed
for a later, separate upstream-update tool.

Because input and output gates are not part of this milestone, Durable Objects
remain **partial**, not fully Cloudflare-conformant, even after these examples
pass. “Basic Durable Objects complete” means the selected API surface works end
to end; it does not claim Cloudflare's storage ordering and failure-reset
semantics.

## Revision plan

Every numbered item below is one jj revision. Each revision must be independently
reviewable, must have a conventional-commit description, and must leave all
available checks passing. The implementing revision also changes its own box
from `[ ]` to `[x]`; a checked item therefore means its acceptance criteria are
present in that revision and verified, not merely that work started.

Checklist progress: **73 of 75 execution items are complete.** Execution always
resumes from the first unchecked item unless an earlier regression must be
repaired.

1. [x] **Remove the obsolete API-surface prototype.** Delete only the old
   `packages/api-surface` implementation, commands, and dependencies; preserve
   the active specification and workspace foundation.
2. [x] **Scaffold the Cloudflare conformance CLI.** Add the private package, command
   dispatch, reference configuration, and empty `support.json`.
3. [x] **Generate pinned Wrangler declarations.** Use the selected Wrangler and
   compatibility profile with `--include-env=false`; repeated generation must
   be byte-for-byte deterministic.
4. [x] **Generate the syntactic API inventory.** Extract stable declarations,
   members, declaration kinds, module specifiers, and signature hashes without
   trying to infer runtime capability categories.
5. [x] **Generate the Wrangler help inventory.** Walk the complete pinned command
   tree and write normalized help and command metadata.
6. [x] **Check generated artifact freshness.** Detect stale declarations,
   inventories, help output, invalid support entries, removed APIs, and changed
   registered signatures.
7. [x] **Prove conformance-check failures.** Add negative tests for stale output,
   missing or incorrectly typed values, extra module exports, invalid binding
   results, CLI-help differences, and unsafe type escape hatches.
8. [x] **Expose the generated Wrangler command tree.** Register every command,
   argument, option, alias, and default in Orange; unimplemented command handlers
   fail explicitly.
9. [x] **Check Orange help parity.** Walk both CLIs and fail on missing, extra, or
   different normalized help endpoints.
10. [x] **Scaffold the Node.js runtime.** Add strict TypeScript, tests, package
   exports, and the pinned Node.js and Undici execution substrate.
11. [x] **Establish the differential-runner protocol.** Pin workerd, run normalized
   fixtures against workerd and an Orange test adapter, compare values and
   errors, and prove that a deliberate mismatch fails `check`.
12. [x] **Install the complete global manifest.** Generate every Cloudflare global
    name, install throwing placeholders for unimplemented values, check exact
    manifest keys, and prove every name exists before Worker evaluation.
13. [x] **Check global implementations.** Generate exact type checks for partial and
    implemented global values without treating placeholders as implementations.
14. [x] **Implement base64 and text globals.** Add `atob`, `btoa`, `TextEncoder`, and
    `TextDecoder` with focused compatibility tests.
15. [x] **Add basic HTTP globals.** Add partial `Headers`, `Request`, and `Response`
    support sufficient for the first Worker request and response.
16. [x] **Check binding factory results.** Validate constructed Secrets Store and
    version metadata values against their exact runtime interfaces; defer
    project-specific `Env` validation until `orange types` exists.
17. [x] **Implement version metadata.** Construct and inject the
    `WorkerVersionMetadata` binding from normalized runtime configuration.
18. [x] **Implement Secrets Store.** Resolve values from `.dev.vars` or the process
    environment by binding name and implement `SecretsStoreSecret.get()` without
    exposing secrets to logs or generated output.
19. [x] **Check imported module exports.** Validate enabled exports by exact
    `cloudflare:*` specifier even though no module export is implemented yet.
20. [x] **Check Worker event handlers.** Compile fixture entrypoints against the
    exact module Worker fetch-handler contract.
21. [x] **Implement the partial execution context.** Supply the type-correct context
    required by fetch dispatch and explicitly fail unsupported context behavior.
22. [x] **Load and dispatch Worker entrypoints.** Install globals, construct `env`,
    preserve named exports, import the controlled entrypoint, invoke `fetch`, and
    require a `Response` result.
23. [x] **Load and validate Wrangler configuration.** Support Wrangler JSONC, TOML,
    named environments, and resolution rules. Resolve the entrypoint,
    environment, exact compatibility profile, and the two supported bindings;
    reject all unsupported configured capabilities.
24. [x] **Implement `orange types`.** Generate a self-contained project declaration
    file through the pinned Wrangler generator and support freshness checking.
25. [x] **Check generated binding environments.** Compare `orange types` output for
    binding fixtures with the pinned Wrangler output and compile their `Env`
    usage against the runtime binding factories.
26. [x] **Bundle Worker entrypoints.** Produce a controlled runnable bundle and an
    allowlisted rewrite seam that rejects unsupported `cloudflare:*` imports.
27. [x] **Start the dedicated runtime process.** Let the child own the HTTP listener,
    load the bundle only after globals and bindings exist, and report readiness,
    startup errors, runtime errors, signals, and shutdown to the CLI.
28. [x] **Implement `orange dev`.** Expose both CLI aliases and serve HTTP through
    the runtime process. Acceptance requires one GET request to reach the Worker
    and return a buffered `Response`.
29. [x] **Verify the published package.** Run `npm pack`, install the tarball in a
    clean fixture, and prove that both binaries can locate and launch the child
    runtime artifact.
30. [x] **Verify version metadata end to end.** Run a real Wrangler-configured
    fixture through `orange dev` and validate the injected metadata.
31. [x] **Verify Secrets Store end to end.** Resolve a non-production test secret,
    call `get()` inside the Worker, and validate the response without logging the
    secret.

### Durable Objects phase 1 — registration and lifecycle

32. [x] **Define the Durable Objects conformance matrix.** Classify every generated
    Durable Object type and member, add failing fixtures for the included and
    excluded surface, and create `docs/modules/durable-objects.mdx` with an
    unimplemented status.
33. [x] **Implement the Durable Object module base.** Export the exact
    `DurableObject` superclass from `cloudflare:workers`, preserve `ctx` and
    `env`, and add constructor and instance-side conformance checks.
34. [x] **Resolve Durable Object configuration.** Parse bindings, same-script class
    names, and initial SQLite migrations into a deterministic runtime manifest;
    reject unsupported cross-script bindings and migrations explicitly.
35. [x] **Discover configured class exports.** Validate named entrypoint exports
    against the manifest and superclass without registering unrelated exports.
36. [x] **Generate Rivet actor definitions.** Wrap every configured Durable Object
    class in one collision-safe RivetKit actor definition with private fetch,
    RPC, and WebSocket route slots.
37. [x] **Start the Rivet registry.** Build one registry with `setup({ use })`, wait
    for readiness, integrate runtime-child startup and shutdown, and propagate
    lifecycle errors.
38. [x] **Construct Durable Object generations.** Create the compatible state and
    environment and instantiate the user class exactly once per Rivet actor
    generation before dispatch begins.
39. [x] **Verify class registration end to end.** Boot a configured exported class,
    prove it appears in the generated registry, and prove unconfigured or
    missing exports fail deterministically without invoking user methods.

### Durable Objects phase 2 — bindings, RPC, and fetch

40. [x] **Implement Durable Object IDs.** Add namespace-scoped named and unique IDs,
    string round trips, equality, name and jurisdiction metadata, and invalid or
    cross-namespace rejection.
41. [x] **Implement Durable Object namespaces.** Add `idFromName`, `newUniqueId`,
    `idFromString`, `get`, `getByName`, and best-effort jurisdiction and location
    option mapping without eagerly starting actors.
42. [x] **Implement lazy Durable Object stubs.** Map the first stub operation to a
    Rivet client get-or-create handle keyed by deployment, class namespace, and
    canonical ID; expose the exact stub `id` and `name` fields.
43. [x] **Isolate and pin the Cap'n Web RPC layer.** Replace the proposed
    catch-all `rpc.ts` with the dedicated Durable Objects `rpc/` directory, pin
    Cap'n Web, expose one narrow facade, and prove its HTTP-batch and WebSocket
    adapters can run behind private Rivet actor routes without owning actor or
    socket lifecycle.
44. [x] **Implement the workerd-style RPC value codec.** Encode ordinary graphs
    with the Node V8 serializer, extract and index Cap'n Web externals, rehydrate
    them without losing cycles or aliases, and add commit-pinned workerd source
    comments plus focused round-trip and rejection tests.
45. [x] **Implement short-lived Cap'n Web HTTP RPC.** Make HTTP batch the default
    for value-only request-response calls and self-contained promise pipelines;
    verify deterministic teardown, errors, cancellation, payload limits, and no
    persistent WebSocket state.
46. [x] **Implement on-demand Cap'n Web sessions.** Use private WebSockets only for
    live externals or calls that outlive a batch, implement single-execution
    HTTP-result promotion with expiring continuation tokens, and prove cleanup
    on claim, disposal, expiry, disconnect, failed upgrade, and generation
    replacement.
47. [x] **Route basic RPC methods.** Proxy arbitrary non-reserved stub methods to the
    matching user class method, make every call asynchronous, and propagate
    return values and exceptions through Cap'n Web.
48. [x] **Match RPC value and lifetime semantics.** Add structured values,
    transferable capabilities, disposal, payload limits, cancellation, error
    normalization, promise pipelining, nested or repeated externals, and explicit
    failures for values the codec cannot match; hide Cap'n Web-only semantics.
49. [x] **Implement streaming RPC.** Transfer request, response, readable, and
    writable bodies with bounded buffering, backpressure, cancellation, and no
    premature actor sleep.
50. [x] **Route Durable Object fetch.** Implement `stub.fetch()` over the private raw
    HTTP route with URL and method preservation, streaming bodies, headers,
    status, cancellation, and user exceptions.
51. [x] **Match stub ordering and failure behavior.** Preserve per-stub call order,
    define retry boundaries, poison or recreate failed stubs where Cloudflare
    does, and prevent late results from a previous actor generation.
52. [x] **Verify RPC and fetch end to end.** Run unchanged RPC, legacy fetch, error,
    isolation, and streaming fixtures through the Worker binding and Rivet
    actor.

### Durable Objects phase 3 — standard WebSockets

53. [x] **Implement WebSocketPair and upgrades.** Support the Cloudflare pair shape,
    `Response` status 101, acceptance state, text and binary frames, and close
    validation needed by Durable Object WebSockets.
54. [x] **Bridge standard Durable Object WebSockets.** Route an upgraded stub fetch
    into the Rivet actor WebSocket path and dispatch message, close, and error
    events while the actor remains awake.
55. [x] **Verify standard WebSockets end to end.** Compare handshake, bidirectional
    text and binary traffic, ordering, close, error, cancellation, and
    backpressure behavior with the pinned Cloudflare runtime.

### Durable Objects phase 4 — hibernatable WebSockets

56. [x] **Implement hibernatable WebSocket registration.** Add
    `acceptWebSocket()`, `getWebSockets()`, tags, event timeout configuration,
    and the connection bookkeeping required for actor sleep.
57. [x] **Persist hibernatable attachments.** Implement attachment serialization,
    size and clone validation, tag lookup, removal, and restoration through
    RivetKit's hibernatable connection state.
58. [x] **Dispatch hibernatable WebSocket events.** Recreate the user Durable Object
    generation on wake and route message, close, and error handlers to restored
    WebSocket objects without replaying acknowledged events.
59. [x] **Implement hibernatable automatic responses.** Add auto-response
    configuration, timestamps, close behavior, and timeout handling; record any
    behavior that Rivet cannot perform without waking the actor.
60. [x] **Verify hibernation end to end.** Prove a connection survives actor sleep,
    wakes a new class generation, restores tags and attachments, preserves event
    order, and cleans up stale connections.

### Durable Objects phase 5 — storage, scheduling, and state

61. [x] **Pin the synchronous RivetKit build.** Use RivetKit pull request #5659,
    update the upstream branch if integration requires generally useful fixes,
    pin the exact consumed commit, make its native artifact reproducible in
    development and package tests, and prove a deliberate version mismatch
    fails startup.
62. [x] **Implement synchronous SQL.** Map `SqlStorage.exec`, cursors, iteration,
    `one()`, `raw()`, column names, row counters, binding validation, and
    `databaseSize` to the actor's SQLite database.
63. [x] **Implement synchronous transactions.** Add `transactionSync()` with atomic
    commit and rollback and reject transaction-control SQL that Cloudflare does
    not permit through `exec()`.
64. [x] **Implement synchronous KV storage.** Map `ctx.storage.kv` to the same
    SQLite database with exact value cloning, ranges, limits, and return shapes.
65. [x] **Implement asynchronous KV storage.** Add async get, multi-get, put,
    multi-put, delete, multi-delete, list, and delete-all over the same state.
66. [x] **Implement async transactions and synchronization.** Add transaction
    rollback, alarm operations inside transactions, `sync()`, no-cache handling,
    and explicit rejection of gate-related options until the gate milestone.
67. [x] **Persist Durable Object alarms.** Map get, set, replace, and delete to one
    durable Rivet scheduled event per actor and preserve the scheduled time over
    restarts.
68. [x] **Dispatch and retry alarms.** Invoke the user `alarm()` handler with retry
    metadata, at-least-once delivery, replacement rules, bounded exponential
    retry, cancellation, and failure diagnostics.
69. [x] **Complete the basic Durable Object state.** Implement `id`, `storage`,
    `waitUntil`, startup-only `blockConcurrencyWhile`, and actor-generation
    abort/reset behavior; keep facets, containers, loopback exports, and full
    gate behavior explicitly unimplemented.
70. [x] **Apply initial SQLite class migrations.** Recognize
    `new_sqlite_classes`, initialize the correct per-class backend once, and
    reject rename, delete, transfer, and legacy-KV migration operations until
    separately implemented.
71. [x] **Verify storage lifecycle end to end.** Test SQL, sync KV, async KV,
    transactions, alarms, object isolation, process restart persistence, actor
    generation recreation, and the documented single-thread blocking behavior.

### Durable Objects phase 6 — acceptance

72. [x] **Standardize the Cloudflare example corpus.** Manually copy the selected
    programs into `tests/examples`, add expected-pass or known-broken manifests,
    and implement the TypeScript manifest validator without network access.
73. [x] **Run the Cloudflare example corpus.** Execute the selected current RPC,
    fetch, streaming, WebSocket, hibernation, SQLite, and alarm examples through
    `orange dev` without source modifications; report known-broken cases as
    explicit expected failures.
74. [x] **Audit Durable Objects conformance.** Run generated type, module-export,
    binding, behavior, and negative checks; update every support status, public
    documentation section, and confirmed gap without broadening a type.
75. [x] **Verify packaged Durable Objects.** Install the packed `open-orange`
    artifact in a clean fixture and rerun registration, RPC, WebSocket,
    hibernation, SQLite, alarm, restart, and shutdown smoke tests.

The Durable Objects revisions run after the foundation and before the remaining
Wrangler command families. Afterward, full Wrangler behavior proceeds command by
command. Each command or coherent subcommand family is one jj revision, adds
behavioral fixtures, updates its support status, and updates the corresponding
public documentation before it can be marked implemented.


```text
orange dev
  -> load Wrangler configuration and assert the supported profile
  -> reject unsupported configuration and imports
  -> bundle the user's Worker
  -> start the dedicated Node.js runtime process
  -> install supported globals and construct bindings
  -> import the controlled user entrypoint
  -> dispatch an HTTP request to the Worker fetch handler
```

The conformance loop is: generate the pinned Cloudflare runtime and Wrangler
help references, check Orange's CLI, globals, module exports, bindings, and
events against them, implement one coherent slice, compare behavior against the
appropriate Cloudflare runner, and repeat. Broad types such as `any` cannot be
used to bypass the generated contract.

## Durable Objects compatibility boundary

Durable Objects remain outside the foundation MVP but are the next milestone in
this specification.

The basic milestone intentionally excludes input and output gates, full
`blockConcurrencyWhile()` behavior outside startup, write coalescing, failed
write effect cancellation, and Cloudflare-equivalent in-isolate actor reset.
The basic `abort()` implementation poisons the current event and requests a full
Rivet actor sleep so the next operation creates a fresh generation. It also
leaves facets, containers, `ctx.exports`, `ctx.props`, point-in-time recovery,
cross-script namespaces, declarative class exports, legacy KV-backed classes,
advanced class migrations, exact jurisdiction or location placement, and
worker-thread isolation unimplemented. These members remain visible in the
generated conformance inventory and must throw or reject clearly rather than
silently degrade.

The lack of gates is a correctness boundary: code that depends on Cloudflare's
storage interleaving prevention or output durability is not compatible yet.
Full Durable Objects conformance requires a later gate milestone. The single-thread synchronous SQLite bridge is
accepted only for this basic milestone and must not be presented as the final
isolation model. Follow-up work implements input and output gates first, then
moves synchronous SQLite execution to worker threads.
