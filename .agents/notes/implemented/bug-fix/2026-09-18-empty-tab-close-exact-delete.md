# Restore exact deletion for closing a never-messaged session tab

Status: implemented
Translation: current

English | [中文](2026-09-18-empty-tab-close-exact-delete.zh.md)

## Abstract

`LODY-SESSION-004`'s cold-hydration step — first reached only after the
provenance assertion was suspended in #812 — failed on the first e2e-full
run of #813: closing an empty child tab left its session doc in
`repo.listDoc()` forever. The cause is a branch that #746 ("workspace-shared
session tab closure") dropped from `handleTabClose`: the old code
exact-deleted tabs that never had a message (`!lastMessageAt`) and archived
the rest, while the rewrite marks every close with `isTabClosed` — leaving
each never-messaged closed tab as an invisible durable doc. The restore
keeps the new `isTabClosed` model for non-empty tabs but re-adds the
exact-delete branch, judging emptiness from `runtime.repo.getDocMeta` rather
than the `childSessions` list the old code used, because the scenario
explicitly verifies that exact deletion works while the metadata scan cache
is still cold. `pnpm e2e:check` is green; the daily run will confirm.

## Evidence

- First e2e-full run on #813 (run 35359528422): 21/22 passed; only
  `LODY-SESSION-004` failed at `expectColdHydrationExactDelete`
  (`session-relation-lifecycle-page.ts:200`) with `Expected: false,
  Received: true` — the closed empty tab's `session-{id}` doc stayed in
  `repo.listDoc()` for the full 30s poll.
- `git show 884ec6ce~1` (pre-#746 `handleTabClose`) had:
  `if (tabMeta && !tabMeta.lastMessageAt) await deleteSessions([id]) else
  await archiveSession(id)`. The current code unconditionally calls
  `setSessionTabClosed` — no remaining path deletes an empty closed tab
  (verified across components, shared, CLI, and electron).
- The contract survived as documentation: `use-session-actions.ts` still
  comments "empty tabs are deleted, not archived", and the shared AGENTS.md
  guarantees `deleteSessions(ids)` bypasses discovery and cache readiness —
  exactly what the scenario's metadata-scan barrier exercises.

## Fix

- `session-detail.tsx` `handleTabClose` re-reads the tab's meta through
  `runtime.repo.getDocMeta` — a direct doc-meta read, independent of the
  scan-cache state — and calls `deleteSessions` when the tab has no
  `lastMessageAt`. Non-empty tabs keep the #746 `isTabClosed` write.
- Deleting the ACTIVE tab navigates to the route's session tab itself:
  `resolveActiveSessionTab` deliberately keeps a meta-missing `session:`
  tab active (a deleted doc is indistinguishable from a replica that has
  not caught up), and the shared-close effect only watches `isTabClosed`
  metas, so without the handler's own navigation the URL would sit on the
  deleted tab forever. The first #814 e2e-full run proved this: deletion
  passed, `toHaveURL` to the parent tab timed out.
- `isLoroRepoDocDeleted` guard mirrors `setSessionTabClosed`'s error
  contract; a missing meta falls through to `setSessionTabClosed`, which
  reports "metadata is still loading" as before.
- `session/tab_deleted_empty` event re-emitted (name carried over from the
  pre-#746 branch) so the two close outcomes stay distinguishable in
  analytics.
- `sessions/AGENTS.md` updated: "Close writes `isTabClosed`, never archive —
  a tab that never had a message is exact-deleted instead."

## Alternatives considered

- Suspending the e2e step like the provenance assertion (#812): rejected —
  this failure is a dropped code branch with a living contract comment, not
  an undecided UX surface; suspending would hide the durable-doc litter.
- Putting the empty check inside `setSessionTabClosed`: rejected — the
  hook's name promises a flag write; a destructive delete belongs at the
  explicit close handler, matching the pre-#746 structure.

## Verification limits

`pnpm e2e:check` and the components unit suites pass; the electron
typecheck errors in this nested checkout are the known missing-deps
environment issue. The cold-hydration step itself can only be proven by an
e2e-full or Daily run; the assertion itself is unchanged since #583, so a
green leg closes the loop on both the restore and the cold-hydration path.
