# Scalar evidence for Roost dispatch

Status: proposed
Translation: current

[中文](2026-10-22-roost-dispatch-scalar-projection.zh.md)

## Abstract

The dispatcher still read and copied the entire transcript to find one input,
despite the incremental writer and windowed renderer. This change queries a
cursor-fenced local projection of pending inputs, requested identities and their
completion evidence, then reads only the selected input body under the existing
selection, repair, queue, cancellation and RPC deduplication rules.
At 10,000 completed messages, warm dispatch p50 fell from 369.40 ms to 2.63 ms
(Loro: 199.41 ms), with 0.4–0.8 MiB dispatch RSS growth instead of 874–945 MiB.
Local backend open was 6.47 s for Loro and 0.68–0.80 s for candidate Roost,
overlapping baseline Roost's 0.67–0.93 s; complete long-session recovery was not measured.
Missing or invalid projections still require bounded-page reconstruction;
ordinary writes, full exports and index repair are separate costs.

## Decision and boundaries

The [previous audit](2026-10-22-roost-end-to-end-incremental-mutations.md#coverage-gaps-and-source-interpretation)
identified the retained `checkHistoryAndQueue → readHistory` path. Its backend
call comes from #1181; the current full Roost implementation comes from #1329.
The earlier write/projection optimizations did not remove this consumer.

- A dispatch entry contains identity, role, status/legacy `read`, user linkage,
  end time and the steer-delivery flag. It carries no prompt, items, tools, plan
  or provider payload. Loro projects the same fields from its shallow directory.
- Native-local derived tables hold logical position/segment references, pending
  identities and completed assistant evidence. An exact event cursor and count
  certify a complete projection. The private row cache is bounded and public
  results are detached. A changed foreign checkpoint invalidates cached rows.
- Ordinary content edits advance the projection in the existing certified Native
  derived-index transaction, comparing the previous projection marker. Scalar
  changes update only affected rows. A deletion or an uncertified batch leaves
  the old marker unusable until guarded index publication; it is never accepted
  merely because the content command returned successfully.
- A confirmed linear append contributes its certified position and physical
  reference. Forks, generation replacement, foreign events and uncertain coverage
  refuse incremental advancement. Missing, interrupted or malformed indexes are
  reconstructed from coherent bounded pages under the existing owner write queue,
  with a final event-cursor check before publishing the complete marker. Repair
  visits old bodies once; a valid persisted index does not. This is derived-cache
  repair, not another message format or compatibility reader.
- Dispatch preserves chronological last-copy ownership, prepared-input activation,
  legacy unread inputs, refused/applied steer distinctions, imported replay
  exclusion, permanent missing-history exclusions and terminal repair evidence.
  Native selection and selected-body hydration run under the same before/after
  event-cursor fence. Loro captures both synchronously before yielding; an async
  owner must supply its own coherent observation rather than stitch independent
  reads together. Changed observations retry within a finite bound. Queue
  promotion refreshes its exact current head and
  preserves older terminal duplicate witnesses. RPC stash identities participate
  in the same evidence query.
- Cancellation checks and pending-inbox enumeration use the same scalar evidence.
  Explicit replay, export, fork and history replacement retain full-read semantics.
  No Native/SDK, wire format, signing, retention or durability change is introduced.

```mermaid
flowchart LR
  H[Authoritative history cursor] --> I[Complete scalar indexes]
  I --> E[Pending inputs and requested identities]
  I --> C[Relevant completion evidence]
  E --> D[Existing dispatch rules]
  C --> D
  D --> T[Read and recheck selected body]
```

## Ownership and failure behavior

History/control updates retain their existing owners and order. Projection repair
shares the Node history owner's serialized write queue; disposal drains that queue
before releasing the Native lease. A caller does not gain a second history writer
or cancellation authority over shared work. A partial repair has no valid marker;
uncertain data cannot authorize dispatch. A cache maintenance failure does not
erase a durable content receipt: the next read repairs authoritative state.

This is feature/fix mode under the Effect skill. Pure selection/index planning
stays ordinary TypeScript; the existing Promise backend/dispatcher boundary and
its unfinished lifecycle dependencies remain unchanged. The L6 migration unit is
not claimed complete, and no migration-ledger ownership changes are made.

## Validation and limits

[Draft PR #1821](https://github.com/LodyAI/Lody/pull/1821) is stacked on #1817.
The complete root `pnpm check` passed: CLI 4,483 passed / 4 skipped, shared
1,581 passed, components 5,882 passed, plus the remaining workspace and boundary
checks. The eight owning dispatcher/backend/Native suites passed 227 tests with
no skips. New behavior covers old pending inputs without historical page reads,
finish/resume completion changes, branch removal, stale index publication,
foreign cache invalidation, interrupted rebuild, body-only foreign writes during
selection, 120 real-Loro decision combinations and synchronous selected-body
capture. Formatting, docs checks and diff checks passed; docs retain 71 existing
warnings, zero errors and no protected-topic changes.

The source-linked pair is Lody baseline `435148029`, candidate runtime `22ef563cc`,
Roost SDK `d4b07d4`; the Linux addon hash is `f0b82fb6524f520125dee23b92ef692c571214c62883b685d5b19e543f7c17fb`.
Local validation uses Node 24.14.0 / pnpm 10.20.0. Measurements use Linux x64,
Node 24.22.0 on the existing 8 GB test host, an isolated research checkout and
fresh synthetic SQLite files. Native/SDK source and addon were reused unchanged.
The inherited release blocker remains: published `@loro-dev/roost@0.2.0` lacks
the atomic checkpoint, commit metadata and directory-transition APIs used by
the parent PRs. Matching source-linked checks
do not establish published-dependency CI; this fix adds no new SDK API dependency.

GitHub [static/CLI checks](https://github.com/LodyAI/Lody/actions/runs/39753960389)
and [desktop smoke build](https://github.com/LodyAI/Lody/actions/runs/39753960366)
currently fail on those missing published APIs/capabilities. They are not reported
as passing or bypassed; the coordinated Roost release and dependency pin remain
required before this stack can ship.

### Fixed-prefix resource report

Prefixes are 100 / 1,000 / 10,000 completed **messages** (50 / 500 / 5,000 rounds),
plus one pending user and one open assistant. Users contain 256 bytes, assistants
1 KiB text plus 16 KiB tool output. Prefix text/tool payload is 8832 × N bytes,
excluding JSON/metadata. The measured reply adds 20 × 256 bytes, finishes,
resumes and adds another 256 bytes, retries that operation, then creates a new
user/assistant pair (N+4 final entries). Neither large-reply growth nor all-pending
histories is represented by this fixed-current-message experiment.

The actual `checkHistoryAndQueue` path is called 13 times (first + 12 warm).
Execution/access/steer setup is stubbed; no ACP process, RPC transport, network,
Stream offset, renderer or paint is measured. All mutations use SQLite WAL/FULL
plus explicit control persistence. Valid indexes and cold process open are
measured; OS page cache may be warm. History bodies normally retain a latest
40-row window; the private dispatch metadata cache caps at 500 rows. Rebuild
uses coherent 40-row pages and discards repair-only decoded bodies.

At each prefix the order is baseline–candidate–candidate–baseline, then one
candidate-Loro reference trial. Both Roost variants use copies of the same
candidate-prepared seed, including its derived indexes; baseline ignores them.
Thus storage rows are actual allocations, **not** an old/new index-size experiment.
Each trial performs measurement and digest verification in separate fresh
processes. Timing excludes prefix preparation, module transforms and fixture
generation. Both Roost trials are pooled: warm n=24, append n=40, each one-off
operation n=2; Loro n=12 / 20 / 1. Every latency cell is p50 / p95 / max in ms;
small n cannot establish a latency-tail guarantee. Quantiles select sorted index
`floor(n*p)`, capped at the last sample, matching the manual harness.

At 10,000 messages, the two first-dispatch observations are 24.94/58.33 s for
baseline and 14.02/12.37 ms for candidate, versus Loro 354.24 ms. Backend opening
is separate (candidate 676–802 ms); these are not total app-startup figures.
Warm p50 is 369.40 → 2.63 ms versus Loro 199.41 ms, about 76× faster than the
Loro scalar-directory reference at this boundary. Candidate RSS remains about
414 MiB after dispatch, versus 1,287–1,337 MiB baseline and 1,382 MiB Loro.
The 10,000-message prefix import still takes 479 s and initial index repair
32.73 s; candidate full export still takes 26.70–27.82 s. These remain explicit costs.
Append p95 is 227–278 ms baseline versus 239–283 ms candidate (n=20 per trial):
the tail is slightly worse in this sample despite similar/slightly lower p50,
so the experiment does not prove that maintaining the index has zero overhead.

#### Selection and reads

**Recovery interpretation.** The 199.41 ms Loro value is warm selection after
the document has already been loaded. In the 10,000-message measurement process,
Loro backend open took **6,469.78 ms**, with RSS growing from **299.7 to
1,183.9 MiB** before selection; candidate Roost open took **676.16–801.58 ms**,
with opened RSS **413.6–414.7 MiB**. Thus the approximately 76× figure applies
only to warm dispatch. The open-stage comparison here is approximately 8–10×,
and neither figure measures complete session recovery. The separate Loro
verification process opened its subsequently updated document in 4,301.34 ms;
that is a different stage, not a second identical-seed measurement trial.

The open timer covers `openPersistedDoc`, `composeSessionData` and
`createSessionBackend`. It does not run `SessionDocument.init` or await
`backend.initialize`, transport join/sync, ACP session restoration or replay,
ConversationView construction, React rendering or first visible output. The
historical prefix is built by one `applyHistoryImport` of final turns; it does
not generate each historical response through repeated streaming edits. This
still creates Loro operations, but does not reproduce a real conversation's
edit sequence. Equal final business content does not establish equal operation
history or recovery cost. No claim that Loro must be slower for those unmeasured
cases follows from this experiment. The raw write metric `resume` is reported below as `assistantEntryReopen`: it
times only `openAssistantTurn` plus control persistence, not session restoration.

Local backend open is a separate stage. Values below are observed min–max,
with trial counts; opened RSS is whole-process memory, and its growth is relative
to that process's pre-open sample. The baseline/current Roost open ranges overlap:
the dispatch change did not establish a local-open improvement. Loro has only one
measurement trial at each prefix. Complete long-session recovery remains **not
measured**, including the original streaming edit history and visible-consumer path.

| Prefix / backend | Open n | Local backend open ms (min–max) | Opened RSS MiB | Open RSS growth MiB |
| --- | --- | --- | --- | --- |
| 100 / baseline | 2 | 371.03–652.00 | 363.6–364.5 | 63.1–66.4 |
| 100 / candidate | 2 | 404.71–449.13 | 363.5–367.6 | 63.6–64.6 |
| 100 / loro | 1 | 107.28 | 327.0 | 26.2 |
| 1,000 / baseline | 2 | 438.30–544.86 | 365.5–367.2 | 67.0–69.2 |
| 1,000 / candidate | 2 | 418.99–444.04 | 365.3–367.6 | 64.8–66.8 |
| 1,000 / loro | 1 | 785.91 | 433.4 | 133.9 |
| 10,000 / baseline | 2 | 673.23–933.34 | 391.9–413.1 | 93.6–113.1 |
| 10,000 / candidate | 2 | 676.16–801.58 | 413.6–414.7 | 113.6–115.2 |
| 10,000 / loro | 1 | 6469.78 | 1183.9 | 884.2 |

The next table starts after local open. The approximately 76× comparison belongs
only to its warm-selection column; first selection also excludes opening costs.

| Prefix / backend | First-selection n | First selection after open ms (min–max) | Warm-selection n | Warm selection ms (p50/p95/max) |
| --- | --- | --- | --- | --- |
| 100 / baseline | 2 | 308.22–322.74 | 24 | 4.25/9.40/12.33 |
| 100 / candidate | 2 | 9.04–9.68 | 24 | 1.91/4.18/4.44 |
| 100 / loro | 1 | 8.62 | 12 | 3.51/3.73/3.73 |
| 1,000 / baseline | 2 | 2441.48–2612.02 | 24 | 21.85/82.89/85.48 |
| 1,000 / candidate | 2 | 9.14–9.42 | 24 | 1.95/3.14/3.26 |
| 1,000 / loro | 1 | 33.98 | 12 | 18.32/20.76/20.76 |
| 10,000 / baseline | 2 | 24943.54–58329.02 | 24 | 369.40/467.09/499.23 |
| 10,000 / candidate | 2 | 12.37–14.02 | 24 | 2.63/6.12/7.43 |
| 10,000 / loro | 1 | 354.24 | 12 | 199.41/264.20/264.20 |

| Prefix / backend | Latest directory ms | Adjacent 20 bodies ms | Old ID ms | Full history ms |
| --- | --- | --- | --- | --- |
| 100 / baseline | 1.87/1.87/1.87 | 171.17/171.17/171.17 | 162.06/162.06/162.06 | 304.37/304.37/304.37 |
| 100 / candidate | 1.72/1.72/1.72 | 144.98/144.98/144.98 | 2.69/2.69/2.69 | 242.93/242.93/242.93 |
| 100 / loro | 3.30/3.30/3.30 | 2.50/2.50/2.50 | 0.10/0.10/0.10 | 4.87/4.87/4.87 |
| 1,000 / baseline | 1.50/1.50/1.50 | 225.02/225.02/225.02 | 3025.36/3025.36/3025.36 | 2346.80/2346.80/2346.80 |
| 1,000 / candidate | 1.43/1.43/1.43 | 152.03/152.03/152.03 | 2.66/2.66/2.66 | 2755.15/2755.15/2755.15 |
| 1,000 / loro | 4.75/4.75/4.75 | 5.24/5.24/5.24 | 0.10/0.10/0.10 | 29.83/29.83/29.83 |
| 10,000 / baseline | 1.81/1.81/1.81 | 154.23/154.23/154.23 | 28408.83/28408.83/28408.83 | 25209.94/25209.94/25209.94 |
| 10,000 / candidate | 4.55/4.55/4.55 | 194.26/194.26/194.26 | 3.16/3.16/3.16 | 27820.09/27820.09/27820.09 |
| 10,000 / loro | 2.31/2.31/2.31 | 57.63/57.63/57.63 | 0.17/0.17/0.17 | 414.33/414.33/414.33 |

#### Durable writes

Total includes acknowledgment and explicit control persistence; all three are shown separately. One finish/resume/creation sample per trial is intentionally labeled.

| Prefix / backend | Operation | n | Total ms | Ack ms | Control persistence ms |
| --- | --- | --- | --- | --- | --- |
| 100 / baseline | textAppend | 40 | 10.91/79.90/107.21 | 10.88/79.57/106.98 | 0.03/0.16/0.25 |
| 100 / baseline | finish | 2 | 20.72/20.72/20.72 | 20.66/20.66/20.66 | 0.03/0.03/0.03 |
| 100 / baseline | assistantEntryReopen | 2 | 63.20/63.20/63.20 | 63.16/63.16/63.16 | 0.02/0.02/0.02 |
| 100 / baseline | firstResumedAppend | 2 | 14.41/14.41/14.41 | 14.36/14.36/14.36 | 0.02/0.02/0.02 |
| 100 / baseline | userCreation | 2 | 49.00/49.00/49.00 | 48.96/48.96/48.96 | 0.02/0.02/0.02 |
| 100 / baseline | assistantCreation | 2 | 69.68/69.68/69.68 | 69.64/69.64/69.64 | 0.02/0.02/0.02 |
| 100 / candidate | textAppend | 40 | 11.60/66.72/87.92 | 11.56/66.52/87.86 | 0.03/0.13/0.15 |
| 100 / candidate | finish | 2 | 24.41/24.41/24.41 | 24.37/24.37/24.37 | 0.03/0.03/0.03 |
| 100 / candidate | assistantEntryReopen | 2 | 77.77/77.77/77.77 | 77.71/77.71/77.71 | 0.03/0.03/0.03 |
| 100 / candidate | firstResumedAppend | 2 | 15.86/15.86/15.86 | 15.80/15.80/15.80 | 0.03/0.03/0.03 |
| 100 / candidate | userCreation | 2 | 60.73/60.73/60.73 | 60.66/60.66/60.66 | 0.03/0.03/0.03 |
| 100 / candidate | assistantCreation | 2 | 71.85/71.85/71.85 | 71.79/71.79/71.79 | 0.04/0.04/0.04 |
| 100 / loro | textAppend | 20 | 3.23/42.32/42.32 | 1.11/38.01/38.01 | 1.94/5.39/5.39 |
| 100 / loro | finish | 1 | 4.71/4.71/4.71 | 2.56/2.56/2.56 | 2.12/2.12/2.12 |
| 100 / loro | assistantEntryReopen | 1 | 3.17/3.17/3.17 | 1.14/1.14/1.14 | 2.00/2.00/2.00 |
| 100 / loro | firstResumedAppend | 1 | 5.26/5.26/5.26 | 3.33/3.33/3.33 | 1.90/1.90/1.90 |
| 100 / loro | userCreation | 1 | 8.79/8.79/8.79 | 7.02/7.02/7.02 | 1.74/1.74/1.74 |
| 100 / loro | assistantCreation | 1 | 7.48/7.48/7.48 | 5.25/5.25/5.25 | 2.21/2.21/2.21 |
| 1,000 / baseline | textAppend | 40 | 12.19/82.99/102.30 | 12.15/82.68/101.99 | 0.03/0.20/0.22 |
| 1,000 / baseline | finish | 2 | 20.87/20.87/20.87 | 20.81/20.81/20.81 | 0.03/0.03/0.03 |
| 1,000 / baseline | assistantEntryReopen | 2 | 62.71/62.71/62.71 | 62.65/62.65/62.65 | 0.03/0.03/0.03 |
| 1,000 / baseline | firstResumedAppend | 2 | 17.05/17.05/17.05 | 17.00/17.00/17.00 | 0.03/0.03/0.03 |
| 1,000 / baseline | userCreation | 2 | 50.65/50.65/50.65 | 50.59/50.59/50.59 | 0.03/0.03/0.03 |
| 1,000 / baseline | assistantCreation | 2 | 66.91/66.91/66.91 | 66.87/66.87/66.87 | 0.02/0.02/0.02 |
| 1,000 / candidate | textAppend | 40 | 11.21/73.38/82.65 | 11.18/73.19/82.46 | 0.03/0.14/0.14 |
| 1,000 / candidate | finish | 2 | 21.17/21.17/21.17 | 21.13/21.13/21.13 | 0.03/0.03/0.03 |
| 1,000 / candidate | assistantEntryReopen | 2 | 69.15/69.15/69.15 | 69.11/69.11/69.11 | 0.03/0.03/0.03 |
| 1,000 / candidate | firstResumedAppend | 2 | 15.18/15.18/15.18 | 15.14/15.14/15.14 | 0.02/0.02/0.02 |
| 1,000 / candidate | userCreation | 2 | 51.94/51.94/51.94 | 51.89/51.89/51.89 | 0.02/0.02/0.02 |
| 1,000 / candidate | assistantCreation | 2 | 73.60/73.60/73.60 | 73.56/73.56/73.56 | 0.02/0.02/0.02 |
| 1,000 / loro | textAppend | 20 | 2.90/62.50/62.50 | 0.99/56.59/56.59 | 1.94/5.83/5.83 |
| 1,000 / loro | finish | 1 | 4.46/4.46/4.46 | 2.27/2.27/2.27 | 2.16/2.16/2.16 |
| 1,000 / loro | assistantEntryReopen | 1 | 3.00/3.00/3.00 | 0.84/0.84/0.84 | 2.14/2.14/2.14 |
| 1,000 / loro | firstResumedAppend | 1 | 16.46/16.46/16.46 | 14.50/14.50/14.50 | 1.91/1.91/1.91 |
| 1,000 / loro | userCreation | 1 | 9.94/9.94/9.94 | 5.40/5.40/5.40 | 4.51/4.51/4.51 |
| 1,000 / loro | assistantCreation | 1 | 9.67/9.67/9.67 | 7.45/7.45/7.45 | 2.19/2.19/2.19 |
| 10,000 / baseline | textAppend | 40 | 15.33/227.35/278.04 | 15.27/227.14/277.72 | 0.03/0.14/0.23 |
| 10,000 / baseline | finish | 2 | 23.93/23.93/23.93 | 23.88/23.88/23.88 | 0.02/0.02/0.02 |
| 10,000 / baseline | assistantEntryReopen | 2 | 74.95/74.95/74.95 | 74.90/74.90/74.90 | 0.02/0.02/0.02 |
| 10,000 / baseline | firstResumedAppend | 2 | 17.21/17.21/17.21 | 17.14/17.14/17.14 | 0.03/0.03/0.03 |
| 10,000 / baseline | userCreation | 2 | 61.87/61.87/61.87 | 61.82/61.82/61.82 | 0.02/0.02/0.02 |
| 10,000 / baseline | assistantCreation | 2 | 88.70/88.70/88.70 | 88.66/88.66/88.66 | 0.02/0.02/0.02 |
| 10,000 / candidate | textAppend | 40 | 15.47/238.92/283.05 | 15.43/238.60/282.83 | 0.03/0.17/0.19 |
| 10,000 / candidate | finish | 2 | 25.63/25.63/25.63 | 25.59/25.59/25.59 | 0.02/0.02/0.02 |
| 10,000 / candidate | assistantEntryReopen | 2 | 76.41/76.41/76.41 | 76.34/76.34/76.34 | 0.03/0.03/0.03 |
| 10,000 / candidate | firstResumedAppend | 2 | 28.84/28.84/28.84 | 28.78/28.78/28.78 | 0.03/0.03/0.03 |
| 10,000 / candidate | userCreation | 2 | 66.45/66.45/66.45 | 66.38/66.38/66.38 | 0.04/0.04/0.04 |
| 10,000 / candidate | assistantCreation | 2 | 88.87/88.87/88.87 | 88.82/88.82/88.82 | 0.03/0.03/0.03 |
| 10,000 / loro | textAppend | 20 | 2.64/206.70/206.70 | 1.00/195.15/195.15 | 1.75/11.49/11.49 |
| 10,000 / loro | finish | 1 | 5.39/5.39/5.39 | 3.55/3.55/3.55 | 1.81/1.81/1.81 |
| 10,000 / loro | assistantEntryReopen | 1 | 2.78/2.78/2.78 | 0.95/0.95/0.95 | 1.81/1.81/1.81 |
| 10,000 / loro | firstResumedAppend | 1 | 133.42/133.42/133.42 | 131.19/131.19/131.19 | 2.20/2.20/2.20 |
| 10,000 / loro | userCreation | 1 | 10.53/10.53/10.53 | 5.80/5.80/5.80 | 4.70/4.70/4.70 |
| 10,000 / loro | assistantCreation | 1 | 9.70/9.70/9.70 | 7.40/7.40/7.40 | 2.26/2.26/2.26 |

#### Memory trajectory

RSS below is whole-process MiB, including Vitest, Native and Workers; it is not Roost-exclusive allocation. Values are per-trial medians. No forced GC is used. Released means owners were closed, not that the allocator returned pages to the OS. Dispatch Δ uses the common opened baseline.

| Prefix / backend | Start | Open | Latest | Dispatch ×13 | Append ×20 | Resume/finish | Create | Before full | Full | Verified | Released | Dispatch Δ |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 100 / baseline | 299.3 | 364.0 | 364.1 | 386.0 | 392.3 | 393.0 | 394.2 | 397.2 | 406.8 | 411.0 | 409.2 | 21.9 |
| 100 / candidate | 301.5 | 365.6 | 365.7 | 366.1 | 368.2 | 368.9 | 370.4 | 371.2 | 384.0 | 396.5 | 394.6 | 0.5 |
| 100 / loro | 300.8 | 327.0 | 327.3 | 334.8 | 342.4 | 343.2 | 345.2 | 345.7 | 347.3 | 380.3 | 380.3 | 7.8 |
| 1,000 / baseline | 298.3 | 366.4 | 366.4 | 487.5 | 493.3 | 492.7 | 493.5 | 510.0 | 520.2 | 586.0 | 585.5 | 121.1 |
| 1,000 / candidate | 300.6 | 366.5 | 366.6 | 367.0 | 372.1 | 372.7 | 373.7 | 373.8 | 435.5 | 521.2 | 520.8 | 0.5 |
| 1,000 / loro | 299.5 | 433.4 | 433.9 | 439.3 | 444.3 | 444.4 | 446.3 | 446.6 | 452.8 | 547.9 | 547.9 | 5.9 |
| 10,000 / baseline | 299.2 | 402.5 | 402.5 | 1312.1 | 1331.4 | 1323.5 | 1318.6 | 1328.0 | 1329.3 | 1356.7 | 1353.1 | 909.6 |
| 10,000 / candidate | 299.7 | 414.1 | 414.4 | 414.7 | 438.6 | 416.4 | 414.2 | 414.6 | 878.8 | 937.4 | 934.5 | 0.6 |
| 10,000 / loro | 299.7 | 1183.9 | 1184.3 | 1382.1 | 1388.4 | 1392.5 | 1393.3 | 1394.9 | 1458.5 | 1521.8 | 1521.4 | 198.3 |

Reporting-isolate JS samples are **heap used / external / array buffers**, in MiB. These overlap RSS and must not be added to it. Native-exclusive allocation and unsampled peaks are not measured.

| Prefix / backend | Open | Dispatch ×13 | Before full | Full |
| --- | --- | --- | --- | --- |
| 100 / baseline | 154.3 / 9.7 / 2.7 | 190.6 / 15.0 / 5.3 | 198.4 / 12.6 / 5.6 | 196.7 / 13.2 / 6.2 |
| 100 / candidate | 151.4 / 10.0 / 3.0 | 153.2 / 9.7 / 2.7 | 164.9 / 10.3 / 3.3 | 182.8 / 12.8 / 5.8 |
| 100 / loro | 153.1 / 28.3 / 11.5 | 160.8 / 28.4 / 11.5 | 171.4 / 28.4 / 11.5 | 173.1 / 28.4 / 11.5 |
| 1,000 / baseline | 151.7 / 11.6 / 2.7 | 258.0 / 19.7 / 10.8 | 210.4 / 19.2 / 10.3 | 273.8 / 27.7 / 18.8 |
| 1,000 / candidate | 157.4 / 11.9 / 3.0 | 159.3 / 11.9 / 3.1 | 180.5 / 13.7 / 4.8 | 229.0 / 20.0 / 11.1 |
| 1,000 / loro | 136.6 / 131.3 / 26.9 | 198.4 / 122.9 / 26.9 | 151.6 / 122.9 / 26.9 | 165.7 / 122.9 / 26.9 |
| 10,000 / baseline | 166.6 / 37.1 / 4.7 | 595.0 / 32.3 / 0.4 | 380.4 / 36.1 / 4.3 | 716.9 / 32.3 / 0.5 |
| 10,000 / candidate | 175.0 / 39.7 / 6.6 | 176.8 / 39.8 / 6.6 | 192.1 / 41.1 / 6.7 | 568.6 / 32.3 / 0.5 |
| 10,000 / loro | 134.5 / 1048.2 / 0.4 | 225.7 / 1048.2 / 0.4 | 271.8 / 1048.2 / 0.5 | 334.1 / 1048.2 / 0.4 |

#### CPU, storage and preparation

Stage CPU/wall include selected reads, writes and full business verification; append CPU covers only the 20 appends plus their persistence. WAL/SHM are sampled file lengths, not payload bytes or live memory.

| Prefix / backend | Stage wall s | Stage CPU ms | Append CPU ms | Initial DB MiB | Final control MiB | Final history MiB | Sampled WAL MiB | SHM KiB |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 100 / baseline | 2.31 | 2179.2 | 273.0 | 5.477 | 0.121 | 5.516 | 1.996 | 64.0 |
| 100 / candidate | 1.72 | 1722.5 | 235.4 | 5.477 | 0.121 | 5.516 | 2.118 | 64.0 |
| 100 / loro | 0.53 | 530.3 | 83.2 | 2.785 | 2.785 | 0.000 | 2.200 | 32.0 |
| 1,000 / baseline | 10.17 | 11091.0 | 288.8 | 53.090 | 0.461 | 52.781 | 2.204 | 64.0 |
| 1,000 / candidate | 4.55 | 4719.3 | 373.2 | 53.090 | 0.461 | 52.781 | 2.318 | 64.0 |
| 1,000 / loro | 1.93 | 2294.3 | 116.1 | 26.586 | 26.586 | 0.000 | 17.842 | 64.0 |
| 10,000 / baseline | 105.03 | 96132.7 | 482.2 | 527.801 | 3.801 | 524.152 | 4.534 | 64.0 |
| 10,000 / candidate | 34.57 | 33372.1 | 508.9 | 527.801 | 3.801 | 524.152 | 4.660 | 64.0 |
| 10,000 / loro | 15.27 | 17352.0 | 244.4 | 265.059 | 265.059 | 0.000 | 178.214 | 384.0 |

Preparation is excluded from selection latency. Roost repair is the first incomplete-index reconstruction after import; the Loro column is only a shallow directory read. Index KV bytes sum stored keys/values, excluding shared SQLite page overhead. Empty DB bytes are measured before import.

| Prefix / backend | Import s | Index repair / directory ms | Post-import RSS MiB | Empty DB KiB | Dispatch index KV KiB |
| --- | --- | --- | --- | --- | --- |
| 100 / candidate | 6.096 | 224.13 | 414.9 | 116.0 | 28.4 |
| 100 / loro | 0.342 | 8.68 | 372.6 | 92.0 | 0.0 |
| 1,000 / candidate | 46.853 | 3027.96 | 582.5 | 116.0 | 284.6 |
| 1,000 / loro | 1.243 | 54.37 | 513.2 | 92.0 | 0.0 |
| 10,000 / candidate | 479.270 | 32727.82 | 834.2 | 116.0 | 2899.4 |
| 10,000 / loro | 16.456 | 216.66 | 1408.6 | 92.0 | 0.0 |

#### Correctness evidence and limits

All 36 manual stages completed successfully; full expected item content, no-op
receipt retry, fresh-process digest and cross-backend digest checks passed at
all three prefixes. Every generated SQLite database passed external post-close
`quick_check`. Source/SDK/Native hashes were recorded; runtime files, dependency
links, Native package and temporary fixtures were restored and verified. Setup
failures before measurement (research dependency directory handling) were fixed
and excluded. An initial local smoke expectation treated streaming text after a
tool as the earlier text item; the fixture expectation was corrected to the
established reducer's separate trailing item before measured trials.

This removes the dispatcher's completed-history body scaling. The comparison is
one pending input and ordinary owned writes: cost still scales with pending or
explicitly requested identities. A foreign Native cursor, branch replacement or
invalid/missing index can require a complete bounded-page rebuild. That repair,
full export, adjacent-page body hydration, prefix import and other write costs
are not made constant or free by this change. Multiwriter/sync churn, network
amplification, thought/tag rewrites, tool/plan update timing, growing 64/256/1024
KiB replies, absolute oldest-window jumps and full renderer delivery are **not
measured in this experiment**. Existing correctness coverage is not a benchmark
of those categories. Ordinary append still has higher acknowledgment cost than
Loro; the tables do not establish whole-product Roost superiority or zero overhead.

Reproduce with the [fixed-prefix workflow](../../../docs/roost-validation.md#fixed-prefix-dispatch).
Raw data and source/restoration manifests are retained in the task's external
`dispatch-index-20261022` artifact directory; no captured user data is committed.
