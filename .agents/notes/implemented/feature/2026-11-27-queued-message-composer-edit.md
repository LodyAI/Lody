# Edit queued messages in the composer, with a visibility-bound lock

Status: implemented
Translation: current
Supersedes: [queued edit operation ownership](../../archived/bug-fix/2026-10-13-queued-edit-operation-ownership.md)

[中文](2026-11-27-queued-message-composer-edit.zh.md)

## Abstract

Queued messages were edited in a small inline textarea that could change only
the text. Their frozen model, mode and Role were invisible. Editing now moves
the message into the composer's edit mode, where text, attachments and run
configuration can all change. Starting an edit writes only the row's existing
editing lock, and Save replaces the row once under the same message id. The lock
is renewed only while the edit is on screen, so an abandoned edit holds the queue
for at most the CLI's five-minute lease. The cost is that a user away for longer
can return to find the old content already sent; the edit then becomes an
ordinary draft.

## Decision

- **Edit surface.** The composer, not the row, owns editing: the same mentions,
  attachments, run-config menu and Role control as a new message. The composer's
  own draft and Role choice are stashed per Session and restored when the edit
  ends; the edit's run-config draft and Role choice use their own scope keyed by
  the row. Only one row is edited at a time.
- **One write on Save.** Start writes `isEditing` and `editingStartedAt`, which
  the CLI already treats as a head-of-queue lock (`EDITING_LEASE_MS`). Content and
  configuration are written once on Save through the shared send admission
  (`acceptSessionUserTurn` with `queueReplace`), which records the human-input
  receipt, signs encrypted content and prepares new attachments before replacing
  the row. Local writes complete without waiting for remote synchronization.
- **Author.** Save with no change is a cancel. A real change makes the editor the
  row's author (owner decision), which matches the existing signed-intent rule
  that the editor re-signs a changed queued input. An unchanged run configuration
  keeps the frozen Role revision instead of adopting the Role's latest revision.
- **Lock lifetime.** Renewal runs only while the Session is shown and the window
  is visible. Leaving stops it and the existing lease expires. A save that is
  still preparing attachments is runtime-owned and renews the lease until the
  replacement lands. A row that disappears while edited ends the edit and keeps
  its content as a draft. Reload loses the edit, like any composer draft.
- **Visibility of frozen config.** Each row has a details popover with the full
  message and frozen run configuration. A short difference tag appears only on
  wide sheets, and avatars only when someone else has queued in a multi-member
  workspace.

## Alternatives considered

- *Pop the message out of the queue into the composer* (Codex CLI style): no lock
  is needed, but the message loses its position and is gone if not resubmitted.
- *Keep the edit purely local until Save:* the CLI would start the old content
  while the user edits the head row, which is exactly when users edit.
- *Release the lock when leaving the Session:* a glance at another conversation
  would let the old content run.
- *Renew while the app runs:* an unnoticed edit stalls the queue indefinitely.
- *Pause the row when the lease expires:* later rows would run first and reorder
  dependent messages.
- *Keep the original author after an edit:* the signer and the displayed author
  would disagree.
- *An "editing by" field to release a reloaded device's lock at once:* rejected
  for now to avoid a queue format change; a stale lock costs at most five minutes.
- The superseded inline editor needed operation identities so an earlier
  blur-save could not erase the next row's draft. With one composer edit at a time
  and no blur-save, that race no longer exists; local writes still complete
  without awaiting remote synchronization.

## Consequences

Editing the last row's configuration also changes the composer default, because
the latest queued Turn is the configuration authority. Multi-device editing of
the same row has no special handling; another device sees only the dimmed lock.
MCP selection is not editable.

## Verification

- Row states, details, tag rules and the edit controller (lock-only start,
  visibility-bound renewal, unchanged save, author, frozen Role, rebuilt config,
  vanished row): [queue tests](../../../../packages/components/tests/message-queue-row-editing.test.tsx).
- Composer stash/restore, Escape after inner handlers, Save and Cancel:
  [composer tests](../../../../packages/components/tests/session-chat-input-submission.test.tsx).
- Held save replacing the row in place and failing when the row is gone:
  [preparation tests](../../../../packages/components/tests/session-attachment-preparation.test.ts).
- Storybook: `Sessions/MessageQueueDisplay` and `Sessions/SessionChatInputArea`
  (`QueueEdit*`). Installed desktop, physical devices and a real daemon were not
  exercised; encrypted re-signing was not run end to end.
