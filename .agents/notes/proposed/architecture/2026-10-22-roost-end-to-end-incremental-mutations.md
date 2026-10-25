# End-to-end incremental Roost mutations

Status: proposed
Translation: current

[中文](2026-10-22-roost-end-to-end-incremental-mutations.zh.md)

## Abstract

Native text append is incremental, but Lody still copied complete message/state
bodies and reread loaded history around commits. This change carries shared
semantic mutation plans through validation, Native content operations and private
projection installation, and uses SDK-certified directory transitions. It covers
markup, tools, finish actions and resumed state as well as ordinary text appends.
Public ownership, durable acknowledgment and authoritative recovery remain intact.
Product dispatch still requests full history; the workloads below do not establish
bounded end-to-end long-history behavior.

## Problem and decision

This continues the [atomic checkpoint work](2026-10-22-roost-atomic-content-checkpoints.md)
and [earlier projection cuts](2026-10-22-roost-owner-incremental-projection.md).
A synthetic boundary probe measured Native append p50 of 0.178/0.167/0.172 ms
at 0/256 KiB/1 MiB old text, while the application path grew from 1.621 to
4.770 ms. Native-only omits receipts, indexes, control persistence and consumers;
it localizes redundant application work rather than promising achievable latency.

The initial implementation optimized suffix-only primary edits and local directory
creation. It did not complete complex operations or resumed-state staging. The
completed consumer now follows the same semantic and durability rules across them:

- The shared reducer and action planner use private copy-on-write drafts and record
  authored paths. They own incoming data and retain untouched stored values. Writer
  validation remains authoritative: paths select affected **validated top-level
  subtrees**, never raw Immer patch values. Validation may normalize siblings in
  that field, so selecting only the narrow leaf would be incorrect.
- Exact text-suffix hints avoid rescanning ordinary appends. Complete text rewrites
  still need compact scalar-indexed splice encoding. Incomplete thinking/plan
  blocks skip the full parser until a complete closing delimiter exists; bounded
  suffix analysis detects split delimiters. The existing parser, overlap/snapshot
  deduplication, per-event order and malformed-scalar repair/refusal remain shared.
- Private staging handles `set`, `remove`, `appendText`, `spliceText` and
  `spliceArray` in both application and lossless SDK representations. Only edited
  ancestors/new values are copied. Added keys use Native's canonical key order;
  own-key guards and Unicode scalar offsets match the actual Native boundary.
- A staged result installs only after Native metadata, exact event coverage, owner
  generation and unchanged window checks. State overlays additionally require the
  derived-index group to have applied. An edit plus seal reads the authoritative
  small header/hash. Uncertain, foreign or unsupported transitions use existing
  authoritative body reads; final checkpoint publication still verifies coverage.
- Resumed state composes an append only with the last related append operation;
  otherwise it rebuilds affected fields' baseline-relative deltas. This preserves
  operation ordering without an unbounded program. Projection copies paths instead
  of deep-copying the immutable primary, and exact private SDK snapshots retain
  decoded values. Public reads and model-summary output remain detached. Borrowed
  command reads stay inside the serialized writer; external acceptance queries use
  the formal reader.

Roost owns checkpoint and branch evidence. Every retained checkpoint proof row is
still compared atomically on each write; stale refresh occurs once only when
Native proves no write happened. A directory transition certifies a confirmed
local linear append's membership, not old-body freshness. Forks, remote
interleavings, incomplete pages and uncertain outcomes retain recovery.

No Rust/Native runtime, storage/wire format, signing, retention or durability
change is needed. No compatibility reader, migration, release or deployment is
added. This unit is pure planning/projection work, not an Effect lifecycle change.
Unresolved observable-behavior or guarantee changes must stop for discussion.

## Validation and measured limits

The [validation workflow](../../../docs/roost-validation.md) owns setup, owning
suites, fixed manual workloads and failure handling. The durable harness/config
live under `apps/cli/benchmarks`, outside default CI. It now also covers mixed
markup/tool/plan changes and finish/reopen followed by resumed streaming.

## Complete resource report

Linux x64, Node 24.22, 2 vCPU; baseline Lody `9f497346a` versus runtime
`e97b58c77`, both with Roost `d4b07d4` and the same Native binary. Both use
SQLite WAL/FULL with per-action control persistence. Processes are fresh per
write/reopen/paging stage; OS caches may be warm, and module import/fixture
preparation is outside the measured operations. Baseline/candidate use A–B–B–A;
Loro uses candidate shared semantics in one reference trial. Every assistant
retains 16 KiB of synthetic tool output. The mixed case adds thinking delimiters,
Unicode, tool/plan notifications and a finish/open halfway through each reply.

