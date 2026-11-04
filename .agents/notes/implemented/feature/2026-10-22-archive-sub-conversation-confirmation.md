# Ask before archiving a conversation's sub-conversations

Status: implemented
Translation: current

[中文](2026-10-22-archive-sub-conversation-confirmation.zh.md)

## Abstract

Since #1772, archiving a conversation archives only its contained Tabs, so the
Sessions it opened stay active, often unnoticed, under an archived opener. The
client now asks before archiving a conversation that has active opened
sub-conversations. The dialog states how many there are and how many are still
working, and offers "Archive all", "Archive this only" or Cancel. Recursive archive
is therefore an explicit choice rather than a default in either direction. CLI and
MCP archive keep the containment-only behavior.

## Decision

`readSessionOperationTargets` gains an `archive-tree` operation:
`collectSessionTreeTargets` follows containment and precise opened-by links
downward, with the same deduplication and cycle guard as collaboration stop, but
never walks up to an ancestor. `archiveSession(id, { includeOpenedSessions })`
selects it. The default `archive` operation is unchanged.

`useArchiveSessionWithConfirmation` reads the `archive-tree` snapshot first. The
dialog counts descendants that are first-class (no `parentSessionId`) and not
archived. A sub-conversation counts as working when live presence reports it or
one of its own Tabs; presence is read once when the request starts, so no layout
subscribes to the presence clock. With nothing to ask about, including a held
creation that has no metadata yet, it archives directly. One dialog host lives in
`AuthenticatedWorkspaceContent`. A second request supersedes an unanswered one
as a cancel. The sidebar row, mobile chat list, session header and mobile
active-tab menu use the hook. Bulk project-chat archive passes an explicit id
list and stays direct.

The keyboard shortcut, which always asked "Archive chat?" in its own dialog, now
passes `confirm: true` to the same hook. With no sub-conversations the shared
dialog asks that plain question (Enter confirms); with them, the sub-conversation
choice is the only dialog. No archive flow stacks two dialogs.

After the choice, `archiveSession` reads targets again, as every archive does, so
a Session opened while the dialog was open follows the user's choice. Writes stay
idempotent and non-transactional, as in the
[relation Spec](../../../../specs/session-relations.md).

## Alternatives

- Restoring recursive archive as the default (the
  [descendants decision](../bug-fix/2026-09-13-session-archive-descendants.md))
  would silently stop independent work again, which #1772 removed.
- A checkbox in the existing generic confirm would not cover the sidebar and
  header, which archive without that confirm.

## Verification

`use-session-actions.test.ts` drives the real hook and dialog over a Repo
snapshot: counts and working text, "Archive all" archiving opened Sessions and
their Tabs, "Archive this only" and Cancel, the no-dialog path, and the single
dialog of the always-confirm path.
`session-operation-targets.test.ts` covers `archive-tree` targets and confirms
they never include the opener. Component and shared type checks and type-aware
lint pass. The CLI type check reports only the unbuilt ACP adapter module.
