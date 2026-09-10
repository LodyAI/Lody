# Archive only after metadata hydration

Status: implemented
Translation: pending

## Abstract

Session Detail can render a bootstrapped root Session before the workspace metadata scan has
discovered its child Tabs. Archive now waits for that initial scan before deriving the lifecycle
subtree, preventing an early action from archiving only the root. Already-hydrated actions retain
their existing repository-read and rendered-cache fallback behavior.

## Problem

Archive derives lifecycle descendants from `sessionMetaCacheAtom`. During cold start, bootstrap
metadata may make the requested root interactive while `docMetaCacheReadyAtom` is still false and
the cache does not yet contain a direct `parentSessionId` child. Starting writes from that partial
view leaves the child active after its root is archived.

## Decision

`archiveSession` waits for both `docMetaCacheReadyAtom` and a ready `docMetaCacheScopeAtom` owned by
the captured workspace runtime before reading the lifecycle cache or authoring archive side effects.
Readiness is the existing signal that the workspace-wide metadata scan has merged its snapshot with
live events. The subscription therefore keeps readiness false while metadata or existence events
observed during the bootstrap window remain in its deferred projection queue, including any full
metadata fetch needed to initialize a newly discovered document. This keeps descendant discovery on
the same source of truth without issuing another full metadata query for each archive action. A
runtime switch rejects the pending action and releases its subscriptions rather than combining the
old repository with a new workspace cache.

The individual root metadata read still prefers the repository and falls back to rendered metadata.
This preserves closing a visible Session when its own repository read lags after the initial scan.

## Verification

The owning `use-session-actions` suite constructs a visible root with readiness false, starts an
archive, and asserts that no metadata write occurs. It then hydrates a synthetic direct child Tab,
marks the cache ready, and verifies that both root and child receive the archived idle state. A second
case switches runtimes during the wait and verifies rejection without writes. Existing coverage
continues to verify the rendered-meta fallback after initial hydration. The metadata subscription
suite also injects both metadata and existence events after the bootstrap snapshot is captured,
asserts readiness stays false while their deferred projection is outstanding, and verifies the newly
discovered child is cached before readiness becomes true.

## Limits

This change does not alter which relationship fields define lifecycle containment or restore/delete
semantics. A failed or empty live full-metadata fetch remains pending until a later event or the
bootstrap snapshot supplies authoritative metadata; this adds no retry policy. The change only closes
the pre-hydration archive window tracked by
[Lody issue #574](https://github.com/LodyAI/Lody/issues/574).
