# Cloudflare conformance

Conformance tooling for OpenOrange. Run the commands from this package:

| Command | What it does |
|---|---|
| `pnpm generate` | Regenerates the pinned Cloudflare reference artifacts in `generated/` |
| `pnpm check` | Checks OpenOrange against the generated artifacts |
| `pnpm upstream` | Runs the upstream workerd test suite against `orange dev` |
| `pnpm results:save <run-dir>` | Saves a compact snapshot of an upstream run to `results/` |
| `pnpm report` | Builds the website (`website/`), whose `/docs/compatibility/` page reads `results/` and `compat/*.json` at build time |
| `pnpm real-projects` | Runs real open-source projects through `orange dev` (`--probes` runs the probes) |
| `pnpm example-results` | Saves each example scenario's outcome |
| `pnpm truth-table` | Builds `compat/truth-table.json` from the recorded results |
| `pnpm site` | Runs the website's dev server; the report is at `/docs/compatibility/` |

## Upstream workerd tests

`pnpm upstream` runs every `.wd-test` file from the workerd commit pinned in `upstream.json` against `orange dev`. For each file it:

1. Runs the file on the pinned `workerd` package. Only tests that pass there are scored.
2. Reads the file's config with `capnp eval` and writes the main service as an Orange project in a temp directory.
3. Starts `orange dev` on its own port and calls each test through a shim.
4. Stops `orange dev` and its Rivet Engine by PID.
5. For Node.js compat files (`node-tests--*`), calls each test in a plain Node.js process with stock built-ins (`src/upstream/plain-node-runner.mjs`). The file's text and JSON bindings are its `env`. See [Plain Node.js pass](#plain-nodejs-pass).

