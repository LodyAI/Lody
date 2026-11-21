# Status view and pin sections on every phone surface

Date: 2026-11-21
Status: proposed
Translation: current

[中文](2026-11-21-status-view-on-phones.zh.md)

## Abstract

The Status view (Focus / Later / Settled), manual order and pin sections exist only
in the desktop sidebar. The phone WebView list groups by project or date and can
only display pin sections; the native iOS and Android lists run an older status
grouping written twice, in Swift and Kotlin, over a catalog that drops the five
fields the view needs. This note proposes one shared, pure implementation of the
list layout and of the write planning, consumed by the desktop sidebar, the phone
WebView and the native clients' shared TypeScript runtime, with one set of golden
vectors run on every consumer. Phones get full operation parity, including drag
reordering and section management. Nothing here is implemented or verified yet.
Native clients still cannot open encrypted workspaces at all; that is a separate
project and the one accepted limit.

## Problem

- Classification is pure (`packages/components/src/lib/sidebar-status-group.ts`),
  but tier ordering lives in `sidebar-updated-session-list.tsx`
  (`buildSidebarUpdatedBuckets`), wake-up activity and unread enrichment live in
  `loro-app-sidebar.tsx`, and the write rules live in the React hook
  `use-session-actions.ts`. No other surface can reuse them.
- The phone WebView list (`components/mobile/mobile-chat-list.tsx`) has no status
  grouping, and its rows expose no Later, Settle or Move to Focus anywhere.
- Native clients receive sessions from `apps/mobile/ios/packages/cloud-runtime`
  (`protocol/catalog.ts` `projectRows`), which drops `orderKey`, `pinSectionId`,
  `snoozedUntil`, `settledAt` and `focusRestoredAt`, never reads `pinSection` rows,
  has no synced server clock, does not clear Later/Settled state on send and
  writes no `orderKey` on creation. Swift (`InboxSections`, `HomeStatusGroup`) and
  Kotlin (`ChatListModel`) each implement the retired Needs-you/Running/Finished
  grouping. Android additionally has no pin, no swipe actions and an older
  runtime snapshot than iOS.

## Decision

### One layout, one write planner, one vector set

Two pure modules in `packages/shared` (no React, no DOM, no clock, no randomness
other than injected) own the behavior. The extraction is behavior-preserving: the
desktop sidebar's current rendering and its tests are the oracle.

**Layout** — `buildStatusViewLayout(input) → StatusViewLayout`.

Input: the visible sessions (non-archived, scope already applied, contained Tabs
folded into their owner as today), each with its metadata timestamps and keys plus
two host-supplied facts, `isWorking` and `isWaitingPermission`, and two
host-supplied permissions, `canManage` and `canPrefer`; the pin sections with
`sectionsLoaded`; the per-section count of rows the scope hid; `nowMs` on the
synced server clock.

Output (JSON-serializable; this shape is the cross-platform contract):

```ts
type StatusViewLayout = {
  pinned: Array<{
    sectionId: string | null; // null is the default section
    name: string | null;
    rows: StatusViewRow[];
    hiddenCount: number;
  }>;
  focus: StatusViewRow[];
  later: StatusViewRow[];
  settled: StatusViewRow[];
  canManageSections: boolean; // create, rename, reorder, delete pin sections
  /** Earliest future instant at which the layout can change by time alone. */
  nextChangeAt: number | null;
};
type StatusViewRow = {
  id: string;
  tier: 'pinned' | 'focus' | 'later' | 'settled';
  children: StatusViewRow[]; // opened-by children rendered under this row
  activityAt: number; // max(lastMessageAt, expired snoozedUntil)
  unread: boolean;
  snoozedUntil: number | null; // set while the row is in Later
  woken: boolean; // expired snooze floating at the top of Focus
  canManage: boolean; // Later / Settle / Move to Focus / reorder in Focus
  canPrefer: boolean; // pin, unpin, pin placement
};
```

Collapse state, "Show all" folding and the countdown label stay with each surface;
the shared module exports the defaults and the countdown and preset formatters.

**Write planning** — `planStatusViewCommand(state, command, env) → writes`.
`state` is the same metadata snapshot the layout reads; `env` supplies `nowMs` and
a random-byte source for fractional-index jitter. The result is a list of session
metadata patches and pin-section row writes or deletes. Commands:

