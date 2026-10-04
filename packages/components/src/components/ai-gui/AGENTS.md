# components/ai-gui

Edit `AGENTS.md`, not `CLAUDE.md` (symlink). [Ownership](README.md).

## Stream And Search

- Search indexes only user/assistant prose, thinking and proposed-plan Markdown,
  including folded prose; matches open groups. Exclude tools (titles/JSON/output),
  terminals, diffs, plan checklists, goals and worktree-script output. Never wire
  `searchBlockId` to tool, terminal or diff renderers.
- Window readiness and viewport visibility share hydration/initial-scroll gates;
  hydrated history alone cannot reveal a native window.
- `SessionChatStreamView` scrolls only through `conversation-list/`'s
  `ConversationListHandle` ([engine](../../lib/conversation-scroll/AGENTS.md)).
  Stable row keys; map history indexes to rows. Build elements only for mounted or
  selection-retained rows. Collapsed activity is one row; expanded details are
  siblings, never nested scrollers or fixed-height panels.
- Native selection retains its row corridor and history leases: hold prose/folding,
  keep actions live, release on clear. [Contract](README.md#native-text-selection).
- `buildChatStreamItems()` must drop empty assistant entries and de-duplicate
  history ids.
- `leadingContent` is a real first row: include it in sticky counts and scroll
  targets; never overlay or persist it.
- Empty-state presentation stays outside the list, even with an empty leading Fragment:
  zero-height caches can hide the first user row. Preserve live activity labels/tones.
  Apply the header inset once to the whole scroller.
- Create `operation_progress` cards update in place per materialized target; bind
  status to its exact Turn and subscribe only to its title. `progressMessageId`
  suppresses duplicate completion cards; legacy completions keep successful-target
  cards. Rationale: [README.md](README.md#creation-progress).

## Turn Folding And Layout

- Finished turns keep the answer/result tail visible and fold earlier work;
  streaming turns stay expanded.
- The final answer is the contiguous text run before trailing never-collapsed
  items. Walk backward over adjacent text blocks to the first non-text boundary.
- Plan approval cuts an `AssistantTurnRenderSegment` in a live turn. Match ACP
  kind `switch_mode`, never a title (`plan-surface.ts`). Keep `workBlockKeys`,
  `hasVisibleFinalContent`, last-item visibility and `expandedWorkedGroups` per
  segment; expansion keys include it. Only the last segment shows duration;
  earlier ones say "Finished working".
- `shouldUseWorkedGroup` requires a finished turn, foldable work, and visible
  final content outside `workBlockKeys`. A cancelled/interrupted or tool-only
  turn with no answer stays expanded; `message.finished` cannot prove
  completion alone. A reused assistant entry that
  reopens upstream must clear `finished` and `endedAt` (see
  `apps/cli/src/session/AGENTS.md`).
- Thought and tool rows share one compact transparent timeline and 13px
  hierarchy, with no glyphs: the verb says the kind of step. Execute calls are not cards. Desktop disclosure headers use
  body type, a hover-only trailing chevron, no fill. Only builtin DeepSeek Harness retains thought rows in expandable
  activity groups; pure thoughts default open unless explicitly collapsed. Other providers
  keep thoughts hidden.
  Turns are avatar-free and full-width; run config lives in the footer.
- An expanded tool step is ONE `ToolDetailSheet` (`tool-call-detail.tsx`): composer
  fill + card shadow, no header restating the row, sections in content order. Only
  the command is highlighted, via the Shiki worker; output stays ANSI text. Drop
  text blocks that echo the command. [Note](../../../../../.agents/notes/implemented/feature/2026-09-26-tool-step-detail-sheet.md).
- Duration has one owner: desktop uses `WorkedGroupHeader` for folded turns and
  the footer after buttons otherwise; mobile always uses the footer before
  buttons, and the worked header suppresses its copy. Preserve
  `MOBILE_TURN_ACTION_LEADING_INSET_PX` so actions clear the edge-back strip.
- Live status precedes a trailing subagent task summary, including when the turn
  has no footer.
- Streaming replies use a direct Copy action and turn-config info (set at open);
  Fork controls and loading need a finished turn.
- `ConversationColumn` owns the gutter; the list and row shells add no horizontal
  pad. EVERY row, including expanded details, shares one left rail. Expansion never
  shifts content right; the chevron carries hierarchy. Prose and desktop process
  labels/steps share StyleX `conversation.railInset` (4px). Steps have no negative
  margin; footer bleed is trailing-only (`-mr-[7px]`).
  See `AssistantTurnAlignment.stories`.
- Follow the StyleX [spacing contract](../../../../../specs/conversation-rhythm.md).
  User rows own `responseGap`; last assistant rows own `roundGap`, including footer
  and next-user metadata. Cache and memo comparison include boundary state.

## Conversation Outline

- Outline, arrival-intent and row-index-to-scroll changes follow
  [conversation-outline.md](conversation-outline.md): only `scrollRowToTop` converts,
  group toggles never scroll, and each jump issues once; the engine holds its row at top.

## Content Contracts

- Child cancel needs subagentCancellation v1 and an exact parent turn; never
  Stop the parent or invent terminal state. Runs also need subagentEvents v1
  and `support.cancel`. Dialogs share turn renderers/grouping and one scroller:
  [task rows and dialog](README.md#subagent-tasks).

- Text roles use `@lody/ui`; reading prose uses `conversation.readingLeading`.
  Compact prose/code use subheadline, never nested `em`. Message sizes use
  `conversation-font-size-classes.ts`; hosts require CSS typed division. Only live
  turns load the stream engine. Remounted live rows show existing text immediately;
  only additions animate.
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
- Attachment layout, preview continuity, and mobile previews follow
  [session-files-rendering.md](session-files-rendering.md).
- Markdown images remember each source's natural size or failure for the page's
  life: a virtualized remount must render at its final height (failed sources show alt text).
- Live file Markdown images use the owning file provider: same-machine reads are
  automatic; remote reads require a per-image click. Never grant this resolver to
  anonymous shares. Release owned Blob URLs on cleanup and ignore late reads.
