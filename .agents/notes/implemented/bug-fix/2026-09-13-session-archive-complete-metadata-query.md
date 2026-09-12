# Discover archive targets from complete repository metadata

Status: implemented
Translation: current

Contract: [Session relations and operation targets](../../../../specs/session-relations.md)

[中文](2026-09-13-session-archive-complete-metadata-query.zh.md)

## Abstract

An interactive root Session could be archived before the client metadata projection
contained its direct child Tabs. Archive target discovery now reads the repository
metadata index for each action and performs no writes if that query fails. This avoids
both a partial-cache archive and an unbounded wait for global projection readiness, at
the cost of one metadata-index scan per archive action.

## Decision

The archive action obtains the workspace metadata index before authoring any state
change. It normalizes Session ids from room ids, selects only direct `parentSessionId`
children, and rechecks that the captured workspace runtime is still active before
writing. The rendered root remains a fallback when the index lags that already-visible
document, but descendant discovery never falls back to the UI cache.

Waiting for `docMetaCacheReadyAtom` was rejected. Readiness belongs to an asynchronous
UI projection whose live-event metadata fetch can fail or remain unresolved; making a
user action wait for that global signal would introduce an unbounded pending state.
The repository index is already the source used to build that projection and gives the
archive action an explicit success or failure boundary.

This change intentionally leaves restore and archived-root deletion behavior unchanged.
It does not expand lifecycle ownership to `openedBySessionId` or
`openedByRootSessionId`; independent Sessions continue to survive opener archive.

## Verification

The owning hook suite starts with a UI cache containing only the root while the
repository index contains its direct child and independently opened Sessions. It
verifies that archive updates the root and child, leaves both independent Sessions
active, and closes only the two lifecycle-owned terminals. A failure case verifies that
an index-query error rejects before any archive metadata write. A deferred-query case
switches workspaces before discovery completes and verifies that the old runtime also
receives no write.

This implements [#574](https://github.com/LodyAI/Lody/issues/574) and complements the
containment decision recorded in
[Keep opened Sessions outside opener state cascades](2026-09-10-session-containment-lifecycle.md).
