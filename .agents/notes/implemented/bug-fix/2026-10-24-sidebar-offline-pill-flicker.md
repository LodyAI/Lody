# Keep sidebar machine status stable across presence reconnects

Status: implemented
Translation: current

[中文](2026-10-24-sidebar-offline-pill-flicker.zh.md)

## Abstract

The sidebar's "Offline" pill after a machine name disappeared and reappeared
periodically. The pill was hidden on every presence-sync state other than
`synced`, and the Streams SDK briefly reports `reconnecting` whenever its SSE
read loop recycles, even though the retained presence store still holds the last
snapshot. The presence transport now keeps a separate display state: a brief
in-place reconnect preserves the last `synced` state for five seconds, while the
raw state still drives recovery immediately. A store-replacing restart, a
terminal failure, and an explicit stop are never hidden; the limit is that a
reconnect longer than the window still hides the pill.

## Problem

`SidebarMachineOfflinePill` renders only when `useMachineOnlineStatus` returns
`offline`. The atom returns `unknown` as soon as `lodyPresenceSyncStateAtom`
leaves `synced`, and that atom was wired 1:1 to the SDK's transport status. In
`@loro-dev/streams-crdt`, a clean end of the SSE read loop sets the read
sub-status to `reconnecting`, recomputes the overall status, and reconnects. A
routine server-side stream recycle, or an inactivity-driven retry, therefore
publishes a real `reconnecting` state even though the store was not recreated
and its snapshot is still current. Every machine in a workspace flips from
`offline` to `unknown` (no pill) for the duration of the reconnect, then back.

The three-state rule exists to avoid claiming a machine is offline when this
client cannot see presence. It does not require forgetting a snapshot the moment
the socket reconnects; the snapshot's absence evidence is still exactly as old
as the last applied update.

## Decision

`WorkspacePresenceTransport` exposes a display sync state alongside the raw one:

- The display state equals the raw state, except when a `synced` room enters
  `connecting` or `reconnecting` without replacing its store. It then keeps
  `synced` for `PRESENCE_SYNC_DISPLAY_GRACE_MS` (5 seconds).
- Recovery before the window closes cancels the pending demotion, so no UI state
  is emitted. After the window the current raw state is published.
- A terminal state (`error`, `disconnected`) is published immediately.
- `start()` replaces the store, so its `connecting` state bypasses the grace;
  the new store's empty snapshot must not inherit the old room's authority.
- `stop()` publishes `idle` immediately and clears the timer.

`RuntimeProvider` feeds the display state to `lodyPresenceSyncStateAtom`; the
room-sync registry keeps `getSyncState()`/`subscribeSyncState()` so reconnect
decisions and the 60-second backstop still observe the failure at once. The
machine-status rule itself is unchanged: `unknown` still renders no pill, and
only a definite `offline` may block work.

## Alternatives

- **Debounce in the pill component.** It would either keep claiming offline from
  a dead transport indefinitely or still unmount during a real outage; the
  transport is the layer that knows whether its snapshot was retained.
- **Show an "Unknown" pill instead of hiding.** It still changes the row on
  every recycle and adds a third visual state the sidebar does not need.
- **Treat every reconnect as `synced` until it fails.** A stuck reconnect could
  claim offline for minutes; the bounded window keeps the lie short.

## Effect assessment

This fix does not adopt Effect locally. `WorkspacePresenceTransport` is a
synchronous Promise/React-facing consumer of the published Streams SDK with no
Effect execution owner or `Scope`, and the roadmap keeps renderer presence on
the Legacy side. A local `Effect.sleep` would need `Effect.runFork` inside this
class or a new managed-runtime callback boundary — an unowned fiber and a
partial migration, not a complete unit. The grace is a single timer with
explicit cancellation on every state transition, covered by fake-timer tests.
When the renderer presence/transport responsibility is migrated as a whole, the
grace should become a Scope-owned fiber (`Effect.sleep` plus interruption) with
TestClock coverage; the display-state contract stays the same. Deferring is
allowed by the feature/fix migration rule because this unit cannot complete
without the renderer presence boundary.

## Evidence and verification

Code inspection of `@loro-dev/streams-crdt` 0.19.2 shows `reconnecting` on a
clean read-loop end and on inactivity retry while the store and cursor are
retained; `setReadSubStatus` recomputes the public status immediately. The
symptom was reported against the desktop sidebar; a live renderer sync-state
trace was not captured, so the periodic trigger is inferred from this path
rather than measured. CLI `machine list` independently reported the same
machines as offline throughout the observation.

Focused tests in `packages/components/tests/workspace-presence-transport.test.ts`
cover the held state, recovery inside the window, expiry, terminal states, store
replacement, and stop. The existing machine-card test still covers
`offline`/`unknown` rendering. A reconnect longer than five seconds, or a new
state transition outside this path, can still blink; capturing the renderer's
presence sync transitions remains the way to confirm the trigger in the field.
