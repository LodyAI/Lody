# Application memory: Loro and Roost goal queries

Status: implemented
Type: architecture
Translation: current
PR: [#2118](https://github.com/LodyAI/Lody/pull/2118)

[中文](2026-10-30-application-memory-attribution.zh.md)

## Abstract

GC's goal protection needs only the latest valid goal, but previously read and
copied complete history. Loro now inspects goal fields synchronously; Native Roost
uses its existing goal projection or reverse pages without caching scanned bodies.
Goal decisions, legacy metadata fallback and user operations remain the same.
On 128 MiB synthetic Roost history, the former query retained another 128 MiB of JS
heap; neither the new projection query nor its fallback retains a complete copy.
The corresponding Loro experiment also eliminates about 119 MiB of query-induced
footprint growth by avoiding whole-history conversion.

## Decision and scope

`MessageHandler.hasActiveGoal` uses the local backend's `readLatestGoal`. The
existing Loro adapter searches synchronously and converts only the complete match
into an independent object. Native Roost reads the current goal projection or
logical history pages. RPC/non-owner services lack the local capability and retain
the previous full read without a new remote protocol operation.

Existing GC checks for active turns, native work, pending input/updates and archive
state, the recheck before cleanup, and Session retention on read failure stay in
place. Goal controls and update/clear commands, collection timeouts and Agent
process retention keep their current implementation. Explicit export, replay,
hashing and fork retain complete independent snapshots; foreground display and
read caching stay unchanged. The change uses existing SDK read boundaries without
introducing a lifecycle owner or an Effect migration unit.

## Why the decision is equivalent

The current resolver visits messages newest first and each message's items from last
to first, selecting the first `type === 'goal'` with string `threadId`, `objective`
and `status`. The new read performs the same search without filtering by role or
timestamp or strengthening old-data validation. Empty strings, Loro Text, old JSON
and complete goal extension fields retain their semantics.

Stop at a non-active goal too; only proven absence across current history enables
legacy metadata fallback. Activity remains `status === 'active'`. A newer paused,
complete or cleared goal therefore overrides an older active one, and intervening
ordinary messages do not expire an old goal. Fixed first/last-N truncation has
actual counterexamples; searching from the newest end until a match agrees with
the existing resolver.

## Roost projection and fallback

Reuse the goal projection introduced in #1329, preserving known-goal, proven-absent
and unknown states. Reuse the existing in-memory projection only while the owner is idle and its
known cursor matches a fresh Native event cursor. Otherwise read a persisted
projection matching that cursor, avoiding a writer's staged goal.
Validate host, generation and cursor across the observation; count or branch
revision alone does not establish that content was not edited in place.

When unknown, SDK paging starts at the latest active-branch page, using 40 rows and
the existing logical projection for state overlays, segments and sealed records.
Validate contiguous coverage, stop at the first valid goal and return `null` only
at the beginning without a match. Content or generation changes between pages use
existing stale-read retries. Failure to establish a coherent result follows the
existing GC read-failure path.

The scan does not occupy the write serialization queue for its duration, populate
`fullEntriesCache`, `pageEntries` or state/permission body caches, or write the derived
goal index. After version validation, an unchanged idle owner at its known cursor
installs the result in the existing in-memory goal projection for subsequent
queries. Existing persistence maintenance and normal UI/edit cache defaults remain
in place. Detach only the returned goal and
release private pages after use. This follows measured evidence: simply looping
existing `readRange(40)` retained about 88 MiB of old bodies. Paging alone was
insufficient. The first no-goal or old-goal fallback still traverses history; working memory
follows page and individual-record sizes.

There is no additional goal cache. An earlier strictly read-only sketch repeated
the missing-index scan in about 5.69 seconds, while the legacy full-body cache
served its second check in about 57–65 ms. Installing the proven result in the
existing goal projection removes that measured repeated-read cost without retaining
bodies or writing the derived index.

## Behavioral verification owners

- [Loro data boundaries](../../../../packages/shared/tests/session-data-review-boundaries.test.ts)
  compare JSON, nested-container and Loro Text shapes with the full-read resolver,
  covering old/new/multiple goals, non-active states, malformed items, extension
  fields and logical order. Guards prohibit ordinary-body conversion and check
  document and returned-value isolation.
- [Local backend/GC integration](../../../../apps/cli/tests/session-history-targeted-write.test.ts)
  exercises real SessionDocument, Loro adapter and MessageHandler boundaries:
  old active goals and in-place clearing work with full reads prohibited.
- [Native backend contracts](../../../../apps/cli/tests/roost-session-backend-contract.test.ts)
  cover persisted projections, unknown fallback, state overlays, goal update/clear/
  deletion, copying and reopening, plus in-place edits between pages and generation
  activation without an event-cursor change. They verify old bodies still require
  on-demand reads after inspection, no projection publication, metadata fallback,
  returned-value isolation and failure propagation.
- [GC manager behavior](../../../../apps/cli/src/lib/session-gc-manager.test.ts)
  retains activity protection, rechecks and failure retention.
  [Goal rules](../../../../packages/shared/tests/goal.test.ts) and
  [goal commands](../../../../packages/shared/tests/session-history-actions.test.ts)
  define existing visible states and update semantics.

## Application-level GC verification

Application acceptance runs the real OSS Electron, preload, renderer, IPC and
bundled CLI, using only an external synthetic ACP Agent to publish goals. Loro
uses the ordinary default; Roost uses saved developer-mode/Roost preferences, with
the actual backend checked in the sidebar information card. The Agent publishes
an active goal and completes its prompt normally, then finishes 22 ordinary turns,
leaving the goal outside the latest 40 messages.

Only isolated processes use a 1000 ms idle timeout and 250 ms sweep interval.
Observation starts after goal publication: create a newer no-goal control Session,
wait for the real daemon's cleanup record and that Agent's exit, and verify the
original goal Agent, ACP Session identity and visible goal remain. Clear directly
through the UI, wait for the original Agent to be collected, and verify the cleared
banner and editable composer remain. Assertions follow completion, collection and
exit signals instead of a fixed wait to infer protection.

The [desktop goal-control journey](../../../../e2e/src/features/session-goal.feature)
separately covers pause, update, resume, reopening, archive, restore and deletion.
Application-process acceptance and the storage/GC contracts provide evidence for
visible behavior and decision semantics respectively. Product GC defaults remain
unchanged.

## Implementation comparison

Source is main `d197e459b9377f7911ec1cf6b21006d8f22fd7c3` plus this change. A temporary diagnostic
entry uses the production CLI Vite configuration and real SessionDocument/backend
under Electron 44.9.3 / Node 24.22.0. Each variant uses a fresh process, identical
synthetic contents and the same native dependencies. The legacy variant hides the
new local capability in the same build so MessageHandler follows its existing
full-read branch; the new variant executes the implementation. It constructs no
complete MessageHandler or GC timer and changes no feature, timeout or process
policy.

Roost uses independent copies of identical persisted databases. The missing-index
variant corrupts the derived goal index before opening; the query does not write
that index. Ordinary latest-window loading can recover a recent goal projection;
old-goal and no-goal cases actually enter fallback. Loro constructs identical loaded CRDT history in-process; its preparation
time includes construction rather than disk opening. Preparation/opening is recorded
separately; the table isolates query increments. Each variant makes two queries
with explicit GC at every checkpoint, with another fresh-process repetition for
128 MiB no-goal cases. Controls with 4 × 1 MiB and 128 × 32 KiB distinguish count
from body bytes. [Numeric evidence](assets/2026-10-30-application-memory-attribution.json)
retains all paired observations.

First-query ranges across two fresh processes, 128 rows of 1 MiB bodies, no goal:

| Path                         | JS heap growth at return | Post-GC JS heap growth | Post-GC footprint growth |     Query duration |
| ---------------------------- | -----------------------: | ---------------------: | -----------------------: | -----------------: |
| Roost legacy full read       |        640.52–640.54 MiB |      128.12–128.13 MiB |        136.89–167.16 MiB | 7776.00–7827.43 ms |
| Roost valid projection       |            0.11–0.12 MiB |            about 0 MiB |              about 0 MiB |       0.45–0.60 ms |
| Roost missing-index fallback |        167.65–248.83 MiB |          0.11–0.13 MiB |          17.09–34.02 MiB | 5454.33–5465.97 ms |
| Loro legacy full read        |                 0.46 MiB |            about 0 MiB |        119.03–119.06 MiB |     20.43–20.56 ms |
| Loro shallow query           |                 0.17 MiB |            about 0 MiB |              about 0 MiB |       0.78–0.80 ms |

Old- and recent-goal fixtures return the same active result. Without a usable Roost
projection, an old goal requires reaching the final page; a recent goal is already
projected by ordinary latest-window loading. Old-goal/no-goal fallback reads four
pages once, then reuses the in-memory goal projection with no more body reads.
Repeated queries do not accumulate complete body copies. The second missing-index no-goal query reads zero pages in 0.28–0.33 ms, compared with 54–55 ms through the legacy full-body cache.

Loro's principal change is process footprint rather than retained JS heap; the
loaded CRDT remains present in both variants. Roost fallback still allocates for
page decoding and leaves allocator retention. Return snapshots are not sampled
peaks, and footprint is not live JS object size. These figures quantify this goal
inspection path; earlier whole-desktop attribution follows below.

## Decision continuity

The [incremental projection investigation](../../proposed/architecture/2026-10-22-roost-owner-incremental-projection.md),
[certified goal/cursor work](../../proposed/architecture/2026-10-23-roost-append-cpu-structure.md)
and [dispatch scalar projection](../../proposed/architecture/2026-10-22-roost-dispatch-scalar-projection.md)
retain their decisions; this adds GC query integration.
The [native-work GC decision](../bug-fix/2026-10-18-gc-respects-native-agent-work.md)
continues to define activity protection. The renderer/style candidate stays
rejected; existing whole-history APIs and write algorithms remain in place.

## Measurement boundary

Source is main `dc44d50a05f8c22842dd5e8ec65703036498b4da`, excluding
[#2099](https://github.com/LodyAI/Lody/pull/2099),
[#2100](https://github.com/LodyAI/Lody/pull/2100) and
[#2104](https://github.com/LodyAI/Lody/pull/2104). Their combined effect remains
unmeasured. [Numeric evidence](assets/2026-10-30-application-memory-attribution.json)
contains only synthetic-fixture parameters and memory/process counts.

macOS 27.2 arm64 runs Electron 44.9.3 / Node 24.22.0. The desktop uses real
main/preload/renderer/IPC, daemon and MCP processes in a disposable profile.
A custom-command Provider launches the production Codex ACP bundle and the
checksum-verified, pinned Codex 0.164.0 runtime. Only the model Responses API
and external provider wire use synthetic loopback services. No user credentials
or data are used. Replies are short, followed by navigation to Home. Tracing and
allocation sampling are disabled; main/renderer GC precedes native measurements.

`footprint -j` group totals below are MiB. RSS sums count shared mappings and
are reported separately. Independently sampled groups can differ slightly from
their sum. OS compression and allocator high-water behavior make a process-tree
delta insufficient on its own to identify a live-object leak.

| Completed Sessions, then Home | Whole desktop footprint | Codex Agent group footprint | Whole desktop RSS sum |
| ----------------------------- | ----------------------: | --------------------------: | --------------------: |
| 0                             |                  1098.8 |                           0 |                1413.7 |
| 1                             |                  1206.1 |                        87.1 |                1821.4 |
| 3                             |                  1276.1 |                       259.6 |                2103.8 |
| 5                             |                  1398.6 |                       414.8 |                2562.6 |
| 10                            |                  1749.1 |                       778.7 |                3583.9 |

## Per-Session process retention

`Session.createAgent` installs a Session-owned AgentClient. The Codex ACP entry
starts its native app-server. `releaseVisibleTurn` deliberately retains the
Agent process after completion. `SessionGCManager` defaults to twenty minutes
idle with a one-minute sweep; active turns, native work, goals and pending work
can protect it further. The experiment confirms ten ACP adapters and ten native
processes still present after ten completed Sessions. All controlled processes
exit when the isolated application closes.

Standalone production-adapter probes corroborate the fixed cost after adapter
GC: ten independent pairs use 792.2 MiB group footprint / 2216.2 MiB summed RSS.
One pair handling ten logical ACP Sessions uses 101.9 MiB footprint in a separate
protocol diagnostic. That comparison is not an established compatible saving:
production account/environment isolation, per-Session MCP context, cancellation,
close, supervisor recovery and crash fanout have not been proved equivalent.
Earlier teardown would also change reuse and potentially background work.
The [native-work GC decision](../../implemented/bug-fix/2026-10-18-gc-respects-native-agent-work.md)
continues to own those protections; the withdrawn residency implementation is
not current authority.

## Baseline whole-history goal inspection

Before this change, `MessageHandler.hasActiveGoal` returned a boolean but unconditionally called
`backend.readHistory()`. The unchanged Roost `history.readAll()` calls `readCompleteEntries`,
which projects the entire branch, clones a complete copy into `fullEntriesCache`,
and returns another cloned copy. `readAll()` clones again. The full cache remains
until its owner generation is invalidated or released. Repeating an inspection
at the same generation plateaus rather than adding another permanent full copy.

The diagnostic invokes the real method against a real persisted Roost backend,
providing its document/backend ports directly. It does not construct the complete
MessageHandler or wait for the GC timer. A temporary entry is built alongside the
existing runtime entries with the production CLI Vite configuration, then runs
under Electron-as-Node with the staged native dependencies. The fixture has 128
turns of 1 MiB low-repetition ASCII text and no goal. Each fresh-process run reads
the history count, collects GC, calls the goal predicate, records ambient memory
at return, then collects GC again. These are owner-process measurements, not a
second whole-desktop measurement or a measured optimization result.

| 128 MiB history                            |             Round A |             Round B |
| ------------------------------------------ | ------------------: | ------------------: |
| Opened, post-GC JS heap                    |          161.43 MiB |          161.44 MiB |
| First goal check returns, before forced GC |          802.03 MiB |          802.02 MiB |
| Same point, process RSS                    |         1056.23 MiB |         1062.80 MiB |
| After forced GC, JS heap                   |          289.58 MiB |          289.59 MiB |
| Post-GC footprint before → after           | 307.39 → 467.72 MiB | 308.31 → 474.58 MiB |

The roughly 641 MiB heap rise includes collectible allocations; the roughly
128 MiB increase after GC is retained. The pre-GC snapshot is not a sampled
peak. The input is intentionally large synthetic history, so this establishes
size-dependent amplification, not that ordinary Sessions contain 128 MiB or that
all observed application memory comes from this predicate. Existing paging does
not bound this explicit full-history read.

A 4 MiB history control under the same bundled entry raises heap by 41.28 MiB
at inspection and retains only 4.06 MiB after GC, further distinguishing
history-size-dependent work from fixed diagnostic overhead.

An additional single-run calibration replaces the query's full read with existing
40-row `readRange` calls against that same 128 MiB no-goal fixture. It still visits
all 128 rows in four pages: heap at return is 622.94 MiB and post-GC heap is
249.73 MiB versus 161.43 MiB before the query, retaining another 88.29 MiB.
The existing range path caches the older 88 rows outside the installed 40-row
window. This is a diagnostic of current paging retention, not an implemented
goal-query optimization or a tested concurrent-read algorithm. Its temporary
wrapper uses the known no-goal fixture and does not establish early-stop behavior
on arbitrary history. Separate semantic comparisons cover nine goal/fallback
cases using the current resolver; a reverse scan agrees with full reads while
fixed first/last-40 truncation has counterexamples. The implemented query and comparison are documented above; these earlier paging
observations retain their diagnostic scope.

The [renderer/style candidate](../../rejected/architecture/2026-10-30-renderer-code-memory.md)
is withdrawn; its prototype/build are removed. No retention timeout, feature,
rendering behavior, history content or process isolation has been changed.
