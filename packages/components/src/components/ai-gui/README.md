# components/ai-gui

Conversation rendering for a Session: the message stream, assistant turn folding,
the outline rail, and the markdown/terminal/file content surfaces.

Builtin DeepSeek Harness keeps thought prose in expandable activity groups, including
a default-open Thought disclosure for groups without tools; explicit collapse is retained. Provider visibility is part of the
virtual-row cache identity; other providers retain their existing filtering.

Binding rules live in [AGENTS.md](AGENTS.md); this file is the directory index and
the reasoning behind those rules.

## Ownership

| Area                    | Owner                                                                                             | Contract                                                                                |
| ----------------------- | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Stream                  | `view.tsx`, `build-chat-stream-items.ts`                                                          | Stable Virtua rows and scroll.                                                          |
| User rows               | `view.tsx`                                                                                        | Multi-member sender metadata and desktop profile.                                       |
| Turns                   | `assistant-turn-render-blocks.ts`                                                                 | Activity groups and foldable segments.                                                  |
| Outline                 | `conversation-outline-*`                                                                          | Round ticks and navigation.                                                             |
| Image sharing selection | [`message-selection.tsx`](message-selection.tsx)                                                  | Temporary message selection, drag rectangle, range modifiers, and edge scrolling.       |
| Typography              | [`conversation-font-size-classes.ts`](conversation-font-size-classes.ts), `markdown-renderer.tsx` | Shared text roles; explicit preview size and compact tool prose without nested scaling. |
| Spacing and surfaces    | [`conversation.tokens.stylex.ts`](conversation.tokens.stylex.ts), [`surface.ts`](surface.ts)      | Themeable conversation anatomy, activity rows and user bubbles.                         |

- `conversation-outline-rail.tsx` renders one tick per round (a user turn plus its
  work) and a hover preview; `conversation-outline-arrival-intent.ts` decides when
  a pointer heading for a tick counts as arrival.
- `markdown-renderer.tsx` renders finished text with react-markdown and a
  streaming turn with `@lobehub/streamdown`. Its dependency patch reveals text
  already present at mount so switching back to a live Session does not replay
  the stream fade ([note](../../../../../.agents/notes/implemented/bug-fix/2026-09-26-streamdown-remount-animation.md)).
  A nonempty session search renders the complete current Markdown without the
  stream reveal animation, so index results and marks update together; clearing
  search resumes the stream engine. Search and outline summaries share
  `lib/session-chat-search.ts`'s CommonMark/GFM text extraction, preserving literal
  punctuation in prose and code while removing parsed formatting delimiters.
  [Decision and synthetic acceptance evidence](../../../../../.agents/notes/implemented/bug-fix/2026-10-07-session-search-literal-punctuation.md).
  Conversation paragraphs use start alignment during and after streaming; see
  [conversation Markdown alignment](../../../../../specs/conversation-markdown-alignment.md).
  `markdown-code-block.tsx` owns fenced
  blocks, wrap, and Markdown-fence preview (`markdown-code-highlight.ts` the Shiki
  tokens); `markdown-diff-block.tsx` is the inline diff; `markdown-mermaid-block.tsx`
  renders a closed Mermaid fence. Diagrams are split three ways: `use-mermaid-diagram-canvas.tsx`
  owns activation and the gestures that follow it, `mermaid-inline-canvas.ts` the
  pure zoom/pan geometry, and `mermaid-diagram-viewer.tsx` the full-screen
  surface. Invariants live in
  [mermaid-diagram-rendering.md](mermaid-diagram-rendering.md).
- A `[Title](session://<id>)` link (the form session mentions reach the agent in)
  renders as a conversation chip. `session-link-context.tsx` supplies the Session
  navigation from `SessionChatInterface`; without it, or on a read-only share, the
  chip is inert.
- `message-content-guards.ts` gates which shared `MessageContent` variants render.
- `markdown-file-image.tsx` binds live file Markdown to its owning provider. Local
  resources load automatically; remote file images show a one-line recessed slot
  (alt, file name, Load image) and load on click. Relative paths use the opened document; Blob URLs last only for the mounted
  image. Uploaded attachments without a file provider keep their existing behavior.
