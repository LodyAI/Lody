# components/ai-gui — Index

`CLAUDE.md` is a symlink to this file. Edit `AGENTS.md` only.

This module is **the message-list renderer for the session conversation page**
(`view.tsx`): markdown, tool calls, terminal output, diff badges. The page shell and
composer live in `../sessions/` (see its AGENTS.md); how conversation data arrives:
context/message-flow.md.

- `view.tsx` — renders the session history items (`MessageContent` shapes from
  `packages/shared/src/schema.ts`); the most frequently edited file here.
- **In-conversation search indexes PROSE ONLY** (`src/lib/session-chat-search.ts`): user
  text, assistant text, thinking, proposed-plan markdown. Tool calls (titles, paths, JSON
  input/output, terminal command/output, diffs), plan checklists, goals, and worktree
  script output are deliberately excluded — indexing them buried real matches under logs
  and JSON. Prose folded inside the `Worked for …` group and activity groups still matches
  (the group auto-expands via `assistantGroupHasActiveSearch`). Do not re-add
  `searchBlockId` wiring to tool/terminal/diff renderers.
- `assistant-turn-render-blocks.ts` merges adjacent assistant tool calls and thoughts
  into one activity group without crossing visible text. `SessionChatStreamView` flattens each assistant
  turn into `virtua` rows: a collapsed group is one row; expanded tool/thought details
  are sibling rows in the same main `VList`. Do not reintroduce a fixed-height process
  panel or nested vertical output scroller. Group keys must remain stable while a turn
  streams; active search blocks force their owning group open, and `scrollToIndex`
  translates history indexes to the matching virtual child row.
- A finished assistant turn keeps its final answer/result tail visible and collapses
  earlier progress text, activity groups, and subagent work under a `Worked for …`
  virtual row. Keep streaming turns fully expanded. Expanding completed work must add
  sibling rows to the main `VList`; search hits inside completed work force that outer
  row and the owning activity group open.
  - "Final answer" is not literally the LAST item (`message-copy.ts`
    `getTextIndexBeforeTrailingNeverCollapsedItems`): the last TEXT stays visible when
    everything after it is itself never collapsed — generated `image_group`s, and the
    `switch_mode` "Exited Plan Mode" card.
  - **One turn can have SEVERAL foldable regions** (`AssistantTurnRenderSegment`).
    A plan is approved from inside a RUNNING turn, so that same turn implements it;
    the plan-approval card cuts a segment so the approved work gets its own region
    under the plan instead of disappearing into the plan's fold — an approved plan
    otherwise looks like it produced nothing. The cut matches the ACP tool KIND
    `switch_mode`, never a title: Claude's `ExitPlanMode` renders "Ready to code?"
    and Codex's plan review renders "Implement this plan?" for the same event.
    Everything the gate needs is
    per-segment: `workBlockKeys`, `hasVisibleFinalContent`, the collapse rule's
    "last item stays visible", and the expansion state
    (`BubbleExpandState.expandedWorkedGroups`, keyed by segment). The turn duration
    is NOT per-segment — only the last region may print "Worked for …", earlier ones
    fall back to "Finished working". Do not collapse this back to one region per
    message, and do not key expansion by message id alone.
- **`Worked for …` collapse gate (`view.tsx` `shouldUseWorkedGroup`)** requires THREE
  things, not just `message.finished`: (1) the turn is finished, (2) there is foldable
  work, and (3) `hasVisibleFinalContent` — at least one render block is NOT in
  `workBlockKeys` (a genuine visible answer/result tail). Rationale (do not regress):
  - Condition (3) exists because activity groups are folded unconditionally
    (`assistant-turn-render-blocks.ts`), so an **interrupted/cancelled** turn ending
    mid-tool with no final text would otherwise fold everything into an empty
    `Worked for …` row. No final answer ⇒ stay expanded. Turns that finish with only
    tool/thought work and no text answer therefore also stay expanded — intended.
  - `message.finished` is set on every teardown/cancel path (CLI `finalizeACPState`),
    not only on a completed answer, so it can never be the sole collapse signal.
  - A turn that **resumed after its machine died mid-turn** used to collapse while still
    streaming: the CLI had stamped `finished=true` on the reused entry during teardown
    and never cleared it. Fixed CLI-side (assistant entry reopen clears `finished`/
    `endedAt` — see apps/cli/src/session/AGENTS.md); the renderer still trusts
    `message.finished`, so keep that reset intact upstream.
