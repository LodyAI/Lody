# components/ai-gui

Conversation rendering for a Session: the message stream, assistant turn folding,
the outline rail, and the markdown/terminal/file content surfaces.

Binding rules live in [AGENTS.md](AGENTS.md); this file is the directory index and
the reasoning behind those rules.

## Ownership

| Area                    | Owner                                            | Contract                                                                          |
| ----------------------- | ------------------------------------------------ | --------------------------------------------------------------------------------- |
| Stream                  | `view.tsx`, `build-chat-stream-items.ts`         | Stable Virtua rows and scroll.                                                    |
| User rows               | `view.tsx`                                       | Multi-member sender metadata and desktop profile.                                 |
| Turns                   | `assistant-turn-render-blocks.ts`                | Activity groups and foldable segments.                                            |
| Outline                 | `conversation-outline-*`                         | Round ticks and navigation.                                                       |
| Image sharing selection | [`message-selection.tsx`](message-selection.tsx) | Temporary message selection, drag rectangle, range modifiers, and edge scrolling. |

- `conversation-outline-rail.tsx` renders one tick per round (a user turn plus its
  work) and a hover preview; `conversation-outline-arrival-intent.ts` decides when
  a pointer heading for a tick counts as arrival.
- `markdown-renderer.tsx` renders finished text with react-markdown and a
  streaming turn with `@lobehub/streamdown`. Its dependency patch reveals text
  already present at mount so switching back to a live Session does not replay
  the stream fade ([note](../../../../../.agents/notes/implemented/bug-fix/2026-09-26-streamdown-remount-animation.md)).
  `markdown-code-block.tsx` owns fenced
  blocks, wrap, and Markdown-fence preview (`markdown-code-highlight.ts` the Shiki
  tokens); `markdown-diff-block.tsx` is the inline diff; `markdown-mermaid-block.tsx`
  renders a closed Mermaid fence. Diagrams are split three ways: `use-mermaid-diagram-canvas.tsx`
  owns activation and the gestures that follow it, `mermaid-inline-canvas.ts` the
  pure zoom/pan geometry, and `mermaid-diagram-viewer.tsx` the full-screen
  surface. Invariants live in
  [mermaid-diagram-rendering.md](mermaid-diagram-rendering.md).
- `message-content-guards.ts` gates which shared `MessageContent` variants render.
- `chat-failed-error-report.ts` owns raw error extraction; `view.tsx`'s
  `AgentNoticeBanner` renders warnings and failures, and
  `build-chat-stream-items.ts` folds them onto the emitting turn. Invariants live
  in [agent-notices.md](agent-notices.md). `chat-failed-detail-dialog.tsx` is the
  retired modal, no longer reached from the conversation.
  `terminal-component.tsx` / `terminal-preview.ts` own terminal output.
- `conversation-outline-rail.tsx`, `conversation-outline-rail-geometry.ts`, and
  `conversation-outline-arrival-intent.ts` own the reader-position rail.
  Invariants live in [conversation-outline.md](conversation-outline.md).
- `session-file-card.tsx`, `session-file-preview-dialog.tsx`, and
  [session-files-rendering.md](session-files-rendering.md) own attachment and
  image-preview rendering.

## Coverage

`tests/build-chat-stream-items.test.ts`, `tests/conversation-outline*.test.ts`,
`tests/user-message-sender-identity.test.tsx`, the `ExtremeConversation` story,
`AssistantTurnAlignment.stories`, `ConversationViewStream.OpenWithBackgroundFacts`
(open, then release fact batches to check the visible tail), and the multiple-sender states in
`SessionConversationPage.stories.tsx`.

