# components/ai-gui

Edit `AGENTS.md`, not its `CLAUDE.md` symlink. Ownership: [README.md](README.md).

## Stream And Search

- Search indexes prose only: user/assistant text, thinking, and proposed-plan
  markdown, including folded prose; matches open their groups. Never index tools
  (titles/JSON/output), terminals, diffs, plan checklists, goals, or worktree script
  output. Never wire `searchBlockId` to tool, terminal, or diff renderers.
- `SessionChatStreamView` uses one Virtua list with stable keys and `shift={false}`.
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
- Thought and tool rows share one compact transparent timeline, icon gutter, and
  13px hierarchy. Execute calls are not cards. Desktop disclosure headers use
  body type, a hover-only trailing chevron, no fill, and no thought rows.
  Turns are avatar-free and full-width; run config lives in the footer.
- Duration has one owner: desktop uses `WorkedGroupHeader` for folded turns and
  the footer after buttons otherwise; mobile always uses the footer before
  buttons, and the worked header suppresses its copy. Preserve
  `MOBILE_TURN_ACTION_LEADING_INSET_PX` so actions clear the edge-back strip.
- Streaming replies use a direct Copy action and turn-config info (set at open);
  Fork controls and loading need a finished turn.
- The gutter belongs to `ConversationColumn`, not Virtua. EVERY row shares one left rail with no shell pad, INCLUDING
  the contents of an expanded region: expanding reveals rows, it never shifts
  them right; the chevron carries the hierarchy. Hover pills bleed instead
  (footer `-mx-[7px]`, steps `-mx-1`). See `AssistantTurnAlignment.stories`.

## Conversation Outline

- Build entries from `items`, never DOM. The rail mounts only once user rounds
  reach `OUTLINE_MIN_USER_ROUNDS`. Reader position is the last round
  anchored above the viewport top, resolved from Virtua offsets; it never
  enters tick-list props. Paint one arithmetic active bar; sync `aria-current`
  imperatively. Pointer magnification may update memoized ticks; scrolling may
  not. `buildConversationOutline` runs at token rate, so memoize per message
  and clean only a bounded markdown prefix.
- The rail is a page-level absolute portal outside the shrinking message area,
  not a Virtua row or viewport child. It stays page-centred as the composer
  grows, pane-local in splits; never `position: fixed` or composer height. Blend
  magnification into resting widths so the pointer's tick stays longest; derive
  `RAIL_TRACK_WIDTH` from the peak.
- Arrival intent belongs to `conversation-outline-arrival-intent.ts`. A directed,
  braking approach gets one short-lived delay bypass; uncertainty waits 200ms.
  Only waiting out that delay arms rapid browsing and its 2.5s close window;
  predictor-opened cards never do. Removing `enableArrivalIntent` installs no
  detector/listener. Keep inputs numeric and replayable, independent of Session,
  lifecycle, telemetry, and platform capabilities. The Storybook Lab records only
  explicit in-memory, rail-relative data; it never persists or uploads.
- `scrollRowToTop` is the only row-index-to-scroll conversion: it adds
  `leadingRowCount` and compensates viewport top padding so reads and writes
  share one coordinate space. Outline jumps, search, and imperative scrolling
  use it; do not call `vlistRef.scrollToIndex` elsewhere. Group toggles never
  scroll — expansion reveals rows in place.
- Far jumps start from estimated offsets; after scroll settles, reissue the
  same jump until within `OUTLINE_JUMP_TOLERANCE_PX`, bounded by
  `OUTLINE_JUMP_MAX_CORRECTIONS`. Wheel, touch, or key input cancels correction
  immediately. Keep `OUTLINE_ANCHOR_TOLERANCE_PX` above jump tolerance.
- Follow-output suppression is owned by `pendingOutlineJumpRef`, never a render.

## Content Contracts

- Native child cancel requires subagentCancellation v1 and an exact parent turn;
  never use durable whole-turn Stop or invent a terminal state in the panel.

- `--ui-font-size` is the 1em baseline; compact chrome is 0.9em. Conversation
  body/headings/mono/terminal still scale through
  `conversation-font-size-classes.ts`. Streamdown stays streaming; never
  word-level `animated`.
- A Mermaid diagram in a message is a still preview until a pointer click
  activates it, and an unmodified wheel is NEVER taken — activated or not.
  `mermaid-diagram-viewer.tsx` stays the only full-screen surface, reached from
  the block's action bar. Invariants:
  [mermaid-diagram-rendering.md](mermaid-diagram-rendering.md).
- `chat_failed` raw errors use a modal; extraction/copy live in
  `chat-failed-error-report.ts`.
- Capacity retry targets only the latest notice: the first click consents, and
  bounded countdowns send a new continuation turn rather than replaying the
  failed input. A visible countdown keeps consent reversible without a second
  control — reveal stop-auto-retry on hover or keyboard focus, and show it
  directly on touch devices.
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
