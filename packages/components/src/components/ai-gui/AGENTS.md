# components/ai-gui - Maintainer Guide

`CLAUDE.md` is a symlink to this file. Edit `AGENTS.md` only.

| Area    | Owner                                    | Contract                               |
| ------- | ---------------------------------------- | -------------------------------------- |
| Stream  | `view.tsx`, `build-chat-stream-items.ts` | Stable Virtua rows and scroll.         |
| Turns   | `assistant-turn-render-blocks.ts`        | Activity groups and foldable segments. |
| Outline | `conversation-outline-*`                 | Round ticks and navigation.            |

## Stream And Search

- In-conversation search indexes prose only: user/assistant text, thinking, and
  proposed-plan markdown. Never index tool titles/JSON/output, terminal data,
  diffs, plan checklists, goals, or worktree script output. Search still reaches
  prose inside folded work and activity; matches force their owning groups open.
  Do not restore `searchBlockId` wiring to tool, terminal, or diff renderers.
- `SessionChatStreamView` flattens turns into one main Virtua list. Collapsed
  activity is one row; expanded details are sibling rows, never a nested output
  scroller or fixed-height process panel. Streaming keys must remain stable, and
  history indexes must translate to the matching virtual child row.
- Keep Virtua `shift={false}`; stale cumulative heights otherwise overlap rows.
  `bufferSize` trades fast-scroll blanks against retaining resizing rows.
- `buildChatStreamItems()` drops empty assistant entries (a `null` render cannot
  be measured) and de-duplicates history ids (duplicate Virtua keys desync the
  list). See `tests/build-chat-stream-items.test.ts`.
- `leadingContent` is a real first row. Include it in sticky counts and every
  scroll target; never overlay or persist it. A `session_create` completion
  renders one card per successful target and reads only that target's title.

## Turn Folding And Layout

- Finished turns keep the answer/result tail visible and fold earlier work.
  Streaming turns stay expanded. Details remain sibling rows; search opens both
  the worked region and activity group.
- The final answer is the final contiguous run of text before trailing
  never-collapsed items, not necessarily the last item. Keep walking backward
  through adjacent text blocks until a non-text boundary. Generated
  `image_group`s and the `switch_mode` "Exited Plan Mode" card may follow it.
- One turn may contain several `AssistantTurnRenderSegment`s. A plan approval
  inside a running turn cuts a segment so implementation stays under the plan.
  Match ACP kind `switch_mode`, never a title; carrier varies
  (`plan-surface.ts`). Keep
  `workBlockKeys`, `hasVisibleFinalContent`, last-item visibility, and
  `expandedWorkedGroups` per segment. Expansion keys include the segment; only
  the last region may show a duration, while earlier regions say "Finished
  working".
- `shouldUseWorkedGroup` requires a finished turn, foldable work, and visible
  final content outside `workBlockKeys`. A cancelled/interrupted or tool-only
  turn with no answer stays expanded. `message.finished` also marks teardown and
  cannot prove completion alone. When a reused assistant entry reopens upstream,
  it must clear `finished` and `endedAt` (see `apps/cli/src/session/AGENTS.md`).
- Thought and tool rows share one compact transparent timeline, icon gutter,
  and 13px hierarchy. Execute calls are not cards; Thought headings stay at
  activity-detail scale.
- Turns are avatar-free and full-width. Run configuration belongs in the footer
  info control.
- Duration has one owner. Desktop uses `WorkedGroupHeader` for folded turns and
  the footer after buttons otherwise. Mobile always uses the footer before
  buttons, and the worked header suppresses its copy. Preserve
  `MOBILE_TURN_ACTION_LEADING_INSET_PX` so actions clear the edge-back strip.
- Gutter belongs to `ConversationColumn`, not Virtua: absolute rows ignore
  scroller padding. EVERY row shares one left rail with no shell pad, INCLUDING
  the contents of an expanded region: expanding reveals rows, it never shifts
  them right, and the chevron carries the hierarchy. Hover pills bleed instead
  (footer `-mx-[7px]`, steps `-mx-1`). See `AssistantTurnAlignment.stories`.

## Conversation Outline

