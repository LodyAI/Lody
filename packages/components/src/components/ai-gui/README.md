# components/ai-gui

Conversation rendering for a Session: the message stream, assistant turn folding,
the outline rail, and the markdown/terminal/file content surfaces.

Binding rules live in [AGENTS.md](AGENTS.md); this file is the directory index and
the reasoning behind those rules.

## Ownership

| Area      | Owner                                            | Contract                                                                          |
| --------- | ------------------------------------------------ | --------------------------------------------------------------------------------- |
| Stream    | `view.tsx`, `build-chat-stream-items.ts`         | Stable Virtua rows and scroll.                                                    |
| User rows | `view.tsx`                                       | Multi-member sender metadata and desktop profile.                                 |
| Turns     | `assistant-turn-render-blocks.ts`                | Activity groups and foldable segments.                                            |
| Outline   | `conversation-outline-*`                         | Round ticks and navigation.                                                       |
| Selection | [`message-selection.tsx`](message-selection.tsx) | Temporary message selection, drag rectangle, range modifiers, and edge scrolling. |

- `conversation-outline-rail.tsx` renders one tick per round (a user turn plus its
  work) and a hover preview; `conversation-outline-arrival-intent.ts` decides when
  a pointer heading for a tick counts as arrival.
- `markdown-renderer.tsx` wraps Streamdown; `markdown-diff-block.tsx` is the
  inline diff. Diagrams are split three ways: `use-mermaid-diagram-canvas.tsx`
  owns activation and the gestures that follow it, `mermaid-inline-canvas.ts` the
  pure zoom/pan geometry, and `mermaid-diagram-viewer.tsx` the full-screen
  surface. Invariants live in
  [mermaid-diagram-rendering.md](mermaid-diagram-rendering.md).
- `message-content-guards.ts` gates which shared `MessageContent` variants render.
- `chat-failed-error-report.ts` / `chat-failed-detail-dialog.tsx` own raw error
  extraction and its modal; `terminal-component.tsx` / `terminal-preview.ts` own
  terminal output.
- `session-file-card.tsx`, `session-file-preview-dialog.tsx`, and
  [session-files-rendering.md](session-files-rendering.md) own attachment and
  image-preview rendering.

## Coverage

`tests/build-chat-stream-items.test.ts`, `tests/conversation-outline*.test.ts`,
`tests/user-message-sender-identity.test.tsx`, the `ExtremeConversation` story,
`AssistantTurnAlignment.stories`, and the multiple-sender states in
`SessionConversationPage.stories.tsx`.

## Why the rules read the way they do

- **Final answer tails.** Generated `image_group`s and the `switch_mode`
  "Exited Plan Mode" card may follow an answer, so the answer is not necessarily
  the final stream item.

- **Virtua `shift={false}` and `bufferSize`.** Shifting reuses stale cumulative
  heights, so rows overlap. `bufferSize` is a trade between blank space during a
  fast scroll and keeping resizing rows mounted.
- **`buildChatStreamItems()` filtering.** An empty assistant entry renders `null`,
  which Virtua cannot measure, and a duplicate history id produces a duplicate key
  that desyncs the list.
- **`message.finished`.** It is also set during teardown, so it cannot prove that a
  turn completed.
- **Segment cuts.** A plan approval inside a running turn cuts a segment so the
  implementation stays folded under the plan it came from.
- **`RAIL_TRACK_WIDTH` from the peak width.** An undersized auto-overflow track
  scrolls sideways once magnification widens a tick.
- **Far-jump correction bound.** `OUTLINE_JUMP_MAX_CORRECTIONS` exists because the
  tail of the list may be clamped and would otherwise never reach tolerance.
- **`pendingOutlineJumpRef` instead of render state.** Clicking the already-active
  round may produce no commit, so a render-based flag never clears.
- **Word-level Streamdown `animated`.** It emits a span per word; the compositor
  cost is unbounded on a long turn.
- **The gutter rule.** Virtua rows are absolutely positioned and ignore scroller
  padding, so the rail has to come from `ConversationColumn`.
- **The Mermaid viewer replacement, and click-to-activate in a message.**
  Streamdown's own overlay could not be left on touch, and the pan/zoom canvas it
  wraps every diagram in swallowed page scrolls that merely passed under one. A
  diagram now becomes a canvas only when the reader asks for one, and an
  unmodified wheel is never taken either way:
  [mermaid-diagram-rendering.md](mermaid-diagram-rendering.md).

## Creation progress

`created-session-operation-card.tsx` owns each navigable child card and its title
subscription; `view.tsx` renders progress and completion rows. The stable
`operation_progress` row appears after target materialization and changes in place,
so a long-running child is reachable before its Operation completes. Status comes
from the creating Operation's target Turn, not later Session activity. Completion
rows linked by `progressMessageId` show a summary without creating a second set of
cards. Older histories without progress rows retain successful-target cards.

Coverage: `SessionRelationCard.stories.tsx`, `tests/session-relation-card.test.tsx`,
and CLI `tests/operation-progress-history.test.ts`. The latter uses real Loro Mirror
validation and snapshot reloads, because schema-free document fakes cannot detect
a missing persisted-history message variant.
