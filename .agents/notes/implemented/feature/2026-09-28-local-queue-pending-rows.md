# Queue-bound uploads render as local rows in the queue sheet

Status: implemented
Translation: current

[中文](2026-09-28-local-queue-pending-rows.zh.md)

Verdict (2026-09-29): implemented in [#1095](https://github.com/LodyAI/Lody/pull/1095) and moved from `proposed/`. Partially superseded by [removing the session send journal](../simplification/2026-09-29-remove-session-send-journal.md): the local queue rows remain, but come from the in-memory held sends instead of journal records, and have only retry and cancel. The text-only projection overlay was removed because a ready send is now written locally at once.

## Abstract

A message sent to a working conversation with attachments first appeared in the conversation stream as "Waiting to be sent", then, once the upload finished, vanished from there and reappeared in the queue sheet. The user saw one message move between two surfaces. Queue-bound messages now render in the queue sheet from the start, as local rows below the real queue items. The rows exist only in the renderer's send journal; nothing reaches the synchronized document until the attachments are ready, as [Session files](../../../../specs/session-files.md#63-direct-queue-and-guide) requires. Idle conversations and steer sends keep the existing in-stream pending rows, because they do not jump.

## Cause

`pushMessageQueue` admits the message into the send journal with `record.queue` set and `delivery.kind: 'queue'`. Until commit, the journal record is the only representation and `SessionPendingMessages` rendered it in the stream. Commit writes the queue item into `mq`, and the queue sheet rendered it there. Both surfaces were correct in isolation; the handoff between them was the jump.

## Decision

- **Queue-bound is `Boolean(record.queue)`.** Only the queue route sets it. Direct dispatch (idle conversation) and guide (steer) do not, so their rendering is unchanged. `SessionPendingMessages` excludes queue-bound records; `MessageQueueDisplay` includes them.
- **Display only, never written early.** The local row is not a queue item: it is outside the sortable list and has no drag, edit or steer. It offers the journal's own recovery actions: cancel while `saved`, discard while `prepared`, and continue sending when failed or interrupted. Each action then resumes the session's FIFO, the same as the in-stream rows. Writing a placeholder into `mq` would make it executable before attachments are ready, which the Spec forbids.
- **Position matches the handoff.** Local rows follow the real items in journal order. Commit appends the real item to the end of `mq`, so it takes the same position. The header count includes local rows.
- **Dedupe by turn ID, not by stage.** The workspace commit port writes `mq` before the record's stage advances to `committed`. For a moment, both the queue item and the `prepared` record exist. `selectPendingQueueRecords` hides any record whose ID matches an item's `userTurnId`, so exactly one row is shown in every render.
- **Visual continuity.** The local row uses the queued row's layout (index, thumbnails, two-line text), with muted text, like the sidebar's unsent title. It shows the upload ring and "Uploading · N%". Thumbnails come from the local Blob. On handoff the row remounts as a real row, which loads its thumbnail from the uploaded image.
- **Render cost.** Upload progress is high-frequency. `session-chat-interface` needs to know only whether the sheet has content (the info bar lays out differently with a sheet), so it reads `useHasPendingQueueRecords`, a boolean `useSyncExternalStore` snapshot that changes only when rows appear or leave. Progress is subscribed inside `MessageQueueDisplay`.
- **Text-only messages never look pending.** A message without attachments reaches history or the queue after a few local writes, but those writes, the eligibility reads and the flush still took long enough to flash a "Waiting to be sent" row. `isInstantSendRecord` covers text-only records that have not failed or been interrupted:
  - The dispatch and guide routes project the record into the conversation through `acceptedSessionHistoryProjectionsAtom`, the existing overlay that drops an entry once history holds the same ID. `SessionSendRecovery` writes it in a layout effect keyed on membership, so it lands in the same paint that removes the pending row and never updates at upload-progress rate.
  - The queue sheet draws its local row like a real queued row, with no status.
  - The sidebar shows no sending mark.
  - Only a session's leading run is projected. A text message behind an earlier upload stays a pending row, or it would render above the upload it waits for.
  - A failure or interruption turns the record back into a pending row with its recovery actions.
- **Upload shimmer.** A determinate ring can sit at one percentage while a large file uploads, which reads as stuck. A short highlight travels along the filled arc every 1.8 s (SVG mask plus a `stroke-dashoffset` animation). It is hidden under `prefers-reduced-motion`. The indeterminate ring keeps its spin.

## Alternatives

- Write a non-executable placeholder into `mq`: rejected; the queue is synchronized state, and every consumer (daemon promotion, other windows, mobile) would need to learn to skip it.
- Delay showing anything until the upload finishes: the message silently disappears from the composer for the duration of the upload.
- Keep the in-stream row and animate it into the sheet: still two surfaces, and the animation spans two independently scrolling containers.

## Verification

- `tests/session-send-recovery.test.tsx` uses a real journal and queue sheet. The message shows as a local sheet row, never in the stream: uploading at 40%, then failed with Continue sending. While commit is paused after writing `mq`, the sheet shows exactly one row, the real one. After delivery there is no local row.
- `tests/session-send-recovery.test.tsx` also covers text-only sends. While commit is blocked, a text-only send is projected into the conversation, with no pending row and no sidebar mark. Behind an upload it stays a pending row in order. When its commit fails it shows "Not sent" and the sidebar failed mark.
- Storybook: `Sessions/MessageQueueDisplay` `LocalUploadRows` and `LocalUploadOnly`.

## Limits

- Handoff is a remount at the same position, not DOM reuse. The real row's thumbnail loads from the uploaded image and may briefly show its placeholder.
- Only admission through the queue route sets `record.queue`. A guide send that falls back to a follow-up queue entry keeps its in-stream row until it is committed.

Related: [Sidebar send status](2026-09-28-sidebar-send-status.md), [Daemon-owned guide outcome](../bug-fix/2026-09-28-daemon-owned-guide-outcome.md), [Deferred attachment send](../architecture/2026-09-14-deferred-attachment-send.md).
