# Isolated bounded control-update prototype

Status: proposed
Type: testing
Translation: current
Owner: Codex

[中文](2026-10-22-control-update-block-prototype.zh.md)

## Abstract

After shared-body storage, the short Roost workload still grows its control database
by 80 KiB through incremental Loro cursor publications. An isolated common SQLite
adapter packs those updates losslessly while preserving immediate durability and
notification behavior. Measured short-workload growth falls from 242 to 192 KiB,
but 1,000 streamed messages cost about 20% more append CPU and 38% higher p95;
RSS does not consistently improve. The local trial is complete, with adoption still
proposed: this implementation fails the no-speed-regression condition and should
not be merged. Product sources, existing PRs and deployments are unchanged.

## Ownership and format boundary

The subsequent scope decision fixes the Loro implementation as an unchanged
reference. Further optimization is limited to Roost core or Roost-specific
integration; the common-adapter prototype is stopped. Packed-Loro rows below
remain diagnostic evidence from the completed experiment, not an eligible
candidate or the fixed Loro baseline.

Authorization covers one isolated implementation and comparison. Copy installed
`loro-repo@0.23.3`; do not edit its installed source. Only the copy's document-update
storage changes. The shared-body Roost Native, Lody runtime and existing benchmark
harnesses stay fixed. Both Roost and plain Loro consume this common adapter, so both
backends receive original-layout and packed-layout trials.

Each block retains exact update bytes, globally increasing IDs and timestamps,
with at most 7,936 raw bytes / 64 records; oversized updates remain uncompressed
singletons. Node's synchronous Zstd level 1 is kept only when smaller, with bounded
decoding. Sequence allocation and append share an IMMEDIATE transaction or the
caller's outer transaction; a failed batch rolls back everything. Prefix cleanup
removes covered blocks and rewrites its boundary only. No cross-transaction cache,
delayed durability or reduced cursor publications. Small appends do not fetch the
body of the preceding oversized singleton.

A persistent sequence counter adds a fixed 4 KiB to the empty database. Old and new
schemas reject one another; there is no legacy reader or product migration. Only
closed synthetic prepared-history copies are converted offline, retaining all
bytes, IDs, timestamps and sequence high-water marks; source seeds stay intact.
The prototype is ESM-only and explicitly rejects CommonJS. It is not a publishable
general dependency update.

Appends read/decode the tail block, re-encode/compress it and persist a sequence SQL
operation. These are concrete additional work, but no profiler attribution separates
their CPU contributions; do not blame Zstd alone. The prototype did not silently
weaken durability, add caches or remove notifications after observing the regression.

## Fixed input and measurement definitions

Lody `812bc3c21da3b3d160eccd6f2cbd05884962d4eb`; shared-body Native SHA-256
`56b737124db34a1dba137856582f5c1809a696bc30ebb22ee49bedea85adb0e2`.

This includes the full preceding integrated PR stacks and #27 shared-body runtime,
not only published npm 0.2.0. Procedure owner:
[Roost validation guide](../../../docs/roost-validation.md); prior acceptance:
[combined shared-body report](2026-10-22-roost-pr-stack-integration.md).

Apple M4 / 32 GiB / 10 cores, Node 24.22.1, FULL/WAL with explicit per-action
persistence. Original/packed/packed/original gives two trials per layout. Write,
reopen and paging use separate processes. Limits remain 1,536 MiB heap, 2 GiB RSS
and 4 GiB free disk before each stage. Sampled one-minute host load is 3.16–9.62;
no other benchmark/build from this task runs concurrently. Two trials are not a
strong statistical confidence claim.

Short means 224×256 B streamed fragments plus a 16 KiB tool payload, not two short
strings. History means 500 user/assistant rounds, each with 20×256 B and a 16 KiB
tool. Reply means 1,024×1,024 B plus tool. Mixed means ten rounds of 100×1,024 B,
tools/thinking/tags/plans and halfway finish/reopen.

