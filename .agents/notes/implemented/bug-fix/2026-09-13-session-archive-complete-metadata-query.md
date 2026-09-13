# Make cold-start archive discovery and commit failure-safe

Status: implemented
Translation: current

Contract: [Session relations and operation targets](../../../../specs/session-relations.md)
Implementation: [#658](https://github.com/LodyAI/Lody/pull/658)

[中文](2026-09-13-session-archive-complete-metadata-query.zh.md)

## Abstract

An interactive root Session could be archived before the client metadata projection
contained its direct child Tabs. Archive now discovers targets from a per-action
repository metadata query and commits direct children before the root. Failed writes
enter compensation before the action rejects, and terminal cleanup starts only after
the metadata set commits.

## Decision

The archive action obtains the workspace metadata index before authoring any state
change. It normalizes Session ids from room ids, selects only direct `parentSessionId`
children, and rechecks that the captured workspace runtime is still active before
writing. The rendered root remains a fallback when the query lags that already-visible
document, but descendant discovery never falls back to the UI cache. “Complete” means
the repository snapshot observed by the query, not children created after it.

Waiting for `docMetaCacheReadyAtom` was rejected. Readiness belongs to an asynchronous
UI projection whose live-event metadata fetch can fail or remain unresolved; making a
user action wait for that global signal would introduce an unbounded pending state.
The repository index is already the source used to build that projection and gives the
archive action an explicit success or failure boundary.

LoroRepo does not provide a cross-document rollback transaction. The action therefore
writes children before the root and treats the root write as its final commit point. On
failure it attempts to restore every attempted target's prior `isArchived` and `status`
values. Root compensation happens first; if it fails, children remain archived and an
error reports both the write and rollback failures, preserving the root-archived
implication. The captured runtime stays authoritative after the first write, so a
workspace switch cannot split one commit across runtimes. Terminal closure is a
best-effort post-commit cleanup: metadata failure closes no terminal, while an IPC
failure cannot undo or hide an already durable archive.

This change intentionally leaves restore and archived-root deletion behavior unchanged.
It does not expand lifecycle ownership to `openedBySessionId` or
`openedByRootSessionId`; independent Sessions continue to survive opener archive.

## Verification

The owning hook suite exercises the production `getMeta().scan()` path with a UI cache
containing only the root while the repository contains its direct child and independently
opened Sessions. It verifies the target set and terminal set, child-write and final root
write compensation, zero terminal effects on metadata failure, and both workspace switch
boundaries: abort before the first write and finish against the captured runtime after it.

This implements [#574](https://github.com/LodyAI/Lody/issues/574) and complements the
containment decision recorded in
[Keep opened Sessions outside opener state cascades](2026-09-10-session-containment-lifecycle.md).
