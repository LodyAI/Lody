# Selected history access in Roost and Loro

Status: proposed
Type: architecture
Translation: current

[中文](2026-10-31-roost-selective-history-reads.zh.md)

## Abstract

Permission, output and configuration queries were locating small fields through complete history arrays. Structural write fallbacks also copied unchanged bodies. The implementation separates metadata selection from body hydration, uses local Loro writes and reuses physical Roost Turns through SDK membership operations. This note records the affected paths, storage choices and memory measurements.

## Read scope

Fork snapshots, import/conflict planning, export, sharing, copying and CLI `history --all` consume the selected complete content. Ordinary queries locate records through metadata and hydrate their result set. Counts, absence checks and multiple-owner selection can visit all relevant fields.

Recovery replay visits source bodies individually. Its formatter keeps budget-sized A/B/C/D candidates, message totals and the ordered set of tool paths; the default prompt budget is 100,000 characters.

## Affected paths

The Loro column identifies the nine complete-body reads in scope. Its output, directory and latest-goal readers already used shallow selection.

| Item | Selection and update | Loro | Lody PR |
| --- | --- | --- | --- |
| 1 Input gate, prepared/preallocated input | Gate checks any matching user; idempotency compares the first matching stored record | Yes | #2132 |
| 2 CLI quota, active reply, config, MCP and limited history | Counts/state/config fields; visible-position selection and hydration for limited transcripts | Yes | #2132 |
| 3 Attribution, usage and goal precheck | Permission uses the newest nonblank user author; usage keeps its separate role-independent predicate; goal uses the latest-goal reader | Yes | #2132 |
| 4 Permission insertion, response and waiting | Select tool/request owners; insertion uses all matching tools, default response uses the first assistant owner, waiter uses the first matching tool | Yes | #2132 query, #2133 Loro write |
| 5 Turn output | User scalars, first later linked assistant and later system entries for a failed user | Already shallow | #2132 |
| 6 Directory, role and dispatch-index repair | Logical primary/late/state fields and member references | Already shallow | #2132 |
| 7 Unknown-projection goal lookup | Newest valid goal fields, including cleared/paused state | Already shallow | #2132 |
| 8 Schedule proposals and run lists | Input configuration, scheduleRun and last linked non-user reply state | Yes | #2132 |
| 9 History actions | Goal/tool/file owners, exact notice matching and insertion/removal positions | Yes | #2132 selectors, #2133 Loro write |
| 10 Worktree output and Agent batches | Target IDs, tool/task owners, transitive subagent ancestry and actual assistant tail | Yes | #2132 Roost, #2133 Loro |
| 11 Edit/resend and compensation | Latest user, provider boundary, configuration and goal; selected suffix and changed-range receipt | Yes | #2132 precheck/Roost, #2133 Loro write |
| 12 Copy target validation and diagnostics | Existing IDs, item-type totals, bounded abnormal-key sample and final-row statistics | Yes | #2132 |

## Query design

Shared metadata readers expose identity, state, attribution, schedule markers and allowlisted input configuration. Loro reads the stored containers directly, including legacy text fields. Roost combines primary, late, complete-state, delta-state and permission-response segments into the logical projection.

The Native owner queue binds selection and hydration to a generation/event observation. Dispatch-index repair reads field pages; original-Create fingerprint recovery scans immutable creation bytes inside Native one record at a time.

Owner RPC negotiates `sessionHistoryInspection` v2. Metadata, latest-goal, limited transcript and replay queries run in the owner command queue and return their publication with the result. Replay returns the budgeted prompt and statistics. ID lookups use the existing single-turn request.

General selection returns a digest of the queried fields, then validates those fields while hydrating the selected positions in one owner task. Ordinary text edits do not supersede an unchanged selection. Owners without v2 retain the pre-optimization single-`readAll` compatibility path; failures from an advertised v2 interface propagate without switching paths. Existing v1 requests remain accepted.

## Write design

Loro's `HistoryWriter.updateSelected` hydrates the selected positions and feeds the existing reducers. Changes to metadata-only placeholders are rejected during planning. Range compensation stores the changed before-images and checks complete shallow membership plus the operation's receipt. The pre-write ID set identifies which newly inserted rows may have automatic seen/read transitions.

Roost structural edits use an SDK membership manifest referencing existing physical segments. A reinserted business ID receives a fresh physical primary alias. Bounded private preparation produces a sealed root; final activation commits the root reference, branch revision and receipts atomically. Immediate compensation restores the old head; compensation after later appends uses another selected membership change.

Replay and diagnostics use the same query/owner ports. Worktree recording selects the already bound backend while a new fork's metadata is being published.

The related decisions are [dispatch scalar projection](2026-10-22-roost-dispatch-scalar-projection.md), [incremental mutations](2026-10-22-roost-end-to-end-incremental-mutations.md) and [GC goal queries](../../implemented/architecture/2026-10-30-application-memory-attribution.md).

## Memory measurements

Two sequential fresh-process pairs use synthetic 128 × 1 MiB history bodies plus a small current turn. Baseline Lody is `6f29141a6`; the measured candidate is `fd941274f`. Both use Roost source `ad6dab8`, Node 24.22.1 and an optimized Rust 1.98.1 Native build on macOS arm64. Native SHA-256: `b07cc8209ef4eff6ee7e6da91ae49e3d26bbc791f3c6475795060952aca278f0`.

Measurements cover the first request after setup, retained heap after GC, footprint and process peak RSS. Permission persistence/outcome and output IDs are checked in each sample.

