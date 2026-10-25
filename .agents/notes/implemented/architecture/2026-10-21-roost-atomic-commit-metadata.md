# Roost local commit metadata

Status: implemented
Translation: current
PR: https://github.com/LodyAI/Lody/pull/1791
Companion: https://github.com/loro-dev/roost/pull/21

[中文](2026-10-21-roost-atomic-commit-metadata.zh.md)

## Abstract

Streaming notifications currently write native events and a separate renderer
receipt with repeated cursor and scope information. This change attaches the
renderer payload to the native transaction's last event, with one immutable scope
binding per stream. Agent idempotency digests retain their direct index and gain
transactional absence checks. Implementation and validation are complete: the
1024-notification fixture used about 21% less database growth, with change reads
about 39% faster and total write time about 1.1% higher. This does not establish
zero regression or Loro-sized storage; the draft still requires an unreleased Native API.

## Decision

Native owns atomic content/index/metadata persistence and the exact event interval.
Lody owns semantic changed IDs, structural positions, nonce and coverage validation.
The raw update log retains its TurnID/seq layout, avoiding per-update indirection
for synchronization. Unannotated events remain gaps, never proof of completeness. Native certifies an
attached interval only when its events equal the local refs plus emitted index
changes; draining pending remote work leaves it unannotated. Contiguous certified
intervals let the hot path avoid its former additional event scan.
Hot patch writes attach metadata atomically; complex SDK operations continue to
prove their whole interval or issue a reset. The Loro control document remains a
separate publication transaction, recovered through the existing durable history.

Renderer payload v3 stores version/flags, a full nonce and lossless changed IDs
plus optional structural position. Native stores before/through and the complete
scope. Old renderer index formats are refused, without migration or deletion.
Agent receipt v2 retains full identity and digest, including no-content operations.
No pruning, delay to accumulate writes, weaker durability, or history replay is
introduced. The existing [renderer receipt decision](../bug-fix/2026-10-21-roost-renderer-receipt-encoding.md)
provides the baseline and the retained checkpoint guarantees.

Effect feature/fix assessment: preserve the current Promise-based Native owner.
A lifecycle migration would cross unfinished Session dependencies and would not
help this storage contract. The codec remains pure TypeScript.

## Validation

The four real-Native owning suites passed all 106 tests. They cover lost-reply retry/reopen change reads, conflicting
digests, receipt-only CAS, batches crossing 128 native-event pages, unannotated
gaps, generations/nonces, corruption and unchanged refusal of old/mixed formats.
Rust passed 365 tests with 6 existing ignored; Native passed 53 tests. The packed
SQLite v8 reopen/encrypted-sync smoke passed. When a local write drains pending
remote work, Native withholds metadata and Lody must verify complete coverage or reset.

CLI typechecking, public-boundary checks, formatting and changed-scope type-aware
lint passed (84 lint warnings). Documentation checks found 0 errors and 71 existing
warnings. Root pnpm check is blocked in unchanged site-docs/fumadocs pretypecheck
by Class extends undefined; this is not a passing root check. Effect lifecycle
scope was not expanded.

Linux: 2 vCPU / 7.5 GiB, Node 24.22; baseline Lody e920a78 / Roost 60f6b16.
The fixture has two visible messages, 40 completed synthetic tools and 224/1024
individual text notifications, with a checkpoint read after each. All history is
retained. Each run uses a fresh process/database; discard a warmup pair, then
alternate four baseline/candidate pairs and take medians. Timing excludes the
separate Loro comparison workload. Database growth is page_count × page_size
minus the empty database, excluding the WAL file size.

| Metric | 224 baseline → candidate | 1024 baseline → candidate |
| --- | --- | --- |
| SQLite growth | 212 → 188 KiB (−11.3%) | 642 → 508 KiB (−20.9%) |
| Total write time | 4070.80 → 4079.98 ms | 19548.27 → 19768.99 ms (+1.1%) |
| Write p95 | 24.92 → 24.76 ms | 25.02 → 25.42 ms |
| Change-read p50 | 7.74 → 5.31 ms | 27.22 → 16.57 ms |
| Change-read p95 | 9.48 → 7.05 ms | 33.07 → 19.68 ms |
| Reopen/read | 92.43 → 86.23 ms | 94.23 → 87.27 ms |

