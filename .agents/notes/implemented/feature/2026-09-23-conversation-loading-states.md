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
(the info bar says "Updating"), and
current. The desktop visual result has unit coverage but has not been checked on a real
uncached open yet.

## Decision

- `lib/session-content-sync-state.ts` is a pure resolver. "Has messages" comes from
  `SessionMeta.lastMessageAt`, never from the CLI dispatch pointers (`latestUserMsgId`),
  which must not drive UI. "Caught up" is sticky per open: once the room reached
  `synced`, later `syncing` blips are live output on a current copy and stay quiet.
- The skeleton follows the Discord pattern of shape without text. It is decided only after
  the local copy (IndexedDB, `openPersistedDoc`) has been read: every open starts with the
  store unready, and deciding before that flashed a skeleton on conversations that were
  cached. Once the read shows nothing cached, the skeleton shows immediately, since the
  alternative is a blank pane; a read still running after 400ms also shows it. Switching
  across 8 cached conversations twice then showed no skeleton, with rows in 130-380ms. "Updating" shows only after the state persists for 400ms and then stay at least 500ms
  (`hooks/use-displayed-content-sync-state.ts`), so routine opens show nothing.
- A "Loading newer messages" last row was tried and removed: a spinner inside the
  transcript looked out of place. The info bar alone carries the catch-up state.
- Degraded connections (reconnecting, disconnected, error) are deliberately not shown.
  A "may be out of date" state was removed earlier by product decision because the
  reconnect loop owns recovery (see `.agents/docs/sessions-auto-review.md`). Browser
  offline remains the info bar status chip. The proposal to show a saved-copy warning
  was therefore not implemented pending that decision.

## Switching without a blank frame

A per-frame screencast of switches between conversations already open in memory showed three
blank frames (~125ms) each: the store was acquired through a promise even when cached, the
initial tail was ready one promise tick after it was hydrated, and the reveal was a state
update from a ResizeObserver callback, which React commits in a later task, after the browser
has painted the hidden conversation. Virtua also learned our restore `scrollTop` only from
the next frame's scroll event, so it first rendered the old range (`offset-mismatch`,
`target-unmounted`).

- `ManagedStoreCache.peek` / `WorkspaceRuntime.peekSessionStore` return an open store
  synchronously; `useSessionDoc` renders it in its first commit and still acquires it in
  its effect.
- `useTurnRange` is ready in render once its whole range is hydrated.
- The reveal writes `visibility: visible` on the viewport directly (React's commit then
  writes the same value), and our own scroll writes before the reveal dispatch a `scroll`
  event so Virtua reads the offset in the same frame.

Measured on the production preview, second pass over six conversations: five open with the
rendered conversation as the first painted frame. The sixth still paints one blank frame: its
cached row heights were stale and a "Goal blocked" banner appears after mount and shrinks the
viewport; both corrections arrive in the next frame's ResizeObserver delivery. Conversations
not open in memory (released after 10 minutes, or after a reload) still open from IndexedDB
(`openPersistedDoc` plus an eager-sync snapshot read of up to 1.5s) and cannot meet one frame.

## Limits

The first-catch-up signal cannot tell whether the saved copy is actually behind; a copy
that is already current still shows "Updating" if catching up takes longer than 400ms.
Mobile keeps its existing header indicator. Related:
[conversation scroll spec](../../../../specs/conversation-scroll.md).
