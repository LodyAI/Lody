# Roost control notification overhead

Status: proposed
Type: architecture
Translation: current
Owner: Codex
Updated: 2026-10-23

[中文](2026-10-23-roost-control-storage.zh.md)

## Abstract

The minimal candidate removes only an unread control-notification operationId;
Native receipts and operation identity remain. It preserves the original cursor,
revision/count/change representation, publication ordering, per-action durability
and recovery. Binary progress encoding, caches and Native layout experiments were
withdrawn. Resource/correctness measurements finished but did not establish the
no-speed-regression condition. The later [Native publication boundary](2026-10-23-roost-native-publication-boundary.md)
replaces this publisher and owns its own acceptance evidence.

## Cause, scope and rejected alternatives

A current control value of about 246 B retains 12,001 updates / 38,504 CRDT
operations over 1,000 messages. That is publication history, not another full
message body. Shared immutable body frames are already implemented. Dropping
control CRDT operations would break offline version-vector synchronization.

The notification operationId had no reader; initialization only carried it through.
Native receipts/digests still handle idempotency, identity conflicts and lost replies.
The candidate removes the unread copy and type/schema declarations while retaining
all subscription/barrier and owner/seq/recovery behavior. Plain Loro and generic
persistence stay fixed. Effect remains locked at 4.0.2; deleting a field adds no
lifecycle owner or migration dependency.

A primitive binary codec passed cross-peer, malformed-format, Unicode/lone-UTF16
and reopen checks, but saved only about 5% overall without a demonstrated speed
benefit. It and its renderer adapter were removed in favor of the minimal trial.
Native page/row/hot-index experiments were rejected; 31 Rust source hashes match
their pre-experiment state. Ordinary KV compression already exists. Roost's
`2026-10-23-storage-amplification` note owns that separate evidence.

## Fixed comparison and outcome

Use the [validation workflow](../../../docs/roost-validation.md). The external
`storage-amplification-id-only/` artifact contains exact sources/binaries, fixed
same-path packages, a coordinator lock and finally restoration. All workloads are
synthetic, use SQLite WAL/FULL and persist each action. All 103 Loro package files
and three harness hashes are checked per stage. Native binary is identical on
both sides (56b737…); no new codec, cache, compatibility reader or migration remains.

All 147 stages finish: four write/reopen/unique-paging loads, 100/1,000/10,000
prefixes, six trials per short/reply side and two per other cell, plus two fresh
original-Loro trials per workload. Completed digests and SQLite quick/FK checks
match. CLI owning 121, Native 38 and configured CLI/shared/components types pass;
changed-scope formatting and docs check pass (72 warnings, zero errors). Root
check/format was not run for this isolated historical candidate.

| Workload                      | Trials/side | DB growth KiB before→candidate | Loro KiB | Append CPU s | Append p95 ms |     RSS MiB | RSS growth MiB |
| ----------------------------- | ----------: | -----------------------------: | -------: | -----------: | ------------: | ----------: | -------------: |
| Short                         |           6 |                        240→216 |      128 |  0.312→0.317 |   1.374→1.579 | 389.6→386.4 |    +62.2→+59.3 |
| 1,000 messages/10,000 appends |           2 |                  24,200→23,314 |   13,720 | 12.273→7.808 |   2.364→1.042 | 545.0→543.8 |  +216.7→+215.8 |
| 1 MiB reply                   |           6 |                    1,804→1,716 |    1,448 |  0.897→0.957 |   0.990→1.085 | 473.4→473.6 |  +145.8→+146.0 |
| Mixed/resume                  |           2 |                    3,300→3,200 |    1,904 |  1.466→1.413 |   2.133→2.078 | 516.8→515.9 |  +189.8→+188.9 |

RSS includes the Vitest process, not an online CLI; growth is backend-open to
before full validation. DB growth excludes WAL/SHM. Append CPU includes action
persistence but excludes creation/seal/reads. Old retained CRDT history does not
shrink automatically. Small Native allocation differences can arise from new
signature/key bytes, not a proven layout change.

The history CPU decrease is not a reliable speedup: baseline trials span
8.833–15.713 s versus candidate 7.442–8.173 s while another Node workload used
about four cores. Six-trial reply CPU rises 6.7% and p95 about 0.095 ms; attribution
is unresolved. The 10,000-prefix results also regress: open 300.5→333.7 ms, first
selection 2.61→3.90 ms, warm append 1.30→2.59 ms, first append 76.2→87.1 ms and
pre-validation RSS 423.2→425.1 MiB. These differences were not accepted merely
because their absolute latency is small. This isolated candidate did not satisfy
performance acceptance and was not independently recommended for merge.

## Follow-up and retained evidence

A cursor cannot simply be removed: it was the published-read barrier and cross-owner
wake source. The subsequent Native-head design moves that complete responsibility
and all consumers together; it does not alter Loro or hide work behind delayed
persistence/polling. Cold Native projection packing remains unimplemented, with
seal-time costs unverified. No actual user data was cleared or migrated.

External report/resource/prefix/environment/status/postcondition artifacts and the
runtime patch retain all ranges, categories and memory trajectories. HTTP/Stream
offset was not measured. Reuse this evidence rather than repeat rejected physical
layouts or add independent KV compression that already exists.
