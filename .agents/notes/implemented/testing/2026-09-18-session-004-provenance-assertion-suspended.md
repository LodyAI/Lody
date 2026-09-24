# Suspend the archived-route provenance assertion in LODY-SESSION-004

Status: implemented
Translation: current

English | [中文](2026-09-18-session-004-provenance-assertion-suspended.zh.md)

## Abstract

`LODY-SESSION-004` kept failing every Daily even after the archive-cascade
realignment in [the cascade repair note](2026-09-17-daily-e2e-cascade-and-windows-tags.md):
its last checkpoint opens each archived survivor's Session route and expects
the `opened-by` card to render `Deleted session`. Since #746
(`isSessionTabClosed` treats `isArchived` as a closed tab) the route falls
back to an empty/draft tab instead, so the card never mounts. wibus-wee
judged the redirect acceptable product behavior rather than a confirmed
defect, so the Gherkin step is commented out pending an explicit
archived-view UX decision. The registry row, its fingerprint, and
`COVERAGE.md` were regenerated to match the shortened scenario; the failure
never proved provenance was lost, and retention can be re-verified at
doc-meta level (`openedBySessionId`) without rendering the card.

## Evidence

- Daily run 35317896229 (commit `3bb73abe`, which already contained the
  cascade repair): macOS and ubuntu fail only on this scenario at
  `expectDanglingProvenanceAndCleanup`; the locator
  `[data-session-relation-card="opened-by"]` times out with
  `element(s) not found`.
- Mechanism: `archive-view.tsx` row clicks navigate to the plain
  `/sessions/{id}` route; `closedConversationIds` includes the archived root,
  so `getSessionTabFallback` resolves the requested tab to `empty`/a draft
  and the URL is rewritten. `isSessionTabClosed` and the fallback were
  introduced by #746 on 2026-09-16; before it, archived Sessions rendered
  their transcript with restore/delete menu actions.
- Related finding: `restoreSession` only flips `isArchived`/`isTabClosed`
  meta — it does not recreate the reclaimed worktree — and
  `assertArchivedLocalProjectCanRestore` makes restore impossible once the
  local project is removed, so a restore-first UX would leave some archived
  histories unreachable.

## Decision

The step `child Tab 被删除而 opened Sessions 保留 dangling 溯源并可独立清理`
is commented out in `session-management.feature` with the rationale inline;
the step definition and page-object method stay registered so re-enabling
needs no code change. The scenario still verifies the cascade, resource
release, and containment-scoped permanent delete; the registry checkpoints
drop `session.openSurvivors` and the two provenance checkpoints, and the
fingerprint was recomputed with `journeyFingerprint`.

Re-enabling (or replacing with a doc-meta `openedBySessionId` assertion)
waits on the archived-view UX decision: whether `/sessions/{archived}`
should render a read-only transcript with restore/delete affordances — the
pre-#746 behavior its now-dead menu branches imply — or require restore
first.

## Verification and limits

`pnpm e2e:check` covers the suite contract, fingerprint, dry-run, and types;
the scenario itself was not re-run (needs a built desktop). The suspended
step also covered the survivors' independent deletion, so the journey no
longer proves archived Sessions are deletable from their own route — that
flow is equally blocked by the unresolved archived-view UX.