The first 24 short stages compared an installed-path baseline with a package copy;
RSS already differed by about 60 MiB before opening storage, exposing an import-graph
confound. That cohort is retained but excluded from performance conclusions. Tables
instead load original/prototype bytes at the same absolute package path, aligning
startup RSS. RSS covers the whole Vitest/JS/WASM/Native process, not Roost-exclusive
memory; growth is relative to backend open, before full validation. DB growth is
history+control relative to empty databases, excluding WAL/SHM and the unchanged
identity database. CPU is process user+system; append CPU encloses notifications
and persistence only, with whole write-stage CPU reported separately. Arrows mean
original→packed, each cell the median of two trials unless explicitly qualified.

## Append versus history selection: fixed-reference audit

This audit reuses existing original-layout samples only; no new benchmark or
runtime modification is made. The measured build includes incremental semantic
mutations, Native atomic content/checkpoint groups, scalar dispatch indexes and
#27 shared-body storage. It is not the pre-optimization runtime.

The short figure's history append CPU is the sum of **10,000 notification batches
while growing to 1,000 messages**: Roost 10.874 s versus unchanged Loro 10.808 s.
It encloses `applyAgentBatch` plus `persistDocNow`, not dispatch selection or long-session
recovery. It includes integration/Native work and immediate control persistence;
the process CPU counter is not a Roost-only cost breakdown. The abandoned packed
values 13.085/7.865 s must not replace these fixed-reference figures.

For prepared prefixes, the current reply and its 20×256 B appends stay fixed:

| Completed messages | Roost: CPU for 20 appends ms | Loro: CPU for 20 appends ms | Roost warm selection ms | Loro warm selection ms |
| ------------------ | ---------------------------- | --------------------------- | ----------------------- | ---------------------- |
| 100                | 58.1                         | 30.1                        | 0.399                   | 1.382                  |
| 1,000              | 72.1                         | 47.7                        | 0.428                   | 6.292                  |
| 10,000             | 156.2                        | 88.3                        | 0.415                   | 56.502                 |

Roost has two complete trials per prefix; Loro has two except one at 10,000.
At 10,000, durable append p50 is 2.529 ms Roost versus 0.311 ms Loro. First
selection after local open is 2.628 versus 82.694 ms. Latest-window → after
selection RSS is 447.5→447.9 MiB versus 1884.6→1784.1 MiB, with GC affecting
the latter decrease. These are whole-process readings and prepared-index local
selection, not full restoration or end-to-end response latency.

The already-recorded boundary timings narrow elapsed-time investigation:
`applyAgentBatch` acknowledgment p50 is 2.519 ms Roost versus 0.226 ms Loro;
the subsequent explicit `persistDocNow` p50 is 0.007 versus 0.081 ms. They are
separate per-trial quantiles, not additive stage percentages. Most measured Roost
append latency is before backend acknowledgment. This does not exclude control
work occurring there or asynchronously, and it is not a CPU hotspot profile.

The previous removal of full-transcript dispatch remains effective. Targeted
ordinary writes also retain semantic append hints and one conditional Native
commit group for body/receipts/derived indexes. Source confirms cursor checks,
receipt lookup, publication and control persistence remain on the append path;
that read-only reanalysis did **not** profile their CPU shares. Neither those
source calls nor an old profile established the largest hotspot. Append CPU/latency is still worse or
comparable at these boundaries, so a selection win cannot establish overall
long-conversation superiority. A further append optimization needs current stage
attribution before choosing another code change, with Loro fixed throughout.
The subsequent [streamed-append structure audit](../architecture/2026-10-23-roost-append-cpu-structure.md)
now supplies that current request trace, thread CPU and append-filtered profile;
it does not authorize the proposed redesign.

Evidence boundaries:
[durable timer](../../../../apps/cli/benchmarks/roost-durable.test.ts),
[prepared-prefix timer](../../../../apps/cli/benchmarks/roost-dispatch.test.ts),
[Roost write integration](../../../../apps/cli/src/session/roost-node-session.ts),
and the [earlier dispatch decision](../architecture/2026-10-22-roost-dispatch-scalar-projection.md).

## Resource results

