# Sidebar send status replaces the pending-send panel

Status: proposed
Translation: current

[中文](2026-09-28-sidebar-send-status.zh.md)

## Abstract

The workspace pending-send panel ("Pending messages (1)") floated in the bottom-right corner, popped in and out for short uploads, and competed with the conversation's own pending rows. A motion pass (float-in, percent bar, checkmark exit) still read as a separate, loud surface. The panel is removed. Unsent messages now show where the conversation already lives: the desktop sidebar row. A new conversation's title stays muted until its first message is in history, and the row's single status mark shows a ring filling with the bytes sent, or a red alert when the send stopped. Recovery actions (Continue sending, Cancel, Discard) remain on the in-conversation pending rows. All of this is renderer-local; nothing is synchronized.

## Decision

- `deriveSessionSendStatuses` (`lib/session-send-status.ts`) projects journal records per session. Only `saved` and `prepared` records count, the set the conversation's pending rows show; `committed` records are already in history and read as ordinary turns. A record with `error` or `activity: 'interrupted'` makes the session `failed`; otherwise it is `sending`. Bytes come from attachment sources (or ready sizes) and per-attachment progress; without measurable bytes the ring is indeterminate.
- `SessionSendRecovery` keeps only the workspace duties: pending placeholder metadata, journal refresh, exit guards and the exit dialog. It writes `sessionSendStatusesAtom`; journal read failures become a toast.
- Row priority is `failed > waiting > working > sending > unread`. A failed send outranks everything because nothing else will retry it; an upload yields to the agent's own activity. One mark per row, in `SidebarRowEndSlot`.
- Upload progress is high-frequency. Only the end-slot leaf subscribes to per-session status (`sessionSendStatusAtomFamily`), so memoized rows do not re-render. Titles read the boolean `sessionUnsentNewConversationAtomFamily`. Folded groups and layout components read the progress-free `sessionSendStatesAtom`, which changes only on start, failure and completion.
- Folded groups count `failed` and `sending` with the other statuses and draw the same single mark; the hover description gains "N not sent" and "N sending".
- Follow-up messages in an existing conversation show the mark only; their title does not mute.
- The journal publishes a freshly admitted record as `active`: the admitting caller always starts its work next, and publishing it as interrupted flashed a failure mark in the sidebar between admission and submission. Refresh and finished work restore the observed value.
- The byte text ("Sending · 12.4 MB / 38.0 MB") is the mark's `aria-label`, not a tooltip. The row's overlay link and desktop hover card own pointer hover; a second hover surface on the end slot would open with them.

## Alternatives

- Delay the panel ~10 s: fewer flashes, but a long silent gap after the user leaves the conversation.
- Keep the panel with motion and a hide button: implemented and reviewed; still a second surface competing with the rows.
- Mute the whole row or all titles while sending: follow-ups are ordinary conversations; only a conversation that does not exist in history yet should read as provisional.

## Verification

- `tests/session-send-recovery.test.tsx`: a real journal drives a new conversation's row from sending (aria bytes, muted title) to failed to sent (no mark, regular title).
- `tests/session-list-pr-badge.test.ts`: row priority and folded-group rollup with send states.
- `tests/session-send-journal.test.ts`: admission publishes active work.
- Storybook: `Components/Sidebar/Send Status` (`States`, `Live`).

## Limits

- Mobile session lists do not show send status; their in-conversation rows still do.
- The panel's discard entry for `committed` records waiting on delivery is gone; those records remain protected by exit guards and retry through the conversation.
- The byte count is not visible on pointer hover.

Related: [Queue-bound uploads render as local rows in the queue sheet](2026-09-28-local-queue-pending-rows.md), which also records the ring's upload shimmer.