This report supplements the previously incomplete chunk-only handoff. It uses
existing raw results; it is not a new experiment or evidence of 1,000/10,000-message
behavior. The many-message quantiles pool growing prefixes up to 200 messages;
they are not fixed-prefix measurements at 200 messages.

### Write latency

Cells are **p50 / p95 / maximum, milliseconds**. p50/p95 are medians of each
trial's statistic; maximum is the largest observed across trials. Counts are per
trial. A single finish/resume observation is not a latency distribution. Creation
pools user and assistant entries; their individual latencies were not retained.

#### 100 rounds / 200 messages, 2,000 × 256 B chunks

| Operation               | Samples: Roost / Loro |      Before completion |              Completed |                Loro |
| ----------------------- | --------------------: | ---------------------: | ---------------------: | ------------------: |
| Create entries (pooled) |             200 / 200 | 49.45 / 74.09 / 182.31 | 49.23 / 74.03 / 204.27 | 2.79 / 4.68 / 69.13 |
| Output batch            |           2000 / 2000 |   8.69 / 11.81 / 58.59 |   8.60 / 11.83 / 63.47 | 2.41 / 4.00 / 25.61 |
| Final finish            |             100 / 100 |  19.17 / 25.49 / 55.60 | 16.05 / 20.44 / 111.92 |  2.17 / 3.98 / 7.19 |
| Incremental change read |              2000 / 0 |    1.65 / 2.56 / 19.57 |    1.63 / 2.51 / 38.82 |                   — |

#### One reply, 1,000 × 1 KiB chunks (about 1 MiB)

| Operation               | Samples: Roost / Loro |        Before completion |                Completed |                  Loro |
| ----------------------- | --------------------: | -----------------------: | -----------------------: | --------------------: |
| Create entries (pooled) |                 2 / 2 | 110.92 / 110.92 / 115.38 | 109.07 / 109.07 / 109.26 | 53.81 / 53.81 / 53.81 |
| Output batch            |           1000 / 1000 |     8.60 / 11.58 / 46.12 |     8.58 / 11.81 / 39.22 |  7.09 / 14.19 / 69.55 |
| Final finish            |                 1 / 1 | 105.91 / 105.91 / 117.15 |    31.67 / 31.67 / 33.37 | 40.68 / 40.68 / 40.68 |
| Incremental change read |              1000 / 0 |      1.73 / 2.86 / 28.44 |      1.62 / 2.71 / 26.65 |                     — |

#### 10 rounds / 20 messages, 100 × 1 KiB per reply, mixed/resumed

| Operation               | Samples: Roost / Loro |       Before completion |               Completed |                 Loro |
| ----------------------- | --------------------: | ----------------------: | ----------------------: | -------------------: |
| Create entries (pooled) |               20 / 20 | 50.85 / 101.90 / 107.89 | 52.81 / 109.08 / 110.61 | 3.25 / 46.13 / 46.13 |
| Output batch            |           1000 / 1000 |  18.63 / 33.09 / 131.74 |    9.56 / 15.15 / 65.05 |  3.09 / 4.94 / 42.77 |
| Final finish            |               10 / 10 |  40.11 / 81.76 / 115.69 |   24.74 / 32.38 / 33.02 |   2.98 / 4.94 / 4.94 |
| Finish + reopen         |               10 / 10 |  84.93 / 98.65 / 106.05 | 73.73 / 104.36 / 107.83 | 5.24 / 23.44 / 23.44 |
| Incremental change read |              1000 / 0 |     1.47 / 2.78 / 23.87 |     1.47 / 2.97 / 27.14 |                    — |

Mixed output rows combine text with periodic tool/plan updates. They do not
isolate tool insertion, tool update, plan update or thought/tag rewrite latency.
The first resumed append and later resumed appends are also pooled. `resume`
includes finish/open and both control persistence barriers. Incremental change
reads run **only on Roost**: the Loro reader does not expose this method, so zero
samples mean unmeasured, not zero latency. These runs do not provide equivalent
renderer/observer delivery measurements on both backends.

### Memory growth

All values below are MiB. These are the measured process's RSS, including test
runtime, control document, Worker and Native allocations, not Roost-exclusive
memory. JS heap/external/array-buffer values describe the reporting JS isolate;
they are not added to RSS. No forced GC or leak/retained-allocation measurement
was performed.

