# sessions/message-queue — queued turns

`CLAUDE.md` is a symlink to this file. Edit `AGENTS.md` only.

Read the parent [sessions AGENTS.md](../AGENTS.md) first. This scope renders the
queued-turn list (`message-queue-display.tsx`, `message-queue-row.tsx`,
`queued-message-details.tsx`, `queued-image-preview.tsx`) and the composer edit of a
queued turn (`queued-message-edit.ts`, `use-queued-message-composer-edit.ts`) that
`session-chat-interface.tsx` mounts through the composer info bar's queue slot. Submission routing into the queue lives in
`../session-message-submit-route.ts` and is described in
[.agents/docs/sessions-live-status.md](../../../../../../.agents/docs/sessions-live-status.md).

Composer routing and queued-row native steering share one capability predicate.
Native acknowledged steering is available only when the
authoritative ACP capability cache advertises it. Never infer steering support
from built-in/custom config type or agent identity. Every row offers Send while idle. Stop retains queued drafts as paused, and only
an explicit Send/Steer reissues the selected paused draft under a fresh input id.
While working, native steering serves every row. Without it, unpaused rows keep
only the first-row interrupt fallback; a paused row can explicitly submit its new
input and interrupt the current turn without releasing its paused siblings.

The queue intentionally stays OUT of the composer info bar's items
([.agents/docs/sessions-info-bar.md](../../../../../../.agents/docs/sessions-info-bar.md)).
It renders through the bar's `queue` slot as an inset sheet (composer fill, rounded
top, square bottom) sitting directly on the bar, or on the composer when the bar
has nothing to show; never with a gap, and never inside the input area.

Rows are inset tiles without hairline dividers; desktop rows share a 16 px index
gutter, mobile rows drop it. Actions always end the row and stay on the message line, because a separate action
line looked detached and cost a full row per item. Mobile rows, and any sheet
narrower than 520 px, fold them into one More button (a real 40 × 36 px box on 36 px touch rows)
whose menu preserves Steer, move-to-top, details, edit and delete when applicable. One-line
previews use ellipsis, not `display: -webkit-box`: that display ignores the clamp
inside the touch grid on iOS and the sheet paints the extra height black. The
scroll fade is a mask on a non-scrolling wrapper around the scroller. Never put
the mask on the overflow element, and never emit a zero-length `transparent` /
`#000` stop for an edge that does not overflow — WKWebView fills that layer black.
Prior intent:
[queue touch actions](../../../../../../specs/message-queue-touch-actions.md).

Queue-bound sends held in memory (`runtime.pendingSends`) while attachments
prepare render here as local rows (`pending-queue-row.tsx`) after the real items,
never in `mq` and never in the conversation stream. They are display-only (retry
and cancel only; no drag, edit or steer) and are hidden by `userTurnId` once the
real item exists. A failed local row shows its failure reason under its text, so
the sender can see what failed and what to do before choosing Continue sending.
Continue sending replaces the button with a loading status for at least a short
interval, so a retry that fails again at once still visibly registers; a
same-machine preparation failure names that step and the local agent, without
falling back to a cloud transfer. Upload progress is subscribed only inside the sheet; the page
reads `useHasPendingQueueRecords`. Decisions: [local queue rows](../../../../../../.agents/notes/implemented/feature/2026-09-28-local-queue-pending-rows.md),
[in-memory held sends](../../../../../../.agents/notes/implemented/simplification/2026-09-29-remove-session-send-journal.md).

A queued turn is edited in the composer, never inline in its row. Starting writes
only `isEditing`/`editingStartedAt`; content and run config are written once on Save
through `saveMessageQueueEdit` (the shared admission with `queueReplace`), replacing
the row under its message id. Renew the lock only while the edit is on screen; a
held save renews it from the runtime until it lands. A vanished row turns the edit
into a draft. Untouched saves cancel; real changes make the editor the author and
keep a frozen Role revision when the run config is unchanged. Local writes never
wait for remote synchronization. One row is edited at a time, and the edited row
offers no drag, steer, move or delete.
[Decision](../../../../../../.agents/notes/implemented/feature/2026-11-27-queued-message-composer-edit.md).

Details show the full message and frozen run config. Avatars appear only when
another member queued here; the difference tag only outside phones and sheets
narrower than 520 px.

The queue disclosure is local display state, initially expanded, never shared or
persisted. Folding never ends a composer edit. Pressing its header moves focus to
the header. Folded summaries retain pending/failed-send awareness. Intent:
[queue presentation](../../../../../../specs/message-queue.md).

Production passes a separate `scheduledItems` view model; never fake a
`MessageQueueItem` for a reservation. Keep dedicated rows after ordinary and
local-pending rows, ordered by send time, in a `Scheduled` section without index,
drag, steer or move-to-top. They reuse the queued row layout: the send time leads
the text inline and opens the time editor; details open the in-chat message
editor and cancel ends the row. Row text is the scheduled message's content; its
schedule title is never shown. Never fake a scheduled row through a queue item
or add a time field to durable `mq`.
