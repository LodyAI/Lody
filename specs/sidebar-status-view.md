# Sidebar Status View and Human Owner Selection

Status: draft
Translation: current

[中文](sidebar-status-view.zh.md)

## Scenario

Users running many parallel Agent conversations lose spatial memory when the
sidebar constantly re-sorts by recency or jumps between live execution buckets
(Needs you / Running / Finished / PR / Idle). Users need a stable manual order
for active work, a clear boundary between what they are actively tracking and
what can wait or has settled, and the ability for Agents to list workspace
members and assign or inherit the right human owner (`SessionMeta.userId`) when
creating conversations.

## Behavior

### Human owner selection via MCP

- `SessionMeta.userId` remains the single human owner and authorization
  identity for a conversation.
- `lody_member_list` lists current workspace members from the authoritative
  workspace directory (`workspaceMembers.listForCliToken`, matching the UI's
  `workspaceMembers.list`); on shared machines `isCurrentUser` reflects the
  human driving the turn. Directory entries never grant execution permissions.
- When an Agent creates a session through MCP (`lody_session_create`,
  `lody_session_create_many`), it may pass `ownerUserId: string`. When
  omitted, it inherits the calling session's `userId`. The resolved owner is
  frozen into the canonical command at acceptance time so daemon restart
  recovery preserves it. After resolving the target machine and local
  project, creation verifies that the target owner already has access to that
  machine and local project (mirroring UI owner transfer), while turn
  authorization remains independently bound to the driving human requester.

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
     showing when it returns to Focus. Once `now >= snoozedUntil`, a one-shot
     wake-up anchored to `snoozedUntil` (gated on online sync) advances
     `snoozeWokenUntil` (without deleting `snoozedUntil`, so a newer re-snooze
     is never clobbered), updates `lastMessageAt` to `max(lastMessageAt,
     snoozedUntil)` so the conversation becomes unread without re-marking
     already-read sessions unread on late-syncing devices, assigns a top Focus
     `orderKey` (still below Pinned) when unread, and records
     `focusRestoredAt` (so older sessions also surface).
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
- Dragging a row from Later or Settled into Focus clears its snooze/settled
  state (recording `focusRestoredAt` if older than 7 days) and places it at
  the dropped `orderKey`.

## Data ownership and ordering

- `SessionMeta.pinOrderKey` is renamed to `SessionMeta.orderKey` (canonical
  uppercase hex fractional index via `@loro-dev/fractional-index`). Both
  Pinned and Focus use `orderKey`; unpinning clears `pinSectionId` while
  retaining `orderKey`.
- Four optional fields are added to `SessionMeta` in Meta Flock (shared
  across workspace members; modifying shared status or Focus order requires
  write permission; per-user private status sorting is out of scope for this
  phase):
  - `snoozedUntil?: number` (epoch ms)
  - `snoozeWokenUntil?: number` (epoch ms; monotonic watermark of the latest
    expired `snoozedUntil` already woken)
  - `settledAt?: number` (epoch ms; written as `max(serverNow, lastMessageAt)`
    to tolerate clock skew)
  - `focusRestoredAt?: number` (epoch ms; overrides the 7-day inactivity rule
    until 7 days elapse from `focusRestoredAt`)
- Conversations waiting on a human permission approval always surface in
  **Focus** regardless of snooze or settle timestamps.
- Automatic 7-day settling is a pure derived state computed from `now` and
  metadata timestamps, avoiding background CRDT write storms across offline
  replicas.
- No new room or document type is added.

## Compatibility

- All added fields are optional on `SessionMeta`. Older clients ignore them
  and continue rendering conversations normally.
- `pinOrderKey` had not shipped; renaming it to `orderKey` requires no data
  migration.

## Out of scope

- Keyboard reordering of Focus rows.
- Agent-managed unread suppression (`agentManaged`), deferred to a separate
  design pass.
- Per-user private Focus ordering or per-session LoroDoc scratch pads / Today
  outliner (tracked for a later experimental phase).
- Mobile native iOS/Android clients.

## Evidence

Implementation:

- Shared schema & ordering: `packages/shared/src/schema.ts`,
  `packages/shared/src/pinned-sections.ts`
- Status classification & snooze countdown:
  `packages/components/src/lib/sidebar-status-group.ts`
- Sidebar rendering, DnD, menus & actions:
  `packages/components/src/components/sidebar-updated-session-list.tsx`,
  `packages/components/src/components/loro-sidebar.tsx`,
  `packages/components/src/components/loro-app-sidebar.tsx`,
  `packages/components/src/components/sessions/session-chat-interface.tsx`,
  `packages/components/src/hooks/use-session-actions.ts`,
  `packages/components/src/atoms/doc-meta.ts`,
  `packages/components/src/atoms/sidebar-state.ts`
- MCP & CLI member list / owner selection:
  `apps/cli/src/mcp/lody-mcp-server.ts`,
  `apps/cli/src/lib/message-handler.ts`,
  `apps/cli/src/commands/session.ts`
- Storybook:
  `packages/components/src/stories/SidebarStatusView.stories.tsx`