- Expanded activity details form one compact timeline: Thought and tool headers share
  the same icon gutter, 13px hierarchy, spacing, and transparent row surface. Keep
  execute calls out of standalone card chrome, and keep Thought markdown headings at
  activity-detail scale rather than assistant-response scale.
- Assistant turns use the same avatar-free, full-width layout on desktop and mobile.
  Do not restore a model/avatar header or reserve a desktop avatar indent. Per-turn
  model, mode, reasoning, and other run configuration lives in the footer info control
  beside Copy; the popover is the detailed configuration surface.
- **Turn duration has one owner per layout.** Desktop: `WorkedGroupHeader` when the turn
  folds, else the footer action bar AFTER the buttons (`showDuration` encodes which).
  Mobile: always the footer, BEFORE the buttons, ignoring `showDuration` — and
  `WorkedGroupHeader` suppresses its own copy there, because both read the same
  `resolveSessionHistoryDurationMs(message)` and would otherwise print an identical
  "Worked for 12s" twice per turn. The mobile leading slot also reserves
  `MOBILE_TURN_ACTION_LEADING_INSET_PX` so the copy button clears the session drawer's
  edge-back strip (see ../mobile/AGENTS.md); it is layout, not decoration.
- Virtua positions rows with `position:absolute; top:<cumulative measured height>`;
  stale measured heights make rows overlap. Keep `shift={false}`. `bufferSize` trades
  fast-scroll blanks against the number of still-resizing rows kept mounted.
- Horizontal gutter for stream rows lives on `ConversationColumn`
  (`CONVERSATION_GUTTER_X_CLASS` / `px-3 sm:px-4`), **not** on the `VList`.
  Virtua absolute rows ignore scroller horizontal padding, which used to leave
  avatars flush to the screen edge while the composer stayed inset.
  **One left rail per turn**: no top-level row adds its own leading pad —
  prose (`MarkdownBlock`), `ActivityGroupHeader`, `WorkedGroupHeader`,
  `SubagentTaskPanel`, edited-files, footer. `MarkdownBlock` carried `sm:px-2`
  and the footer/edited-files were tuned to that 8px, so prose read as indented
  beside the chevrons. Footer keeps `-mx-[7px]` to put its glyph on the rail.
  Indents belong to CHILD rows only (`activity_detail`, worked-group details).
  Story: `AssistantTurnAlignment.stories.tsx`.
- `build-chat-stream-items.ts` — `buildChatStreamItems()` turns `sessionDoc.history`
  into `VList` items. **Normalizes defensively** so interrupted / bad-network docs
  can't make virtua overlap deterministically: drops empty assistant entries (they'd
  render to `null` = an unmeasurable row) and de-dupes by `id` (the VList keys rows
  by `history.id`; duplicate keys desync virtua). Test: `tests/build-chat-stream-items.test.ts`.
- `SessionChatStreamView.leadingContent` is a real first Virtua row used for non-history
  conversation provenance. Its presence must be included in sticky-scroll item counts and added to
  every imperative/search/group `scrollToIndex` target. Do not absolutely overlay it or persist a
  synthetic history entry. `session_create` Operation completions render one navigable relation
  card per successful target and select only that target Session's title from doc meta.