The assistant footer's duration — live and finished on desktop, and the leading
slot on mobile — is pinned by `tests/assistant-turn-action-inset.test.ts`,
`tests/chat-virtual-rows-identity.test.ts`, and
`tests/session-history-duration.test.ts`. The desktop live state is shown by
`AssistantTurnAlignment.stories.tsx`; `MobileTurnDurationSlot.stories.tsx` shows
the mobile live and finished states. `tests/agent-activity-row.test.tsx` covers
live status placement above the subagent task summary, both with and without
footer actions, and task-summary expansion.
The [compact duration Spec](../../../../../specs/compact-duration-spacing.md)
defines locale-specific spacing for these labels.

## Why the rules read the way they do

- **Final answer tails.** Generated `image_group`s and the `switch_mode`
  "Exited Plan Mode" card may follow an answer, so the answer is not necessarily
  the final stream item.

- **Keyed `@lody/virtua` and `bufferSize`.** Upstream `shift` reuses stale
  cumulative heights (rows overlap) and only covers rows added at the start;
  placeholder turns expand in the middle. The keyed fork keeps sizes with row keys
  and the row at the viewport start in place
  ([note](../../../../../.agents/notes/implemented/architecture/2026-09-24-virtua-keyed-fork.md)).
  `bufferSize` is a trade between blank space during a fast scroll and keeping
  resizing rows mounted.
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
- **Static rendering once a turn finishes.** The stream engine fades only the
  in-flight tail, but it still parses per block and ships lookbehind regex
  literals that Safari < 16.4 cannot parse; finished text never needs either
  ([note](../../../../../.agents/notes/implemented/feature/2026-09-26-lobehub-streamdown.md)).
- **No replay on a live row remount.** A session switch or virtualized row
  remount can mount a stream with existing text. The patched engine seeds that
  text as revealed and continues to animate later additions.
- **The gutter rule.** Virtua rows are absolutely positioned and ignore scroller
  padding, so the rail has to come from `ConversationColumn`.
- **The Mermaid viewer replacement, and click-to-activate in a message.**
  The earlier bundled overlay could not be left on touch, and the pan/zoom canvas
  it wrapped every diagram in swallowed page scrolls that merely passed under one. A
  diagram now becomes a canvas only when the reader asks for one, and an
  unmodified wheel is never taken either way:
  [mermaid-diagram-rendering.md](mermaid-diagram-rendering.md).

## Subagent tasks

`subagent-task-panel.tsx` renders a turn's `subagent_task` items as one card of
ruled rows. A row's first line is the task and its time; a running task adds a
second line with its latest step, taken from the last `run.items` entry, then
`run.progress`, then the legacy `summary`/`lastToolName`, so older tasks keep
working. A row opens the panel's ONE dialog by task id (not a snapshot), so a
streaming run keeps updating inside it and the view follows the end only while
the reader is there. The dialog renders `run.items` through `view.tsx`'s turn
renderers (`SubagentRunHistory`) and never passes a `searchBlockId`: search
indexes the conversation, not a dialog.

State comes from `run.snapshot.state` when present; the legacy `status` cannot
say cancelled or unknown. `unknown` means Lody lost sight of the run, so the
group never waits on it. A run whose provider streams nothing says so rather
than looking stalled, and `outputIncomplete` is stated under what arrived. Stored
run history renders whatever the machine's state; only Stop waits on
`machineSupportsSubagentEvents` and the run's `support.cancel`. Behaviour is
pinned by `tests/subagent-task-panel.test.tsx` and shown by
`SubagentTaskPanel.stories.tsx`.

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

## Native text selection

[`use-conversation-text-selection.ts`](../../hooks/use-conversation-text-selection.ts)
owns native range retention, history leases, and incomplete-copy protection.
`view.tsx` supplies stable row identities, `keepMounted`, folding snapshots, and
follow suppression; `markdown-renderer.tsx` holds selected prose presentation.
Session data and action controls continue updating. This is independent of
`message-selection.tsx`, which selects messages for image sharing.

The [decision note](../../../../../.agents/notes/implemented/bug-fix/2026-09-20-conversation-text-selection.md)
records lifecycle, alternatives, and platform verification limits.
