# components/ai-gui

Ownership: [README.md](README.md).

## Stream And Search

- Search indexes prose only: user/assistant text, thinking, and proposed-plan
  markdown, including folded prose; matches open their groups. Never index tools
  (titles/JSON/output), terminals, diffs, plan checklists, goals, or worktree script
  output. Never wire `searchBlockId` to tool, terminal, or diff renderers.
- Window stream readiness must use the same hydration/initial-scroll conditions as
  viewport visibility; hydrated history alone cannot reveal a native window.
- Stream scrolling uses `ConversationListHandle` and the
  [engine](../../lib/conversation-scroll/AGENTS.md) only. Use turn-ID keys through
  local/history handoff. Local UI stays outside history/outline/export and owner
  facts; its selection has no history lease.
  Map history indexes to rows. Collapsed activity is one row; expanded details
  are siblings, never nested scrollers or fixed-height panels.
- Native selection retains its row corridor and history leases: hold prose/folding,
  keep actions live, release on clear. [Contract](README.md#native-text-selection).
- `buildChatStreamItems()` must drop empty assistant entries and de-duplicate
  history ids.
- `leadingContent` is a real first row: include it in sticky counts and scroll
  targets; never overlay or persist it.
- Empty state stays outside the list even with an empty leading Fragment; zero-height
  caches can hide the first user row. Keep activity labels/tones and one header inset.
- Creation cards: [contract](README.md#creation-progress). Bind status to the
  target Turn and subscribe only to its title; `progressMessageId` prevents
  duplicates. Share a five-card scroller; retain full hydration.
  Keep concrete cards; hide contentless successes and their empty batch rows.

## Turn Folding And Layout

- Finished turns keep the answer/result tail visible and fold earlier work;
  streaming turns stay expanded.
- The final answer is the contiguous text run before trailing never-collapsed
  items. Walk backward over adjacent text blocks to the first non-text boundary.
- Plan approval cuts a live turn by ACP kind `switch_mode`, never title.
  `plan-surface.ts` prefers nonempty `rawInput.plan` over replaceable tool content.
  Keep `workBlockKeys`, `hasVisibleFinalContent`, last-item visibility and expansion
  keys per segment. Only the last segment shows duration; earlier segments say
  "Finished working".
- `shouldUseWorkedGroup` requires a finished turn, foldable work, and visible
  final content outside `workBlockKeys`. A cancelled/interrupted or tool-only
  turn with no answer stays expanded; `message.finished` cannot prove
  completion alone. A reused entry reopening upstream
  must clear `finished` and `endedAt` (see
  `apps/cli/src/session/AGENTS.md`).
- Thought and tool rows share one compact transparent timeline, 13px, no glyphs:
  the verb says the kind of step. Execute calls are not cards. Disclosure labels
  lead; the chevron trails (desktop: hover-only, body type, no fill). Only builtin DeepSeek Harness retains thought rows in expandable
  activity groups; pure thoughts default open unless explicitly collapsed. Other providers
  keep thoughts hidden.
  Assistant footers show config, not author identity.
- An expanded tool step is ONE `ToolDetailSheet` (`tool-call-detail.tsx`): composer
  fill + card shadow, no header restating the row, sections in content order. Only
  the command is highlighted, via the Shiki worker; output stays ANSI text. Drop
  text blocks that echo the command. [Note](../../../../../.agents/notes/implemented/feature/2026-09-26-tool-step-detail-sheet.md).
- Duration has one owner: desktop uses `WorkedGroupHeader` for folded turns and
  the footer after buttons otherwise; mobile always uses the footer before
  buttons, and the worked header suppresses its copy. Preserve
  `MOBILE_TURN_ACTION_LEADING_INSET_PX` so actions clear the edge-back strip.
  Mobile buttons rest hidden but the newest turn's; a tap reveals one message's.
- Live status precedes a trailing subagent task summary, including when the turn
  has no footer.
- Streaming replies use a direct Copy action and turn-config info (set at open);
  Fork controls and loading need a finished turn.
- `ConversationColumn` owns the gutter; row shells add no horizontal pad. EVERY
  row shares one rail: prose, process labels/steps, live status and the mobile
  footer sit at `conversation.railInset`; expansion never shifts content right.
  Footer bleed is trailing-only (`-mr-[7px]`). See `AssistantTurnAlignment.stories`.
- Follow the StyleX [spacing contract](../../../../../specs/conversation-rhythm.md).
  User rows own `responseGap`; assistant tails own `roundGap` (desktop: including
  footer/metadata; mobile: below the footer).
  Cache/memo include boundaries. Expanded work preserves prose and summary gaps.

## Conversation Outline

- Outline, arrival-intent and row-index-to-scroll changes follow
  [conversation-outline.md](conversation-outline.md): only `scrollRowToTop` converts,
  group toggles never scroll, and each jump issues once; the engine holds its row at top.

## Content Contracts

- Child cancel requires subagentCancellation/subagentEvents v1, `support.cancel`
  and an exact parent turn; never Stop the parent or invent state. Dialogs reuse
  parent renderers/grouping, one scroller, and read run bodies only while open:
  [task/dialog contract](README.md#subagent-tasks).

- Text roles: `@lody/ui`; prose: `conversation.readingLeading`; compact prose/code:
  subheadline, no nested `em`. Message sizes: `conversation-font-size-classes.ts`;
  hosts require CSS typed division. Stream engine: live turns only;
  remounts show existing text immediately and animate only additions.
- Rendering and search share CJK emphasis rules.
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
- Frozen Agent/Role names/icons never use human profiles or live catalogs. Human names
  sit right of time; only desktop avatars open accessible name/email cards.
- Attachment layout, preview continuity, and mobile previews follow
  [session-files-rendering.md](session-files-rendering.md).
- Markdown images remember each source's natural size or failure for the page's
  life: a virtualized remount must render at its final height (failed sources show alt text).
- Live file Markdown images and plain-text image links use the owning file provider:
  same-machine reads are automatic; remote ones need a per-image click. Anonymous
  shares never get this resolver. Release own Blob URLs; drop late reads.
