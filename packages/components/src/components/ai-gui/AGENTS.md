# components/ai-gui - Maintainer Guide

`CLAUDE.md` is a symlink to this file. Edit `AGENTS.md` only.
File-by-file ownership and coverage pointers: [README.md](README.md).

## Stream And Search

- Search indexes prose only: user/assistant text, thinking, and proposed-plan
  markdown. Never index tool titles/JSON/output, terminal data, diffs, plan
  checklists, goals, or worktree script output. Search still reaches prose inside
  folded work and activity, and matches force their owning groups open. Do not
  restore `searchBlockId` wiring to tool, terminal, or diff renderers.
- `SessionChatStreamView` flattens turns into one main Virtua list. Collapsed
  activity is one row; expanded details are sibling rows, never a nested output
  scroller or fixed-height process panel. Streaming keys must remain stable, and
  history indexes must translate to the matching virtual child row.
- Keep Virtua `shift={false}`; stale cumulative heights otherwise overlap rows.
- `buildChatStreamItems()` must drop empty assistant entries and de-duplicate
  history ids.
- `leadingContent` is a real first row. Include it in sticky counts and every
  scroll target; never overlay or persist it. A `session_create` completion
  renders one card per successful target and reads only that target's title.

## Turn Folding And Layout

- Finished turns keep the answer/result tail visible and fold earlier work;
  streaming turns stay expanded. Details remain sibling rows, and search opens
  both the worked region and the activity group.
- The final answer is the final contiguous run of text before trailing
  never-collapsed items, not necessarily the last item: walk backward through
  adjacent text blocks until a non-text boundary. Generated `image_group`s and
  the `switch_mode` "Exited Plan Mode" card may follow it.
- A turn may hold several `AssistantTurnRenderSegment`s; a plan approval inside a
  running turn cuts a segment. Match ACP kind `switch_mode`, never a title
  (`plan-surface.ts`). Keep
  `workBlockKeys`, `hasVisibleFinalContent`, last-item visibility, and
  `expandedWorkedGroups` per segment; expansion keys include the segment. Only
  the last region may show a duration; earlier ones say "Finished working".
- `shouldUseWorkedGroup` requires a finished turn, foldable work, and visible
  final content outside `workBlockKeys`. A cancelled/interrupted or tool-only
  turn with no answer stays expanded, and `message.finished` cannot prove
  completion alone. A reused assistant entry that
  reopens upstream must clear `finished` and `endedAt` (see
  `apps/cli/src/session/AGENTS.md`).
- Thought and tool rows share one compact transparent timeline, icon gutter, and
  13px hierarchy. Execute calls are not cards; Thought headings stay at
  activity-detail scale. Turns are avatar-free and full-width, and run
  configuration belongs in the footer info control.
- Duration has one owner: desktop uses `WorkedGroupHeader` for folded turns and
  the footer after buttons otherwise; mobile always uses the footer before
  buttons, and the worked header suppresses its copy. Preserve
  `MOBILE_TURN_ACTION_LEADING_INSET_PX` so actions clear the edge-back strip.
- The gutter belongs to `ConversationColumn`, not Virtua. EVERY row shares one left rail with no shell pad, INCLUDING
  the contents of an expanded region: expanding reveals rows, it never shifts
  them right, and the chevron carries the hierarchy. Hover pills bleed instead
  (footer `-mx-[7px]`, steps `-mx-1`). See `AssistantTurnAlignment.stories`.

## Conversation Outline

- Build entries from `items`, never DOM. Reader position uses Virtua offsets and
  selects the last round whose anchor is above the viewport top; it never enters
  tick-list props. Paint one arithmetic active bar and sync `aria-current`
  imperatively. Pointer magnification may update the memoized ticks; scrolling
  may not. `buildConversationOutline` runs at token rate, so memoize per message
  and clean only a bounded markdown prefix.
- The rail is a page-level absolute portal outside the shrinking message area,
  not a Virtua row or viewport child. Keep it page-centred as the composer grows
  and pane-local in splits; never use `position: fixed` or composer height. Blend
  magnification into resting widths so the pointer's tick stays longest, and
  derive `RAIL_TRACK_WIDTH` from the peak.
- Arrival intent belongs to `conversation-outline-arrival-intent.ts`. A directed,
  braking approach gets one short-lived delay bypass; uncertainty waits 200ms.
  Only waiting out that delay arms rapid browsing and its 2.5s close window;
  predictor-opened cards never do. Removing `enableArrivalIntent` installs no
  detector/listener. Keep inputs numeric and replayable, independent of Session,
  lifecycle, telemetry, and platform capabilities. The Storybook Lab records only
  explicit in-memory, rail-relative data; it never persists or uploads.
- `scrollRowToTop` is the only row-index-to-scroll conversion: it adds
  `leadingRowCount` and compensates viewport top padding so reads and writes use
  one coordinate space. Group expansion, outline jumps, search, and imperative
  scrolling all use it; do not call `vlistRef.scrollToIndex` elsewhere.
- Far jumps start from estimated offsets. After scroll settles, reissue the same
  jump until it is within `OUTLINE_JUMP_TOLERANCE_PX`, bounded by
  `OUTLINE_JUMP_MAX_CORRECTIONS`. Wheel, touch, or key input cancels correction
  immediately. Keep
  `OUTLINE_ANCHOR_TOLERANCE_PX` greater than jump tolerance.
- Follow-output suppression is owned by `pendingOutlineJumpRef`, never a render.

## Content Contracts

- Conversation font size is a bounded integer pixel value. Scale body, headings,
  dense monospace, terminal output, and collapsed height through
  `conversation-font-size-classes.ts`; settings own legacy preset migration.
  Keep Streamdown in streaming mode, but never enable word-level `animated`.
- A Mermaid diagram opens in `mermaid-diagram-viewer.tsx`, never Streamdown's own
  full-screen overlay (`controls.mermaid.fullscreen` stays off). Keep three
  properties: controls padded by the `--safe-area-*` variables rather than a fixed
  viewport offset and at least 44px; never a single exit (close button, click off
  the diagram, Escape); and `--z-image-viewer` stacking, so a diagram opened
  inside a dialog lands above that dialog. Open the diagram at NATURAL size when
  it does not fit and pan, instead of scaling it down. `markdown-renderer.tsx`
  applies the click target and its `role`/`tabindex` by observer; the block's own
  copy/download controls must stay reachable without hover.
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
- `assistant-edited-files.tsx` shows four paths before expanding and aligns stats
  without per-file pills.
- Update `message-content-guards.ts` with every shared `MessageContent` variant.
  `isMessageContent` gates rendering; a missing case silently drops the item.
- A user entry marked by `SessionMeta.lastMissingHistoryUserMsgId` renders the
  terminal "Not delivered" label. That label is the only recovery entry: its
  dialog resends the same content as a new ordinary message, then marks the old
  entry `canceled` while retaining the marker as a tombstone. Never automatically
  dispatch or revive the old turn.
- Attachment and mobile image-preview invariants live in
  [session-files-rendering.md](session-files-rendering.md).
