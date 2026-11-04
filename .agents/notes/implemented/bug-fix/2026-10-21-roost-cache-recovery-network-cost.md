# Bound Roost cache recovery to changed bodies and requested windows

Status: implemented
Type: bug-fix
PR: https://github.com/LodyAI/Lody/pull/1765
Translation: current
Date: 2026-10-21

[中文](2026-10-21-roost-cache-recovery-network-cost.zh.md)

## Abstract

The checkpoint/body binding fix routed an unbound cache through a serial, whole-history snapshot rebuild. Recovering 2,000 cached turns over an emulated 250 ms RTT / 2 Mbps link took 41.00 seconds and 50 requests; late capabilities could trigger it during a quiet reopen. The cache now preserves change coverage independently from patch eligibility, repairs affected bodies through complete change replies, and resumes patches only after the atomic repair. Missing or foreign coverage replaces only the latest coherent window, with older pages fetched on demand. The same unbound-cache workload now takes 2.21 seconds and one request while preserving all 2,000 cached turns; a genuine reset invalidates older cached pages, which must be fetched again before offline use.

## Decision and correctness boundaries

- `checkpoint` certifies every retained body for relative patches. `recoveryCheckpoint` retains verified change coverage after a consecutive unprotected write; it permits complete replies only. Such repair uses `readChanges` immediately, never an idle watch, and atomically replaces bodies and the bound checkpoint. The two cursor fields participate in compare-and-swap.
- A same-revision legacy page leaves a verified base untouched. A partial protected page at another checkpoint cannot certify an untouched prefix, even when its revision appears consecutive. Preserve the old baseline and validate the complete interval with the owner, which can reject a foreign generation.
- A reset or absent coverage reads one latest window and atomically publishes its bodies, membership and checkpoint. The previous projection survives a failed or superseded transaction. A late replacement cannot overwrite a head another tab advanced. The normal refresh no longer sweeps older pages or restarts such a sweep under continuous writes.
- Invalidated old rows are removed from the active cache. A cached cursor names an absolute edge: capable owners serve the requested range directly at the bound checkpoint instead of walking there from the tail. Legacy owners retain their explicit cursor path. Search, facts and export still fetch the data those operations actually require; an unread prefix does not become a complete history.
- Ordinary complete-change repair preserves the existing cached prefix. Genuine reset changes offline availability: invalidated old pages require another owner read. Authoritative Roost history and locally accepted input are unaffected. This is the explicit cache-policy trade-off recorded in the draft [history contract](../../../../specs/session-history-writes.md), not a database migration.
- The v2 cache namespace continues to isolate unsafe v1 writers. No new namespace, native package release, wire capability or patch journal is added. V1 retention remains a separate browser-space cost.

This follows the [binding protection](2026-10-21-roost-cache-checkpoint-body-binding.md) and replaces its full-cache recovery choice. Keeping that protection is mandatory; directly applying relative operations to an unbound body would reintroduce duplicate text.

## Measurement

Controlled local measurements use Apple M4 / macOS arm64, Node 24.14.0 and Chromium 145.0.7632.6. The owner is production MessageHandler and Native Roost 0.2.0 with temporary SQLite; the browser runs the production bridge/cache and real IndexedDB. Chrome CDP shapes HTTP after fixture/assets are ready. Roost uses the actual AES-GCM RPC envelope. Each synthetic history contains deterministic 2 KiB prefix texts, one unchanged 352 KiB tool result and a one-character append. These are individual samples, not p95 or live Linux/staging measurements; completion means durable cache state, not DOM paint.

| 2,000 turns, 250 ms RTT / 2 Mbps | Previous recovery | Corrected recovery |
| --- | ---: | ---: |
| Unbound cached bodies, valid change coverage | 40.998 s / 50 replies / 6,892,567 bytes | 2.207 s / 1 reply / 481,696 bytes |
| Normal incremental append | 0.268 s | 0.275 s |

The corrected quiet-reopen capability race takes 2.979 seconds and two replies, preserving the entire cache. Missing coverage restores the latest 40 turns in 2.714 seconds / one reply; an owner reset needs the reset reply plus that window, 2.987 seconds / two replies. At 400 turns the corresponding bounded recovery is also about 2.7–3.0 seconds. These window results must not be presented as full-history restoration.

With 29 further appends over three seconds, the same 2,000-turn repair commits its first coherent state at 0.513 seconds on the 100 ms / 10 Mbps link and 2.200 seconds on the slow link. Subsequent production watches converge to the final owner checkpoint and tail at 3.089 and 3.027 seconds respectively, retaining all cached positions. The slow run uses one complete-change reply and three patch replies (487,773 response bytes total); no history sweep restarts.

Loro comparison uses Loro 1.16.3, the production domain writer, `loro-repo` 0.23.3 SQLite/IndexedDB adapters, product zstd snapshot compression and a benchmark AES-GCM binary envelope. The final logical histories and persisted state are checked against the Native owner. At 2,000 turns on the same slow link, normal Loro increment takes 0.280 seconds / 117 bytes; full snapshot recovery takes 27.957 seconds / 6,899,194 bytes. A valid Loro incremental cursor does not need that full snapshot. Neither comparison includes complete Streams bootstrap/auth/SSE or cloud hops.

The read-only matrix shows no growth in backend database/WAL file sizes; it does not establish zero physical write I/O. In a separate persistent browser profile, v1 plus the seeded v2 cache measures 17.83 MiB before actual complete-change repair and 17.76 MiB afterwards. The previous full-rebuild run measured 15.48 → 26.16 MiB. LevelDB compaction makes these observed file sizes unsuitable as universal steady-state ratios; the change removes repeated prefix rewriting but does not remove retained v1 caches.

## Verification

The owning IndexedDB bridge/cache suite exercises stale and foreign partial pages, complete repair followed by relative patches, bounded reset publication, retained old state before commit, concurrent-tab replacement rejection, and progress under newer writer hints. Regular CI runs the real Native owner regression with one and 120 retained turns, spanning three 40-turn pages: legacy body refresh, late capability negotiation, one complete change interval and full equality with the authoritative history, without fetching unchanged pages. Existing content-patch, encrypted-RPC, structural-repair and failed-repair coverage remains applicable.

The opt-in `corepack pnpm --dir apps/cli test:roost-recovery:perf` command runs the same assertions with 2,000 turns. Its Native fixture imports and seals 1,999 unchanged turns in a separately bounded 120-second setup hook; regular setup has a 30-second limit. Recovery retains the normal 30-second test deadline in both modes. The 120-turn fixture covers the pagination regression without paying the large import cost in every CI run; the opt-in case retains scale coverage. Vitest's test-body duration excludes the import, which contributes to the file duration. Neither mode simulates network latency.

The controlled browser harness and raw results are retained with the local benchmark artifacts. They measure the specified workloads; they are not an exhaustive proof of arbitrary corruption, cross-version application behavior or production latency distributions.