| Metric | Permission before → after | Single-turn output before → after |
| --- | --- | --- |
| Additional retained JS heap | 125.77 → 0.51 MiB | 125.97–127.79 → 0.041 MiB |
| Additional footprint | 64.30–108.13 → 1.17–1.27 MiB | 35.93–56.91 → −0.91–0.13 MiB |
| Process peak RSS, including setup | 1552.30–1557.83 → 677.98–702.78 MiB | 986.59–1006.34 → 525.17–525.69 MiB |
| First request time | 15856–15990 → 22.45–22.92 ms | 7956–7961 → 10.30–10.50 ms |
| readActiveBranch / readAll / readHistory | 2 / 3 / 1 → 0 / 0 / 0 | 1 / 0 / 0 → 0 / 0 / 0 |

These are single-process synthetic measurements. Peak RSS includes setup and Native temporaries; footprint includes GC/page variation. Permission and output previously filled the same cache, so their savings overlap.

## Owner-query field reuse (2026-11-01)

The shared inspection entry previously prepared the complete field index before choosing the query. Certified goal summaries and ordered replay do not need those fields. They now use the same per-session owner queue and stable Native observation directly; a missing goal summary retains authoritative discovery. Replay and generic folds visit logical members in order and hydrate one entry at a time, preserving the formatter, budget, paths and statistics.

Transcript queries memoize item types, text-presence flags and image counts in a private index. Every touched record invalidates its memo, including text-only updates with otherwise identical metadata. The index token, cache epoch and exact event coverage distinguish current entries from writes made by older owners. Missing, malformed or unavailable cache entries use the existing field projection. Memoization stores no text and leaves the response shape unchanged.

Sparse membership planning already holds a certified field projection. Unchanged physical members retain those fields; replacement members use their complete prepared values and new physical aliases. Reuse requires a contiguous Native-exclusive write interval, the matching activation revision/head and observation scope, and a final generation/cursor check. The index is rewritten during the structural operation; subsequent reads use that projection. An interrupted or externally changed projection is rebuilt from authoritative fields. Initial field discovery remains necessary when no valid projection exists.

The SDK page decoder separately reuses the same Turn's already-read authoritative header instead of exporting its full Create again for immutable parents. Its body/header comparison, stable read and bounded sealed-body cache remain in place. This is a TypeScript SDK implementation change; the Native API and stored format do not change.

The baseline is Lody `29d74d496` with published SDK/Native 0.3.1. Measurements use Node 24.22.1 on an Apple M4 with 32 GiB RAM and real temporary SQLite databases. The main fixture has 8,192 synthetic records of approximately 1 KiB text plus a live assistant. Setup, complete-reference reads and connection time are excluded; SDK/OS caches are warm. An unready inspection marker exercises field discovery. Explicit signals submit output and permission writes at the query's first Native request, and every query and persisted write is compared with its complete reference. Timings are observations; this experiment does not measure application RSS.

| Operation | Before | Implementation |
| --- | --- | --- |
| Repeated last-50 transcript after output changes | 3.44 s | 0.31 s |
| Certified latest goal with an unready field index | 4.09 s | 2.06 ms |
| Replay with an unready field index | 8.49 s | 4.57 s |
| Metadata after removing a turn | 4.08 s | 0.25 s |
| Removal plus its following metadata query | About 5.6 s | 2.32 s |
| Replay with 127 × 1 MiB prefix and a small live tail | 7.81 s | 2.42 s with SDK header reuse |

The removal itself increases from approximately 1.5 s to 2.06 s: its 0.44 s index rewrite replaces the later field rediscovery. The combined operation becomes shorter. A genuinely unready metadata index still takes approximately 4–5 s to discover; first-use transcript visibility also requires computation. Output's queue delay follows the query duration. Permission writes have the same queue dependency and can themselves require a cold index. Replay is an Agent restore path; limited history can also run during active output.

Range paging classifies a changed total count as stale and uses the existing bounded retry. Edit/resend normalizes inherited input configuration before creating the replacement, and a changed selection returns `STALE_USER_TURN` after closing the prepared ACP session. The shared service applies these rules to Loro and Roost.

## Verification

The [Native contract suite](../../../../apps/cli/tests/roost-session-backend-contract.test.ts) exercises cold repair, selected reads, receipt recovery, branch changes, visibility invalidation, older writers and state overlays across sparse edits and forced field discovery. [RPC tests](../../../../apps/cli/src/session/roost-session-backend.test.ts) cover checkpoint/generation changes. [Writer tests](../../../../packages/shared/tests/history-writer.test.ts) and [Agent storage tests](../../../../apps/cli/tests/session-history-storage.test.ts) compare persisted results and range compensation. [Replay tests](../../../../apps/cli/src/lib/replay-prompt-builder.test.ts) compare exact prompts and statistics across budget boundaries.

Electron acceptance covers follow-up messages, Fork, goals, queue and unread state on both backends. Dependency validation uses published `@loro-dev/roost@0.3.1` and `@loro-dev/roost-node@0.3.1`.

## Dependencies

[Roost #29](https://github.com/loro-dev/roost/pull/29) supplies the SDK/Native APIs. [Foundation #2132](https://github.com/LodyAI/Lody/pull/2132) contains common queries and Roost integration; [Loro #2133](https://github.com/LodyAI/Lody/pull/2133) adds selected writes on that base. Lody consumes these APIs through SDK and Native 0.3.1, with all six exact-version platform packages in the lockfile.

[Edit/resend tests](../../../../apps/cli/src/session/session-edit-and-resend-service.test.ts) cover inherited configuration, concurrent selection refusal and prepared-session cleanup before the rewrite barrier is released.
