# Roost indexed position paging

Status: proposed
Translation: current
Date: 2026-10-24
Pull request: [LodyAI/Lody#1845](https://github.com/LodyAI/Lody/pull/1845)

[中文](2026-10-24-roost-position-paging.zh.md)

## Abstract

Lody's positional reader hydrates intervening history backward from the head;
the preceding 1,000-message benchmark took 885 ms to read the oldest 20 messages.
This local experiment adds a body-free position mapping to the existing certified
dispatch index and hydrates only the selected physical segments. In two fresh-process
trials per cell, the 10,000-prefix oldest-page median falls from 8,320 to 10.3 ms,
with range-read process RSS falling from 590 to 445 MiB. The owning behavioral
suites pass, and a same-checkout six-trial write crossover does not reproduce an
earlier CPU increase; this remains a local proposal, without merge or deployment.

## Scope and decision

This builds on the [Native publication boundary](2026-10-23-roost-native-publication-boundary.md)
and follows the [fixed validation workflow](../../../docs/roost-validation.md).
Only Lody's local derived index and reader are in scope. The Loro reference,
Roost body format, seals, wire protocol and durability settings stay fixed.
No production state is opened, migrated or removed. No deployment or publication
is authorized by this local experiment.

The existing dispatch rows already hold logical positions, business identities
and ordered physical-segment references. Add position-to-business-ID keys in the
same projection, maintained by the existing atomic puts/checkpoint boundary.
The new checkpoint version certifies that these keys exist; there is no old
checkpoint reader. Rebuild clears and restores the position table together with
the other projection tables before publishing its completion marker.

Ordinary text appends do not rewrite position mappings. New membership adds a
short mapping; branch replacement retains the existing generation lifecycle.
Measure SQLite page allocation and creation/finish cost rather than predicting
the index's byte or latency overhead from its payload size.

## Read and failure contracts

Use indexed ranges only with a complete checkpoint matching the authoritative
cursor and count. Batch position and row reads, validate identity/position, then
hydrate every ordered physical segment, respecting SDK request limits. Recheck
the marker, event cursor and history generation before returning or caching any
projected bodies. In particular, an index-only generation replacement need not
advance the event cursor. Use the existing bounded body cache, not the latest
window or an unbounded second history copy.

A missing or malformed projection is not a shorter history. Range reads retain
the existing bounded-page behavior; they never force a partial replica to fetch
all history or invoke dispatch's complete-index rebuild. Existing dispatch repair
remains its own writer-queue operation. A stale observation uses the existing
finite retry budget; storage and incomplete-data errors remain scoped to the
awaited read, without retiring the shared owner or changing write success.

The existing Effect projection lanes and ownership stay unchanged. A native
lifecycle migration would pull the surrounding Promise/SDK owner chain into this
read optimization and is deferred; no Effect dependency or migration-ledger fact
changes.

## Validation plan

Extend the owning real-Native suites for cold range reads without historical
page hydration, successor segments, stale generation/cursor/index observations,
missing/corrupt position rows, interrupted rebuilds, branch replacement and
partial/missing-index behavior. Use explicit injected races, never timing sleeps.

Run baseline and candidate in independent clones with the same built SDK/Native
and immutable Loro sources. Preserve the existing durable workload inputs and
measure fresh-process reopen/paging, append CPU and latency, creation/finish,
logical DB growth, WAL and RSS trajectories. Also compare positions across
100/1,000/10,000 prepared histories. Reuse fixed resource limits and record
failed stages; no performance assertions enter ordinary CI.

## Outcome and acceptance limits

The implementation is complete locally; the decision remains **proposed**.
Draft #1845 is stacked on the preceding Native-publication PR (#1839).
It has not been merged, deployed or used to clean up existing data. Only Lody
runtime behavior changes; the preceding shared-body/Native-publication stack is
required, but this unit adds no Roost SDK, Native, storage-body or wire changes.
Published npm 0.2.0 alone cannot validate that preceding stack.

The same-checkpoint position mapping avoids an O(history) body walk. It does not
replace bodies with lossy summaries, change seals or trust an unverified cache.
The existing reader remains the fallback when a complete index is unavailable.
No old body-format reader or migration was added. A position checkpoint older
than version 2 is uncertified; existing dispatch repair rebuilds derived indexes
without deleting authoritative history.

### Fixed-prefix reads

Median of **two** fresh processes per backend/prefix; oldest-page min–max is
shown explicitly. Each process opens the latest window before selecting the
oldest 20 entries, then middle and quarter positions. The latter two positions
may be warmed by the first read, so their raw `coldMs` field is only the first
call at that position, not an independent cold-history measurement. The
100-prefix baseline middle read, for example, is already cached (0.59 ms), while
the candidate's first middle read is 22.54 ms. Both paths cache subsequent reads.

| Prefix | Backend | Local open ms | Oldest first ms (min–max) | RSS after ranges MiB | RSS growth since open MiB |
| ---: | --- | ---: | ---: | ---: | ---: |
| 100 | Before | 99.03 | 72.28 (69.15–75.41) | 425.2 | +62.0 |
| 100 | After | 102.29 | 11.04 (9.89–12.19) | 411.2 | +48.2 |
| 100 | Loro | 30.07 | 1.37 (1.33–1.40) | 408.9 | +79.7 |
| 1,000 | Before | 108.88 | 843.36 (839.33–847.40) | 516.2 | +148.8 |
| 1,000 | After | 112.32 | 9.55 (9.21–9.88) | 415.0 | +48.7 |
| 1,000 | Loro | 248.76 | 3.23 (3.00–3.45) | 492.9 | +0.1 |
| 10,000 | Before | 175.57 | 8320.01 (8245.36–8394.66) | 590.2 | +171.3 |
| 10,000 | After | 182.99 | 10.27 (9.88–10.66) | 445.2 | +28.8 |
| 10,000 | Loro | 1629.05 | 16.62 (13.93–19.32) | 1929.8 | +22.9 |

RSS includes Vitest, JS, WASM, the Native Worker and allocator retention; it is
neither Native-exclusive memory nor renderer/production CLI RSS. Loro's
10,000-prefix value is **1,930 MiB (about 1.88 GiB)**. This selected-content
range stage does not perform a full dispatch/write/export, so it does not
supersede earlier full-workload RSS-limit failures.

Preparation is outside local-open/read timing. At 10,000 entries, the single
preparation samples are 63.5 s before, 66.5 s after and 4.9 s for Loro (including
55.1 / 57.9 / 4.8 s import respectively). The Roost seeds include explicit
complete derived-index preparation. These final-turn imports do not reproduce
a full streaming edit history or prove equal bulk-import costs.

### Durable writes and resources

The unchanged workloads use SQLite WAL/FULL and persist the control document
after each action. Rows below are two-trial medians. DB growth combines Native
history and Lody control databases relative to empty state, excluding WAL, shared
memory and identity files. RSS is sampled before full-content validation; its
growth is relative to the same process after open. Full raw samples retain user
and assistant creation, finish, resume, first-resumed append, WAL/SHM, sampled
peak RSS, fresh-process reopen, paging, whole-stage CPU and memory trajectories.

| Workload | Backend | DB growth KiB | Append CPU s | Whole-write CPU s | Append p95 ms | RSS MiB | RSS growth MiB |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Short exchange | Before | 164 | 0.288 | 0.673 | 1.706 | 388.6 | +60.3 |
| Short exchange | After | 164 | 0.223 | 0.533 | 1.158 | 387.6 | +60.5 |
| Short exchange | Loro | 128 | 0.108 | 0.185 | 0.573 | 353.0 | +50.2 |
| 1,000 turns / 10,000 appends | Before | 19960 | 19.192 | 84.819 | 3.205 | 539.2 | +218.8 |
| 1,000 turns / 10,000 appends | After | 20010 | 12.599 | 54.752 | 2.245 | 534.6 | +208.5 |
| 1,000 turns / 10,000 appends | Loro | 13720 | 9.097 | 11.502 | 0.930 | 583.2 | +279.8 |
| 1 MiB reply | Before | 1442 | 1.543 | 3.022 | 2.225 | 489.8 | +163.0 |
| 1 MiB reply | After | 1440 | 1.411 | 2.848 | 1.979 | 490.2 | +164.1 |
| 1 MiB reply | Loro | 1448 | 3.020 | 3.203 | 4.567 | 501.1 | +184.0 |
| Mixed tools / markup | Before | 2930 | 0.996 | 2.605 | 1.397 | 526.0 | +198.5 |
| Mixed tools / markup | After | 2922 | 1.333 | 3.341 | 2.437 | 526.4 | +199.0 |
| Mixed tools / markup | Loro | 1904 | 0.662 | 0.870 | 0.801 | 510.2 | +207.1 |

The history candidate's append CPU samples are 18.54 and 6.66 s, versus 18.80 and
19.59 s before. Reply samples also vary substantially. The medians are recorded
but cannot establish a causal append-speed benefit from a positional read change.
The history DB increase is about 50 KiB (0.25%); this is a read-path optimization,
not a body-size reduction.

### Isolating the mixed-write difference

The first independent-clone pair showed a slower candidate mixed write. Four
more write-only trials per variant retained all samples: six-trial append CPU
medians were 1.058 → 1.172 s (+10.8%) and p95 1.535 → 1.844 ms (+0.310 ms).
These results were not discarded or relabeled as noise.

A separate instrumented diagnostic found exactly the same work during all 1,000
appends: 1,000 Native `writeBatch`, 60 `indexRead`, 1,000 dispatch plans, zero
changed dispatch rows and zero row lookups. Index planning took 3.25 / 2.98 ms
total. This workload has only 20 logical turns inside the 40-turn window; new
indexed hydration is not reached. Diagnostic timings are excluded from the
performance tables.

To remove checkout/dependency-placement differences, a further six-trial
A–B–B–A crossover used the **same checkout and dependencies**, fresh DB/process
per sample, swapping only the two runtime files and restoring them in `finally`.
Both variants passed content/retry and SQLite checks. Append CPU was
0.955 → 0.946 s, p50 0.515 → 0.530 ms, p95 1.357 → 1.341 ms and cumulative
append wall time 684.7 → 708.5 ms. RSS was 528.3 (+201.5) → 526.1 (+198.7) MiB.
The earlier increase was not stable in this crossover; it is not evidence of a
confirmed structural write regression, nor proof of zero regression on every
machine. No write optimization or weakened durability was introduced to chase
these samples. Merge remains deferred.

### Correctness and reproducibility

The four owning real-Native suites pass **134 tests**. Added cases verify selected
bodies against a full reference after reopen, sealed/resumed state overlays,
foreign state changes during hydration, index-only generation switching without
an event-cursor advance, missing/wrong/uncertified position maps, partial missing
boundaries and interrupted rebuilds. Returned objects remain detached.

The generation-race test was also run with the final generation fence deliberately
removed: it returned the old branch and failed. The fence was restored byte for
byte. An added interrupted-build assertion initially treated an in-memory cached
checkpoint as an uncached read; the corrected test checks that a range rejects
the stale cached marker, then forgets it before verifying the incomplete marker.
No runtime semantics were changed to satisfy that mistaken assertion.

The main matrix completed **99 stages and 165 post-close SQLite checks**, with
no measurement-stage failures. Separate followups comprise eight independent-clone
mixed writes, twelve same-checkout mixed writes and two diagnostic writes. Before
measurement, two setup attempts failed on unbuilt ACP core/DSH imports; both are
preserved and their setup correction is recorded in the validation guide.
CLI typecheck, scoped type-aware lint and documentation checks pass. Submission
checks also pass: root `pnpm format` and the complete `pnpm check`, including CLI
4,559 passed / 4 skipped, components 5,962 passed and shared 1,610 passed, desktop
packaging/tests, i18n and all boundary guards. These checks use the same matching
locally built SDK/Native; the Native wrapper is staged in its actual split-package
layout using the already verified addon. Original dependency links are restored
after validation. This does not establish compatibility with the published npm
dependency graph; the preceding stack still needs a coordinated release.

Raw evidence, source snapshots/hashes, environments and per-stage logs remain in
`shared-body-validation/position-paging/`: `results.json`, `environment.json`,
`write-followup/`, `diagnostic/`, `same-checkout/` and `validation/`.
Runtime and Loro source hashes were checked before/after measured runs. Final
lint-only local-variable renames and test-assertion corrections are recorded
separately; they do not replace the immutable measured-source manifest.
No network, renderer, power-loss simulation, cold OS-cache guarantee or
production-host validation was performed.