| Workload                | Backend | DB growth KiB   | Append p95 ms | Append CPU s    | RSS MiB (+growth)               |
| ----------------------- | ------- | --------------- | ------------- | --------------- | ------------------------------- |
| Short: 2 messages       | Roost   | 242 → 192       | 2.75 → 2.44   | 0.408 → 0.391   | 437.6 (+36.0) → 445.9 (+44.4)   |
| Short: 2 messages       | Loro    | 128 → 104       | 0.92 → 3.38   | 0.247 → 0.342   | 413.2 (+52.6) → 408.9 (+46.8)   |
| 1,000 streamed messages | Roost   | 24,242 → 21,590 | 1.74 → 2.41   | 10.874 → 13.085 | 615.4 (+214.8) → 625.8 (+225.6) |
| 1,000 streamed messages | Loro    | 13,720 → 12,100 | 1.22 → 1.15   | 10.808 → 7.865  | 662.9 (+301.8) → 660.5 (+298.5) |
| Single 1 MiB reply      | Roost   | 1,812 → 1,572   | 2.59 → 3.18   | 1.440 → 1.615   | 523.0 (+121.6) → 520.6 (+119.8) |
| Single 1 MiB reply      | Loro    | 1,448 → 1,396   | 4.07 → 4.68   | 2.579 → 2.824   | 596.8 (+236.6) → 600.3 (+239.2) |
| Mixed / resume          | Roost   | 3,292 → 3,048   | 2.69 → 2.25   | 1.742 → 1.595   | 558.6 (+156.3) → 569.3 (+168.4) |
| Mixed / resume          | Loro    | 1,904 → 1,820   | 0.84 → 0.93   | 0.671 → 0.745   | 559.5 (+198.4) → 604.3 (+242.9) |

Short control files measure 172→124 KiB, with empty files 92→96 KiB, hence growth
80→28 KiB. History-page allocation differences make median total savings 50 KiB.
The offline model's 184 KiB was an estimate, not a runtime result: live sequence
and allocation costs cannot be omitted. Absolute combined DB is 358→312 KiB,
saving 46 KiB.

Plain Loro also falls from 128 to 104 KiB. The fair short ratio is therefore
192/104≈1.85, not 1.50 using old Loro's 128 KiB. Roost history growth falls about
10.9%, but original append CPU samples are 11.601/10.148 s versus 13.336/12.835 s
packed; p95 samples are 1.971/1.514 ms versus 2.631/2.183 ms. Both trials show a
cost. Single-reply CPU/p95 medians also rise, while mixed improves; neither all
paths slower nor all paths faster is supported. RSS does not consistently fall.

| Workload                | Backend | Absolute DB KiB | WAL MiB     | Sampled peak RSS MiB | Write-stage CPU s |
| ----------------------- | ------- | --------------- | ----------- | -------------------- | ----------------- |
| Short: 2 messages       | Roost   | 358 → 312       | 7.07 → 6.04 | 437.6 → 445.9        | 0.801 → 0.763     |
| Short: 2 messages       | Loro    | 220 → 200       | 3.17 → 2.58 | 413.2 → 408.9        | 0.317 → 0.421     |
| 1,000 streamed messages | Roost   | 24,358 → 21,710 | 7.99 → 7.97 | 615.4 → 633.3        | 30.622 → 34.080   |
| 1,000 streamed messages | Loro    | 13,812 → 12,196 | 3.96 → 3.94 | 667.4 → 660.6        | 13.241 → 9.900    |
| Single 1 MiB reply      | Roost   | 1,928 → 1,692   | 7.91 → 7.90 | 523.0 → 520.6        | 2.281 → 2.601     |
| Single 1 MiB reply      | Loro    | 1,540 → 1,492   | 3.94 → 3.94 | 669.4 → 688.0        | 2.724 → 2.979     |
| Mixed / resume          | Roost   | 3,408 → 3,168   | 8.00 → 7.90 | 566.9 → 580.6        | 3.216 → 3.108     |
| Mixed / resume          | Loro    | 1,996 → 1,916   | 3.94 → 3.94 | 559.5 → 604.9        | 0.906 → 1.041     |

WAL measures current file allocation, **not cumulative bytes written**. No cumulative
VFS I/O was measured, so this does not demonstrate absence of write amplification.
Peaks are stage samples, not continuous system monitoring.

## Creation, finish and separate-process reads

