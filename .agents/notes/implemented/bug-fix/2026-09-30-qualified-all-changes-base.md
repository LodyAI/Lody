# Compare qualified owner branches against their tracking refs

Status: implemented
Translation: current
PR: [#1177](https://github.com/LodyAI/Lody/pull/1177)

[中文](2026-09-30-qualified-all-changes-base.zh.md)

## Abstract

All Changes could include unrelated upstream changes when a local worktree stored
its base as `refs/heads/main`. Compare resolution tried the nonexistent
`origin/refs/heads/main` and then accepted a stale local main, before trying the
valid tracking ref. Normalize qualified local refs for tracking lookup, share the
candidate policy between summary and file-index paths, and pin the batch diff base.
This repairs comparison selection, not PR history or offline remote-ref freshness.

## Evidence and ownership

The reported avatar [PR #1164](https://github.com/LodyAI/Lody/pull/1164) contains
five files, +165/-0. Read-only inspection found a qualified local base in its
owner metadata and a refreshed durable file-index projection with 525 paths,
+21317/-10255, including an unrelated SDK update. Refresh logs in the reported
UTC interval show the projection being rebuilt, so a stale browser cache alone
does not explain it. The clean checkout's current upstream merge base gives the
PR's five files; stale local main includes the unrelated SDK change. The current
checkout's stale-main diff is not exactly the historical 525-path snapshot.

The info bar reads durable `SessionMeta.diffStats`, whereas the fixed panel's
summary and list read the owner file-index document through the provider.
Current file/batch diff RPCs compare disk against a freshly resolved Git base.
These are separate snapshots; the exact writer/time of the observed +165 metadata
has not been reconstructed. The Web client reported 0.103.0 / `eb96909d`, not the
repair baseline `e10e5226`; that frontend build has not been mapped to this source.
Installed machine CLI compare logic was inspected separately and exhibited the
qualified-ref selection defect.

## Decision

`gitDiffBaseRefCandidates` is the one candidate policy. A qualified local ref
first tries `origin/<branch>`, retaining the original local ref as fallback;
qualified remote refs retain their identity. No fetch, checkout, metadata
migration, or numeric override is added. The scan core owns merge-base resolution
for both worker indexing and current diffs. One batch resolves a commit once and
uses it for its list, response identity, and every inline old snapshot.

Replacing the chip's numbers with panel totals alone was rejected because it
would hide the incorrect SDK diff. Permanently pinning PR head/base was also
rejected: All Changes is a live owner-workspace comparison, not an immutable PR
viewer. Remote refs still require ordinary fetch updates; dirty/untracked files
can legitimately differ from committed metadata. Deferred later RPCs are new
reads, not a transaction over the original batch's disk state.

## Verification

Synthetic real-Git regressions cover stale local main versus an advanced tracking
ref, inline/current snapshots, squash-merged history, ref-only movement after a regular merge, zero
summary publication, service reactivation, and the worker scan boundary. Restoring
the old candidate construction makes the regression fail with the unrelated
upstream change. With normalization, the four owning CLI suites pass 73 tests;
CLI typecheck passes. Production data was inspected read-only, never republished;
no deployment or signed-in Web acceptance is claimed.
