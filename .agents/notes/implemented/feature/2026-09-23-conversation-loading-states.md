# Conversation loading states

Status: implemented
Translation: current

[中文](2026-09-23-conversation-loading-states.zh.md)

## Abstract

Opening a conversation whose history was not yet on the device showed a blank pane,
because a local copy with no turns was treated exactly like an empty conversation: the
empty state rendered nothing and the info bar's Syncing indicator is suppressed for empty
conversations. It read as frozen rather than loading. Opens now distinguish three cases:
nothing cached (a message skeleton in the content area), a saved copy still catching up
(the info bar says "Updating" and the last row says newer messages are loading), and
current. The desktop visual result has unit coverage but has not been checked on a real
uncached open yet.

## Decision

- `lib/session-content-sync-state.ts` is a pure resolver. "Has messages" comes from
  `SessionMeta.lastMessageAt`, never from the CLI dispatch pointers (`latestUserMsgId`),
  which must not drive UI. "Caught up" is sticky per open: once the room reached
  `synced`, later `syncing` blips are live output on a current copy and stay quiet.
- The skeleton follows the Discord pattern of shape without text. It shows immediately,
  since the alternative is a blank pane. "Updating" and the last-row note show only after
  the state persists for 400ms and then stay at least 500ms
  (`hooks/use-displayed-content-sync-state.ts`), so routine opens show nothing.
- The last-row note is a Virtua row, like the agent activity row, so follow mode and the
  measurement observers see it appear and disappear.
- Degraded connections (reconnecting, disconnected, error) are deliberately not shown.
  A "may be out of date" state was removed earlier by product decision because the
  reconnect loop owns recovery (see `.agents/docs/sessions-auto-review.md`). Browser
  offline remains the info bar status chip. The proposal to show a saved-copy warning
  was therefore not implemented pending that decision.

## Limits

The first-catch-up signal cannot tell whether the saved copy is actually behind; a copy
that is already current still shows "Updating" if catching up takes longer than 400ms.
Mobile keeps its existing header indicator plus the last-row note. Related:
[conversation scroll spec](../../../../specs/conversation-scroll.md).