`conversation-outline-rail.tsx` renders one tick per round (a user turn plus its
work) and a hover preview.

- Build entries from `items`, never DOM. Reader position uses Virtua offsets and
  selects the last round whose anchor is above the viewport top.
- The rail is a page-level absolute portal outside the shrinking message area.
  It is not a Virtua row or viewport child. Keep it page-centred as the composer
  grows and pane-local in splits; never use `position: fixed` or composer height.
- Reader position never enters tick-list props. Paint one arithmetic active bar
  and sync `aria-current` imperatively. Pointer magnification may update the
  memoized ticks; scrolling may not. `buildConversationOutline` runs at token
  rate, so memoize per message and clean only a bounded markdown prefix.
- Blend magnification into resting widths so the pointer's tick stays longest.
  Derive `RAIL_TRACK_WIDTH` from the peak; an undersized auto-overflow track
  scrolls sideways.
- Arrival intent belongs to `conversation-outline-arrival-intent.ts`. A directed,
  braking approach gets one short-lived delay bypass; uncertainty waits 200ms.
  Only waiting out that delay arms rapid browsing and its 2.5s close window;
  predictor-opened cards never do. Removing `enableArrivalIntent` installs no
  detector/listener. Keep inputs numeric and replayable, independent of Session,
  lifecycle, telemetry, and platform capabilities. The Storybook Lab records
  only explicit in-memory, rail-relative data; it never persists or uploads.
- `scrollRowToTop` is the only row-index-to-scroll conversion. It adds
  `leadingRowCount` and compensates viewport top padding so reads and writes use
  one coordinate space. Group expansion, outline jumps, search, and imperative
  scrolling all use it; do not call `vlistRef.scrollToIndex` elsewhere.
- Far jumps start from estimated offsets. After scroll settles, reissue the same
  jump until it is within `OUTLINE_JUMP_TOLERANCE_PX`, bounded by
  `OUTLINE_JUMP_MAX_CORRECTIONS` because the tail may be clamped. Wheel, touch,
  or key input cancels correction immediately. Keep
  `OUTLINE_ANCHOR_TOLERANCE_PX` greater than jump tolerance.
- Follow-output suppression is owned by `pendingOutlineJumpRef`, not a render;
  React may skip the commit when clicking the already-active round.
- Coverage: `tests/conversation-outline*.test.ts` and `ExtremeConversation`.

## Content Contracts

- Conversation font size is a bounded integer pixel value. Scale body, headings,
  dense monospace, terminal output, and collapsed height through
  `conversation-font-size-classes.ts`; settings own legacy preset migration.
  Keep Streamdown in streaming mode, but never enable word-level `animated`: its
  span-per-word compositor cost is unbounded on long turns.
- A Mermaid diagram opens in `mermaid-diagram-viewer.tsx`, never Streamdown's own
  full-screen overlay (`controls.mermaid.fullscreen` stays off). That overlay put its
  ONLY exit at a raw `top-4 right-4` — inside the status-bar inset on a phone — while
  its content layer covered the backdrop and swallowed every tap, so a touch user could
  not leave it. The replacement keeps three properties: its controls are padded by the
  `--safe-area-*` variables rather than a fixed viewport offset and are at least 44px;
  there is never a single exit (close button, a click off the diagram, Escape); and it
  stacks at `--z-image-viewer`, so a diagram opened inside a dialog lands above that
  dialog. It opens the diagram at NATURAL size
  when it does not fit — an agent's sequence diagram scaled to a phone screen is
  unreadable — and pans instead. Streamdown owns that markup, so the click target and
  its `role`/`tabindex` are applied by observer in `markdown-renderer.tsx`; the block's
  own copy/download controls must stay reachable without hover.
- `chat_failed` raw errors use a modal; extraction/copy live in `chat-failed-error-report.ts`.
- Capacity retry targets only the latest notice: first click consents; bounded countdowns send a
  new continuation turn, never replay the failed input. During a visible countdown, the countdown
  control reveals its stop-auto-retry action on hover or keyboard focus and shows that action
  directly on touch devices so consent stays reversible without adding a second control.
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
