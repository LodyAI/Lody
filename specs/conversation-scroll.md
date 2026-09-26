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
- **Opening** reveals the conversation only once it can be shown at its restored
  position; it must not flash through intermediate positions, and late row measurements
  must not leave it hidden
  ([initial scroll recovery](../.agents/notes/implemented/bug-fix/2026-09-23-initial-scroll-recovery.md)).

## Open questions

- The cause of repeated flicker when opening long conversations is not established; see
  the [follow-mode note](../.agents/notes/implemented/architecture/2026-09-23-conversation-follow-modes.md).

## Evidence

- Implementation: `packages/components/src/hooks/use-sticky-scroll.ts`,
  `packages/components/src/components/ai-gui/view.tsx`.
- Unit tests: `packages/components/tests/use-sticky-scroll.test.ts`. Not yet validated
  in the running desktop or Web app.