| Case   | Variant   | After open | Before full validation | Growth from open | Sampled peak before validation |
| ------ | --------- | ---------: | ---------------------: | ---------------: | -----------------------------: |
| many   | baseline  |     328.06 |                 497.09 |           169.03 |                         497.09 |
| many   | candidate |     328.02 |                 495.82 |           167.80 |                         495.82 |
| many   | loro      |     301.35 |                 399.13 |            97.78 |                         399.13 |
| single | baseline  |     327.28 |                 474.23 |           146.95 |                         474.23 |
| single | candidate |     328.43 |                 451.26 |           122.83 |                         451.26 |
| single | loro      |     300.35 |                 399.62 |            99.28 |                         632.85 |
| mixed  | baseline  |     327.56 |                 545.83 |           218.27 |                         558.73 |
| mixed  | candidate |     326.61 |                 507.28 |           180.67 |                         515.31 |
| mixed  | loro      |     299.61 |                 468.73 |           169.13 |                         468.73 |

The post-import RSS baseline is already about 295–296 MiB on both sides. The
single-reply Loro peak (632.85 MiB) is above its ending RSS (399.62 MiB); the
completed Roost peak/end is 451.26 MiB, but its growth from open is 122.83 MiB
versus Loro 99.28 MiB. Selecting only peak or only ending RSS gives a different
impression; neither establishes Native-exclusive retention or a leak.

The remaining write-process phase samples are **post-import/before backend setup
RSS / after full validation and catch-up probe RSS, MiB**. The latter precedes
cleanup and is not a release-memory measurement.

| Case   | Before completion |       Completed |            Loro |
| ------ | ----------------: | --------------: | --------------: |
| many   |   296.33 / 514.36 | 295.82 / 510.46 | 296.37 / 423.91 |
| single |   295.65 / 438.13 | 295.88 / 436.83 | 295.40 / 407.25 |
| mixed  |   296.11 / 560.26 | 294.96 / 529.62 | 294.48 / 471.69 |

The actual many-message trajectory follows. Each point is after the harness
reads the latest page, jumps to the oldest range and performs nine warm latest
reads. Roost can retain up to 500 page bodies, so a 200-message run may have
cached all tested history. This is not a latest-window-only residency experiment.
Cells are **RSS / JS heap used / external / array buffers, MiB**; they are
medians across trials, without forcing collection.

| Messages at sample |               Before completion |                      Completed |                           Loro |
| -----------------: | ------------------------------: | -----------------------------: | -----------------------------: |
|                 10 | 378.71 / 188.14 / 16.57 / 10.03 | 378.70 / 187.32 / 16.39 / 9.84 | 326.32 / 172.06 / 14.34 / 7.47 |
|                100 |   468.59 / 236.90 / 9.49 / 1.89 | 467.76 / 253.76 / 11.94 / 4.33 | 382.20 / 203.30 / 12.36 / 1.44 |
|                200 |  497.09 / 248.66 / 12.09 / 4.05 | 495.76 / 242.92 / 11.36 / 3.34 | 392.76 / 201.93 / 17.18 / 0.89 |

Fresh-process reopen samples, **RSS after latest window / after full read, MiB**:

| Case   | Before completion |       Completed |            Loro |
| ------ | ----------------: | --------------: | --------------: |
| many   |   371.54 / 395.73 | 371.03 / 404.03 | 348.91 / 352.66 |
| single |   378.96 / 395.73 | 383.16 / 400.78 | 338.70 / 340.70 |
| mixed  |   381.38 / 400.03 | 380.03 / 397.88 | 343.20 / 348.08 |

### Read latency, CPU and storage

Read values are medians of one observation per trial, in milliseconds. `start →
latest` begins after module import and includes Repo setup/backend open/latest
read, not complete desktop startup. `oldest jump` requests absolute positions
0–19 and traverses intermediate Roost pages. `full read` runs **after** this jump,
so it is not a cold full-export test. Sequential paging is a separate fresh
process; its p95 covers 20-message pages through the whole history.

| Case / metric                   | Before completion | Completed |   Loro |
| ------------------------------- | ----------------: | --------: | -----: |
| many / Backend open             |            525.89 |    591.33 | 439.81 |
| many / Start → latest           |            588.36 |    648.47 | 494.59 |
| many / Latest read after open   |              6.52 |      6.06 |   6.69 |
| many / Absolute oldest jump     |            637.74 |    565.88 |   2.22 |
| many / Full read after jump     |            533.64 |    437.87 |   8.69 |
| many / Sequential page p95      |            160.18 |    142.51 |  18.86 |
| single / Backend open           |            339.93 |    420.18 | 161.50 |
| single / Start → latest         |            427.66 |    481.86 | 214.09 |
| single / Latest read after open |             22.17 |      3.33 |   4.19 |
| single / Absolute oldest jump   |              6.74 |      1.92 |   1.42 |
| single / Full read after jump   |             98.42 |     99.04 |   1.41 |
| single / Sequential page p95    |             10.70 |     10.82 |  10.80 |
| mixed / Backend open            |            535.65 |    497.56 | 216.16 |
| mixed / Start → latest          |            593.70 |    556.64 | 270.68 |
| mixed / Latest read after open  |              9.74 |      8.96 |   8.53 |
| mixed / Absolute oldest jump    |              7.64 |      6.89 |   4.85 |
| mixed / Full read after jump    |            115.06 |     93.00 |   3.54 |
| mixed / Sequential page p95     |             56.24 |     49.76 |  16.78 |

