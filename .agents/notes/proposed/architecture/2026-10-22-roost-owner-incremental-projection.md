# Incremental projection for the Lody Roost owner

Status: proposed
Translation: current
PRs: https://github.com/LodyAI/Lody/pull/1804, https://github.com/LodyAI/Lody/pull/1806

[中文](2026-10-22-roost-owner-incremental-projection.zh.md)

## Abstract

Long-conversation measurements show that Lody's Roost integration still performs
whole-message work around small native edits. A local CPU diagnostic identifies
repeated JSON encoding/decoding, including conversions of unchanged window rows
and body conversion merely to build an identity index. The first implementation
removes redundant conversions while retaining authoritative reads, and its four
real-Native regression suites pass 107 cases with both v8 and v9 candidates.
A second implementation installs certified local text appends; the current cut
reuses unchanged sealed decoded bodies within one SDK handle. SDK pagination still
owns membership and cursors. These cuts do not yet establish the performance goal.

## Evidence and scope

The same-host Linux long-workload comparison is recorded in
[Roost #22](https://github.com/loro-dev/roost/pull/22). Its v8/v9 comparison uses
identical Lody runtime source and does not attribute the effect of every earlier
Lody optimization. Content cloning, post-commit full-message refresh, and window
reloads already exist in Lody commit cf1ee8dcbd / PR #1329. The patch-write path
added in a4de9a264 / PR #1626 retains that refresh. This establishes provenance of
these specific operations, not absence of every possible historical regression.

A fresh local Mac diagnostic uses the real Lody backend and v9 Native addon,
1000 individual 1 KiB low-repetition appends, a 16 KiB tool result, SQLite WAL/FULL,
and persistence after every action. Main-thread V8 sampling covers the write
stage; interleaved readChanges is disabled to separate consumer reads. Content and
receipt retry assertions are retained. It is a diagnostic, not a before/after
optimization benchmark or a Rust-worker profile.

In that diagnostic, 10.44 seconds of 21.17 seconds of sampled wall time are self
samples in Roost's JSON codec: 49.3% of all samples, 65.9% excluding idle/program.
Inclusive stack groups overlap and must not be summed. The original Native-only
microbenchmark omits Lody's receipts/control/projection work and cannot establish
complete-flow performance. Synthetic profiles and the temporary harness are kept
outside the repository under the existing packed-storage research artifacts.

A second diagnostic has 50 rounds / 100 messages, 200 appends and one 16 KiB
tool result per assistant. Codec self samples are 2.51 seconds of 11.71 seconds,
42.4% excluding idle/program. Both runs verify complete business content and
receipt retries, then verify the same full digest after reopening in a new
process. These identify avoidable work; they do not quantify its removable share
or compare a new implementation with Loro. Whole-message cloning is present but
must not be called the largest CPU cost based on these profiles.

Correction to the earlier validation attribution: exporting
NAPI_RS_NATIVE_LIBRARY_PATH for an entire workspace overrides other napi-rs
bindings too. Rolldown then reports Class extends undefined and Oxlint reports
lint is not a function because they loaded the Roost binary. The earlier
site-docs failure is not evidence of an independent repository defect. Full
workspace verification instead stages the binding only beside the isolated
candidate Native package and runs without the global override. No shared pnpm
store or checked-in dependency version is modified. Individual Native-only
test commands may use an explicit override with the matching candidate binary.

## Changes to assess

1. In rebuildSegmentIndexes, derive the key from businessId/segmentId directly.
   adaptRoostProjectedMessage currently converts and validates the body even
   though the resulting body is discarded. In refreshTurnProjections, retain
   unchanged row projections and convert only changed rows. Preserve the current
   native read, receipts, validation boundaries and publication ordering.
2. For an unsealed local edit, stage a private projection delta and install it
   only when Native's returned event interval and ownership evidence certify the
   exact successful transaction. Existing expectedEventCursor/expectedIndexes,
   commit metadata and generation fencing provide relevant primitives. A lost
   reply, foreign mutation, pending remote work, or uncertain generation must use
   authoritative reconstruction; receipt presence alone is not sufficient.
3. For a linear tail append, update the bounded window instead of rehydrating
   unchanged bodies. Branch state, logical count and pagination cursors remain
   SDK-owned; extend the Roost TypeScript helper if the existing mutation result
   cannot safely advance them. Do not duplicate its private branch format in Lody.
4. Remove whole-turn cloning/diffing from common streaming updates by producing
   deltas from the semantic reducer with structural sharing. Preserve fragmented
   thinking/plan markup, text normalization, tool updates and Unicode scalar
   offsets. Simply sending every raw notification as appendText changes behavior.

The first step is Lody-only. Later steps may need a Roost TypeScript API change;
current evidence does not require a Rust storage or wire-format rewrite. This
proposal adds no legacy-format reader, migration, receipt pruning, deferred
durability, or weaker signature/seal checks. Public lossless JSON validation
must not be disabled to improve a benchmark.

## Ownership and verification before implementation acceptance

The first implementation PR starts from packed-storage-contract and changes only
Lody's redundant projection work: build identity indexes without body conversion,
retain unchanged decoded rows, and reuse the already validated decoded primary
when calculating a patch against the exact installed physical row. Keep Native
authoritative refresh and all transaction/publication/recovery checks. Validate
caller isolation and interleaved same-session mutations with the real backend,
then compare the same durable synthetic workloads with the unchanged base.
Post-commit delta installation and SDK-owned incremental append remain a separate
scope until this step is measured; this first step does not claim constant-cost
streaming or completion of the long-conversation performance goal.

Trigger: a serialized owner mutation or an external observation. The current
owner retains raw Native requests until settlement. Caller cancellation does not
make an uncertain commit safe to repeat. Install only committed state, advance
the revision/checkpoint after its matching projection, and invalidate/rebuild
when ownership or coverage is uncertain. Recovery must preserve availability
and complete existing close/flush behavior. No lifecycle migration is proposed:
the remaining Session/Promise consumers prevent a small complete native Effect
unit, and migration is unrelated to removing repeated projection work.

Extend the real-backend suites for Unicode and split markup, mixed tools,
no-op/duplicate/conflicting notifications, lost replies, concurrent native writes,
pending remote work, seals/state corrections, branch changes, cursor boundaries,
reopen, and caller isolation from internal caches. Verify against the unchanged
semantic reducer, not a duplicated approximation of its output. The existing
[atomic metadata decision](../../implemented/architecture/2026-10-21-roost-atomic-commit-metadata.md)
continues to own persistence and release gates.

Performance acceptance requires paired before/after runs plus the same-content
durable Loro reference. Separately vary total history, current reply length and
window size; measure open-to-tail, append, new-message, paging, CPU and RSS. Keep
long runs outside ordinary CI. No orders-of-magnitude claim follows from this
profile. Only Lody's repeated projection conversion changes; Native storage,
dependency versions, deployment and stored databases are unchanged.

## First-step runtime results

The final implementation reuses rows by the exact physical message object and
captures the corresponding decoded window before asynchronous refresh. The
decoded-content shortcut also compares the complete business/segment identity.
Native still supplies the changed authoritative body after each commit; no
transaction, signature, receipt, publication or durability check is removed.
The added real-backend regression mutates an exposed copy, retries a Unicode
notification, interleaves a sealed-row correction through a peer, appends again,
and compares complete history after a new owner opens it.

Linux measurements use one unchanged v9 addon for both Lody variants, WAL/FULL
and a barrier per action. The many-message workload has 100 rounds / 200 messages
/ 2000 appends and 2,220,771 visible JSON bytes. The single-reply workload has
1000 x 1 KiB appends and 1,041,086 visible JSON bytes. Each assistant retains a
16 KiB tool result. Figures are medians of two before/two final-source after
runs; the Loro reference has one run. Completed original baselines are reused
after tightening snapshot matching, so final order is not fully alternating.
The superseded candidate revision is retained separately and excluded.

| Metric | Before | Reused projections | Same-content Loro |
| --- | ---: | ---: | ---: |
| Many-message append p95 | 37.31 ms | 30.01 ms | 3.86 ms |
| Many-message total append time | 61.10 s | 48.97 s | 5.07 s |
| Many-message append CPU | 43.70 s | 29.86 s | 2.39 s |
| Many-message new-message p95 | 341.61 ms | 332.65 ms | 4.56 ms |
| Single-reply append p95 | 131.45 ms | 110.30 ms | 12.30 ms |
| Single-reply total append time | 75.67 s | 64.69 s | 7.80 s |
| Single-reply append CPU | 68.43 s | 57.16 s | 6.73 s |

Append p95 improves by about 19.6% / 16.1%, and append CPU by about 31.7% / 16.5%.
This is useful but does not reach the original performance goal. New-message
cost remains dominated by the unchanged reload path; the full growing reply is
still read and processed. There is no demonstrated storage reduction: those
paths and formats are unchanged, and small database-size differences include
random identities/compression. Sampled whole-worker RSS is not Roost-exclusive
memory and is not used as an independent memory-improvement claim.

All ten write/reopen/paging cases pass, canonical message-content digests match
across backends, each reopened full-history digest matches its write result, and
202 replay checks per Roost variant preserve content. Eighteen benchmark SQLite
databases pass quick_check; both Roost variants use container 9. The research
source is restored and the temporary benchmark is removed from ordinary suites.
Raw samples, final source hashes and the restoration record remain under the
owner-projection-optimization research artifact directory.

The first read samples have variable paging tails. Three additional alternating
read pairs pass all 12 process checks, but their per-run page-p95 median is
86.07 -> 94.35 ms and does not justify a no-regression claim. Eight crossover
reads then run each source against each same database: on the baseline database,
median total paging is 764.63 -> 763.29 ms; on the candidate database it is
802.79 -> 860.02 ms. Individual paired differences reverse direction and ranges
overlap substantially. This does not identify a consistent source-code slowdown,
and the small noisy sample does not prove every read path is regression-free.
The source and temporary test are restored/removed after both investigations.

Final validation: both candidate layouts pass the four owning suites (107 cases),
CLI typecheck and scoped type-aware lint pass (72 existing warnings), root format
passes, and docs check has 0 errors / 71 existing warnings. Full pnpm check passes
without the generic Native override, using the correctly assembled isolated
candidate package and split host binding. Its six packaging tests pass as well.
Initial setup attempts using an incompatible addon, a workspace-wide override,
or an incomplete private package are not passing verification. The parent still
requires a coordinated published Native release; candidate-linked local checks
do not establish registry CI success.

## Certified local append implementation plan

Phase timings on the first-step source isolate post-commit refresh as 7.01 s of
9.73 s for 500 x 1 KiB appends; the actual atomic Native commits total 0.43 s.
These local diagnostic timings include nested phases and must not be added.
The next implementation stages only text-appending patches against the exact
installed unsealed primary snapshot. It clones private SDK and application
content, applies the already planned append paths, and uses the usual logical
projection and permission overlay. It installs those snapshots only after a
successful Native commit certifies its event interval and the installed window
has not changed. Seals, state records, other operations, uncertain replies,
uncertified intervals and changed windows keep authoritative refresh. No new
interpreter for general Roost edits, storage format or lifecycle is introduced.
Verification must cover the real durable boundary, caller isolation, stale
snapshots, foreign/pending events, retries and full reopened equality before
making a performance claim. New-message window hydration remains a distinct
measured problem.


## Certified append measurements

Two before/two after Linux runs compare this cut with PR #1804 using the same
v9 addon and SDK. Runs alternate baseline, candidate, candidate, baseline; Loro
is a separate same-content reference. Both workloads retain the 16 KiB tool
output and use SQLite WAL/FULL plus persistence per action. Median single-reply
append p95 is 105.77 -> 37.64 ms (Loro 15.30 ms), total append time 63.41 ->
29.18 s, CPU 56.22 -> 21.23 s. Many-message append p95 is 32.45 -> 26.20 ms
(Loro 4.00 ms), total 50.34 -> 42.80 s, CPU 30.83 -> 24.49 s. The reduction
helps growing replies but does not meet the performance goal or fix the window
reload: new-message p95 remains 346.22 -> 339.16 ms (Loro 4.79 ms). Do not infer
a gain from the two-sample initial-message metric for the single-reply case.

All 30 write/reopen/paging stages pass, full reopened digests match, canonical
business-content digests match Loro, receipt replays preserve exact content, and
18 closed SQLite databases pass quick_check. The research sources are restored
and the temporary harness removed. Small disk differences are not storage gains;
worker RSS varies and is not attributed to this cut. Only named-import formatting differs from the measured source; the patch helper
is byte-identical. Raw measurements, hashes and checks
are in the committed-projections research artifacts. Full pnpm check, root format,
CLI typecheck and docs check (0 errors / 71 warnings) pass. The four owning Native
suites include the two new certificate/body-read failure regressions (109 cases).

A separate current-source diagnostic traces 100 small text appends. Per append it
observes 39 indexRead calls, 13 eventsAfter calls, about four index scans and five
write transactions: content+receipt, binding cursor, two publication-progress
commits and goal projection. This diagnostic is not an isolated Linux before/after
result, and overlapping request timings must not be added to wall time. It exposes
SDK catch-up and derived-progress overhead as the next target; this PR does not
skip those correctness paths or claim the growing-body refresh was the only cost.


## Sealed decoded window reuse

The consumer reuses private decoded primary/segment bodies only within the same
SDK handle and after matching business/segment identity, physical Turn ID, nextSeq,
seal hash and every parent edge. The SDK still supplies branch state, logical
count, completeness and cursors; Lody does not synthesize a tail append. Changed
seals, unsealed rows and new generations decode normally. State and permission
lookups are invalidated/reapplied as before, so caching an immutable primary
cannot suppress a later state correction. Decode each new window once for its
logical projection, comparisons and installed private rows. The SDK's separately
bounded sealed body reuse is [Roost #23](https://github.com/loro-dev/roost/pull/23).
The next SDK cut reduces duplicate catch-up work, separately from body reuse.

The original SDK and candidate SDK both pass CLI typecheck and the four owning
real-Native suites (109 cases before the final SDK-handle equality guard; final
verification is pending). No Effect lifecycle migration, new dependency version,
wire/storage layout or compatibility reader is introduced. Performance comparison
will separate the already measured certified-append cut from this combined SDK
and consumer change; no cache benefit is claimed before that measurement.


### Sealing an installed primary

The existing single-primary refresh rejected a successfully read sealed result
and reloaded the whole latest window. This is unnecessary when the identity is
already installed and no branch mutation is being handled: sealing changes its
sequence/hash, not branch membership. Retain the same generation/window fence
and install the SDK's authoritative single-row result, including its sealed hash.
The enclosing publication still verifies every event and reloads on foreign or
uncertain work. Membership changes and missing/outside-window rows keep full
SDK-owned paging. Tests seal while window rereads are unavailable, append a child
using the signed parent, reopen exactly, and interleave a peer branch append during
the seal. Both focused cases pass; final combined verification is pending.


### Final sealed-reuse validation and Linux attribution

Root `pnpm format` and full `pnpm check` pass after the seal guard change and its
behavioral tests. The CLI suite reports 330 files passed / one skipped, including
111 cases across the four owning Roost suites; docs check has zero errors and
71 existing warnings. Final measured seal-source SHA-256 exactly matches this
PR's runtime source. No Native/SDK package version is published or deployed.

Same-content durable Linux runs (WAL/FULL, per-action acknowledgment, two Roost
trials per configuration, 100 rounds / 200 messages / 2000 appends of 256 bytes,
16 KiB synthetic tool result per assistant) isolate the combined cuts:

| Configuration | Append p95 ms | New message p95 ms | Append CPU seconds |
| --- | ---: | ---: | ---: |
| #1804 / original SDK | 29.87 | 347.95 | 30.78 |
| Certified text + decoded reuse + SDK body cache only | 26.88 | 148.27 | 25.56 |
| Above + SDK settled/progress shortcut | 21.98 | 137.21 | 17.25 |
| Above + final single-primary seal refresh | 23.43 | 115.89 | 17.09 |
| Durable same-content Loro reference (one trial) | 4.85 | 6.03 | 2.43 |

The seal cut improves the measured message boundary, not steady append p95; the
latter varies between trials. Do not attribute all combined gains to this Lody
PR. The main matrix's single 1000 x 1 KiB reply improves append p95 from 112.41 to
33.97 ms, vs Loro 14.86 ms; the final seal ablation only reruns the many-message
case. Full business-content digests match Loro, reopen digests match writes, and
all 26 post-close SQLite quick checks across main/ablation pass. Main candidate
many-message reopen/paging remain worse than Loro (0.970s tail / 0.684s paging vs
0.467s / 0.041s); the long-conversation objective is not complete. Artifacts and
synthetic harness stay outside Git in `tail-and-catchup-20261022` research output.

The newly approved next cut is a separate Native conditional derived-index API
and consumer PR. It must reduce the remaining four transactions without weakening
durability, pending-event processing or publication dependencies.
