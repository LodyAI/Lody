# sessions/message-queue — queued turns

`CLAUDE.md` is a symlink to this file. Edit `AGENTS.md` only.

Read the parent [sessions AGENTS.md](../AGENTS.md) first. This scope renders the
queued-turn list (`message-queue-display.tsx`, `message-queue-row.tsx`,
`queued-image-preview.tsx`, `use-message-queue-editing.ts`) that
`session-chat-input-area.tsx` mounts. Submission routing into the queue lives in
`../session-message-submit-route.ts` and is described in
[.agents/docs/sessions-live-status.md](../../../../../../.agents/docs/sessions-live-status.md).

Composer routing and queued-row native steering share one capability predicate.
Native acknowledged steering is available only when the
authoritative ACP capability cache advertises it. Never infer steering support
from built-in/custom config type or agent identity. Every row offers Steer
while native steering is available; without it only the FIRST row keeps the
interrupt-and-send fallback, because interrupt always runs the queue head next.

The queue intentionally stays OUT of the composer info bar's items
([.agents/docs/sessions-info-bar.md](../../../../../../.agents/docs/sessions-info-bar.md)).
It renders through the bar's `queue` slot as an inset sheet (composer fill, rounded
top, square bottom) sitting directly on the bar, or on the composer when the bar
has nothing to show; never with a gap, and never inside the input area.

Coarse-pointer and narrow-screen actions use real, non-overlapping 44 px boxes
on a separate row; fine-pointer desktop actions stay compact. Intent:
[queue touch actions](../../../../../../specs/message-queue-touch-actions.md).

Queue-bound sends held in memory (`runtime.pendingSends`) while attachments
prepare render here as local rows (`pending-queue-row.tsx`) after the real items,
never in `mq` and never in the conversation stream. They are display-only (retry
and cancel only; no drag, edit or steer) and are hidden by `userTurnId` once the
real item exists. Upload progress is subscribed only inside the sheet; the page
reads `useHasPendingQueueRecords`. Decisions: [local queue rows](../../../../../../.agents/notes/implemented/feature/2026-09-28-local-queue-pending-rows.md),
[in-memory held sends](../../../../../../.agents/notes/implemented/simplification/2026-09-29-remove-session-send-journal.md).

The queue disclosure is local display state, initially expanded. Keep its editing
rows mounted while folded; focusing the disclosure must not commit or discard a
row draft. Folded summaries retain pending/failed-send awareness. Intent:
[queue presentation](../../../../../../specs/message-queue.md).
