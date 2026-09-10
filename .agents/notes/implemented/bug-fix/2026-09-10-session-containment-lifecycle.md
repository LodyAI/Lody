# Keep opened Sessions outside opener state cascades

Status: implemented
Translation: pending

Contract: [Session relations and operation targets](../../../../specs/session-relations.md)

## Abstract

Desktop and mobile operations treated opened-by provenance as lifecycle ownership,
so acting on an opener could stop or delete an independent Session and its worktree.
Archive, restore, and archived-root permanent delete now follow only direct
`parentSessionId` containment. Exact cleanup deletes only caller-supplied Session ids.
Surviving Sessions retain opened-by provenance, while reverse navigation is available
only when its target is known to exist.

## Evidence and decision

The inconsistency in [#528](https://github.com/LodyAI/Lody/issues/528) is real,
but extending CLI/MCP cascades would preserve the wrong ownership model. An opened
Session is a first-class Session with its own workspace, machine, project, and
lifecycle; `openedBySessionId` and `openedByRootSessionId` record provenance and
navigation. A child Tab instead carries `parentSessionId` and shares its root
Session's lifecycle.

The desktop/mobile archive behavior follows
[#531](https://github.com/LodyAI/Lody/issues/531). Archive, restore, and archived-root
delete select the root plus cache entries whose `parentSessionId` equals the root id.
This is intentionally a one-level, operation-local rule: supported product paths do
not create nested child Sessions, and CLI/MCP also select only direct children. The
generic `collectSessionLifecycleIds` graph was removed because there is no unified
lifecycle tree spanning containment and provenance.

`deleteSessions(ids)` is a separate exact-cleanup API. Its callers already know the
failed-create child, empty Tab, or side Session to remove, so it neither discovers
related Sessions nor waits for metadata hydration. Discovery-based
`deleteArchivedSession(rootId)` retains the readiness gate because selecting its
additional direct children from a partial cache would be unsafe.

Deleting an opener does not rewrite a surviving Session's `openedBySessionId` or
`openedByRootSessionId`; those fields preserve the causal fact. Once the metadata
cache is ready, reverse navigation requires both the precise opener and its route
root to exist. Missing targets therefore render as non-clickable deleted-session
provenance instead of routing to `SessionNotFound`. Archived-root permanent delete
refuses to select targets before the metadata cache is complete, so a partial cache
cannot silently omit a direct child from a destructive operation. No tombstone model
is needed for this bug: the surviving Session already retains the irreducible ids.

Archive presentation remains separate in
[`buildArchivedSessionTree`](../../../../packages/components/src/lib/archived-session-tree.ts),
which may still indent two Sessions that were archived independently.

Status/result aggregation, unread and permission routing, worker panels, settle,
and handoff from [#529](https://github.com/LodyAI/Lody/issues/529) are not part of
this fix.

## Verification

Regression coverage models a root Session, its child Tab, an independently opened
Session, and a Session opened from the Tab. Archive, restore, and archived-root delete
affect only the root and Tab; exact deletion removes only its supplied id even before
metadata hydration completes. The archive-then-delete sequence puts the Sessions on
the same machine and verifies that surviving documents, worktree delete commands,
launch configs, and legacy queues remain untouched. Navigation tests cover partial
hydration, deleted precise openers, and deleted route roots; UI tests verify that
dangling provenance has no clickable action. ACP termination retry is idempotent at
the RPC boundary: once the runtime is gone, the Session manager returns `not-found`,
which the terminate handler still reports as a successful response.

Archive and restore targets still come from `sessionMetaCacheAtom`. The cache is populated by a
full metadata scan before `docMetaCacheReadyAtom` becomes true, but Session Detail
can expose Archive for an already rendered Session before that scan finishes. A
direct child not yet present in the cache can therefore be missed. The readiness
or complete-query contract and its regression coverage are tracked in
[#574](https://github.com/LodyAI/Lody/issues/574), rather than expanding this
archive-semantics fix.

The action, navigation, relation-card, header-menu, and archive-tree suites own the
focused regression coverage. Desktop journey `LODY-SESSION-003` exercises the full
user sequence with two real worktree forks: archive and archived-root delete remove
the opener and its child Tab while the opened Sessions, their ACP processes, and
their worktrees survive. It then opens both survivors to verify non-navigable deleted
provenance. The same journey delays the real initial metadata Flock scan across a
renderer reload and closes an empty child Tab populated by live metadata events,
proving exact cleanup remains available before full hydration. Repository-wide check
results are recorded in the PR status rather than duplicated here.
