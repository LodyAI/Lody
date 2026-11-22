# Status view and pin sections on every phone surface

Date: 2026-11-21
Status: implemented
Translation: current

[中文](2026-11-21-status-view-on-phones.zh.md)

## Abstract

The Status view (Focus / Later / Settled), manual order and pin sections used to
exist only in the desktop sidebar, while the native iOS and Android lists ran an
older status grouping written twice, in Swift and Kotlin. One shared, pure
implementation of the list layout and of the write planning now serves the desktop
sidebar, the phone WebView and the native clients' shared TypeScript runtime, and
one set of golden vectors runs on every consumer. Phones have full operation
parity, including drag reordering and section management. Native clients still
cannot open encrypted workspaces at all, which is a separate project; physical
phones, signed-in native workspaces and the packaged phone app are not verified.

## Problem

- Classification was pure, but tier ordering, wake-up and unread enrichment and the
  write rules lived in three desktop React files, so no other surface could reuse
  them.
- The phone WebView list had no Status grouping and offered no Later, Settle or
  Move to Focus.
- The native runtime's catalog dropped `orderKey`, `pinSectionId`, `snoozedUntil`,
  `settledAt` and `focusRestoredAt`, never read `pinSection` rows, had no synced
  server clock, did not clear Later/Settled state on send and wrote no `orderKey`
  on creation. Swift and Kotlin each implemented the retired Needs you / Running /
  Finished grouping, and Android had no pin or swipe actions.

## Decision

### One layout, one write planner, one vector set

`packages/shared/src/status-view/` owns the behavior. Its modules import only each
other, `../pinned-sections.ts` and the vendored fractional index, and never read a
clock or a random source ([scope rules](../../../../packages/shared/src/status-view/AGENTS.md)).
The extraction preserved desktop behavior; the desktop tests were the oracle.

**Layout** — `buildStatusViewLayout(input) → StatusViewLayout`. The input is the
visible sessions (non-archived, scope applied, contained Tabs folded into their
owner) with their metadata and two host facts, `isWorking` and
`isWaitingPermission`, plus the per-row permissions `canManage` and `canPrefer`;
the pin sections with `sectionsLoaded` and `canManageSections`; the per-section
count of rows the scope hid; and `nowMs` on the synced server clock. The output is
the cross-platform JSON contract:

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

Collapse state, "Show all" folding and countdown labels stay with each surface; the
module exports the defaults and the countdown and preset formatters.

**Write planning** — `planStatusViewCommand(state, command, env) → writes`. `state`
is the layout input, optionally with `related` rows the list does not show (another
scope, archived) that opened-tree actions still reach; they never affect order.
`env` supplies `nowMs` and a random-byte source for fractional-index jitter.
Commands:

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

The result is session-metadata patches, each carrying `access: 'manage' | 'prefer'`
so the host applies the matching guard (`null` clears a field), and pin-section row
writes or deletes. A command the state cannot satisfy (unknown row, missing
permission, a past snooze time) plans no writes rather than a partial set. A move
names the neighbor it lands before, so a stale caller list still resolves against
the planner's order. The planner keeps the desktop rules: one jittered key per
move, keys for unkeyed rows above the drop, real keys for expired snoozes when
Focus is reordered, opened sub-conversations restored with a row dropped into
Focus, `settledAt = max(now, lastMessageAt)`, and unpinning keeps `orderKey`.

**Golden vectors** — `vectors/layout.json` (13 cases) and `vectors/commands.json`
(38 cases, fixed `nowMs` and random bytes) run in `packages/shared`, against the
desktop and phone-WebView adapters in `packages/components`, in the iOS runtime
tests and in the Android runtime tests.

### Surfaces

- **Desktop**: the sidebar builds the layout input from its rows, and
  `useSessionActions().runStatusViewCommand` performs planned writes after guarding
  every affected Session. A refused drop shows a notice. Status actions are withheld
  from an encrypted workspace's Guest and from a known read-only membership.
