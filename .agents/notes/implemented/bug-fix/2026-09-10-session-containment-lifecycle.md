# Keep opened Sessions outside opener lifecycle cascades

Status: implemented
Translation: pending

## Abstract

Desktop and mobile archive, restore, and delete treated opened-by provenance as
lifecycle ownership, so acting on an opener could stop or remove an independent
Session and its worktree. Lifecycle cascades now follow only `parentSessionId`
containment, matching CLI/MCP behavior and the existing opened-Session contract.
Archived lists still use opened-by provenance for display; supervised-worker
behavior remains a separate product decision.

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
and traverses only `parentSessionId`. Archive presentation remains separate in
[`buildArchivedSessionTree`](../../../../packages/components/src/lib/archived-session-tree.ts),
which may still indent two Sessions that were archived independently. If an opener
is missing, the existing opened-by tree renders its surviving Session as a
top-level row rather than inferring ownership from the dangling provenance edge.

Status/result aggregation, unread and permission routing, worker panels, settle,
and handoff from [#529](https://github.com/LodyAI/Lody/issues/529) are not part of
this fix.

## Verification

Regression coverage models a root Session, its child Tab, an independently opened
Session, and a Session opened from the Tab. Archive, restore, archived deletion,
and active deletion affect only the root and Tab. Separate tree coverage confirms
that archived opened Sessions retain provenance-based indentation.

The three targeted Vitest files passed 33 tests. Repository formatting, typecheck,
type-aware lint, documentation, i18n, collaboration-import, platform-boundary, and
public-boundary checks passed. The root check reached the components suite and
passed 3,351 of 3,352 tests with an isolated Node localStorage file before stopping
on an app-store review test that also fails alone. It does not import or exercise
the changed Session code.