```ts
type StatusViewCommand =
  | { type: 'snooze'; sessionId: string; until: number; includeOpened: boolean }
  | { type: 'settle'; sessionId: string; includeOpened: boolean }
  | { type: 'moveToFocus'; sessionId: string; includeOpened: boolean }
  | { type: 'setPinned'; sessionId: string; pinned: boolean }
  | {
      type: 'move'; // drag-and-drop, "Move to section", "Move to top"
      sessionId: string;
      to: { area: 'focus' } | { area: 'pinned'; sectionId: string | null };
      beforeId: string | null; // the row it lands in front of; null is the end
    }
  | { type: 'createSection'; sectionId: string; name: string }
  | { type: 'renameSection'; sectionId: string; name: string }
  | { type: 'deleteSection'; sectionId: string }
  | { type: 'moveSection'; sectionId: string; beforeId: string | null }
  | { type: 'touchOnSend'; sessionId: string } // clears snoozedUntil / settledAt
  | { type: 'newSessionOrder'; sessionId: string }; // top of Focus; none for opened-by or Tab
```

A session patch carries `access: 'manage' | 'prefer'` so the host applies the
matching guard, and `null` clears a field. `state` may add `related` rows the list
does not show (another scope, archived) that opened-tree actions still reach; they
never affect order. A command the state cannot satisfy (unknown row, missing
permission, a past snooze time) plans no writes rather than a partial set.

A move names the neighbor it lands before rather than an index, so a stale list on
the caller still resolves against the planner's current order. The planner keeps
today's rules: one key per move with jitter, keys for unkeyed rows above the drop,
materializing expired snoozes when Focus is reordered, restoring opened
sub-conversations when a row is dropped into Focus, `settledAt = max(now,
lastMessageAt)`, unpin keeps `orderKey`.

The modules live in `packages/shared/src/status-view/`, with the vectors in its
`vectors/` directory.

**Golden vectors** — JSON files of `{input, expected layout}` and `{state, command,
fixed env, expected writes}` live beside the shared modules. They run in
`packages/shared`, against the desktop and phone-WebView adapters in
`packages/components`, in the iOS runtime tests and in the Android runtime tests.

### Native clients render, the shared runtime decides

The shared modules and the vendored fractional index are copied verbatim into
`cloud-runtime` at a pinned Lody commit with a provenance record and hashes, the
pattern that runtime already uses for the session-sharing files. The runtime:

- projects the five dropped fields and keeps a live read of the workspace Flock so
  `pinSection` rows arrive without an app action;
- estimates the server clock offset from `/api/time` with the round-trip midpoint
  used by `packages/shared/src/time-sync.ts`, falling back to the device clock
  while unknown;
- adds `statusView: { mine: StatusViewLayout; team: StatusViewLayout }` and
  `pinSections` to the catalog snapshot, so layout and rows arrive atomically and
  restore from the catalog cache on a cold start, and republishes at `nextChangeAt`
  and on foreground;
- exposes one method, `statusViewCommand({ workspaceId, command })`, that plans
  against its current replica and writes, plus `snoozePresets()`; one method keeps
  Android's capability list within its bound;
- applies `touchOnSend` when a message is dispatched and `newSessionOrder` when a
  session is created.

Swift and Kotlin never sort or classify these lists. The time and project
groupings keep their native code; the Pinned area in every grouping and the whole
Status grouping come from the layout. The retired native status grouping is
removed.

### Phone interaction (WebView, iOS, Android)

| Gesture                     | Result                                                             |
| --------------------------- | ------------------------------------------------------------------ |
| Tap                         | Open the conversation                                              |
| Long press                  | The full action menu; moving while still pressed turns into a drag |
| Trailing swipe              | Focus and Later rows: Settle, Later. Settled rows: Archive         |
| Leading swipe               | Pin or unpin                                                       |
| Section header ⋯            | New section, Rename, Move up, Move down, Delete                    |
| Conversation page "…" sheet | Later, Settle, Move to Focus                                       |

- Drags reorder Focus, reorder and move between pin sections, pin a row dropped
  into the Pinned area, and restore a Later or Settled row dropped into Focus. The
  list scrolls at the edges; lift and each crossed slot give haptic feedback. The
  dropped order is held locally until the write reads back, and incoming reorders
  are frozen while a drag is in flight.
