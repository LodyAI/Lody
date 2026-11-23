# Where the per-session key of the conversation surface can sit

Status: proposed
Translation: current

[中文](2026-09-23-session-surface-key-boundary.zh.md)

## Abstract

`session-detail.tsx` mounts each conversation surface with `key={tabSession.id}`, so a session
switch unmounts and remounts all of `SessionChatInterface`. Moving the key down would let React
reuse session-agnostic chrome, but every piece of state below the key that relies on remount
would then carry the previous session into the next one. This note records where that state is,
which actions could target the wrong session, how much reuse would save, and the boundary that
keeps sessions isolated.

## Evidence

A React DevTools-hook census on the production preview (10 keyboard switches between cached
conversations) counted mounts per switch by nearest region:

| Region | Components | DOM nodes |
| --- | --- | --- |
| `SessionChatStreamView` (conversation rows) | 944 | 380 |
| composer (`ChatComposer`, mention textarea, input area) | 120 | 37 |
| `SessionChatInterface` itself | 43 | 9 |
| `SessionInfoBar` | 36 | 29 |
| `SessionHeaderMenu` | 34 | 5 |
| `DesktopRunConfigMenu` | 26 | 7 |

The conversation body must remount (new content, Virtua's size cache, scroll controller and read
window are per session). Reusable chrome is ~260 components and ~90 DOM nodes, about a fifth of
the mount work. Inside the conversation body, ~21 rows mount per switch; row tooltips, popovers
and context menus (`SessionForkDestinationPopover`, `AssistantTurnFooter`,
`AssistantTurnConfigInfoButton`, `UserMessageRowView`, `AgentFileLink`) expand into ~360 Radix
components that only matter on hover or click.

## Findings

**The root leak: `useSessionDoc` lags one render.** Its store, history, `ready`, queue and
`syncState` change only in an effect. A reused instance renders the new `session` with the old
document once; its write callbacks already use the new id. Run config, MCP ids, the durable Agent
Role (whose effects then write the old snapshot into the new session's atom), the active turn id
(stop and guide), pending permissions, the queue and content-sync state are all derived from it.
The store carries `sessionId`, so a render-time check can close this.

**State that relies on remount** (would leak if reused):

- `SessionChatInterface`: `pendingRemoteHtmlFileName` (its Confirm opens the new session's browser
  for the old session's file), `renameDialogTarget`, `isPrActionPending`,
  `isResolvingConflicts`, `pendingOwnerUserId`, `conversationPreparationSignalRef`; search state
  and the sending/plan-decision state are reset one commit late by effects.
- Hooks: `useSessionMcpSelection` clears its override only when the persisted ids change, so
  the old MCP choice is sent with the new session's turns when both persist the same (often
  empty) ids. `useCapacityAutoRetry` retargets its pending timer to the new session's
  `dispatchPrompt`. `useGitHubPrDetails` shows the old PR's checks (and enables Merge) until
  IndexedDB answers. `useAutoReview` shows the old run for a commit.
- Composer: `agentRoleEditor`, `ChatComposer` preview/drag state, `uncontrolledMentionValues`,
  and the open state of the attachment, run-config, permission and usage menus.
- Async continuations: after an `await`, `dispatchPrompt` callers read the shared composer ref
  (the new session's Agent Role), `anchorChatToMessage` scrolls the new stream, and failure paths
  write the new session's `inputActionState` / `directDispatchInFlightRef`.

**Already isolated:** every write targets `session.id` or `useSessionDoc` callbacks bound to it
at call time; `SessionChatInputArea` resets drafts, attachments and references in render; uploads
take an explicit target session; `<Mention key={draftKey}>` isolates the textarea DOM, undo stack
and IME; `useAcpSessionConfigSelectionState` and `useMessageSelection` fence in render;
`SessionHeaderMenu`, the stream and the share surfaces are keyed.

The desktop toolbar instance (`hideMessageArea`) is unkeyed and survives switches. Its
session-scoped UI state (port confirmation, rename target, pending PR, conflict and owner flags)
now stores the session it belongs to and is read only for that session, and
`useGitHubPrDetails` returns nothing until the current PR's cache read or fetch lands.

## Proposal

1. Keep the key where it is for now. Chrome reuse saves about a fifth of the mount work and needs
   every item above fixed first.
2. Take the larger, isolated win first: mount row tooltips, popovers and context menus on first
   hover, focus or click instead of with each row (done: `ui/interaction-arm.tsx`).
3. If chrome reuse is still wanted, move the key in this order:
   - `useSessionDoc` treats `loadedStore.sessionId !== sessionId` as not loaded in render.
   - The `SessionChatInterface` leaks move into the render-phase block that already resets
     action state; the two `useEffect([session.id])` resets move there too.
   - `useSessionMcpSelection`, `useCapacityAutoRetry`, `useGitHubPrDetails` and `useAutoReview`
     reset or fence on the session in render.
   - Async continuations read the Agent Role before awaiting and drop UI writes when the session
     changed.
   - Keys stay on: the conversation stream, `<Mention key={draftKey}>`, and each dialog or menu
     that holds session state.
