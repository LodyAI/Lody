# Native session presence leases and heartbeat

Status: implemented
Translation: current
PR: [#1527](https://github.com/LodyAI/Lody/pull/1527)

[中文](2026-10-13-effect-session-presence-leases.zh.md)

## Abstract

Session active presence previously used process timers and callback waiters, and exit,
archive or GC paths could clear a visible Turn's presence before its owner finished.
A native Effect 4.0.2 lease now owns local publication, heartbeat and initialization
stall detection; the actual execution service composes that lease into its Turn Scope.
Only successful lease release clears presence and permits replacement, preserving the
raw ACP drain ordering fixed in #1518. Existing analytics flushing remains explicitly
Legacy and bounded shutdown retains its original owner rather than pretending cleanup
completed. This completes the session presence responsibility, not the upper Session,
Turn or daemon migration.

## Responsibility and contract

```text
MessageHandler / SessionActivePresenceControllerLegacy
  native SessionActivePresence service (SessionPresenceHost + Clock)
    visible Turn's presence child Scope
      acquireRelease lease -> synchronous local-origin publication
      heartbeat fiber -> Schedule.spaced / Clock
      per-generation Deferred -> actual Turn's initialization failure race
    synchronous phase/status readers -> existing permission/image/reconnect consumers
  optional diagnostics -> existing Legacy analytics flush (actual Promise retained)
  shutdown -> stop producers -> await leases/monitoring -> flush ACP/history -> close stores/docs
```

The host only admits synchronous local publication and diagnostics. CRDT/status mapping
remains ordinary computation. Analytics `captureMessage` invokes an unfinished Lody
flush workflow, so it is not wrapped and called a native dependency. The Legacy entry
retains the actual flush Promise and preserves the existing reporting/telemetry gates.
No HTTP, token lookup, new payload fields or authenticated cloud work is added.

- Trigger: visible Turn admission acquires one exclusive session generation. Phase and
  detail changes publish immediately and reset the silence clock; duplicate status does
  neither. Callers still obey the existing progress-rate bound.
- Owner: `acquireRelease` registers the child's release atomically. A scoped heartbeat
  owns all wakeups. The single MessageHandler facade owns imperative compatibility
  leases and optional monitoring, without another ManagedRuntime.
- Cancellation: closing the Turn presence Scope interrupts/joins the heartbeat before
  clearing its local entry. The existing raw prompt/steer drain remains ahead of that
  Scope closure; a lifecycle callback cannot release the Turn's lease. Startup progress
  callbacks capture the exact runtime, so abandoned startup cannot mutate its successor.
- Handoff: a second hold is refused while the old generation exists. The initialization
  deadline latches a per-lease Deferred, stops heartbeat and reports failure once even
  if detection precedes the Turn waiter. A stall remains failure rather than cancellation.
- Failure/recovery: local clear failure retains the entry, generation and complete Cause;
  explicit `retryRelease` retries the synchronous clear without closing the same Scope
  again. This is local lease recovery, not recovery of a failed upper Turn finalizer.
  Shutdown retires new holds, awaits existing lease release and joins actual monitoring
  settlement. Each observation has a five-second deadline; failure retains the owner
  for retry and blocks document teardown. Concurrent Legacy close joins one receipt.

## Decision and boundaries

`RcMap` sharing would allow a second visible Turn to borrow the old generation; this
responsibility needs exclusive admission instead. The local map holds synchronous
identity/state only, not Promise producers. `Scope` owns heartbeat cancellation and
`Effect.cached` owns one lease close receipt. The installed 4.0.2 `forkIn` registers and
joins fiber interruption in the Scope; `Scope.close` alone is not a concurrent receipt.
`Deferred.doneUnsafe` is synchronous signal admission, preserving detection before an
observer subscribes without an internal executor or callback waiter map.

This extends [the cancellation release decision](../bug-fix/2026-10-12-session-presence-cancellation-release.md)
and [P5 workspace ownership](2026-10-12-effect-workspace-presence.md). The existing
[presence guide](../../../docs/cli-lib-loro-presence.md) owns current implementation;
[initialization intent](../../../../specs/session-initialization-deadline.md) is unchanged.
Full Session/process startup, Turn finalization, MessageHandler/daemon orchestration,
analytics and P7 room/LoroRepo integration remain unfinished. Machine liveness remains
owned by the merged workspace presence unit; it is not reimplemented here.

## Verification

Base: main `d76690b6` (including #1518, #1519 and #1520). The independent clone preserves
the original workspace and author checkouts. Frozen installation preserves all
locked versions; consuming Effect 4.0.2 instructions/source were inspected.

Behavioral acceptance uses TestClock, fake timers and explicit raw completion signals:
publication/status, silent-stage and detail progress deadlines, latched early stalls,
owner interruption, replacement, failed clear recovery, heartbeat publication failure,
shutdown timeout and actual archive callbacks. The existing execution suite connects
the native lease to real controller publication and verifies all four original ACP
drain completion branches. Its deadline harness now drives native Clock timers without
wall-clock sleeps. Replaced controller tests assert entries/status, not mock-only calls.

Six temporary ablations each fail their corresponding observable regression:
heartbeat Scope ownership, early stall latch, progress deadline reset, failed-clear
retention, exact startup generation and incidental archive clear. Restored source
passes all seven actual-consumer suites (308 tests). The native/Legacy lease suite also verifies actual monitoring
settlement after bounded close failure. Root typechecking, lint, format, document checks and every static boundary guard pass.
`pnpm check` reached the full test phase but the unchanged code-review renderer suite
failed with `act is not a function` under the inherited production React environment;
this is the previously recorded validation limit, not a green full check. The unchanged review-helper package passes all 33 tests under `NODE_ENV=test`,
confirming the production environment constraint. The seven
P6 consumer suites pass 308 tests. Clean-environment CI must validate the final PR.
Linux source-level evidence does not establish packaged desktop or production-load
behavior, or native ownership of the remaining upper workflows.