- `chat-failed-error-report.ts` owns raw error extraction; `view.tsx`'s
  `AgentNoticeBanner` renders warnings and failures, and
  `build-chat-stream-items.ts` folds them onto the emitting turn. Invariants live
  in [agent-notices.md](agent-notices.md). `chat-failed-detail-dialog.tsx` is the
  retired modal, no longer reached from the conversation.
  `terminal-component.tsx` / `terminal-preview.ts` own terminal output;
  `tool-call-detail.tsx` is an expanded tool step's sheet.
  `tool-call-command.ts` formats its command and suppresses text echoes whose
  visible command matches it, including echoes with Markdown-linked paths;
  result text remains in the sheet. The
  [linked-echo fix](../../../../../.agents/notes/implemented/bug-fix/2026-09-29-linked-tool-command-echo.md)
  records the matching boundary.
- `conversation-outline-rail.tsx`, `conversation-outline-rail-geometry.ts`, and
  `conversation-outline-arrival-intent.ts` own the reader-position rail.
  Invariants live in [conversation-outline.md](conversation-outline.md).
- `session-file-card.tsx`, `session-file-preview-dialog.tsx`, and
  [session-files-rendering.md](session-files-rendering.md) own attachment and
  image-preview rendering.

## Spacing and themes

Conversation spacing and colours use the semantic `conversation` StyleX variable
group, derived from `@lody/ui` space, radius and colour tokens or the active VS Code
palette. `surface.ts` owns shared row and bubble styles; the Markdown renderer and
code block own their element styles. A host can apply `createTheme(conversation, …)`
to a subtree to change these values without descendant utility overrides.
`scopedConversationTheme` rebinds the defaults on a host that pins its own CSS
palette, such as a share card. CSS aliases resolve where they are declared;
inheriting the root aliases would retain the app's colours even after that host
changes the underlying theme variables. Share cards also bind the product colour
theme locally. Code-block dark styling respects `.light-scope` and `.dark-scope`.

Activity thought prose uses compact Markdown at the same subheadline size and
leading as its summary and tool rows, in the parent conversation and task dialog.
Reading prose and user text use `readingLeading`, derived from the body role
at 1.2 times its leading (24px at 14px). Compact tool prose and code retain their
control leading. Explicit previews scale the reading token with their own size.
Spacing follows the active interface leading through semantic `responseGap`,
`roundGap`, `activityPitch`, `proseGap`, `paragraphGap`, `surfaceGap` and `listItemGap` tokens.
Progress prose and activity summaries keep the prose gap inside expanded work;
individual tool details keep their compact pitch.
The user row reserves the response gap for its actions. The first assistant row
adds no top gap; its last row reserves the next-round boundary only before a user
turn. Footer actions and the next user's metadata share that reserve; larger
footer content grows naturally. User text retains authored whitespace and the
existing reading rail. The [rhythm Spec](../../../../../specs/conversation-rhythm.md)
owns formulas and size examples; [the decision](../../../../../.agents/notes/implemented/simplification/2026-10-03-conversation-rhythm-stylex.md)
records evidence and retained CSS boundaries.

## Coverage

`InterfaceTypography.stories.tsx` composes real settings and surfaces;
`tests/e2e/interface-typography.spec.ts` checks computed type metrics, portals,
five-tier persistence, legacy preferences, themes and narrow desktop layout.
See the [global scale decision](../../../../../.agents/notes/implemented/simplification/2026-10-03-interface-typography.md)
for scope and retained exceptions.
`AssistantTurnAlignment.ConversationRhythm` renders a synthetic two-round conversation;
`ConversationRhythmTheme` applies a scoped StyleX theme to the same components.
`ConversationRhythmReading` and its streaming variant add continuous mixed-script
paragraphs to verify real wrapped-line pitch and compare reading density.
`ConversationRhythmProgress` and its streaming variant interleave long progress
paragraphs with tool summaries to check separation inside and outside folded work.
The no-footer and edited-files variants exercise boundary reserves without a
footer and with taller footer content. The typography browser suite checks all
five interface sizes, measured activity/turn spacing, preserved
user blank lines, keyboard access to actions, list pitch, folding, and token overrides.

`tests/build-chat-stream-items.test.ts`, `tests/conversation-outline*.test.ts`,
`tests/user-message-sender-identity.test.tsx`, the `ExtremeConversation` story,
`AssistantTurnAlignment.stories` (including the scroll-to-latest working and waiting
states), `ConversationViewStream.OpenWithBackgroundFacts` (open, then release fact
batches to check the visible tail), and the multiple-sender states in
`SessionConversationPage.stories.tsx`.