The 1024 paired write-time differences range from −3.22% to +4.15%, and median
write CPU is about 1.9% higher; zero performance risk is not established. Mixed
harness RSS did not decrease and is not deployed CLI memory. A separate strace
of the 224 fixture measured 14325368 → 12516688 WAL bytes written (−12.6%) and
1369 → 1145 commit frames, including fixture setup/reopen/retry. Strace timings
are excluded. The parser was corrected for -xx filename escaping; its initial
incorrect zero counts are not evidence.

A separate same-content Loro 1.16.3 storage comparison retains all increments:
76 KiB at 224 and 200 KiB at 1024; Roost in those runs used 188/516 KiB. Every
visible checkpoint, reopen and replay-deduplication check passed, but Loro input
comes from Roost checkpoints rather than an independent business oracle, and
this reference does not implement all agent/renderer contracts. Roost's raw
update values at 1024 remain 138086 B versus 139240 B of Loro increments; this
change does not reduce wire size. The remaining disk ratio is about 2.5× Loro,
so the storage problem is not fully solved.

## Release boundary

Native commit-metadata-v1 requires fresh/SQLite v8, without legacy readers,
migration or automatic deletion. Released @loro-dev/roost-node@0.2.0 lacks this
API. Validation links candidate JS/types and macOS/Linux addons only inside
isolated checkouts; the shared pnpm store was not modified. The draft must not
merge until maintainers publish the coordinated Roost release, update exact
dependencies and the lockfile, and recheck against the published package. No
running CLI, staging deployment, npm package or existing test database was changed.

## Packed-storage validation follow-up (2026-10-22)

Roost's proposed SQLite v9 groups retained updates/events into compressed blocks.
The streaming regression previously equated SQL rows with operations and measured
encoded receipt bytes, so that assertion fails for the new physical layout even
when history is intact. The test now checks Native Turn sequence totals, exported
update bytes and decoded index entries, retaining the same 1 MiB history bound,
128 complete 82-byte receipts, unchanged-field content and reopen/retry checks.
Projection record-count bounds remain physical because that layout is unchanged.
The post-seal state regression now exports individual updates through Native as
well: a direct SQL query would return no packed updates and let its byte-stability
checks pass vacuously. Both tests check complete decoded batches and nonempty
history; the post-seal test keeps immutable prior bytes, no sealed-Turn writes,
and the original total/per-update growth limits. No assertion is relaxed to fit
compression.
This changes tests only, works with both the v8 candidate and v9 candidate, and
adds no runtime format reader, dependency update or migration. Package publication
and the exact dependency update required above remain separate release steps.

Companion implementation: [Roost #22](https://github.com/loro-dev/roost/pull/22).
The four suites pass all 106 cases with both candidate addons. CLI typechecking,
scoped lint and formatting pass; docs check has 0 errors / 71 existing warnings.
Root check with the candidate addon is blocked by the unchanged site-docs/fumadocs
pretypecheck error described above; it is not reported as passing.
[PR #1800 static CI](https://github.com/LodyAI/Lody/actions/runs/39695502246/job/119551749710)
confirms the separate release gate: the pinned published package lacks
`readCommitMetadata`, `annotateCommit`, `commitMetadataAfter`, `expectedIndexes`
and `commit-metadata-v1` used by the parent PR. Those source files are unchanged
here. Publish the coordinated Native package and update the parent's exact
dependency/lockfile before merging; candidate-linked tests do not make registry
CI green.

Long-conversation verification exposed an unsafe measurement pattern: a second
SQLite library must not open and close a live Native-owned file in the same
process, because it can release the owner's POSIX locks. The remaining physical
projection-count assertion now inspects the database in a separate Node process;
the Native client stays open and the original nonempty/count bounds are retained.
The manual benchmark uses the same separation. This is test tooling only, with no
runtime storage or history behavior change. Long-workload results and the discarded
initial SIGBUS run are recorded in Roost #22's owning note.
After this isolation change, the owning session-backend suite passes all 88 tests
with both v8 and v9 addons; root formatting passes. Root check remains blocked by
the existing site-docs pretypecheck failure above.

Correction (2026-10-22): the site-docs error above was caused by applying the
generic NAPI_RS_NATIVE_LIBRARY_PATH override to the full workspace, so Rolldown
loaded the Roost binding. It was not established as an independent baseline bug.
The [owner projection investigation](../../proposed/architecture/2026-10-22-roost-owner-incremental-projection.md)
records verification without that global override. The unpublished Native API
and coordinated release requirements remain unchanged.
