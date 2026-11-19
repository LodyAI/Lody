# Sidebar Status View and Agent-Managed Unread Suppression

Status: draft
Translation: current

[中文](sidebar-status-view.zh.md)

## Scenario

Users running many parallel Agent conversations lose spatial memory when the
sidebar constantly re-sorts by recency or jumps between live execution buckets
(Needs you / Running / Finished / PR / Idle). At the same time, conversations
that an Agent creates and runs autonomously should not raise unread dots or
notifications for humans, and users need a clear boundary between what they are
actively tracking today and what can wait or has settled.

## Behavior

### Agent-managed unread suppression

- `SessionMeta.userId` remains the single human owner and authorization
  identity for a conversation.
- A new optional boolean field `agentManaged?: boolean` on `SessionMeta`
  marks conversations currently managed by an Agent rather than awaiting
  direct human reading.
- When `agentManaged` is `true`, the conversation suppresses human unread
  indicators (sidebar/tab unread dots, window badge, desktop notifications,
  and live-activity unread counts). Live running/permission indicators remain
  visible so blocked approvals are never silently hidden.
- When an Agent creates a session through MCP (`lody_session_create`,
  `lody_session_create_many`), it may pass `agentManaged: boolean`. When
  omitted, the new session inherits the calling session's `agentManaged` value
  (defaulting to `false`).
- `lody_session_list` exposes `agentManaged` alongside the existing
  `ownerUserId` field.
- When a human sends a message into an `agentManaged` session, `agentManaged`
  is cleared (`false`) so the human receives unread notifications for the
  Agent's reply (and any active `snoozedUntil` / `settledAt` state is also
  cleared so the conversation returns to Focus). Users with write permission
  can also toggle `agentManaged` explicitly from the session context menu.

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
     sort after keyed rows by latest activity. Keyboard reordering is out of
     scope.
  2. **Later** (`稍后`): Collapsed by default (showing its count). Contains
     conversations with `snoozedUntil > now`. Sorted by `snoozedUntil`
     ascending (soonest wake-up first) when expanded. Each row displays a
     compact countdown indicator (countdown icon + `3d`, `2h`, `45m`, `<1m`)
     showing when it returns to Focus. Once `now >= snoozedUntil`, the
     conversation automatically returns to Focus without requiring a metadata
     write.
  3. **Settled** (`已收尾`): Collapsed by default (showing its count).
     Contains conversations explicitly settled (`settledAt` with no newer
     message) or inactive for at least 7 days (`now - lastMessageAt >= 7d`,
     not working, not waiting for permission, and not manually restored to
     Focus within the last 7 days). Sorted by latest activity descending when
     expanded. A newer message (`lastMessageAt > settledAt`) automatically
     returns a settled conversation to Focus.

### Entry points and actions

- Session context menu ("More actions") provides:
  - **Snooze / Later** submenu with quick presets (Later today +3h, Tomorrow
    morning 9:00, Next week Monday 9:00, Custom date/time) and **Move to
    Focus** when already snoozed.
  - **Settle** when in Focus, or **Move to Focus** when in Settled.
  - **Mark as agent-managed / Take over (enable unread)** toggle.
- Dragging a row from Later or Settled into Focus clears its snooze/settled
  state (recording `focusRestoredAt` if older than 7 days) and places it at
  the dropped `orderKey`.

## Data ownership and ordering

- `SessionMeta.pinOrderKey` is renamed to `SessionMeta.orderKey` (canonical
  uppercase hex fractional index via `@loro-dev/fractional-index`). Both
  Pinned and Focus use `orderKey`; unpinning clears `pinSectionId` while
  retaining `orderKey`.
- Four optional fields are added to `SessionMeta` in Meta Flock (shared across
  workspace members with the same visibility as `isPinned`; per-user private
  status sorting is out of scope for this phase):
  - `agentManaged?: boolean` (requires write permission to modify)
  - `snoozedUntil?: number` (epoch ms)
  - `settledAt?: number` (epoch ms; written as `max(serverNow, lastMessageAt)`
    to tolerate clock skew)
  - `focusRestoredAt?: number` (epoch ms; overrides the 7-day inactivity rule
    until 7 days elapse from `focusRestoredAt`)
- Conversations waiting on a human permission approval always surface in
  **Focus** regardless of snooze or settle timestamps, and opened-by child
  sessions follow their visible root's Status tier.
- Automatic 7-day settling and snooze expiration are pure derived states
  computed from `now` and metadata timestamps, avoiding background CRDT write
  storms across offline replicas.
- No new room or document type is added.

## Compatibility

- All added fields are optional on `SessionMeta`. Older clients ignore them
  and continue rendering conversations normally.
- `pinOrderKey` had not shipped; renaming it to `orderKey` requires no data
  migration.

## Out of scope

- Keyboard reordering of Focus rows.
- Per-user private Focus ordering or per-session LoroDoc scratch pads / Today
  outliner (tracked for a later experimental phase).
- Mobile native iOS/Android clients.

## Evidence

Implementation:

- Shared schema & ordering: `packages/shared/src/schema.ts`,
  `packages/shared/src/pinned-sections.ts`,
  `packages/shared/src/live-activity-summary.ts`
- Status classification & snooze countdown:
  `packages/components/src/lib/sidebar-status-group.ts`,
  `packages/components/src/lib/session-read-receipt.ts`
- Sidebar rendering, DnD, menus & actions:
  `packages/components/src/components/sidebar-updated-session-list.tsx`,
  `packages/components/src/components/loro-sidebar.tsx`,
  `packages/components/src/components/loro-app-sidebar.tsx`,
  `packages/components/src/hooks/use-session-actions.ts`,
  `packages/components/src/atoms/doc-meta.ts`,
  `packages/components/src/atoms/sidebar-state.ts`
- MCP & CLI session creation/list:
  `apps/cli/src/mcp/lody-mcp-server.ts`,
  `apps/cli/src/commands/session.ts`
- Storybook:
  `packages/components/src/stories/SidebarStatusView.stories.tsx`
