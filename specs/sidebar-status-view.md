# Sidebar Status View

Status: draft
Translation: current

[中文](sidebar-status-view.zh.md)

## Scenario

Users running many parallel Agent conversations lose spatial memory when the
sidebar constantly re-sorts by recency or jumps between live execution buckets
(Needs you / Running / Finished / PR / Idle). Users need a stable manual order
for active work and a clear boundary between what they are actively tracking
and what can wait or has settled.

## Behavior

### Sidebar Status view

- The sidebar's "By status" organize option is unified to **Status**
  (`状态`).
- The **Pinned** area stays at the top of the sidebar with its own Pinned
  Sections; Pinned Sections do not mix into the Status sections below.
- Below Pinned, the Status view organizes non-archived, non-pinned
  conversations into three tiers:
  1. **Focus** (`进行中`): Expanded by default. Ordered manually by
     `SessionMeta.orderKey` (fractional index, shared with Pinned). Users
     reorder Focus rows via pointer drag-and-drop (reusing Pinned's drag
     interaction and settle animation). Conversations without an `orderKey`
     sort after keyed rows by stable ascending `session.id` so ordinary new
     replies never cause them to jump. Keyboard reordering is out of scope.
  2. **Later** (`稍后`): Collapsed by default (showing its count). Contains
     conversations with `snoozedUntil > now`. Sorted by `snoozedUntil`
     ascending (soonest wake-up first) when expanded. Each row displays a
     compact countdown indicator (countdown icon + `3d`, `2h`, `45m`, `<1m`)
     showing when it returns to Focus. Once `now >= snoozedUntil` (on the
     synced server clock), wake-up is derived directly from `snoozedUntil`
     without background CRDT writes: the conversation surfaces in **Focus**
     (even if older than 7 days), floats to the top of Focus (below Pinned),
     and derives unread state and activity time from
     `max(lastMessageAt, snoozedUntil)`. Real `lastMessageAt`, user-reordered
     `orderKey`, and newer re-snoozes are never overwritten by another device.
  3. **Settled** (`已完成`): Collapsed by default (showing its count).
     Contains conversations explicitly settled (`settledAt` with no newer
     message) or inactive for at least 7 days (`now - lastMessageAt >= 7d`,
     not working, not waiting for permission, and not manually restored to
     Focus within the last 7 days). Sorted by latest activity descending when
     expanded. A newer message (`lastMessageAt > settledAt`) automatically
     returns a settled conversation to Focus.
- **Opened-by child sessions**: Each conversation is classified into its own
  Status tier based on its own metadata. When an opener `A` and its child `B`
  are in the same Status tier, `B` renders indented under `A`. Acting on `B`
  (Later, Settle, Move to Focus) updates only `B`; when `A` and `B` are in
  different tiers they appear independently in their own tiers, and returning
  to the same tier restores the indentation. Each row's menu reflects the tier
  it is rendered in.

### Entry points and actions

- Both the sidebar context menu and the conversation header menu (`…`)
  provide (for users with write permission on non-archived conversations):
  - **Snooze / Later** submenu with quick presets (Later today +3h, Tomorrow
    morning 9:00, Next week Monday 9:00, Custom date/time) and **Move to
    Focus** when already snoozed.
  - **Settle** when in Focus, or **Move to Focus** when in Settled.
- Sending a message in a snoozed or settled conversation clears its
  `snoozedUntil` / `settledAt` state so it returns to Focus.
- Dragging a row in Focus materializes real `orderKey`s for any expired-snooze
  rows at the top of Focus (clearing their expired `snoozedUntil` while
  preserving `focusRestoredAt`) so the user's explicit drag placement always
  wins cleanly. Dragging a row from Later or Settled into Focus clears its
  snooze/settled state and places it at the dropped `orderKey`.

## Data ownership and ordering

- `SessionMeta.pinOrderKey` is renamed to `SessionMeta.orderKey` (canonical
  uppercase hex fractional index via `@loro-dev/fractional-index`). Both
  Pinned and Focus use `orderKey`; unpinning clears `pinSectionId` while
  retaining `orderKey`.
- Three optional fields are added to `SessionMeta` in Meta Flock (shared
  across workspace members; modifying shared status or Focus order requires
  write permission; per-user private status sorting is out of scope for this
  phase):
  - `snoozedUntil?: number` (epoch ms)
  - `settledAt?: number` (epoch ms; written as `max(serverNow, lastMessageAt)`
    to tolerate clock skew)
  - `focusRestoredAt?: number` (epoch ms; overrides the 7-day inactivity rule
    until 7 days elapse from `focusRestoredAt`)
- Conversations waiting on a human permission approval always surface in
  **Focus** regardless of snooze or settle timestamps.
- Both 7-day automatic settling and snooze expiration wake-up are pure derived
  states computed from synced server time and metadata timestamps, avoiding
  background CRDT write storms and multi-device overwrite races.
- No new room or document type is added.

## Compatibility

- All added fields are optional on `SessionMeta`. Older clients ignore them
  and continue rendering conversations normally.
- `pinOrderKey` had not shipped; renaming it to `orderKey` requires no data
  migration.

## Out of scope

- Keyboard reordering of Focus rows.
- Agent-managed unread suppression and MCP owner directory tools (deferred to
  separate changes).
- Per-user private Focus ordering or per-session LoroDoc scratch pads / Today
  outliner (tracked for a later experimental phase).
- Mobile native iOS/Android clients.

## Evidence

Implementation:

- Shared schema, ordering & unread summary: `packages/shared/src/schema.ts`,
  `packages/shared/src/pinned-sections.ts`,
  `packages/shared/src/live-activity-summary.ts`
- Status classification, read receipts & snooze countdown:
  `packages/components/src/lib/sidebar-status-group.ts`,
  `packages/components/src/lib/session-read-receipt.ts`
- Sidebar rendering, DnD, menus & actions:
  `packages/components/src/components/sidebar-updated-session-list.tsx`,
  `packages/components/src/components/loro-sidebar.tsx`,
  `packages/components/src/components/loro-app-sidebar.tsx`,
  `packages/components/src/components/sessions/session-chat-interface.tsx`,
  `packages/components/src/hooks/use-session-actions.ts`,
  `packages/components/src/atoms/doc-meta.ts`,
  `packages/components/src/atoms/sidebar-state.ts`
- Storybook:
  `packages/components/src/stories/SidebarStatusView.stories.tsx`