The end-of-write `readChanges(initialCheckpoint, { withPatches: true })` probe
has one sample per trial. Cells are **latency in ms / serialized response bytes**;
Loro has no corresponding sample. Response kind and patch completeness were not
retained, so this does not establish successful incremental replay. These are
JSON API response bytes, not network or Stream offset bytes.

| Case   | Before completion |    Completed | Loro |
| ------ | ----------------: | -----------: | ---: |
| many   |      73.76 / 2650 | 56.00 / 2650 |    — |
| single |       20.15 / 193 |  46.89 / 193 |    — |
| mixed  |       21.39 / 400 |  20.65 / 400 |    — |

CPU cells are **chunk-only process CPU / whole write-stage process CPU / whole
write-stage wall time, seconds**. Whole stage includes setup, creates, finishes,
read probes and correctness/export work; chunk-only excludes those and fixture
generation. Child-process CPU (for example Python DB probes) is not included.

| Case   |     Before completion |             Completed |               Loro |
| ------ | --------------------: | --------------------: | -----------------: |
| many   | 11.73 / 29.84 / 40.48 | 11.53 / 29.27 / 39.94 | 2.66 / 4.01 / 7.07 |
| single |   6.11 / 9.28 / 12.31 |   5.99 / 9.05 / 12.15 | 7.28 / 7.94 / 8.85 |
| mixed  | 15.32 / 20.72 / 24.22 |  7.47 / 12.71 / 16.34 | 2.53 / 3.26 / 4.42 |

Storage values are **SQLite page bytes**, decimal MB: `page_count × page_size`,
not peak physical allocation including WAL/SHM. The table separates control and
history databases; logical JSON is the explicit final full-read serialization.

| Case / variant     | Empty DBs combined | Final control DB | Final history DB | Combined growth | Final logical JSON |
| ------------------ | -----------------: | ---------------: | ---------------: | --------------: | -----------------: |
| many / baseline    |               0.12 |             0.95 |            13.46 |           14.29 |               2.22 |
| many / candidate   |               0.12 |             0.95 |            13.45 |           14.27 |               2.22 |
| many / loro        |               0.09 |             2.90 |             0.00 |            2.81 |               2.22 |
| single / baseline  |               0.12 |             0.45 |             6.10 |            6.43 |               1.04 |
| single / candidate |               0.12 |             0.45 |             6.11 |            6.44 |               1.04 |
| single / loro      |               0.09 |             1.54 |             0.00 |            1.45 |               1.04 |
| mixed / baseline   |               0.12 |             0.47 |             8.35 |            8.70 |               1.20 |
| mixed / candidate  |               0.12 |             0.47 |             8.33 |            8.68 |               1.20 |
| mixed / loro       |               0.09 |             2.04 |             0.00 |            1.95 |               1.20 |

### Coverage gaps and source interpretation

Not measured in this experiment: fixed 1,000/10,000-message prefixes, adjacent
cursor-page latency in isolation, user versus assistant creation separately,
isolated tool/plan/thought operations, first versus later resumed append, memory
after release/forced GC, Native-exclusive retention, timed per-layer transaction
or Worker costs, WAL/SHM peaks, equivalent Loro incremental delivery, network
HTTP/Stream offset bytes and renderer-visible latency. The available result
does not demonstrate the intended ultra-long-history advantage.

Source review explains why the previous headline was insufficient:

- Loro's [agent writer](../../../../apps/cli/src/lib/loro/session-agent-writes.ts)
  already selects an owning tail/item window with `HistoryWriter.updateTail`.
  The pinned `loro-repo` 0.23.3 `persistDocUpdate` exports updates from the
  previously persisted version, rather than serializing the complete history for
  each ordinary append. Warm tail-write latency therefore does not by itself
  distinguish full-document residency from Roost's paging design.
