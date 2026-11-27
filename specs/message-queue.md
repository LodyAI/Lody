# Message queue presentation

Status: draft
Translation: current

[中文](message-queue.zh.md)

## Scenario

While an Agent works, queued messages sit above the composer. A reader can fold
the list to reclaim conversation space, reopen it to inspect a message and how it
will run, and edit a message in the composer before it is sent.

## Behavior

- The header is a keyboard-accessible disclosure with the total count, including
  local sends still preparing attachments. It starts expanded; its state lives only
  in the mounted display, with no shared setting or persisted preference.
- Folding changes presentation only. It neither sends nor removes messages, changes
  their order, nor ends a composer edit. New items update the count without
  reopening the list.
- While folded, preparation and failed-send counts remain visible. Reopening exposes
  the existing retry/cancel controls; local pending rows remain outside the sortable
  queue and acquire no edit or steer action.

## Details

- Every row has a details action (inside More on phones and on sheets narrower
  than 520 px). It shows the full message, its attachments, the sender, when it
  was queued and its frozen run configuration: Role, Agent, model, reasoning,
  mode, Plan and Fast. It offers Edit.
- When the workspace has several members and someone else has queued in this
  conversation, every row shows its sender's avatar; otherwise no avatar column
  is shown.
- A row whose frozen model, mode, options or Role differs from the composer's
  current selection shows a short tag naming the difference. Fields the row did
  not record follow the Session and never differ. The tag is a hint: it is left
  out on phones and on sheets narrower than 520 px, and never displaces the text.

## Editing in the composer

- Edit moves the row's text into the composer, which enters an edit mode: a
  strip at the top of the input card (the info bar stays attached above) names the row and lists the images, files and references the message
  still carries (each removable), Send becomes Save, and Cancel sits beside it.
  The composer's own unsent draft and run-config choice are set aside and return
  when the edit ends. Only one row of a queue is edited at a time.
- The run configuration starts from the row's frozen values. Model, mode, options
  and Role can be changed within what the composer offers this Session, and new
  attachments can be added. MCP selection is not part of the edit.
- Starting an edit writes only the row's editing lock. Content and configuration
  are written once, on Save, replacing the row's fields under the same message id
  and position. Save never routes the message (no send, queue, steer or
  interrupt); Send/Steer stay on the row.
- Save with no change ends the edit like Cancel: the row, its author and its
  signature stay as they were. A real change makes the editor the row's author,
  and in encrypted workspaces the editor signs the new content. An unchanged run
  configuration keeps the frozen Role revision. Because the latest queued Turn is
  the composer's configuration authority, editing the last row's configuration
  also sets the default for the next new message.
- Escape (once nothing inside the composer, such as a mention menu or an IME
  candidate, claims it) and the Cancel button end the edit without changing the
  queue. Discarding needs no confirmation.
- While edited, the row keeps its place, dims, shows "Editing" (which returns to
  the composer) and offers no drag, steer, move or delete.
- New attachments are prepared before the row is replaced; meanwhile the row
  shows progress, or the failure with retry and discard.

## Lock lifetime

The CLI does not start a row whose editing lock is younger than five minutes. The
editor renews the lock only while the edit is on screen (its Session shown and
the window visible). Leaving the Session, hiding the window or closing the app
stops renewal, so an unattended edit holds the queue for at most five more
minutes. The edit itself survives in memory, like composer drafts: returning
continues it and renews the lock. If the row ran or was removed meanwhile, the
edit ends and its content stays in the composer as an ordinary draft, with a
notice. A save still preparing attachments renews the lock until it lands.
Reloading or quitting loses the edit like any unsent draft.

## Evidence and limits

[Queue display](../packages/components/src/components/sessions/message-queue/message-queue-display.tsx),
[edit rules](../packages/components/src/components/sessions/message-queue/queued-message-edit.ts),
[edit controller](../packages/components/src/components/sessions/message-queue/use-queued-message-composer-edit.ts)
and the [composer](../packages/components/src/components/sessions/session-chat-input-area.tsx).
[Queue tests](../packages/components/tests/message-queue-row-editing.test.tsx),
[composer tests](../packages/components/tests/session-chat-input-submission.test.tsx) and
[held-edit tests](../packages/components/tests/session-attachment-preparation.test.ts)
cover the row states, details, save rules, lock renewal and in-place replacement.
Storybook shows each state. Another device editing the same row has no special
handling. Installed desktop, physical devices and a real daemon were not exercised.
Rationale: [composer queue edit](../.agents/notes/implemented/feature/2026-11-27-queued-message-composer-edit.md).
