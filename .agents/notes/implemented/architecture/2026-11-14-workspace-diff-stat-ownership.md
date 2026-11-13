# Workspace comparisons own cumulative diff statistics

Status: implemented
Translation: current
PR: [#2748](https://github.com/LodyAI/Lody/pull/2748), [#2751](https://github.com/LodyAI/Lody/pull/2751), [#2757](https://github.com/LodyAI/Lody/pull/2757)

[中文](2026-11-14-workspace-diff-stat-ownership.zh.md)

## Abstract

The composer diff entry describes current workspace changes, including saved edits
that have not been committed. Committed-only Git finalization could overwrite that
summary, after which an unchanged file index incorrectly suppressed reconciliation.
Code Collab's complete All Changes comparison now supplies cumulative statistics;
one owner-serialized publisher writes session totals and Project Member projections.
Turn history remains a separate record of each turn's edits. PR association does
not change the workspace summary's meaning.

## Ownership and alternatives

The comparison uses the workspace's existing resolved base against current files,
including staged, unstaged and non-ignored untracked paths. Committing the same
content does not change this scope. A net reversion to the comparison base yields
zero, independently of whether Git still reports a dirty checkout.

`WorkspaceGitService.publishDiffStats` publishes Code Collab results on the existing
owner mutation queue. Branch/dirty/unpushed observations preserve Member totals;
Git turn attribution cannot write cumulative totals. Nested Members own their
deepest path prefix, so their edits are not counted again in an ancestor Member.
Additional file roots retain independent summaries when their indexes are merged.
A group total requires a comparison from every Git Member. Non-Git directory
Members (`additional`/`link`) are shared, unisolated folders: their summaries count
when their roots resolve, but an unavailable directory never withholds the total.

Statistics are computed before the shared file index is trimmed. Unknown line
counts preserve the prior line total rather than publishing a partial sum as complete.
The additive `allChange.files` metadata field independently records the complete
changed-path count, also on Project Member `diff` records. Confirmed binary changes
contribute zero text lines; unreadable/budget-deferred paths keep unknown line counts.
The composer uses file presence for its entry, positive text totals for ordinary
and mixed comparisons, and localized file counts for zero-line changes. Older
writers without `files` retain their positive-line-count entry behavior.
Root initialization and terminal refresh reconcile against actual metadata even
when index content is unchanged. Watcher-only refresh remains Flock-only; no new
periodic metadata writer, Repo or retry owner is introduced. Cancelled comparisons
cannot publish after waiting for the owner queue, and failures remain retryable.

Keeping committed-only totals in the same field was rejected: the review-before-
commit workflow needs saved edits to remain visible. A forced refresh alone would
retain two incompatible writers. PR-specific remote comparisons keep their own
scope instead of replacing workspace statistics. The earlier
[base-ref decision](../bug-fix/2026-09-30-qualified-all-changes-base.md) still owns
base selection, and the [All Changes scopes](../feature/2026-10-19-all-changes-diff-scope.md)
remain unchanged.

The requested change removes the incompatible producer while retaining the
existing Promise Repo/Streams publication boundary. Migrating that dependency chain
is separate work; no Effect migration completion is claimed.

## Verification

The owning Code Collab, workspace Git and turn post-processing suites exercise real
Git commits, uncommitted edits, net reversions, bounded indexes, extra roots, nested
Members, open PR metadata, cancellation and retry after metadata failure. Native
clients and Web retain the same `diffStats` shape. No deployed-session or native UI
acceptance is claimed by these service-level checks.
