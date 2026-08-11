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
- `build-chat-stream-items.ts` — `buildChatStreamItems()` turns `sessionDoc.history`
  into `VList` items. **Normalizes defensively** so interrupted / bad-network docs
  can't make virtua overlap deterministically: drops empty assistant entries (they'd
  render to `null` = an unmeasurable row) and de-dupes by `id` (the VList keys rows
  by `history.id`; duplicate keys desync virtua). Test: `tests/build-chat-stream-items.test.ts`.
- `markdown-renderer.tsx` — assistant markdown (story: `MarkdownRenderer.stories.tsx`).
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
- File attachment rendering and mobile image-preview invariants:
  [session-files-rendering.md](session-files-rendering.md).
