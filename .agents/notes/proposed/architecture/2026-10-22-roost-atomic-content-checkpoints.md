# Atomic Roost content checkpoints

Status: proposed
Translation: current

[中文](2026-10-22-roost-atomic-content-checkpoints.zh.md)

## Abstract

A common text append still commits four SQLite transactions: content/receipts,
binding progress, publication progress and goal projection. Use the newly
authorized Native conditional derived-index group to commit them together only
when the SDK proves a settled published-body edit and Native proves the entire
actual event interval belongs to this batch. Preserve full catch-up and ordinary
goal persistence for all other cases. Implementation and durable same-content
Loro comparison are in progress; no package or deployment is included.

## Plan and acceptance

The SDK owns private progress formats, binding/member validation and publication
wait dependencies. Lody supplies ordinary receipts plus a separately staged goal
projection. Stage without mutating live goal state; only a confirmed exact
`derivedIndexesApplied` result can suppress its later separate index transaction.
Do not infer this from metadataAttached. Publication still verifies all actual
events and reloads on foreign or uncertain work. Unknown goals, non-body commands,
seals, pending waiters and remote events retain the existing recovery paths.

Require the matching Native capability explicitly. No backward storage readers,
migration, weakened sync/signatures, receipt pruning, or deferred durability.
Keep the lifecycle ownership boundary intact; no Effect migration helps this
small pure/Native-boundary change. Test actual Native content/goal/receipt recovery,
lost replies, remote races, semantic failures and reopened state. Run root format,
check and docs check. Use a separate draft PR stacked on #1807, with a coordinated
Roost API companion. Benchmark full WAL/FULL operations against the preceding
version and same-content durable Loro on the Linux research checkout.

## Progress

2026-10-22: explicit approval received for Native atomic merging and correctness /
speed measurement. Core and Native SDK behavioral cases pass for exact interval,
pending remote update, future publication dependency, raced event cursor and lost
reply/reopen. Lody consumer integration begins here. Owning Roost plan:
`2026-10-22-atomic-derived-indexes.md`. Final checks and measurements pending.


### Integration checkpoint

Four owning real-Native suites pass 112 cases. Additional focused coverage confirms
that a text/receipt/active-goal commit survives a lost reply, is not appended twice
on retry/reopen, and still blocks removal of the active goal. The existing owner
race case now exercises an applied atomic group before a peer changes an older
goal; publication reloads and preserves the peer's active goal.

Goal staging and installed updates share one pure reducer. A private cloned goal
snapshot and original host identity fence later write elision; numeric cursor
coincidence across generation handles cannot certify it. The SDK also owns the
write/options bytes before its first await. None of these checks turn unknown
or foreign work into success. CLI's configured `pnpm run typecheck` passes;
a direct generic `tsc --noEmit` used the broad development config and reported
unrelated pre-existing test/desktop typing errors, so it is not the project's
acceptance command. Root format/check and docs check are in progress.

100 small appends produce 100 Native writeBatch transactions (previously 200
writeBatch + 200 index compare/write), 1300 index reads (2200 before), and 500 event
reads (800 before). All 100 include the SDK progress and application goal group.
The independent Loro control-document persistence remains unchanged. This trace
is not a timing comparison. The two complete same-content Linux configurations
and durable Loro reference are still running; preliminary speeds are not final.


## Final measurement and verification

