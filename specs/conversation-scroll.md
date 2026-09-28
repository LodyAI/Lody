# Conversation scroll

Status: draft
Translation: pending

## Scenario

A user opens a conversation, reads it, types in the composer and sends a message while
the agent's reply streams in. The conversation should show what the user is looking
for, and never move unless the user or the arrival of new output asks it to.

## Behavior

- **Following the end.** A conversation opened at its end, or scrolled back to the end
  by the user, stays on the latest output as it grows. Changing the composer's height,
  a mobile keyboard or a docked panel keeps it on the end.
- **Reading elsewhere.** Scrolling up (wheel, keys, scrollbar, touch) stops following at
  once. New output then grows below without moving what the user is reading. Scrolling a
  code block or terminal inside a message is not scrolling the conversation. The
  "scroll to latest" control returns to following.
- **Sending a message** while the agent is idle smoothly scrolls the sent message to
  the top of the viewport (instantly when the system asks for reduced motion) and
  leaves the space below it empty for the reply. The reply fills that space without
  moving the message; once it reaches the bottom, the conversation
  follows the end again. If the user scrolls up meanwhile, the empty space is given up
  as they scroll, never re-added, and scrolling down reaches the real end of the reply.
  A message taller than the viewport is shown from its end instead.
- **Queued or steering messages** sent while the agent is working do not move the view.
- **Loading.** A conversation that has messages but nothing on this device yet shows a
  skeleton of messages in place of a blank pane. A saved copy is shown at once; while
  this open is still catching up with the server, the info bar says "Updating". Nothing
  is added to the conversation itself. Routine opens that catch up quickly show
  neither (a status must persist briefly before it appears, and stays long enough not
  to flash). A lost connection is not announced here: reconnecting is automatic.
- **Opening** shows the conversation in its first painted frame and never hides it.
  A conversation left while following opens at its end; one left while reading opens
  with the row the reader was reading at the top, even if rows above it changed since.
  The first frame is already at that position: it does not flash through intermediate
  positions, and rows still being measured never leave the pane blank
  ([scroll engine](../.agents/notes/implemented/architecture/2026-09-27-conversation-scroll-engine.md)).

## Open questions

- On iOS, a position correction during a touch fling ends the fling. Whether that
  matters is decided from the engine's momentum counts after release; see the
  [scroll-engine note](../.agents/notes/implemented/architecture/2026-09-27-conversation-scroll-engine.md#write-forms).

## Evidence

- Implementation: `packages/components/src/lib/conversation-scroll/`,
  `packages/components/src/components/ai-gui/conversation-list/engine-conversation-scroller.tsx`,
  `packages/components/src/components/ai-gui/view.tsx`.
- Tests: `packages/components/tests/conversation-scroll-engine.test.ts` (model),
  `engine-conversation-scroller.test.tsx` (adapter),
  `conversation-viewport-contract.test.tsx`, and the browser specs
  `tests/e2e/conversation-scroll-engine.spec.ts` and `session-chat-hydration.spec.ts`
  (Storybook, Chromium). Not yet validated in the running desktop app or on iOS.