- **Phone WebView**: the home list's Status grouping, the default when no grouping
  is stored, and the Pinned area of every grouping render the same layout through
  the same command runner ([mobile README](../../../../packages/components/src/components/mobile/README.md#status-grouping)).
- **Native**: `cloud-runtime` copies the shared modules verbatim at a pinned Lody
  commit with a provenance record and hashes. It projects the five fields, keeps a
  live read of the workspace Flock for `pinSection` rows, estimates the server clock
  from `/api/time` by round-trip midpoint (device clock while unknown), and
  publishes `statusView: { mine, team, nowMs, sectionsLoaded }` with `pinSections`
  in the catalog. It republishes at `nextChangeAt` and on foreground. One method,
  `statusViewCommand({ workspaceId, command, scope? })`, plans against the current
  replica, writes, and returns `{ writes }`, where 0 means refused or nothing to do;
  `snoozePresets()` returns the presets. `start` accepts `workspaceReadOnly`.
  The runtime applies `touchOnSend` when a message is dispatched and
  `newSessionOrder` when a session is created. Swift and Kotlin never sort or
  classify these lists ([cross-platform rules](../../../../apps/mobile/docs/rules/cross-platform.md));
  the time and project groupings keep their native code, and the retired native
  status grouping is gone.

### Phone interaction (WebView, iOS, Android)

| Gesture                     | Result                                                             |
| --------------------------- | ------------------------------------------------------------------ |
| Tap                         | Open the conversation                                              |
| Long press                  | The full action menu; moving while still pressed turns into a drag |
| Trailing swipe              | Focus and Later rows: Settle, Later. Settled rows: Archive         |
| Leading swipe               | Pin or unpin                                                       |
| Section header ⋯            | New section, Rename, Move up, Move down, Delete                    |
| Conversation page "…" sheet | Later, Settle, Move to Focus                                       |

Drags reorder Focus, reorder and move rows between pin sections, pin a row dropped
into the Pinned area, and restore a Later or Settled row dropped into Focus. The
list scrolls at its edges, holds the dropped order until the write reads back, and
freezes incoming reorders during a drag. Every drag outcome is also a menu item and
an accessibility action (Move up, Move down). Later opens a sheet with the four
presets and a custom date and time; past times are refused. Settle and Later
confirm with Undo, and the sub-conversation question matches desktop. Sections
reorder with Move up and Move down, not by dragging headers. Collapse state and the
chosen grouping stay device-local; Later and Settled start collapsed and Settled
folds past 20 rows.

## Alternatives

- **Reimplement the rules in Swift and Kotlin with shared vectors.** Rejected:
  three implementations of ordering, wake-up and write planning drift, and the
  native clients already run a shared TypeScript runtime that owns sync.
- **Emit index diffs from the runtime (Element X style).** Rejected for now: the
  catalog is already a full snapshot, diffable data sources and keyed Compose lists
  compute their own animations, and a dropped diff needs a reset protocol.
- **Generate order keys in native code.** Rejected: key generation, jitter and the
  tie-break stay in one place; native sends the neighbor it dropped before.
- **A separate "Reorder" edit mode with handles on phones.** Held as the WebView
  fallback if long-press drag failed. It was not needed in the browsers tested;
  it has not been tried in the packaged app.
- **Native encrypted workspaces in this change.** Deferred to its own project:
  native clients block encrypted workspaces before any content opens, and enabling
  them needs custody, pairing, recovery, the ledger and a protected Streams codec.
  The layout and the planner sit above decryption, so they need no change then.

## Consequences and limits

- Native has no session presence channel. The runtime derives `isWorking` and
  `isWaitingPermission` from durable catalog state (`status`, `awaitingUserSince`),
  while desktop uses live presence. The lists can differ briefly for a snoozed or
  settled conversation that is waiting for approval, and for a conversation silent
  for seven days that is running.
- Status actions use the full session-management guard. On the phone WebView in an
  encrypted workspace, the person's own conversations on another member's shared
  machine offer no status actions: the phone does not discover that machine
  (`isSessionEditableToUser`), so those rows are `readOnly`. Pinning stays
  available. Allowing the write needs the portable machine-sharing read the phone
  lacks, not a looser guard.
- On iOS and Android, a teammate's local-project conversation, a Project group
  with a local member included, offers no status actions: whether that project is
  shared with the team is server access state the runtime cannot read, and a
  machine's Flock lists private projects too (`sessionPermissions` in the
  runtime's `status-view.ts`). Pinning still works for the conversation's author.
  Desktop offers the actions when the project is shared with the member.
- Encrypted workspaces on the WebView need no special handling: no in-repository
  layer filters session metadata fields or workspace Flock row families. A
  non-owner Member sealing a `pinSection` row and the new session fields is tested
  at the room level (`apps/electron/src/main/services/e2ee-runtime.test.mjs`); the
  hosted gateway's admission cannot be inspected from this repository.
- Android marks a conversation read when it is opened in the foreground, so a woken
  conversation's unread state clears there too.
- Placement and restore never consume a wake-up; only opening, sending or settling
  does. Reordering Focus gives a woken row a real key and records `focusRestoredAt`
  at its wake-up; a restore into Focus (a drop from Later, Settled or the Pinned
  area, Move to Focus, and the opened sub-conversations that follow) records
  `focusRestoredAt` now and clears only a snooze still in the future. Either way
  an expired `snoozedUntil` stays, so the row stays where it was put and stays
  unread until it is read. No new field is needed: `focusRestoredAt` is written
  only by these placements and restores, and a snooze always sets `snoozedUntil`
  in the future, so a re-snoozed row floats again when it expires. Desktop builds
  older than this rule (before LodyAI/Lody#3077) float a placed woken row back to
  the top; the data is valid both ways.
- On every phone surface the long-press menu opens on a stationary release, and a
  press that moved opens no menu; iOS 16.4–17.3 cannot present a menu from code
  and keep the system context menu, which still turns into the drag.
- Known gaps: no haptics on the iOS WebView, and Chrome refuses vibration before
  the first tap.

## Verification

Verified:

- Golden vectors (13 layout cases, 38 command cases) run in `packages/shared`,
  against the desktop and phone adapters in `packages/components`, in the iOS
  runtime tests and in the Android runtime tests.
- Desktop: the Storybook end-to-end suite for Focus drops
  (`packages/components/tests/e2e/sidebar-status-focus-drop.spec.ts`, 5 cases).
- Phone WebView: the list, gestures, sheets and drag in Storybook, opened in Safari
  on the iOS Simulator and in Chrome on the Android emulator, and with real touch
  input in Chromium.
- Native Android: on a Pixel 8 / Android 16 emulator with the offline fixture, 23
  interaction checks of the list, menus, swipes and drag, and a smoke pass on the
  final head.
- Native iOS: on the iOS 26.5 and 27.0 Simulators with the offline fixture, light
  and dark, the `home-status` and `home-status-drag` UI regressions (collapsed
  tiers, Later presets, Later and Settle Undo, Move to Top held through a stale
  catalog and read back, a held drag reordering Focus and moving a pinned row into
  an empty section, the stationary long-press menu, both swipes) and edge
  scrolling during a drag.

Not verified anywhere: physical devices; iOS 16.4–17.3 runtimes; a signed-in cloud
workspace on the native clients; the Android runtime's `/api/time` read against
staging (it was reached only through a forward from a Mac); the desktop app
writing to a real repository replica (as opposed to tests and Storybook); a real
encrypted Guest session, and the hosted gateway admitting the new encrypted
writes; VoiceOver activating Move up and Move down on a device (the handlers are
tested: each sends exactly one `move` with the right `beforeId`); the
Capacitor-packaged app, since the WebView list was only exercised in browsers.

## Evidence

- Intent: [Status view](../../../../specs/sidebar-status-view.md),
  [pin sections](../../../../specs/pinned-session-sections.md).
- Pull requests: LodyAI/Lody#3063 (shared layout, planner, desktop),
  LodyAI/Lody#3065 (phone WebView), LodyAI/lody-ios#130 (shared runtime),
  LodyAI/lody-ios#131 (iOS list), LodyAI/lody-android#25 (Android list and bridge);
  review fixes in LodyAI/Lody#3093, #3096 and #3098, LodyAI/lody-ios#137 and #138,
  and LodyAI/lody-android#33.
- Shared-list precedent: matrix-rust-sdk `RoomListService` computes the sorted room
  list in shared code and hands it to Swift and Kotlin.
- Interaction references read in source: Telegram (pinned chats and folders),
  Bluesky `SavedFeeds` (handle drag, accessible Move up and Move down), Tasks.org
  (long press that becomes a drag), Proton Mail (snooze sheet); Apple's guidance
  that every drag has a menu alternative.