| Workload                | Backend | Append p50 ms | User-create p95 ms | Assistant-create p95 ms | Finish p95 ms |
| ----------------------- | ------- | ------------- | ------------------ | ----------------------- | ------------- |
| Short: 2 messages       | Roost   | 1.40 → 1.23   | 17.81 → 16.40      | 13.35 → 13.17           | 4.04 → 4.73   |
| Short: 2 messages       | Loro    | 0.37 → 0.47   | 18.32 → 20.53      | 2.71 → 2.76             | 1.25 → 1.23   |
| 1,000 streamed messages | Roost   | 0.86 → 0.98   | 6.58 → 7.44        | 11.06 → 12.33           | 2.99 → 3.99   |
| 1,000 streamed messages | Loro    | 0.14 → 0.17   | 0.92 → 0.71        | 1.75 → 1.06             | 0.40 → 0.54   |
| Single 1 MiB reply      | Roost   | 0.97 → 1.07   | 16.79 → 18.23      | 13.87 → 24.62           | 6.58 → 7.14   |
| Single 1 MiB reply      | Loro    | 1.89 → 1.99   | 15.21 → 16.60      | 2.21 → 2.45             | 1.37 → 1.75   |
| Mixed / resume          | Roost   | 1.14 → 1.11   | 17.17 → 16.00      | 13.32 → 13.97           | 7.90 → 9.80   |
| Mixed / resume          | Loro    | 0.33 → 0.37   | 14.81 → 16.14      | 1.60 → 2.41             | 1.77 → 2.30   |

| Workload                | Backend | Backend-open ms | Stage → latest ms | Oldest page ms  | Full export ms  | Paging total ms |
| ----------------------- | ------- | --------------- | ----------------- | --------------- | --------------- | --------------- |
| Short: 2 messages       | Roost   | 79.30 → 80.37   | 96.66 → 97.49     | 0.20 → 0.21     | 4.64 → 4.38     | 1.98 → 2.03     |
| Short: 2 messages       | Loro    | 22.49 → 23.47   | 40.13 → 44.18     | 0.12 → 0.24     | 0.31 → 0.40     | 2.12 → 1.95     |
| 1,000 streamed messages | Roost   | 270.22 → 299.35 | 287.91 → 317.74   | 995.60 → 893.01 | 788.06 → 893.31 | 880.04 → 980.32 |
| 1,000 streamed messages | Loro    | 614.90 → 508.05 | 650.00 → 528.38   | 0.59 → 0.45     | 10.63 → 10.18   | 52.53 → 50.30   |
| Single 1 MiB reply      | Roost   | 151.46 → 108.12 | 188.43 → 124.79   | 0.42 → 0.49     | 28.01 → 26.57   | 2.93 → 3.32     |
| Single 1 MiB reply      | Loro    | 62.65 → 64.21   | 84.47 → 90.27     | 0.18 → 0.56     | 0.29 → 0.44     | 4.03 → 4.30     |
| Mixed / resume          | Roost   | 167.17 → 174.96 | 188.88 → 198.07   | 1.37 → 1.28     | 35.60 → 36.88   | 7.10 → 8.00     |
| Mixed / resume          | Loro    | 70.28 → 76.63   | 97.03 → 102.12    | 1.67 → 1.42     | 1.22 → 0.90     | 5.11 → 5.01     |

Backend open / stage→latest exclude ACP, network and UI restoration. Reading the
oldest page can require index catch-up; full export is timed separately after local
reads and is not first recovery. Machine summaries and original JSON retain halfway
resume phases, quantiles and resource trajectories.

## Prepared-history local selection and continuation

Closed synthetic seeds have equal business contents and prepared indexes; only
control physical layout differs. This measures local selection, not recovery from
an empty replica with preparation costs hidden. Each RSS cell shows original/packed
latest-window→after 13 selections; GC can lower it. This is not growth since open.