- **Outline rail** (`conversation-outline-rail.tsx` + `src/lib/conversation-outline.ts`):
  the left table of contents, one tick per ROUND (a user turn plus the work it
  produced), hover card showing the round's opening words. Three invariants:
  - **Data comes from `items`, never from the DOM.** The list is virtualized, so
    most rounds have no element — an IntersectionObserver / item-registration
    design (shadcn `MessageScroller`'s approach) silently omits them. Reader
    position likewise comes from Virtua's index math (`getItemOffset` +
    `resolveActiveOutlineIndex`), and the active round is the LAST one whose
    anchor is above the viewport top, so it stays set through a long turn.
  - **It is a page-level overlay, portalled outside the shrinking message area.**
    It is never a Virtua row (it would scroll away) or a child of the viewport
    (`use-sticky-scroll.ts` takes the content element from that div's
    `firstElementChild`). Its portal root is the full session page so the rail
    stays vertically centred when the composer changes height; do not replace
    that with a composer-height measurement or `position: fixed`, which breaks
    split conversation panes.
  - **Reader position must not re-render the tick list.** It never enters the
    list's props: the active round is painted by one absolutely-positioned bar
    (fixed pitch, pure arithmetic, no measurement) and `aria-current` is synced
    imperatively. Hover MAGNIFICATION is the deliberate exception — it changes
    every tick at once, but it is driven by pointer entry rather than by
    scrolling at frame rate, and each tick is memoized on its own width so a
    move only re-renders the few inside the bell. The outline itself is rebuilt
    at token rate, so `buildConversationOutline` memoizes per message and only
    ever runs the markdown cleanup over a bounded prefix — never a whole answer.
    Same lesson as `hooks/use-incremental-search-blocks.ts`.
  - **Magnification blends the bell in, it does not add it on**
    (`conversation-outline-rail-geometry.ts`). Ticks rest at a width set by how
    much was said in the round, so ADDING a Gaussian let a heavy neighbour
    outgrow the tick under the cursor. `outlineTickWidth` interpolates toward
    the bell weighted by the bell itself, which keeps the pointer's own tick
    the longest and the run of them reading as one normal distribution, while
    distant ticks keep the resting texture. `RAIL_TRACK_WIDTH` is derived from
    the peak, not written down separately: the strip is `overflow-y: auto`,
    which makes the x axis `auto` too, so a tick wider than the track would
    scroll the rail sideways instead of extending.
  - **`scrollRowToTop` is the ONLY place a row index becomes a scroll.** It adds
    `leadingRowCount` and compensates the viewport's top padding, which Virtua's
    `align: 'start'` does not know about. That compensation is not cosmetic: the
    rail reads positions back out of the same coordinate space, so a call site
    that skips it lands a padding's worth low and the rail then reports the round
    BEFORE the one that was asked for. Group expansion, outline jumps, and the
    imperative/search `scrollToIndex` all go through it — do not add a fourth
    direct `vlistRef.scrollToIndex` call.
  - **A jump into unmeasured rows must be re-issued once it settles.** Virtua
    scrolls on ESTIMATED offsets there. It _does_ re-issue internally as
    measurements arrive, but gives up after 150ms of measurement silence
    (`virtua/lib/core/index.js`), and a React commit plus the ResizeObserver
    round trip for a screenful of message rows routinely exceeds that — so a far
    jump settles a round short. (It is NOT that `shift={false}` disables
    correction; that was the original, wrong diagnosis.) Arriving is what
    measures the rows, so `handleStreamScrollEnd` re-runs the same jump until it
    is within `OUTLINE_JUMP_TOLERANCE_PX`, bounded by
    `OUTLINE_JUMP_MAX_CORRECTIONS` (the list's tail genuinely cannot reach the
    top, so it must stop rather than retry against the clamp). Any wheel / touch
    / keydown on the viewport abandons the pending correction — a reader who has
    started scrolling must never be yanked back.
    `OUTLINE_ANCHOR_TOLERANCE_PX` then has to EXCEED the jump tolerance: a jump
    settles a hair above its target, and an exact-to-the-pixel "has this round
    started" test reported the previous round while its successor visibly owned
    the top edge.
  - **Follow-output suppression for a jump is tied to `pendingOutlineJumpRef`,
    not to a render.** Group expansion can release in the layout effect of its
    own commit because it _runs_ in one; a jump is an event handler, and React
    skips the commit when `setActiveOutlineIndex` gets the value it already has
    — which is exactly what clicking the current round does. Keying suppression
    on the pending ref means the release cannot be skipped.
  - Tests: `tests/conversation-outline.test.ts`,
    `tests/conversation-outline-active.test.ts`,
    `tests/conversation-outline-rail-geometry.test.ts`. The
    `ExtremeConversation` story (120 rounds, turns up to 220 paragraphs, a round
    with no reply, CJK and degenerate titles) is what surfaces the jump and
    tolerance behaviour; the comfortable stories do not.
