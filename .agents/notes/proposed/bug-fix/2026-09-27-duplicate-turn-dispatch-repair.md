# Stop dispatch repair loops for duplicate turn IDs

Status: proposed
Translation: current

[中文](2026-09-27-duplicate-turn-dispatch-repair.zh.md)

## Abstract

Concurrent queue promotion and queued-message steering can append the same business
turn ID on separate Loro replicas. Dispatch previously selected the first copy while
the shared writer updated the last, so a stale first copy could trigger recursive
terminal repair until the daemon exhausted its heap. This patch aligns dispatch and
activation reads with the existing last-row-wins identity lookup and stops a check
when repair makes no progress. It preserves stored history and does not serialize
the competing producers; that remains a separate ownership problem.

## Decision and evidence

The synthetic regression forks a queued document, promotes its queue on the CLI,
and appends a `pending_apply` copy on the other replica before merging. It exercises
the real SessionDocument, Loro reader and HistoryWriter; a deterministic tripwire
fails the old recursive path without allowing the test process to run out of memory.
Terminal duplicate copies must not mask a subsequent pending message. An injected
no-op status command verifies that a matched write alone cannot authorize a retry.

Dispatch, activation settlement and queue recovery use the last stored copy, matching
`readTurn` and `HistoryWriter.locate`. The iterative repair pass tracks identities
already repaired; seeing one again logs a warning and returns no turn. Normal
session notifications and recovery remain responsible for subsequent checks.
Changing every duplicate or deleting rows was rejected because it would introduce
new write/merge semantics and mutate historical data merely to select work.

The producer race remains: renderer native queue steering appends history before
removing its queue row, while CLI promotion independently reads and consumes that
row. Process-local locks do not serialize those replicas. Centralizing queue claims
requires its own protocol/compatibility decision; this patch makes existing data
safe to inspect without claiming that new duplicate records are impossible.

This complements [dispatch check coalescing](../../implemented/bug-fix/2026-09-13-dispatch-check-coalescing.md):
coalescing bounds queued checks, while this patch prevents one check from recursing.
Intent: [session history writes](../../../../specs/session-history-writes.md).

## Verification limits

The regression uses synthetic content and in-memory replicas, not live cloud writes
or UI timing. Installed-client recovery was separately verified by repairing one
stale status locally; it is not deployment evidence for this source patch.
