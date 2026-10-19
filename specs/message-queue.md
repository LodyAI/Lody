# Message queue presentation

Status: draft
Translation: current

[中文](message-queue.zh.md)

## Scenario

While an Agent works, queued messages sit above the composer. A reader can fold
the list to reclaim conversation space, then reopen it to inspect or edit messages.

## Behavior

- The header is a keyboard-accessible disclosure with the total count, including
  local sends still preparing attachments. It starts expanded; its state lives only
  in the mounted display, with no shared setting or persisted preference.
- Folding changes presentation only. It neither sends nor removes messages, changes
  their order, nor commits/discards an unfinished row edit. Reopening retains that
  draft. New items update the count without reopening the list.
- While folded, preparation and failed-send counts remain visible. Reopening exposes
  the existing retry/cancel controls; local pending rows remain outside the sortable
  queue and acquire no edit or steer action.

## Evidence and limits

The [queue display](../packages/components/src/components/sessions/message-queue/message-queue-display.tsx)
uses the existing disclosure primitive and editing state. The
[owning tests](../packages/components/tests/message-queue-row-editing.test.tsx) cover
editing continuity and live folded counts. Storybook includes a folded upload state. Browser and physical-device acceptance
remain unverified.
