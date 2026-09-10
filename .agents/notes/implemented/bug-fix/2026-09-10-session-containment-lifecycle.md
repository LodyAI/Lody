# Keep opened Sessions outside opener archive cascades

Status: implemented
Translation: pending

## Abstract

Desktop and mobile archive and restore treated opened-by provenance as lifecycle
ownership, so acting on an opener could stop or mutate an independent Session and
its worktree. Archive-state cascades now follow only `parentSessionId` containment,
matching CLI/MCP behavior and the existing opened-Session contract. Permanent
deletion and supervised-worker behavior remain separate decisions.

## Evidence and decision

The inconsistency in [#528](https://github.com/LodyAI/Lody/issues/528) is real,
but extending CLI/MCP cascades would preserve the wrong ownership model. An opened
Session is a first-class Session with its own workspace, machine, project, and
lifecycle; `openedBySessionId` and `openedByRootSessionId` record provenance and
navigation. A child Tab instead carries `parentSessionId` and shares its root
Session's lifecycle.

The desktop/mobile behavior now follows
[#531](https://github.com/LodyAI/Lody/issues/531). The operation helper is named
[`collectSessionContainmentIds`](../../../../packages/components/src/lib/session-containment.ts)
and traverses only `parentSessionId`. It is used only for archive and restore.
Permanent deletion retains its existing full cascade because preserving an opened
Session after deleting its opener would otherwise leave a clickable reverse-navigation
target pointing to a missing Session. That orphan interaction needs an explicit
contract outside this archive-only fix. Archive presentation remains separate in
[`buildArchivedSessionTree`](../../../../packages/components/src/lib/archived-session-tree.ts),
which may still indent two Sessions that were archived independently.

Status/result aggregation, unread and permission routing, worker panels, settle,
and handoff from [#529](https://github.com/LodyAI/Lody/issues/529) are not part of
this fix.

## Verification

Regression coverage models a root Session, its child Tab, an independently opened
Session, and a Session opened from the Tab. Archive and restore affect only the
root and Tab. Tests assert resulting metadata and the terminal, machine Flock,
legacy archive queue, and restore queue boundaries. Existing delete behavior and
archived opened-by presentation coverage remain unchanged.

The containment set still comes from `sessionMetaCacheAtom`. The cache is populated
by a full metadata scan before `docMetaCacheReadyAtom` becomes true, but archive can
be invoked for an already rendered Session before that scan finishes. A child not
yet present in the cache can therefore be missed; changing action readiness or the
metadata query boundary is intentionally deferred from this focused fix.

The three targeted Vitest files passed 32 tests. Repository formatting, typecheck,
type-aware lint, documentation, i18n, collaboration-import, platform-boundary, and
public-boundary checks passed. The full components suite passed 3,350 of 3,351
tests with an isolated Node localStorage file before stopping on an app-store review
test that also fails alone. It does not import or exercise the changed Session code.