- `markdown-renderer.tsx` — assistant markdown (story: `MarkdownRenderer.stories.tsx`).
  Conversation font size is a bounded integer pixel value, not a preset name; keep body,
  headings, dense monospace output, terminal output, and collapsed-text height scaling
  through `conversation-font-size-classes.ts`, with legacy preset migration in settings.
  Keep Streamdown in streaming mode for incomplete Markdown, but do not enable its
  word-level `animated` option: it wraps every word in an opacity-animated span and can
  explode Chromium compositor-layer count during long turns.
- `chat_failed` notices (`ChatFailedNoticeView` in `view.tsx`) put the raw agent error
  behind a **modal**, never a hover tooltip — a tooltip is unreachable on touch and
  truncates upstream payloads, so mobile users could not read or copy the real error.
  `chat-failed-detail-dialog.tsx` renders the full verbatim `meta.message` plus
  reason/code and a one-tap copy; `chat-failed-error-report.ts` holds the pure
  readable-message extraction and clipboard-report builder (tested).
- `terminal-component.tsx` — terminal/tool output rendering.
- Terminal persistence and legacy preview limits are documented in
  context/terminal-output-lifecycle.md.
  Never send a full legacy output through ANSI parsing, search, or React rendering.
- `assistant-edited-files.tsx` — per-turn edited-file summary + grouped path list. It shows
  four paths by default, expands in place, and aligns per-file add/delete stats without
  returning to one-pill-per-file chrome (story exists).
- `message-content-guards.ts` — type guards for history item variants; update together
  with new `MessageContent` types (see `context/hotspots.md` "Shared: schemas").
  **`isMessageContent` gates rendering** — a `MessageContent` variant missing a `case`
  here is silently dropped from the parsed history (see `index.tsx`).
- `message-send-status-context.tsx` / `message-copy.ts` — send-state + copy helpers.
- A user entry negatively acknowledged by missing-history recovery
  (`SessionMeta.lastMissingHistoryUserMsgId === message.id`, entry still
  non-terminal) renders as a terminal "Not delivered" label, never as an
  endless sending spinner. The derivation is display-only
  (`src/lib/undelivered-user-turn.ts`): the marker permanently excludes the
  exact turn, so the old turn never revives. The label is the ONLY recovery
  entry point: clicking it opens `ResendUndeliveredDialog` (local to
  `view.tsx`), which resends the SAME content as a brand-new message through
  the interface's ordinary send path (`onResendUndelivered`, threaded through
  `SessionChatStream` → `MessageRowView`), then the interface supersedes the
  abandoned entry to `canceled` — the ordinary producer write clears the
  marker, and without the terminal flip the stale pending entry would
  duplicate-dispatch once the marker is gone. Never add an automatic or
  old-turn re-dispatch path.
- File attachment rendering and mobile image-preview invariants:
  [session-files-rendering.md](session-files-rendering.md).