Requirements: the `capnp` CLI (Cap'n Proto 1.x, `apt install capnproto` or `brew install capnp`) and `git`. The first run fetches the pinned test sources into `.upstream/cache/` (sparse, shallow, about 20 MB). Results go to `.upstream/runs/<timestamp>/`. Both are gitignored.

The runner also runs the Orange-written `.wd-test` files in the directories listed under `localTestDirectories` in `upstream.json`, with the same workerd-first scoring. `synthetic/` holds Durable Object tests ported from workerd's C++ unit tests. Their ids start with `synthetic--`. `synthetic/manifest.json` maps each file to the upstream C++ files and `KJ_TEST` names it ports, with the git blob SHA of each C++ file at the pinned commit. `synthetic/worker-loader-lifetime-test.wd-test` is not a port: it checks Worker Loader behavior that upstream tests do not reach, such as a loaded Worker's stubs after the event that loaded it ends, and runs on workerd first like every other file.

```sh
pnpm upstream                                   # full suite, 4 files at a time
pnpm upstream --filter 'synthetic--'            # only the synthetic tests
pnpm upstream --filter 'api-tests--actor' --jobs 2
pnpm upstream --jobs 6 --compare .upstream/runs/<earlier-run>
```

| Flag | Default | Meaning |
|---|---|---|
| `--filter <regex>` | all files | Runs only files whose id matches, for example `node-tests--buffer` |
| `--jobs <n>` | `4` | Files to run at once |
| `--out <dir>` | `.upstream/runs/<timestamp>` | Results directory. Must be new or empty. |
| `--compare <dir>` | none | Prints tests that became passing or failing since an earlier results directory |
| `--bindings <list>` | `service,entrypoints,vars,unsafeEval,loader,kv,r2,queues,analyticsEngine` | Binding kinds to configure. Other bindings are dropped and recorded. |
| `--engine-binary <path>` | `RIVET_ENGINE_BINARY`, then RivetKit's bundled engine | `rivet-engine` for `orange dev` to start |

The results directory holds one `<file-id>.json` per file, `summary.json` (one row per test), `run.json` (settings and wall time), and `logs/` (workerd, plain Node.js, and `orange dev` output per file). Each file has a 25 minute limit. A test that does not answer in 60 s is a hang, and `orange dev` restarts for the next test.

### Plain Node.js pass

Orange gives Workers stock Node.js built-ins, so a Node.js compat test only says something about Orange when stock Node.js passes it. A test that fails on plain Node.js tests workerd-specific behavior, such as a stub that throws `ERR_METHOD_NOT_IMPLEMENTED` or workerd's per-request `/tmp`. Such a test is **workerd-only**: its row keeps the Orange outcome and the plain Node.js error (`node: "fail"`, `nodeError`), and no score counts it. The summary prints two scores: Cloudflare APIs (every area except Node.js compat) and Node.js (Node.js compat tests that pass on plain Node.js).

- A test that ends the plain Node.js process fails there, and the rest of the file runs in a new process.
- A test file that imports a `cloudflare:` module cannot load on plain Node.js. Its tests get no plain Node.js outcome and stay scored.
- Files listed under `tmpWriters` in `upstream.json` write to `/tmp`. The workerd `fs-*` tests are there. Orange runs them unmodified, because each Worker event has a private `/tmp`. On plain Node.js `/tmp` is the host `/tmp`, where they would change real host files, such as a `/tmp/link-root` symlink to `/`, so plain Node.js runs them with `/tmp` remapped. See [Files that write `/tmp`](#files-that-write-tmp).
- Tests listed under `notRunTests` (`<file id> > <test>`) run on neither Orange nor plain Node.js, with a reason. They fail with the cause `Not run`.

### Files that write `/tmp`

- On Orange the test module runs unmodified, and its results are scored like every other file. Orange gives each request and each Durable Object a private `/tmp`, as workerd does, so each test, which is its own request, starts with an empty `/tmp`.
- For plain Node.js only, the runner rewrites every `/tmp` path in the test module (string and template literals, `file:///tmp` URLs, and `\/tmp` in regular expressions) to `<os tmpdir>/oo-fs-scratch-<random>/tmp`, and empties that directory before each test.
- After the rewrite, any `/tmp` text outside the scratch path stops the file with an error, so a path the rewrite cannot place never reaches the host `/tmp`.
- Cleanup uses `fs.rm` with `recursive`, which does not follow symlinks. The runner never changes modes or owners recursively.
- These files run first, one at a time, before the other files. Around each one, the runner snapshots the top-level entries of the host `/tmp`, the home directory, and the repository root (`lstat`: type, mode, owner, mtime). Any change outside the runner's own temporary directories stops the run with the list of changes, so a Worker that reached the host `/tmp` stops the run.
- Saved runs from before Orange had a private `/tmp` ran these files remapped on Orange too. Their rows have the status `remapped-pass` or `remapped-fail`, which no score includes, and `totals.remapped` counts them.

### Failure causes

The summary groups failures by the first rule that matches. Files listed under `notSupported` in `upstream.json` skip the rules:

| Cause | Meaning |
|---|---|
| `Not supported` | The file is listed under `notSupported` in `upstream.json` with a reason, such as a feature behind a workerd experimental flag. Its tests stay in the total. |
| `Not run` | The test is listed under `notRunTests` in `upstream.json` with a reason. |
| `test-infra` | The test needs a workerd-only test module or global (`workerd:unsafe`, `workerd:test`, `gc`). Excluded from the score. |
| `cloudflare:<name> module missing` | The import fails at bundle time, so the whole file fails. |
| `cloudflare:workers has no <export>` | A missing export stops the file from loading. |
| `Config rejected` | Orange rejects the generated Wrangler config. |
| `Missing CF globals` | The test reached a throwing stub for a Cloudflare global. |
| `Bundling fails` | esbuild cannot bundle the worker. |
| `Unsupported binding` | The test uses a binding Orange cannot configure, so it reads `undefined`. |
| `fs is the host disk, not a virtual fs` | An `fs-*` test fails on a host path or error, such as `ENOENT` for `/bundle`. |
| `Not-implemented API` | The error says `not implemented` or `NotSupportedError`. |
| `One test crashes the whole runtime` | `orange dev` exited during the test. |
| `Hangs (60s timeout)` | The test did not answer in 60 s, or the file hit its time limit. |
| `File fails at load` | `orange dev` did not start for another reason. |
| `Behavior differs` | The test ran and its assertion failed. |

## Truth table

`compat/truth-table.json` says what works and what does not. A claim's status comes from recorded results only:

| Status | Evidence |
|---|---|
| `works` | All of it passed |
| `partial` | Some of it passed |
| `does-not-work` | None of it passed |
| `not-run` | None was recorded |

A page that reads `compat/truth-table.json` needs no other context:

| Field | What it holds |
|---|---|
| `notices` | Claims to show first, each complete on its own: `title`, `availability` (`coming-soon` means planned, with no date or design), `cloudflare`, `orange` (what it means today), `why`, `action`, and `drawbacks` |
| `areas[].claims` | Everything else, by area, with `status`, `evidence`, and the same text fields |
| `summary.failedSteps` | Failed project steps by cause: `owner`, a `label` ready to show, and `steps` |
| `projects[].failures[]` | Each failed step: `step`, the exact `error`, `ownerLabel`, and `note`. `emulated` is what a step that fails for lack of hibernation did under the emulated sleep gate. The step stays failed |
| `projects[].status` | The run's status, or `works-emulated`: the project fails only hibernation steps, and each one passes emulated. `summary.projects` counts it apart from `works` |
| `emulatedHibernation` | The emulated runs in numbers, and a `note` that says what emulation is and what it still costs. Show the note with every emulated result |
| `scaling` | How each binding scales: `binding`, `scalesBy`, and `detail` |

Each claim in `compat/truth-table.claims.json` also says which status its text describes. When a run changes a result, `pnpm truth-table` stops and names the claim, so the words change with the facts.

```sh
pnpm upstream --jobs 6 && pnpm results:save .upstream/runs/<timestamp>   # workerd tests
pnpm example-results
pnpm real-projects --probes
pnpm real-projects --jobs 6
pnpm real-projects --jobs 6 --sleep-gate emulated   # writes result.emulated.json, never result.json
pnpm truth-table
pnpm report
```

## Saved results and the compatibility matrix

Committed data that a website can chart directly. All files are JSON with a `schemaVersion` (now `3`). A version bump means a field changed meaning or was removed. New fields keep the version. Version 2 leaves workerd-only Node.js tests out of every score. Version 3 adds the `remapped-pass` and `remapped-fail` statuses and `totals.remapped`. Older snapshots stay readable: version 1 Node.js scores count every Node.js compat test, and versions 1 and 2 have no remapped tests.

| File | What |
|---|---|
| `results/runs/<YYYY-MM-DD>-<sha7>.json` | One saved full run (`RunSnapshot` in `src/results/save.ts`) |
| `results/latest.json` | A copy of the newest saved run |
| `results/history.json` | Every run so far, oldest first (`HistoryEntry[]`), for the runs chart |
| `compat/matrix.json` | Hand-maintained feature matrix (`CompatMatrix` in `src/compat/matrix.ts`) |
| `compat/products.json` | Hand-maintained product table with status and configuration (`ProductTable` in `src/compat/products.ts`) |
| `compat/real-projects.json` | Hand-maintained Cloudflare template results against `wrangler dev`. The website's templates section reads it |
| `compat/truth-table.json` | Generated. What works, what does not, how each binding scales, and the real-project results (`TruthTable` in `src/truth-table/types.ts`). The website reads this file |
| `compat/truth-table.claims.json` | Hand-written text and the recorded results each claim rests on |
| `results/runnable-examples.json` | Saved outcome of each example scenario |
| `real-projects/` | Real open-source projects: pinned commit, scenario, and result. See [its README](real-projects/README.md) |
| `probes/` | Small Workers that measure SQLite, limits, and scaling, on Orange and on workerd. See [its README](probes/README.md) |
| `repros/` | The smallest Worker for each Orange bug that real projects found. See [its README](repros/README.md) |

`RunSnapshot` fields:

| Field | Meaning |
|---|---|
| `date`, `startedAt`, `wallSeconds` | When the run started (UTC) and how long it took |
| `label`, `note` | Short run name and one sentence, from `results:save` |
| `orange.sha`, `orange.dirty` | Orange commit (7 chars). `dirty` is null when unknown |
| `rivetkit`, `engine.binary`, `workerd` | RivetKit version, engine override (`null` = RivetKit's bundled engine), pinned workerd tag and commit |
| `unverified` | Field paths whose values were not verified, for example `orange.sha` |
| `totals` | `files`, `syntheticFiles`, and pass/total for `all`, `upstream`, `synthetic`, `cloudflare` (upstream tests outside Node.js compat), and `node` (Node.js compat tests that pass on plain Node.js). `infraExcluded` and `workerdOnly` count unscored tests. `remapped` is pass/total for `/tmp`-remapped tests that are not workerd-only, also unscored. It is 0 for runs where Orange has a private `/tmp` |
| `perArea` | Scored upstream tests only, by area |
| `perCause` | Failed tests by cause, upstream and synthetic |
| `notSupported` | File id to its `upstream.json` reason |
| `files[]` | `id`, `area`, `synthetic`, `pass`, `total`, `infra`, `workerdOnly` per file |
| `tests[]` | `file` (file id), `area`, `test`, `status` (`pass`, `fail`, `infra`, and in older runs `remapped-pass` or `remapped-fail`), `cause`, and `error` on failures (no stack frames, at most 200 characters). Node.js compat tests also have `node` (`pass` or `fail` on plain Node.js), and `nodeError` when it fails |

`HistoryEntry` has `source` (`run` or `manual`), `date`, `label`, `sha`, `rivetkit`, scored upstream `pass` and `total`, `synthetic`, `cloudflare` and `node` (absent on entries saved before them, and `node` is null for version 1 runs), `perArea` (null when not recorded), and `run` (snapshot path) for saved runs. `manual` entries predate saved runs, and `results:save` keeps them.

Each matrix entry has `id`, `category`, `name`, `status`, `cloudflare`, `orange`, `notes`, `evidence`, and optional `workaround`, `since`, and `unverified`. Each entry covers one item: one binding type, handler, API, module, flag, config key, or limit. Statuses: `supported`, `partial`, `alternative` (works on an Orange backend, such as KV and D1 on Rivet Actors), `stub` (throws a clear error), `rejected` (fails at config or Worker load), `unsupported` (missing, ignored, or wrong without a clear error), `not-applicable` (deploy-only, or workerd-only or experimental). Evidence items are `code` (repo path and lines), `test` (a file id and test name in the saved results), `doc` (URL), or `note` (a research note outside the repo). The package tests check that every code path exists and every test is in `results/latest.json`.

Save a full run, then view it on the website:

```sh
pnpm upstream --jobs 6
pnpm results:save .upstream/runs/<timestamp> --label "Orange PR #3"
pnpm site                           # the website's dev server; open /docs/compatibility/
pnpm report                         # or build the website into website/dist/
```

The website imports these files directly when it builds, so there is no export step: commit a saved run or a `compat/*.json` change and the next website build shows it.

`pnpm upstream` records the Orange commit and the installed RivetKit version in `run.json`. For older runs, pass `--orange-sha` and `--rivetkit`. `results:save` refuses runs made with `--filter`.