Companion API: [Roost #25](https://github.com/loro-dev/roost/pull/25), stacked on
Roost #24. This Lody cut is stacked on #1807. Matching unreleased Native and SDK
packages are required; no manifests/lockfile are changed to a fictitious release.
Local checks use isolated candidate packages, never modified pnpm-store packages.

All 30 valid Linux stages pass: 10 write/reopen/paging workloads, two Roost trials
per variant in before/after/after/before order and one Loro reference per workload.
Both use SQLite WAL/FULL and a per-action persistence barrier. Complete business
content digests agree with Loro; complete reopen digests agree with each write;
all 18 post-close SQLite quick checks pass. The runtime matches measured Rust,
Native JS, SDK JS and four Lody source files byte for byte. All research sources,
package links/directories and the temporary harness are restored/removed.

| Workload | Before append p95 | After append p95 | Durable Loro p95 |
| --- | ---: | ---: | ---: |
| 100 rounds / 200 messages / 2000 x 256B appends; 16 KiB tool/assistant | 25.70 ms | 13.16 ms | 4.00 ms |
| Single reply, 1000 x 1 KiB appends + 16 KiB tool | 33.09 ms | 25.88 ms | 13.55 ms |

Append elapsed totals are 35.43→19.41s / Loro 5.08s for the many-message case,
and 23.89→16.94s / Loro 8.45s for the single reply. Append CPU is 17.03→12.97s
and 17.65→15.04s respectively. This reduces p95 by 49% / 22%; it does not achieve
the long-conversation goal of outperforming Loro. Many-message creation p95 is
109.45→105.04ms vs Loro 4.63ms; total paging is 0.621→0.541s vs 0.049s.
Combined SQLite bytes and whole-process RSS do not improve. No network-round-trip
speedup or Roost-exclusive memory claim follows from these local measurements.

Roost validates 15 core SQLite application-index cases, 56 Native cases,
37 SDK Native index cases, 38 process-host cases and 63 Chromium cases. Its full
serial Rust run passes 376 tests, 6 ignored, including 4 doctests. Default parallel
runs still intermittently fail existing HTTP-stub cases; the isolated failed case
and serial full run pass. That parallel flake is recorded, not silently fixed.
Lody's four owning suites pass 112 cases. Two final focused cases additionally
lose the real Native reply before SDK cache adoption and interleave a peer goal
edit after an applied atomic group. Runtime code did not change afterward.
Complete root check and final docs gate status are appended below when finished.

Raw synthetic artifacts/source hashes stay outside Git in the existing
`atomic-derived-indexes` research directory. The result includes all raw trials,
not just median claims. Remaining private decoded-row copying and serial local
index/event calls still cost work; this PR does not remove those checks or claim
that this transaction cut solves every remaining bottleneck.


### Final gates and fresh diagnostic

Full root `pnpm check` passes (type/lint/effect checks, all configured package tests
and boundary checks); root format passes. Latest strengthened Native-reply and
peer-goal cases pass after moving the fault below SDK acknowledgment. Final docs
check has zero errors and 71 existing warnings. No unrelated source is changed.
Roost companion CI's linux-arm64 job failed before compilation while downloading
pnpm 12.3.4 from npm (30-second registry timeout). The failure is infrastructure,
not a TypeScript diagnostic; retry was attempted, but GitHub returned HTTP 403 because the workflow containing
the ongoing Windows jobs is still running. No retry is queued yet. Native matrix CI is
not declared green. This release dependency remains a draft until matching
Native/SDK packages can be pinned and the hosted checks complete.

A new main-thread-only V8 profile after the atomic cut uses the same synthetic
1000 x 1 KiB reply, with interleaved consumer readChanges disabled. It is a local
Mac diagnostic, not the Linux comparison: 3.69s sampled interval, 1000 append
operations, full content/retry verification retained. By self samples (not
inclusive stack sums), roost-content-patches.ts is 13.72%, roost-node-session.ts
10.28%, GC 7.25%, Node js_transferable 3.51%, idle 26.30%. The largest named
application functions include stageRoostTextAppends and its diff walk. This
confirms growing-body staging/diff/copy work remains; it does not attribute the
whole remaining gap or the separate new-message/paging cost to those functions.
No additional optimization follows from this diagnostic in this PR.


Consumer draft: [Lody #1811](https://github.com/LodyAI/Lody/pull/1811).
Hosted Roost Rust checks and Native darwin-arm64/darwin-x64/linux-x64 jobs have
passed. The pending hosted platform gate and published package dependency are
explicit review limits; no production session or staging deployment was changed.