The assistant footer's duration — live and finished on desktop, and the leading
slot on mobile — is pinned by `tests/assistant-turn-action-inset.test.ts`,
`tests/chat-virtual-rows-identity.test.ts`, and
`tests/session-history-duration.test.ts`. The desktop live state is shown by
`AssistantTurnAlignment.stories.tsx`; `MobileTurnDurationSlot.stories.tsx` shows
the mobile live and finished states. `tests/agent-activity-row.test.tsx` covers
live status placement above the subagent task summary, both with and without
footer actions, task-summary expansion, and the scroll-to-latest icon while work
is streaming or waiting for permission. `AssistantTurnAlignment.stories.tsx`
provides the same two states as Storybook interaction stories; its play function
uses a synthetic upward wheel because a real scrollbar gesture is not reliable in
the Storybook canvas.
The [compact duration Spec](../../../../../specs/compact-duration-spacing.md)
defines locale-specific spacing for these labels.

## Why the rules read the way they do

- **Final answer tails.** Generated `image_group`s and the `switch_mode`
  "Exited Plan Mode" card may follow an answer, so the answer is not necessarily
  the final stream item.

- **Keyed sizes and `bufferSize`.** Placeholder turns expand in the middle of the
  list, so the scroll engine keeps sizes with row keys and holds the reader's row
  through its reading anchor
  ([note](../../../../../.agents/notes/implemented/architecture/2026-09-27-conversation-scroll-engine.md)).
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
- **One outline jump, no correction pass.** The scroll engine's reading anchor
  keeps the jumped row at the top while the rows around it are measured and
  hydrate. The Virtua-era loop re-issued the jump by a stored row index, which
  went stale as placeholders expanded and landed rounds past the target.
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
the reader is there. `subagent-run-history.tsx` groups `run.items` with the conversation's
`buildAssistantTurnRenderBlocks`; `view.tsx` supplies the same activity headers,
Markdown, plans and tool detail renderers used by the parent turn. Activity groups
start open and can be folded without hiding the surrounding prose; their state
survives streamed updates. File links use the parent session's file-open callback.
No `searchBlockId` is passed: search indexes the conversation, not a dialog.

`subagent-task-state.tsx` owns task aggregation and display-state helpers;
`subagent-task-panel.tsx` owns rows and the selected task;
`subagent-task-detail.tsx` owns the dialog body and cancellation. Panel, detail and
run-history styles each live in their adjacent `.stylex.ts` file and use shared
conversation spacing and UI text tokens. Background command briefs use the same
`ToolCommandSection` and `ToolDetailSheet` as tool steps, including shell highlighting
and conversation font sizing. The brief and activity share one vertical scroller.

State comes from `run.snapshot.state` when present; the legacy `status` cannot
say cancelled or unknown. `unknown` means Lody lost sight of the run, so the
group never waits on it. A run whose provider streams nothing says so rather
than looking stalled, and `outputIncomplete` is stated under what arrived. Stored
run history renders whatever the machine's state; only Stop waits on
`machineSupportsSubagentEvents` and the run's `support.cancel`. Behaviour is
pinned by `tests/subagent-task-panel.test.tsx` and shown by
`SubagentTaskPanel.stories.tsx`.

The dialog is capped (`min(760px, 85dvh)`) and scrolls its body with the app's
`scrollbar-pro` skin. On mobile the session lives in a Vaul drawer, and a body
portal is outside that drawer's modal boundary: its scroll lock ate every touch
scroll and a sideways swipe dragged the session away. So inside a
`[data-vaul-drawer]` the dialog mounts in the drawer, `data-vaul-no-drag`,
with a no-drag layer over its backdrop (`InMobileDrawer` story).

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

## Message authors

`message-author-identity.tsx` renders frozen Agent/Role identity in input avatars.
Assistant replies do not show an author identity entry or its popover. It reads no catalogs or source documents. Human profiles remain
in `view.tsx`; execution controls continue to describe the receiving turn. The
[identity contract](../../../../../specs/message-author-identity.md) defines capture,
recovery and legacy behavior.
