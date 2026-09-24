# Bound automatic session prefetch on every surface

Status: implemented
Translation: current
PR: [#753](https://github.com/LodyAI/Lody/pull/753)

[中文](2026-09-16-bounded-session-prefetch-window.zh.md)

## Abstract

Desktop and mobile previously queued every eligible unarchived session for background prefetch,
while Web stopped after 20, so a user with a large history could download many conversations they
never opened. Automatic prefetch now uses the same 20-session priority window on every surface;
older conversations continue to sync through the normal foreground path when opened. This trades a
potentially slower first open for an uncommon conversation for bounded startup background work.

## Decision

The coordinator already orders candidates by pinned state, current UI visibility, running or unread
activity, and then recency. All surface policies now apply a 20-session window to that ordered list.
Desktop retains Web's 1.5-second batch cooldown and mobile retains its 3-second cooldown, so this
change narrows candidate scope without changing worker serialization, transport routing, snapshot
storage, high-water deduplication, or cancellation.

The manual prefetch entry point remains able to request a session outside the automatic window. More
importantly, foreground acquisition remains independent of background prefetch: opening a session
cancels any matching worker task, merges a cached snapshot when one exists, and otherwise performs
the established foreground synchronization. The window is therefore a cache policy, not an access
or correctness boundary.

This narrows the candidate policy introduced with the
[serial prefetch worker](2026-09-12-session-prefetch-worker.md); it does not revise that note's worker
ownership or snapshot-cache decisions. Current intended behavior is recorded in the
[draft background-prefetch Spec](../../../../specs/session-background-prefetch.zh.md).

## Verification and limits

The coordinator suite constructs 1,000 eligible sessions for each of Web, desktop, and mobile, then
asserts that only the 20 highest-priority candidates are queued or in flight. Existing tests continue
to cover persisted high-water skips, hidden/offline pausing, manual prefetch, priority ordering,
batch pacing, cancellation, and on-demand cache behavior in the runtime's owning suites.

This change does not measure the cold-open latency of an out-of-window conversation and does not
change the separate 64-entry snapshot-cache capacity.