- The [Roost adapter](../../../../apps/cli/src/session/roost-node-session.ts)
  implements an uncached absolute range or ID lookup by scanning pages from the
  head and projecting intervening bodies (`readRangeEntries`/`scanPages`). The
  current oldest-jump probe consequently materializes intermediate pages and can
  fill the page-body cache. It must not be labeled one adjacent page or evidence
  of latest-window-only memory. `readTurnOutput` also explicitly uses complete
  entries; its actual frequency and cost were not measured here.
- A further source audit identifies a real product consumer outside this manual
  harness: the [dispatch watcher](../../../../apps/cli/src/session/session-dispatch-watcher.ts)
  calls `checkHistoryAndQueue` for its initial dispatch check and again for
  requested checks while awaiting history. That method calls `backend.readHistory`.
  The Roost backend routes it through `readAll`/`readCompleteEntries`: a cache miss
  walks the full active branch, projects all bodies and retains a full snapshot;
  even a cache hit clones all entries. This path therefore has whole-history
  content work despite the bounded latest-page API. Its invocation rate and
  end-to-end cost were not measured by this writer/reader harness. Replacing it
  with the latest page alone would be unsafe: pending older inputs, terminal
  repair evidence, queue ordering and RPC deduplication must remain authoritative.
- The matching [SDK linear page reader](https://github.com/loro-dev/roost/blob/d4b07d48d53036da824372d5531f41da1fce02d2/ts/src/lody-history.ts#L1580)
  supports latest/before-cursor reads, with branch/header/metadata checks. Absolute
  `from` falls back to a complete branch directory. This distinction and the
  adapter's scan are integration work, not evidence that Native must load all
  historical content for an ordinary append.

The architectural expectation concerns bounded working-set memory, cold latest
load and history scaling. This small warm-write test does not exercise all three.
SDK/Worker/checkpoint/control-persistence work is present, but this run has no
per-layer timing, so no single function is declared the measured hotspot. Runtime
changes require a separate discussed scope; this reporting correction changes no
algorithm or correctness guarantee.

All 45 write/reopen/paging stages, complete expected output, receipt retries,
canonical cross-backend business digests, exact reopened full digests and 27
post-close SQLite checks pass. Measured runtime/harness hashes match; research
sources/dependency links were restored. A setup-only attempt with logs in the
required empty data directory failed before measurement; its failure/restoration
are retained and excluded from results. The [report contract](../../../docs/roost-validation.md#report-contract)
now requires every benchmark to publish the full metric/coverage matrix.

## Correctness and release evidence

The earlier text-only comparison used Lody `f06b820f3` / Roost `ff1a639` as its
baseline: growing-reply chunk p95 fell from 26.30 to 11.98 ms, and many-message
creation p95 from 103.01 to 68.34 ms. Those results belong to the earlier source
pair; they are not relabeled as measurements of the completed extension.

Current owning checks: CLI 128 cases and shared semantic/action suites 89 cases
pass. They compare planned output with the established reducer, every tested
Unicode/tag/internal-marker split, malformed scalars, caller-input ownership,
Native operation results, canonical fresh-reader/reopen output, receipts, paging,
branch/owner fences and resumed state. The mixed Native case makes body readback
unavailable during writes and finish, then verifies the actual stored/reopened
result. Added-key checks include an own `__proto__` field and rejection of invalid
scalar offsets without mutation.

Lody root `corepack pnpm check`, `corepack pnpm format` and documentation checks
pass with the matching local SDK. Full checks retain their reported opt-in skips;
the owning 217 cases above run without skips. The first root attempt stopped at
a type-aware lint error in the pre-existing malformed-scalar branch; its explicit
type assertion preserves runtime coercion/refusal, and the complete rerun passes.
The documentation-only reporting correction reuses those unchanged-runtime checks;
formatting, documentation links and diff checks are rerun for the report itself.

Unchanged SDK/Native validation is reused: Native 59 cases, SDK Chromium/Node 101
and WebKit 63 pass. The initial parallel SDK attempt hit parent timeouts; cancelled
children are not passes. Rust fmt/clippy pass; the root serial Rust attempt stopped
at unchanged `rs3_link` loopback `Transport(Unavailable)`, whose isolated rerun
passes. No complete green Rust-suite result is claimed for that attempt. This
extension changes no SDK/Rust runtime or addon build input, so it reuses their
recorded binaries and hashes rather than rebuilding them.

Review: [Lody #1817](https://github.com/LodyAI/Lody/pull/1817),
[Roost #26](https://github.com/loro-dev/roost/pull/26). They remain draft stacks on
Lody #1811 / Roost #25. A coordinated Roost release and real dependency pin remain
necessary: published 0.2.0 lacks the new directory API; source-linked checks do not
remove that release blocker. Synthetic raw samples and hashes stay outside Git in
the validation workspace's `complete-incremental-20261022` directory.
