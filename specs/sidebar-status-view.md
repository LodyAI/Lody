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
     interaction and settle animation). A newly created conversation is
     written an `orderKey` below every existing key so it opens at the top
     of Focus; a conversation opened by another conversation (or a child
     Tab) gets no key at creation, renders nested under its opener, and
     never reorders that opener row. Conversations without an `orderKey`
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
  - **Snooze / Later** submenu with quick presets (In 1 hour, In 3 hours,
    Tomorrow morning 9:00, Next week Monday 9:00, Custom date/time) and
    **Move to Focus** when already snoozed.
  - **Settle** when in Focus or Later, or **Move to Focus** when in Settled.
- On desktop, Focus and Later rows reveal a one-click **Settle** action on
  hover in the slot other organize modes give to Archive; Settled rows keep
  Archive there. A Later row's wake-up countdown parks at the row's right
  edge in neutral ink.
- Snoozing, settling, or moving a conversation back to Focus when it has
  active opened sub-conversations first asks whether they should follow —
  apply to this conversation only, or to the whole opened-session tree.
  Contained Tabs follow their owner's bucket and are never written separately,
  matching the sub-conversation summary the Archive confirmation already
  shows. Dragging a row into Focus restores its opened sub-conversations with
  it without asking; only the dropped row gains an `orderKey`.
- Sending a message in a snoozed or settled conversation clears its
  `snoozedUntil` / `settledAt` state so it returns to Focus.
- Dragging a row in Focus materializes real `orderKey`s for any expired-snooze
  rows at the top of Focus so the user's explicit drag placement always wins
  cleanly. Dragging a row from Later, Settled or the Pinned area (which unpins
  it) into Focus restores it at the dropped `orderKey`, and Move to Focus
  restores it in place; its opened sub-conversations follow when included. Placement and
  restore never consume a wake-up; only opening the conversation, sending in it
  or settling it does. A placed or restored row records `focusRestoredAt` and
  keeps an expired `snoozedUntil`, so it stays where it was put and stays unread
  until it is read; a snooze still in the future is cleared on restore. A woken
  row floats to the top of Focus only while its expired `snoozedUntil` is later
  than its `focusRestoredAt`, so a new snooze floats it again when it expires.

### Phones

The phone WebView layout and the native iOS and Android clients show the same
Pinned area and the same three tiers, in the same order, as the desktop sidebar.
All three ship this; the design, its limits and what was verified are in the
[phone note](../.agents/notes/implemented/architecture/2026-11-21-status-view-on-phones.md).

- Every surface derives the list and plans its writes from one shared
  implementation. Native clients render the layout their shared runtime computes
  and never sort or classify these lists themselves.
- A long press opens the full action menu, and moving while still pressed turns
  into a drag: reorder Focus, or drop a Later or Settled row into Focus. Every drag
  outcome is also a menu item and an accessibility action.
- A trailing swipe offers Settle and Later on Focus and Later rows and Archive on
  Settled rows. Later opens a bottom sheet with the presets and a custom date and
  time. Settle and Later confirm with an Undo notice. The conversation page's "…"
  sheet carries the same status actions.
- The native clients' previous status grouping (Needs you, Running, Finished, Pull
  requests, Idle) is replaced by these tiers.
- Native clients have no live session presence. They treat a conversation as
  working or waiting for approval from its synced status, so a snoozed or settled
  conversation waiting for approval, or a conversation silent for seven days that
  is running, can sit in a different tier there for a short time.

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
- Encrypted workspaces on the native iOS and Android clients, which do not open
  encrypted workspaces at all yet. The phone WebView supports them.
- Live session presence on the native clients.

## Evidence

Implementation:

- Shared schema, ordering & unread summary: `packages/shared/src/schema.ts`,
  `packages/shared/src/pinned-sections.ts`,
  `packages/shared/src/live-activity-summary.ts`
- Status layout, write planning, snooze countdown & golden vectors:
  `packages/shared/src/status-view/`
- Read receipts: `packages/components/src/lib/session-read-receipt.ts`
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
- Phones: `packages/components/src/components/mobile/` (WebView); the native
  shared runtime and lists in the `apps/mobile/ios` and `apps/mobile/android`
  submodules.

Executed validation: the golden vectors (13 layout and 38 command cases) in
`packages/shared/tests/status-view.test.ts`, against the desktop and phone adapters
in `packages/components` and in the iOS and Android runtime tests; the Storybook
end-to-end suite `packages/components/tests/e2e/sidebar-status-focus-drop.spec.ts`
(5 cases); the phone WebView in Storybook on the iOS Simulator and the Android
emulator, and with real touch input in Chromium; the native lists with the offline
fixture on the iOS 26.5 and 27.0 Simulators and a Pixel 8 / Android 16 emulator.
Not verified: physical devices, iOS 16.4–17.3 runtimes, a signed-in cloud workspace
on the native clients, the Android `/api/time` read against staging, the desktop app
writing to a real replica, a real encrypted Guest session and the hosted gateway
admitting the encrypted writes, VoiceOver on a device, and the Capacitor-packaged
app. Known gap: on iOS and Android a teammate's local-project conversation offers
no status actions, because the native runtime cannot read whether the project is
shared; desktop offers them when it is. Details: the
[phone note](../.agents/notes/implemented/architecture/2026-11-21-status-view-on-phones.md#verification).
