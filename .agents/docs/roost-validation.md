# Roost validation workflow

Use this workflow for Lody's Roost integration and its matching Roost SDK/Native
changes. It fixes setup, owning suites and comparison workloads so a new change
does not require rediscovering them. Runtime contracts remain in
[session rules](../../apps/cli/src/session/AGENTS.md) and the matching Roost source.
Run expensive measurements manually; timing is never a CI assertion.

For the current coordinated release, use the [PR stack integration review](../notes/proposed/testing/2026-10-22-roost-pr-stack-integration.md) for exact heads, dependency order and release gates.
The [append CPU report](../notes/proposed/architecture/2026-10-23-roost-append-cpu-structure.md#completed-local-optimization-acceptance--2026-10-23)
records request reduction, paired resource results and retained read-time outliers.
The [Native publication report](../notes/proposed/architecture/2026-10-23-roost-native-publication-boundary.md#final-local-resource-measurements)
records the coordinated command/head/observer unit, complete resource tables and
retained RSS-limit failures. These local results do not imply release acceptance.
The [position paging experiment](../notes/proposed/architecture/2026-10-24-roost-position-paging.md)
tracks cold positional reads, derived-index maintenance and the index-only
generation-race regression.
The [control storage study](../notes/proposed/architecture/2026-10-23-roost-control-storage.md)
records the minimal notification change and rejected storage experiments. Ordinary
Roost KV values already have independent compression; check the current source
and retained-byte/page breakdown before proposing the same optimization again.

The [producer text rewrite fix](../notes/proposed/bug-fix/2026-10-25-roost-producer-text-rewrites.md)
records the isolated published-0.3.0 comparison for tag splits and state-patch
movement. Keep these measurements separate from Native format experiments.

## Prepare once per source revision

Use separate source clones with their own dependency directories for baseline
and candidate. Record both repository SHAs, uncommitted runtime diffs, Node
version, platform/architecture, package-manager versions and loaded SDK/Native
paths. A branch name or unchanged package version does not identify a candidate.
Use synthetic data in fresh directories; do not point a benchmark at live state.

Electron staging tests additionally require the installed split Native platform
package. A Native source checkout with an adjacent addon can exercise CLI behavior
but does not provide that package layout. For whole-workspace validation, prepare
the same-revision six-platform CI artifacts with Native `release:prepare` and
`release:check`, run `packed:smoke`, and install the generated local tarballs in a
private consumer. Point the isolated CLI Native link to that installed package;
record the CI source tree and selected binary hash as well as the SDK revision.

Install Lody from its root with `corepack pnpm install --frozen-lockfile`, following
the root runtime floor. Run `corepack pnpm run docs status` once at task start.
In a new clone, first initialize the pinned ACP submodules included in the root
workspace (core, DSH, Claude, Codex, Devin and Grok). Empty submodule directories
can let installation succeed while benchmark imports fail. Build core and DSH's
imported entry points with `corepack pnpm --filter acp-extension-core --filter
acp-extension-dsh build`; record their gitlinks and generated JS hashes. Kimi/Pi
remain excluded from the root graph. Missing-import setup failures are not samples.
For published dependencies, the lockfile is the source of truth. For an unreleased
matching SDK, prepare Roost in **its own package directories**:

```sh
cd "$ROOST_CHECKOUT/ts"
corepack pnpm install --frozen-lockfile
corepack pnpm check
corepack pnpm build
cd "$ROOST_CHECKOUT/node/native"
corepack pnpm install --frozen-lockfile
RUSTUP_TOOLCHAIN=stable corepack pnpm build
```

Roost has no root `package.json`; running pnpm at its root can select the wrong
pnpm version. Reuse an existing addon only with a recorded build-input manifest matching Rust,
Native glue and build inputs; record its hash. An adjacent addon file or matching
package version alone is insufficient. Check the Native capability handshake and
one actual SDK write/reopen before starting a whole-workspace run; rebuild from
the fixed revision if build provenance or the reply protocol is uncertain. Use Roost's `ts` `pack:consumer` and Native
`release:prepare`/`release:check` for package verification rather than inventing
another packaging process. Rebuilding an unchanged addon is unnecessary.

In an isolated Lody clone, an unreleased source pair may replace only its CLI
dependency symlinks with the corresponding built Roost packages. Confirm each
path is a symlink before replacing it; retain the old target for restoration.
Do not write through pnpm-store links or another checkout's scope directories.
If using an archived research workspace, `node_modules/@lody` itself may point
outside that workspace: use an isolated dependency tree instead of changing its
children. The loaded `@lody/shared` must resolve to the measured Lody revision.

From `apps/cli`, verify the resolved pair before testing:

```sh
node --input-type=module -e 'for (const s of ["@loro-dev/roost/lody-history", "@loro-dev/roost-node", "@loro-dev/roost-node/native", "@lody/shared"]) console.log(s, import.meta.resolve(s))'
```

Capture resolved files and hashes with the result. Never set
`NAPI_RS_NATIVE_LIBRARY_PATH` globally: it also overrides unrelated napi-rs tools.
If needed, scope it to one Native test/benchmark command. A local source link
does not make published dependency CI green; release and pin the matching SDK
before removing that release blocker.

For a Native storage change, the owning integration command is
`node --test tests/native.test.mjs` from `node/native` after building the addon.
The package-wide `pnpm test` additionally runs release-script fixtures; those
are a separate boundary and must not replace the Native storage suite.

## Select checks from the changed boundary

During iteration, run the owning row below. After a fix, rerun its failed case and
owning suite; do not restart completed unrelated suites. Run Lody's required
root `corepack pnpm check` and `corepack pnpm format` once before committing, then
`corepack pnpm run docs check`. Subsequent documentation-only edits need docs and
format checks, not another complete runtime run.

| Change                                                  | Owning checks                                                                                                                                                                                                          | Additional evidence when relevant                                                                                            |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Text notification semantics / immutable plans           | CLI `acp-apply-notification-on-history.test.ts`                                                                                                                                                                        | Split Unicode, prompt markers, thinking/plan tags, snapshot/overlap behavior, malformed stored scalars, caller mutation      |
| History actions / state projection                      | Shared `session-history-actions.test.ts`; CLI `roost-message-state.test.ts`                                                                                                                                            | Finish/permission semantics, borrowed snapshot ownership, bounded resumed-state programs, Native scalar offsets and own keys |
| Lody commit, projection, receipt or branch behavior     | CLI `roost-session-backend-contract.test.ts`, `roost-history-local-writes.test.ts`, `roost-history-local-branch.test.ts`, `roost-history-local-owner.test.ts`                                                          | Retry/lost reply, foreign/pending events, reopen, reader ownership, pagination and retained overlays                         |
| SDK history/checkpoint/index behavior                   | Roost `ts` type/build; Native `tests/native.test.mjs`; SDK `lody-history.test.mjs` and `node-history-index.test.mjs`                                                                                                   | Browser IndexedDB and Native/process paths; copied/altered proof, stale CAS, non-applied derived group                       |
| Rust storage, events, transaction or signature behavior | Matching Roost Rust integration suites, fmt and clippy; Native integration                                                                                                                                             | Crash/reopen, export identity, partial replica, seal/owner/sequence rules; rebuild addon                                     |
| Packed consumer or release layout                       | Existing Roost consumer/release checks and platform CI                                                                                                                                                                 | Installed tarball, optional platform package and supported Node floor                                                        |
| History RPC / protocol / observation / cache            | Shared `machine-protocol-capabilities.test.ts`; CLI `message-handler-machine-registration.test.ts`, `roost-session-backend.test.ts`; components `conversation-session-backend-factory.test.ts` (including cache cases) | Advertised capability version, coherent checkpoints, bootstrap/close, reconnect and offline cache                            |
| Performance-sensitive path                              | Owning correctness suites, then one applicable manual benchmark below                                                                                                                                                  | Same host, workload, durability, read-consumer behavior and source hashes                                                    |

Run the CLI suites from `apps/cli`:

```sh
corepack pnpm exec vitest run tests/acp-apply-notification-on-history.test.ts
corepack pnpm exec vitest run tests/roost-session-backend-contract.test.ts tests/roost-history-local-writes.test.ts tests/roost-history-local-branch.test.ts tests/roost-history-local-owner.test.ts --maxWorkers=2
```

Use the package's `corepack pnpm typecheck` for static validation. The CLI selects
`tsgo --noEmit -p tsconfig.typecheck.json`; a raw `tsc -p tsconfig.json` also includes
test/renderer declarations outside that configured check and is not its substitute.

Run SDK history suites from Roost's `ts` after building. On a constrained host,
serialize browser files; the existing test-name filter selects the browser:

Install Chromium/WebKit once with `corepack pnpm exec playwright install chromium webkit`
in `ts` if absent. For the process cases, build `cargo +stable build --locked --bin
roost-node-owner` at Roost's root when no matching binary exists. A missing binary
skips those cases; check the reported skip count rather than counting them as passes.

```sh
node --test --test-concurrency=1 --test-name-pattern='chromium' tests/lody-history.test.mjs
node --test --test-concurrency=1 tests/node-history-index.test.mjs
node --test --test-concurrency=1 --test-name-pattern='webkit' tests/lody-history.test.mjs
```

Run `node --test tests/native.test.mjs` from Roost's `node/native` with the matching
SDK built. For the complete Native/sync/release-unit suite, use `npm test`: the
publisher fixtures require npm's executable path and do not accept a direct
`node --test tests/release.test.mjs` invocation. It requires the addon; subprocess-only tests use the matching owner
binary. Follow that checkout's Native README/CI for Rust and package checks.

Desktop staging fixtures resolve the host platform package from the Native wrapper's
real path. Use an installed package or a staged copy of the matching local runtime
with its exact-version platform dependency pins and host package/addon. The main
wrapper carries no adjacent `.node` in the split layout. A bare source-checkout symlink can
lack that package and makes recursive fixture copies include the Rust target tree.
Record staged runtime/addon hashes, retain setup failures, and restore dependency
links afterwards. A local candidate does not prove published npm dependency compatibility.

## Choose a fixed manual benchmark

All entries below run from `apps/cli`. Existing `.mts` entries use:

```sh
TSX_TSCONFIG_PATH=tsconfig.json node --experimental-wasm-modules --import ./node_modules/tsx/dist/loader.mjs benchmarks/roost-send.mts
```

Replace the filename for the other `.mts` entries and use their documented
`BENCH_*` options. Do not compare their numbers across different scopes:

| Entry                                                                        | Question / fixed case                                                                                        | Durability and excluded costs                                                                                                        |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| [`roost-send.mts`](../../apps/cli/benchmarks/roost-send.mts)                 | First input + three follow-ups; 9 samples, 2 warmups; `BENCH_DISPATCH=1` includes activation                 | Roost durable; Loro in memory. No network, Agent execution or renderer                                                               |
| [`roost-first-input.mts`](../../apps/cli/benchmarks/roost-first-input.mts)   | Cold open / first input after 0, 100, 1000 messages; same `BENCH_DIR`, `BENCH_PHASE=prepare` then measure    | Roost durable; Loro snapshot restored into memory. File cache may be warm                                                            |
| [`roost-history.mts`](../../apps/cli/benchmarks/roost-history.mts)           | Windowed reads at 100, 1000, 10000 messages; 4 KiB bodies; `BENCH_STRUCTURAL=1` adds structural work         | Production backends + ConversationView. No renderer transport, IndexedDB or paint                                                    |
| [`roost-durable.test.ts`](../../apps/cli/benchmarks/roost-durable.test.ts)   | Durable growing history and growing reply; explicit write → fresh-process reopen → paging                    | Both sides SQLite WAL/FULL and control persistence after every action; live incremental reader measured separately. No network or UI |
| [`roost-dispatch.test.ts`](../../apps/cli/benchmarks/roost-dispatch.test.ts) | Fixed 100/1,000/10,000-message prefixes, actual watcher selection, 20 appends and fresh-process verification | Both sides SQLite WAL/FULL plus per-action control persistence; selected boundary excludes ACP execution, transport and renderer     |

The durable harness has an explicit opt-in config, excluded from default CI.
The fixed-prefix harness also accepts `LONG_BENCH_STAGE=ranges` after `prepare`.
Copy a closed prepared seed into an independent directory for each trial. Set
`LONG_BENCH_DISPATCH=1` and `LONG_BENCH_PREFIX=100`, `1000` or `10000`, and run the
same opt-in config. This read-only stage reports oldest/middle/quarter 20-row
position ranges, the first read and nine warm repeats, read-only CPU, RSS trajectory
and DB/WAL sizes. It verifies selected business content outside the timed read;
it does not perform the dispatch stage's appends or full-history validation.
Only the oldest position is the first range outside the latest window in that
fresh process; traversal may warm the following middle/quarter reads. Their raw
`coldMs` means first call at that position, not an independent cold-history read.
Do not label its Loro/large-history outcome as a complete write/recovery result.

Set an absolute, fresh `BENCH_DIR` outside the source checkout. Use the same
commands/parameters in each measured source checkout, changing only its output
directory. This example is the **many-message** case:

```sh
export BENCH_DIR=/absolute/path/to/a/new-benchmark-run
(
set -e
for kind in roost loro; do
  for stage in write reopen paging; do
    LONG_BENCH_DIR="$BENCH_DIR/$kind" LONG_BENCH_KIND="$kind" \
      LONG_BENCH_STAGE="$stage" LONG_BENCH_ROUNDS=100 \
      LONG_BENCH_CHUNKS=20 LONG_BENCH_CHUNK_BYTES=256 LONG_BENCH_TOOL_BYTES=16384 \
      corepack pnpm exec vitest run --config benchmarks/vitest.durable.config.ts
  done
done
)
```

The **growing-reply** case uses `ROUNDS=1`, `CHUNKS=1000`, `CHUNK_BYTES=1024`,
`TOOL_BYTES=16384` with the same `LONG_BENCH_` prefixes. Use another fresh output
directory. Start each stage in its own process; the installed Native backend is
process-wide, so changing its database options within a reused process is invalid.
Keep coordinator logs and source manifests outside `LONG_BENCH_DIR`: the write
stage requires an empty data directory and refuses pre-existing files.
The **mixed/resumed** case sets `LONG_BENCH_MIXED=1`, `ROUNDS=10`, `CHUNKS=100`,
`CHUNK_BYTES=1024`, `TOOL_BYTES=16384`. It includes a fragmented thinking block,
Unicode, tool/plan changes, and a durable finish/reopen halfway through each reply.
The `resume` metric includes that finish/open pair and both persistence barriers;
chunk latency includes later writes to the resumed state. Role-specific creation,
first resumed-append and notification-category statistics are separate. A combined
text/tool/plan batch does not isolate individual tool or plan cost. Memory milestones
record the state before diagnostic page reads; WAL/SHM bytes remain separate from
logical DB pages. Its expected business
content comes from the established mutating reducer, and includes the final plan.
Use identical deterministic fixtures; do not include fixture generation, builds
or other tests in the timed interval. Run baseline/candidate in an A–B–B–A order
when reporting a speed change. Record the shared reducer revision used by Loro.
Larger cases are opt-in and must state their parameters rather than silently
replacing the standard workloads.

The joint-stack comparison uses these fixed durable workloads, each followed by
fresh-process reopen and paging:

| Case                              | ROUNDS | CHUNKS | CHUNK_BYTES | TOOL_BYTES | MIXED |
| --------------------------------- | ------ | ------ | ----------- | ---------- | ----- |
| Short                             | 1      | 224    | 256         | 16384      | 0     |
| Streamed history (1,000 messages) | 500    | 20     | 256         | 16384      | 0     |
| Single 1 MiB reply                | 1      | 1024   | 1024        | 16384      | 0     |
| Mixed/resumed                     | 10     | 100    | 1024        | 16384      | 1     |

With a Loro reference, use baseline-1 → candidate-1 → Loro-1 → Loro-2 →
candidate-2 → baseline-2. Keep a stage ledger so interrupted runs resume only
missing stages. Retry failed measurements at most once after diagnosis, from a
fresh copy of the closed seed, preserving both logs and the original failure.
Do not raise resource budgets to make a failed group pass. Summarize only trials
whose owning mutation/content checks and fresh-process verification completed;
partial JSON is diagnostic evidence, not a successful sample. Report the actual
number of complete trials and any missing phases. Compare matching source and
harness hashes before resuming instead of restarting successful unrelated cases.

After the three stages for both backends, verify the persisted results:

```sh
python3 - <<'PY_CHECK'
import json, os, pathlib, sqlite3
root = pathlib.Path(os.environ['BENCH_DIR'])
digests = set()
for kind in ['roost', 'loro']:
    read = lambda name: json.loads((root / kind / (name + '.json')).read_text())
    write, reopen = read('write'), read('reopen')
    assert write['fullDigest'] == reopen['fullDigest'], kind
    digests.add(write['canonicalContentDigest'])
assert len(digests) == 1
for path in root.glob('*/*.db'):
    with sqlite3.connect('file:' + str(path) + '?mode=ro', uri=True) as db:
        assert db.execute('pragma quick_check').fetchall() == [('ok',)], path
print('Reopen, cross-backend content and SQLite checks passed')
PY_CHECK
```

### Fixed-prefix dispatch

This is a local-open and post-open selection benchmark. For the measured
100/1,000/10,000-prefix results, use the
[stage-separated result tables](../notes/proposed/architecture/2026-10-22-roost-dispatch-scalar-projection.md#selection-and-reads).
Complete long-session recovery is not measured by this workload.

Use the same opt-in config with `LONG_BENCH_DISPATCH=1`. For each backend and
prefix of 100, 1,000 and 10,000 **logical messages**, run `prepare` in a fresh
synthetic directory. It imports a completed alternating prefix (half as many
rounds), appends one pending user and one open assistant, and records initial
index repair separately. All assistants have 1 KiB text and 16 KiB tool output;
users have 256 bytes. The measured count initially equals prefix + 2.

```sh
LONG_BENCH_DISPATCH=1 LONG_BENCH_DIR="$BENCH_DIR/roost-1000" \
  LONG_BENCH_KIND=roost LONG_BENCH_PREFIX=1000 LONG_BENCH_STAGE=prepare \
  corepack pnpm exec vitest run --config benchmarks/vitest.durable.config.ts
```

Close preparation completely. Copy its database directory into a new trial
directory, then run `measure` followed by `verify`, each in a fresh process with
the same environment except `LONG_BENCH_DIR` and `LONG_BENCH_STAGE`. Reuse a closed Roost seed across baseline/candidate A–B–B–A trials only when
their container and application formats match. Otherwise prepare each runtime
from the identical declared input sequence and record its container version;
use the matching Loro business content. Record the exact overlaid sources and dependency
paths, and restore any archived research workspace in `finally`.

The measurement invokes the real watcher's history/queue selection 13 times
(first + 12 warm); agent execution, access checks and steer reconciliation are
excluded. It then records 20 primary 256-byte notification appends, finish,
resume, the first resumed append, user/assistant creation, selected old-turn and
adjacent-page reads. Every mutation includes explicit control persistence, with
acknowledgment and persistence timings also retained separately. Same-operation
retry must not duplicate output. Memory samples precede full export and follow
each phase; full-content verification and a fresh-process digest check run after
timing. SQLite `quick_check` remains an external, post-close check.

`openMs` covers persisted-document loading, composition and backend creation;
it stops before backend initialization, transport sync, agent restoration and
visible UI. `warmDispatch` follows that loading, and the write metric `resume`
only reopens an assistant history entry. Neither is long-session recovery.
Reports label these raw fields `localBackendOpen`, `firstSelectionAfterOpen`,
`warmSelection` and `assistantEntryReopen`; retain original raw samples and their
hashes when correcting prior summaries. Show min–max and n for one-off open/first
selection trials rather than presenting two observations as a stable tail distribution.
The prefix imports final turns rather than generating their full streaming edit
sequences: matching final content does not match CRDT operation history.

Do not describe this as full session recovery, full agent-response latency, a
network test, a growing 1 MiB reply test, or the cost of a cold OS page cache. The
[dispatch report](../notes/proposed/architecture/2026-10-22-roost-dispatch-scalar-projection.md#validation-and-limits)
records results and missing categories.

## Report contract

Every benchmark handoff includes a human-readable report in the owning bilingual
Agent Note, linked from the PR and this guide. Raw JSON alone is insufficient.
Use the same rows for baseline, candidate and Loro; show regressions and missing
measurements alongside improvements. A narrow probe may mark unrelated rows
`not measured`, but cannot establish overall or long-conversation performance.
The user-facing chat summary includes the main latency, CPU, RSS/growth and storage
tables directly. A linked report supplements those numbers; it must not be the
only place showing memory or regressions. Label prior-run references separately
from contemporaneous paired measurements.
The [completed incremental-mutation report](../notes/proposed/architecture/2026-10-22-roost-end-to-end-incremental-mutations.md#complete-resource-report)
is the current example, including its measurement gaps and read-path interpretation.

| Dimension                | Required report                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Workload and ownership   | Exact revisions/binaries, host/runtime, durability, warm/cold state, logical messages **and** rounds, body/tool bytes, chunks and sizes, loaded window/cache bounds, trial order/count, consumers and exclusions. A 1 MiB reply and 10,000 historical messages answer different questions.                                                                                                                                                                                                                   |
| History scaling          | For a claim about long-history structure, cover fixed prefixes of 100, 1,000 and 10,000 messages (or report an explicit supported limit/failure), keeping current-message size and measured operations fixed. Report prefix preparation separately. Growing-history aggregate p95 is not p95 at its final size.                                                                                                                                                                                              |
| Reply scaling            | Keep historical count fixed and measure growth through at least 64/256/1,024 KiB where supported. Separate primary streaming, thought/tag rewrites, tool insertion/update, plan update and resumed-state append. Mixed-batch timing cannot identify each operation's cost.                                                                                                                                                                                                                                   |
| Writes                   | Per category: sample count, p50/p95/max for user creation, assistant creation, text/thought append, tool/plan update, finish/seal, resume and the first/subsequent resumed append. Show local acknowledgment, control persistence and visible-consumer latency separately when measured. Pooled user/assistant creation must be labeled pooled.                                                                                                                                                              |
| Memory growth            | RSS at post-import process start, after backend open, after latest-window hydration, at every reported history/body-size milestone, before full export/validation, after full materialization, and after release where measured. Include JS heap, external and array-buffer samples with phase labels. Show growth from a common opened baseline and an actual trajectory, not only one peak. Label whole-process RSS versus the reporting JS isolate; Native-exclusive memory requires its own measurement. |
| Reads and delivery       | Fresh-process backend open, time to first/latest readable window, adjacent cursor page, absolute jump to oldest, targeted old-turn lookup, full export and incremental delivery/catch-up. State which operations load intermediate pages/bodies and whether Loro already holds its full document. Distinguish writer-only, observer and end-to-end visible latency.                                                                                                                                          |
| CPU and storage          | Process CPU and wall time per stage; distinguish chunk-only CPU from total-stage CPU. Empty/final control and history DB bytes, payload bytes, sampled WAL/SHM bytes and growth versus message/body count. For sync tests also show HTTP body bytes, Stream offset advance, network conditions and recovery traffic. Local SQLite tests mark network/sync rows `not measured`.                                                                                                                               |
| Correctness and coverage | Complete expected output, retry stability, fresh-reader/reopen digests, branch/receipt/proof failures, complete unique paging, SQLite checks, source hashes and restoration. List skips, timeouts, OOM/limits, missing categories and unmatched consumer behavior explicitly.                                                                                                                                                                                                                                |

The summary states which goal improved, which remained unchanged or regressed,
and which is unproven. Every long-conversation conclusion includes both the
memory-growth and latency tables and its measured scale. Never substitute a warm
tail-write result for cold-open, memory or history-scaling evidence.

### Recovery claims

A recovery result identifies its exact start/end signals and historical edit
sequence. Separate local backend open, backend initialization, remote catch-up,
first readable conversation window, dispatch readiness, agent resume/replay and
first visible output. Mark omitted stages `not measured`; do not add separately
timed fragments and label their sum end-to-end recovery. A warm selection speedup
does not establish a recovery speedup, and a baseline/current local-open comparison
must be reported even when their ranges overlap.

To evaluate recovery of streamed conversations, build both prefixes through the
same declared sequence of user creation, per-chunk text/thought edits, tool/plan
updates and completion, and record chunk counts/sizes, commit boundaries, snapshot
or compaction behavior and any retained-operation statistics available. Final-turn
bulk import alone cannot establish that the original edit history was reproduced.
Use fresh owner processes and the intended reader/consumer; report local loading
separately from transport and rendering rather than assuming either is negligible.

### Memory interpretation

Memory samples must identify actions performed before sampling. Walking to the
oldest range can populate a page cache with the entire tested history; that is
different from retaining only the latest window. JS garbage collection and heap
reservation make RSS growth insufficient to diagnose a leak. Forced-GC retention
experiments, if needed, are separate from ordinary latency runs and are labeled.
Do not add JS heap, external and RSS into a purported total, or treat DB/WAL bytes
as process memory. A zero sample count means unavailable, not zero cost.

Keep expensive scale experiments manual. Extend the existing harness for missing
measurements when needed, preserving the same synthetic business content and
durability; do not turn timing expectations into CI assertions or repeat unrelated
completed suites. If scale/coverage is incomplete, report that gap rather than
declaring the performance objective complete.

## Accept results and diagnose failures

- Require expected full text/tool output, receipt retry stability, exact reopen
  digest, complete unique paging IDs, and equal canonical business-content
  digests across backends. Performance numbers with a failed digest are invalid.
- After processes close, run SQLite `quick_check` on every generated database.
  Never open the Rust-owned database using another SQLite library in its process.
  Raw Native probes must use the SDK canonical JSON encoder and explicit queue
  bounds; they localize a cost but omit application receipts/indexes/consumers.
- Follow the [report contract](#report-contract), including memory trajectories,
  operation categories, long-history coverage and missing measurements.
  SQLite page bytes, WAL/SHM allocation, serialized content, HTTP bodies and Stream
  offset movement are different metrics; never label one as another.
- An absent export or unexpected loaded path is setup failure: correct the source
  pair before rerunning affected cases. Separate excluded setup runs from results.
  A child cancelled by a parent timeout is not an assertion result. Preserve the
  failure and rerun that owning suite in isolation once; report both outcomes.
  Likewise, a loopback transport failure in unchanged Rust requires diagnosis,
  not a new algorithm or a blanket claim that all Rust tests passed.
- Preserve raw samples, source hashes, workload parameters, exit statuses and
  complete errors outside Git; publish only synthetic summaries. Restore every
  changed dependency link/source file in a `finally` block and verify restoration
  if an archived workspace was used. Prefer isolated clones so swapping source
  files is unnecessary. A successful benchmark never authorizes deployment.

Reserve seed-copy bytes above the minimum free-space budget before cloning a
large prepared prefix. A refusal before stage start is a coordinator limit;
retain it separately from product test failures. Reclaim only owned synthetic
copies through byte-verified recoverable archives, without relaxing the budget.

Update this guide and its owning benchmark when a repeatable setup issue is found.
Keep per-change conclusions in the owning Agent Note rather than creating a new
test recipe for every PR.

## Storage refactor acceptance

When changing private body/log/projection representation, keep the fixed current
candidate and published reference untouched. Use a separate matching Native
consumer, record every Rust/build-input hash and loaded addon hash, and scope any
dependency-link replacement to the isolated measurement checkout. Restore that
link after checks. Do not use a global NAPI override for a Vitest/Rolldown process.

In addition to the standard workloads, reconcile decoded body/log/projection
bytes with actual SQLite pages, indexes and control DB allocation. Demonstrate
byte-exact retained exports, bounded range/tail I/O, invalid edits without partial
mutation, rollback fault sweeps, seals, pending replay and reopen. A storage cut
does not establish a process RSS cut. Include RSS/growth and CPU in chat tables.

Keep cold first append separate from steady appends and prepared-index selection.
If a small tail difference repeats, report individual samples; do not discard it
inside a faster average. The shared-body follow-up in the linked integration
review records the user's accepted approximately 3.3 ms first-cold-append difference.
Retain failed full-suite logs and compare unchanged baseline behavior before
attributing an intermittent transport fixture error to the storage refactor.