| Prefix | Backend | Trials original/packed | First selection ms | Warm selection ms | Text append ms | Resume ms     | First resumed append ms | RSS latest → after selections MiB; original / packed |
| ------ | ------- | ---------------------- | ------------------ | ----------------- | -------------- | ------------- | ----------------------- | ---------------------------------------------------- |
| 100    | Roost   | 2/2                    | 2.75 → 2.77        | 0.40 → 0.41       | 1.59 → 2.01    | 9.89 → 11.47  | 2.53 → 3.35             | 393.9 → 394.2 / 394.4 → 394.8                        |
| 100    | Loro    | 2/2                    | 3.20 → 2.83        | 1.38 → 0.79       | 0.43 → 0.47    | 0.42 → 0.55   | 1.09 → 1.23             | 395.0 → 395.7 / 396.1 → 396.9                        |
| 1,000  | Roost   | 2/2                    | 2.95 → 2.83        | 0.43 → 0.40       | 1.64 → 1.81    | 12.28 → 13.17 | 2.51 → 2.39             | 406.4 → 406.7 / 398.0 → 398.3                        |
| 1,000  | Loro    | 2/2                    | 10.88 → 10.49      | 6.29 → 5.46       | 0.32 → 0.43    | 0.31 → 0.53   | 5.33 → 4.53             | 551.4 → 573.1 / 551.6 → 573.0                        |
| 10,000 | Roost   | 2/2                    | 2.63 → 2.80        | 0.42 → 0.40       | 2.53 → 3.90    | 14.37 → 12.91 | 3.11 → 3.40             | 447.5 → 447.9 / 448.4 → 448.8                        |
| 10,000 | Loro    | 1/1                    | 82.69 → 100.21     | 56.50 → 53.61     | 0.31 → 0.38    | 0.33 → 0.54   | 54.09 → 50.64           | 1884.6 → 1784.1 / 1949.5 → 1881.1                    |

Both 10,000-message Roost trials complete: first selection 2.628→2.796 ms, warm
selection 0.415→0.400 ms, and about 0.4 MiB RSS growth during selection under both
layouts. Bounded selection remains intact. Full materialization still takes
8.27→8.61 seconds. Loro has only one complete trial per layout at 10,000: the second
packed measure exceeds the 2 GiB RSS budget at `after-release`, preventing its stage
JSON from being written. Do not invent exact latency/RSS samples for that failure.
Its dependent verify and the final original-layout second trial are not run.

## Correctness evidence, budget failure and limits

Real adapter-boundary tests pass 9/9: exact bytes/IDs/timestamps and oversized data
across reopen; prefix cleanup; actual Loro load/snapshot compaction and subsequent
updates; failed batch rollback including sequence/sibling metadata; corrupt-block
rejection; table prefixes/multiple documents/original writer fencing; 80 updates
from two processes; committed/uncommitted SIGKILL recovery after explicit IPC
signals; and old/new schema rejection in both directions. No sleep chooses crash
timing.

All 96 four-workload stages finish. Prepared history has 44 successful stages,
one RSS-budget failure and three not executed. Total: 140 successful stages and
212 SQLite quick/foreign-key checks. Full-content digests, cross-backend business
digests, reopen, retries, paging and successful dispatch/verify pairs agree. This
is not an all-tests-passed result. An earlier 4 GiB disk preflight also stopped
before a child test started. Completed synthetic databases were archived with
per-file SHA-256 verified by reading the archive back before removing originals;
seeds, failed data, raw JSON/logs and archive manifests remain available.

The full Lody/Rust CI is not rerun for this scratch prototype. Nine boundary tests
and the real end-to-end matrix assess the trade-off; previous #27 checks cannot
certify this new storage for release. CommonJS, six-platform packaging, network
sync, browser notifications, full ACP recovery and cumulative disk writes remain
unverified. Adoption stays proposed: this implementation does not meet the stated
correctness-and-no-speed-regression condition. Retain the evidence and do not add
this version to existing PRs.

## Reproduction and handoff

Artifacts live under the existing validation root's `control-block-prototype/`:
`original-package-manifest.json` / `prototype-storage-manifest.json` pin source;
`storage.test.mjs` / `worker.mjs` own boundary tests; `run-experiment.py` reuses the
existing durable/dispatch harness; `matched-package-paths/status.json` records
success/failure; `results.json` retains samples/min/max;
`matched-package-paths/archives/manifest.json` records recoverable databases and
per-file SHA. `run-short.log` retains the confounded cohort; `run-dispatch.log` and
`run-dispatch-resume.log` retain disk/RSS stops. Do not overwrite or blindly retry
failed records.

All 103 original package files, Native build inputs/binary and benchmark harness
hashes are checked; both CLI dependency links are restored. Prototype code remains
outside the checkout, with local-only notes. No commit, push, remote PR update,
publication or deployment is part of this trial. Scoped Markdown formatting and
root `pnpm run docs check` pass (zero errors, 71 existing size warnings, no
protected topics); a check does not establish adoption.
