# Workspace watch refreshes publish changed diff totals

Status: implemented
Translation: current

[中文](2026-11-21-watch-refresh-diff-stats.zh.md)

## Abstract

A workspace edit made outside a Lody turn reaches the daemon only through the
workspace watch. That path refreshed the Code Collab file index but deliberately
skipped session metadata, so every client reading the catalog kept a stale
`diffStats.allChange` until the next turn. The watch refresh now publishes the
comparison totals through the existing owner-serialized
`WorkspaceGitService.publishDiffStats`, which still writes only when the aggregate
changes. The cost is one metadata read per watch refresh; an unchanged save still
produces no metadata write.

## Decision

`CodeCollabV2Service.refreshWatchedWorkspace` passes
`persistAllChangesDiffStats: true` to the shared-state refresh, matching root
initialization and terminal turn refresh. The worker and in-process publication
paths already carry `allChangesDiffStats` and `memberDiffStats`, so Project group
Member `diff` projections reconcile through the same publisher. The file index
remains content-deduped on Flock; only session metadata is conditional.

`WorkspaceGitService.publishDiffStats` remains the sole workspace-total writer and
keeps its `sameChange` short circuit. A watch refresh that recomputes the same
add/del/file totals performs the metadata read and returns without
`upsertDocMeta`. This bounds metadata writes to actual aggregate changes rather
than saves or watcher ticks.

## Alternatives

Comparing the fresh aggregate against an in-memory mirror before calling the
publisher was rejected: session meta is authoritative, another writer can change
it between refreshes, and a stale mirror would suppress a needed reconciliation.
The publisher's metadata read is bounded, and its short circuit already prevents
the write, which is the expensive durability operation.

Keeping watch refreshes Flock-only and waiting for the next turn refresh was
rejected. Non-turn edits can persist indefinitely, and clients that read the
catalog instead of live-probing stay wrong. Android's All changes row
(`LodyAI/lody-android#21`) is absent whenever catalog `diffStats.allChange` is
missing, even though a live probe can show the Uncommitted row.

## Consequences

No new timer, Repo, retry owner, or publication queue is introduced. Watch
refreshes keep Flock file-index deduplication and signal behavior; the only added
work is the conditional metadata publication. Manifest readers remain live and
independent of metadata freshness.

## Verification

`apps/cli/src/lib/code-collab/code-collab-v2-service.test.ts` — "persists All
Changes totals after a workspace watch refresh" drives a real Git workspace
through initialization, an external edit, and the watch refresh, then asserts the
session totals and no metadata write when the same totals are republished.
Workspace-Git suites continue to cover Project Member reconciliation and the
unchanged-total behavior. Native UI acceptance is not claimed.