- Every drag outcome is also a menu item (Later, Settle, Move to Focus, Pin, Move to
  section, Move to top) and an accessibility action (Move up, Move down).
- Later opens a bottom sheet with the four presets, each showing its resolved time,
  and a custom date and time picker inside the same sheet; past times are refused.
  Settle and Later confirm with an Undo notice. The "apply to opened
  sub-conversations too?" question matches desktop.
- Sections reorder with Move up and Move down rather than by dragging headers.
- Collapse state and the chosen grouping stay device-local. Later and Settled start
  collapsed; Settled folds past 20 rows. The WebView phone list gains a Status
  grouping, the default for new installs.

## Alternatives

- **Reimplement the rules in Swift and Kotlin with shared vectors.** Rejected:
  three implementations of ordering, wake-up and write planning drift, and the
  native clients already run a shared TypeScript runtime that owns sync.
- **Emit index diffs from the runtime (Element X style).** Rejected for now: the
  catalog is already a full snapshot, diffable data sources and keyed Compose lists
  compute their own animations, and a dropped diff needs a reset protocol.
- **Generate order keys in native code.** Rejected: key generation, jitter and the
  tie-break stay in one place; native sends the neighbor it dropped before.
- **A separate "Reorder" edit mode with handles on phones.** Kept only as the
  fallback for the WebView if long-press drag fails on real WKWebView or Android
  WebView; one grammar across phones is preferred.
- **Native encrypted workspaces in this change.** Deferred to its own project:
  native clients block encrypted workspaces before any content opens, and enabling
  them needs custody, pairing, recovery, the ledger and a protected Streams codec.
  The layout and the planner sit above decryption, so they need no change when
  that lands.

## Consequences and limits

- Native has no session presence channel. The runtime derives `isWorking` and
  `isWaitingPermission` from durable catalog state (`status`, `awaitingUserSince`),
  while desktop uses live presence. The lists can differ briefly for a snoozed or
  settled conversation that is waiting for approval, and for a conversation silent
  for seven days that is running.
- Read-only members must not be offered section management or status actions; today
  the desktop offers them and the encrypted upload fails silently.
- Status actions use the full session-management guard. Traced: on the phone WebView
  in an encrypted workspace, the person's own conversations on another member's
  shared machine are refused, because the phone does not discover that machine
  (`isSessionEditableToUser`); other members' conversations there are not listed
  at all. The guard is kept: allowing the write needs the portable machine-sharing
  read the phone lacks, not a looser guard. Those rows are already `readOnly` by
  the same predicate, so the phone list does not offer Later, Settle or Move to
  Focus on them; pinning stays available.
- Encrypted workspaces on the WebView need no special handling: no in-repository
  layer filters session metadata fields or workspace Flock row families. A
  non-owner Member sealing a `pinSection` row and the new session-meta fields is
  tested at the room level (`apps/electron/src/main/services/e2ee-runtime.test.mjs`);
  the hosted gateway's admission cannot be inspected from this repository.
- Android has no mark-read command; whether opening a woken conversation clears
  its unread state there is unverified.

## Delivery

1. Lody: shared layout, planner and vectors; the desktop sidebar moves onto them
   with unchanged behavior; read-only gating.
2. Lody: phone WebView list, gestures, sheets and section management; encrypted
   transport tests for the new fields and rows.
3. lody-ios: runtime projection, live workspace Flock read, clock, layout,
   command method, send and creation writes; then the iOS list.
4. lody-android: runtime snapshot refresh, bridge commands, the Kotlin list.
5. Lody: submodule pointers, Spec evidence, and the cross-platform rule that
   native clients never sort these lists.

Steps 2 to 4 proceed in parallel once step 1 publishes the shared modules and
vectors. Acceptance compares the ordered ids of one fixture workspace across the
desktop, the phone WebView, iOS and Android.

## Evidence

- Desktop behavior and Specs: [Status view](../../../../specs/sidebar-status-view.md),
  [pin sections](../../../../specs/pinned-session-sections.md).
- Shared-list precedent: matrix-rust-sdk `RoomListService` computes the sorted room
  list in shared code and hands it to Swift and Kotlin.
- Interaction references read in source: Telegram (pinned chats and folders),
  Bluesky `SavedFeeds` (handle drag, accessible Move up and Move down), Tasks.org
  (long press that becomes a drag), Proton Mail (snooze sheet); Apple's guidance
  that every drag has a menu alternative.
