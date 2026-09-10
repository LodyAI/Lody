# Keep opened Sessions outside opener state cascades

Status: implemented
Translation: pending

## Abstract

Desktop and mobile operations treated opened-by provenance as lifecycle ownership,
so acting on an opener could stop or delete an independent Session and its worktree.
Archive, restore, and permanent delete now follow only direct `parentSessionId`
containment. Surviving Sessions retain opened-by provenance, while reverse navigation
is available only when its target is known to exist.

## Evidence and decision

The inconsistency in [#528](https://github.com/LodyAI/Lody/issues/528) is real,
but extending CLI/MCP cascades would preserve the wrong ownership model. An opened
Session is a first-class Session with its own workspace, machine, project, and
lifecycle; `openedBySessionId` and `openedByRootSessionId` record provenance and
navigation. A child Tab instead carries `parentSessionId` and shares its root
Session's lifecycle.

The desktop/mobile archive behavior follows
[#531](https://github.com/LodyAI/Lody/issues/531). Archive, restore, active delete,
and archived delete select the root plus cache entries whose `parentSessionId` equals
the root id. This is intentionally a one-level, operation-local rule: supported
product paths do not create nested child Sessions, and CLI/MCP also select only
direct children. The generic `collectSessionLifecycleIds` graph was removed because
there is no unified lifecycle tree spanning containment and provenance.

Deleting an opener does not rewrite a surviving Session's `openedBySessionId` or
`openedByRootSessionId`; those fields preserve the causal fact. Once the metadata
cache is ready, reverse navigation requires both the precise opener and its route
root to exist. Missing targets therefore render as non-clickable deleted-session
provenance instead of routing to `SessionNotFound`. Permanent delete refuses to
select targets before the metadata cache is complete, so a partial cache cannot
silently omit a direct child from a destructive operation. No tombstone model is
needed for this bug: the surviving Session already retains the irreducible ids.

Archive presentation remains separate in
[`buildArchivedSessionTree`](../../../../packages/components/src/lib/archived-session-tree.ts),
which may still indent two Sessions that were archived independently.

Status/result aggregation, unread and permission routing, worker panels, settle,
and handoff from [#529](https://github.com/LodyAI/Lody/issues/529) are not part of
this fix.

## Verification

Regression coverage models a root Session, its child Tab, an independently opened
Session, and a Session opened from the Tab. Archive, restore, and both delete paths
affect only the root and Tab. The archive-then-delete sequence puts the Sessions on
the same machine and verifies that surviving documents, worktree delete commands,
launch configs, and legacy queues remain untouched. Navigation tests cover partial
hydration, deleted precise openers, and deleted route roots; UI tests verify that
dangling provenance has no clickable action.

Archive and restore targets still come from `sessionMetaCacheAtom`. The cache is populated by a
full metadata scan before `docMetaCacheReadyAtom` becomes true, but Session Detail
can expose Archive for an already rendered Session before that scan finishes. A
direct child not yet present in the cache can therefore be missed. The readiness
or complete-query contract and its regression coverage are tracked in
[#574](https://github.com/LodyAI/Lody/issues/574), rather than expanding this
archive-semantics fix.

The targeted action, navigation, relation-card, header-menu, and archive-tree Vitest
suites pass 52 tests. Component typechecking also passes. Repository-wide checks are
recorded in the PR status rather than duplicated here.
