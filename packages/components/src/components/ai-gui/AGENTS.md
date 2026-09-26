# components/ai-gui

Edit `AGENTS.md`, not its `CLAUDE.md` symlink. Ownership: [README.md](README.md).

## Stream And Search

- Search indexes prose only: user/assistant text, thinking, and proposed-plan
  markdown, including folded prose; matches open their groups. Never index tools
  (titles/JSON/output), terminals, diffs, plan checklists, goals, or worktree script
  output. Never wire `searchBlockId` to tool, terminal, or diff renderers.
- Window stream readiness must use the same hydration/initial-scroll conditions as
  viewport visibility; hydrated history alone cannot reveal a native window.
- `SessionChatStreamView` uses one `keyed` `@lody/virtua` list with stable row keys (no `shift`).
  Map history indexes to rows. Collapsed activity is one row; expanded details
  are siblings, never nested scrollers or fixed-height process panels.
- Native text selection retains its complete row corridor and history leases;
  hold prose/folding, keep actions live, and release on clear. See [README.md](README.md#native-text-selection).
- `buildChatStreamItems()` must drop empty assistant entries and de-duplicate
  history ids.
- `leadingContent` is a real first row: include it in sticky counts and scroll
  targets; never overlay or persist it.
- Empty-state presentation stays outside Virtua, even with an empty leading Fragment:
  zero-height caches can hide the first user row. Preserve live activity labels/tones.
  Apply the header inset once to the whole scroller.
- Create `operation_progress` cards update in place per materialized target; bind
  status to its exact Turn and subscribe only to its title. `progressMessageId`
  suppresses duplicate completion cards; legacy completions keep successful-target
  cards. Rationale: [README.md](README.md#creation-progress).

## Turn Folding And Layout

- Finished turns keep the answer/result tail visible and fold earlier work;
  streaming turns stay expanded.
- The final answer is the final contiguous run of text before trailing
  never-collapsed items, not always the last item: walk backward through
  adjacent text blocks until a non-text boundary.
- A turn may hold several `AssistantTurnRenderSegment`s; a plan approval inside a
  running turn cuts a segment. Match ACP kind `switch_mode`, never a title
  (`plan-surface.ts`). Keep
  `workBlockKeys`, `hasVisibleFinalContent`, last-item visibility, and
  `expandedWorkedGroups` per segment; expansion keys include the segment. Only
  the last region may show a duration; earlier ones say "Finished working".
- `shouldUseWorkedGroup` requires a finished turn, foldable work, and visible
  final content outside `workBlockKeys`. A cancelled/interrupted or tool-only
  turn with no answer stays expanded; `message.finished` cannot prove
  completion alone. A reused assistant entry that
  reopens upstream must clear `finished` and `endedAt` (see
  `apps/cli/src/session/AGENTS.md`).
- Thought and tool rows share one compact transparent timeline and 13px
  hierarchy, with no glyphs: the verb says the kind of step. A background or
  subagent task opens a popover peek from its row, never a dialog. Execute calls are not cards. Desktop disclosure headers use
  body type, a hover-only trailing chevron, no fill, and no thought rows.
  Turns are avatar-free and full-width; run config lives in the footer.
- Duration has one owner: desktop uses `WorkedGroupHeader` for folded turns and
  the footer after buttons otherwise; mobile always uses the footer before
  buttons, and the worked header suppresses its copy. Preserve
  `MOBILE_TURN_ACTION_LEADING_INSET_PX` so actions clear the edge-back strip.
- Live status precedes a trailing subagent task summary, including when the turn
  has no footer.
- Streaming replies use a direct Copy action and turn-config info (set at open);
  Fork controls and loading need a finished turn.
- The gutter belongs to `ConversationColumn`, not Virtua. EVERY row shares one left rail with no shell pad, INCLUDING
  the contents of an expanded region: expanding reveals rows, it never shifts
  them right; the chevron carries the hierarchy. Prose, desktop group/status
  labels, and steps share a fixed 4px inset. Steps use `px-[4px]` with
  no negative margin; the footer bleeds only on the trailing edge (`-mr-[7px]`).
  See `AssistantTurnAlignment.stories`.

## Conversation Outline

- Before changing the outline rail, its arrival intent, or any row-index-to-scroll
  conversion, read [conversation-outline.md](conversation-outline.md). It binds
  every caller: `scrollRowToTop` is the ONE such conversion, group toggles never
  scroll, and follow-output suppression is owned by `pendingOutlineJumpRef`.

## Content Contracts

- Native child cancel requires subagentCancellation v1 and an exact parent turn;
  never use durable whole-turn Stop or invent a terminal state in the panel.

- `--ui-font-size` is the 1em baseline; compact chrome is 0.9em. Conversation
  body/headings/mono/terminal still scale through
  `conversation-font-size-classes.ts`. Only streaming turns load the stream
  engine; else static.
- A Mermaid diagram in a message is a still preview until a pointer click
  activates it, and an unmodified wheel is NEVER taken — activated or not.
  Deactivation preserves pan/zoom and activation adds no outline; see the
  [inline view contract](../../../../../specs/mermaid-inline-view.md).
  `mermaid-diagram-viewer.tsx` stays the only full-screen surface, reached from
  the block's action bar. Invariants:
  [mermaid-diagram-rendering.md](mermaid-diagram-rendering.md).
- `chat_failed` and `agent_warning` share ONE always-open `AgentNoticeBanner`,
  never a modal, and fold onto the emitting assistant row at RENDER time only —
  never into the `ConversationView` that copy/share/replay read. Extraction
  stays in `chat-failed-error-report.ts`. Invariants, tones, and capacity-retry
  consent: [agent-notices.md](agent-notices.md).
- Terminal persistence and legacy preview bounds live in
  `context/terminal-output-lifecycle.md`. Never send full legacy output through
  ANSI parsing, search, or React rendering.
- `assistant-edited-files.tsx` shows four paths before expanding, no per-file
  pills, list on `--background`.
- Update `message-content-guards.ts` with every shared `MessageContent` variant.
  `isMessageContent` gates rendering; a missing case silently drops the item.
- A user entry marked by `SessionMeta.lastMissingHistoryUserMsgId` renders the
  terminal "Not delivered" label. That label is the only recovery entry: its
  dialog resends the same content as a new ordinary message, then marks the old
  entry `canceled` while retaining the marker as a tombstone. Never automatically
  dispatch or revive the old turn.
- User rows show names right of time; desktop avatars open accessible name/email
  cards, mobile avatars do not.
- Attachment and mobile image-preview invariants live in
  [session-files-rendering.md](session-files-rendering.md).
- Markdown images remember each source's natural size or failure for the page's
  life: a Virtua remount must render at its final height (failed sources show alt text).
