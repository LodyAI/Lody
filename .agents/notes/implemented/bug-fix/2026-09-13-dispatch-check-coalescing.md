# Coalesce backlogged dispatch checks and yield between them

Status: implemented
Translation: current

[中文](2026-09-13-dispatch-check-coalescing.zh.md)

## Abstract

After a long session's turn ended, the daemon pinned one CPU core for 20 to 42
seconds with the event loop fully blocked: timers, the Loro heartbeat, and every
other session stalled until the backlog cleared. The cause was the dispatch
watcher's per-session check chain, which appended a new check for every session
mirror commit during the turn while the chain itself was blocked awaiting that
turn, then drained hundreds of identical checks back-to-back on microtasks, each
re-reading the full history. `enqueueSessionCheck` now reuses a queued check that
has not started yet, so a turn of any length leaves at most one follow-up check,
and a check that follows another one in the chain yields one macrotask first.
Letting the dispatch branch return before the turn finishes was evaluated and
deferred: it is guard-safe but changes what the returned promise means for every
caller, and coalescing alone removes the observed stall.

## Problem and evidence

Logs from 2026-09-13 (`~/.lody/logs/<date>.log`) show the signature:

```
[event-loop] lody start timer lag detected: fired 41993ms late ... cpuRatio=1.07
```

Immediately before it are several hundred adjacent lines of
`dispatch.maybe_handle_session -> dispatch.find_or_await_turn (~130 ms) ->
outcome=no-dispatchable-turn` with nothing in between, preceded by that session's
`execution.visible_turn ... outcome=completed` and `Unwatching idle session (no
pending work)`. Over an 88-minute log there were 1898 such no-op checks costing
192 CPU seconds in total; the 42-second stall was 329 of them.

Three designs in `apps/cli/src/session/session-dispatch-watcher.ts` combined:

1. `enqueueSessionCheck` appended every call to the session's promise chain with
   no coalescing, even when a check was already queued and had not started.
2. The session-doc mirror subscription enqueues a check on every commit, and an
   agent turn commits hundreds of times while streaming output.
3. The dispatch branch of `maybeHandleSession` awaits
   `dispatchPreparedSessionTurn`, whose duration equals the whole turn
   (`execution.prepared_session_turn` spans confirm it). The chain is therefore
   blocked for the turn, every mirror commit becomes a backlogged check, and the
   backlog drains after the turn.

Each drained check calls `sessionDoc.getHistory()`, which materializes the full
history from the mirror state. On a 341-entry, 13 MB session doc that costs about
130 ms; on a fresh session about 3 ms, which is why short sessions never showed
it. Every await inside a check settles on in-memory objects, so the drain never
reaches the timer phase. The lag monitor wakes only after the last check, and the
Loro watchdog then forces a reconnect.

## Decision

- **Coalesce.** A queued check reads meta and history fresh when it starts, so it
  already covers any trigger that arrives before then. `enqueueSessionCheck`
  finds a probe record for the session that is not started and shares the
  caller's lifecycle generation, and returns that record's promises instead of
  appending: `resolveAfterInitialProbe` callers get its probe promise, others
  get its whole-chain promise. The existing `reuseExistingCheck` branch used by
  bootstrap keeps its exact semantics and is consulted first. Coalescing is
  keyed on `started`, which is set only after the yield below, so triggers that
  land during the yield also fold in.
- **Yield.** A check that follows another one in the chain awaits one
  `setImmediate` before running. `setImmediate` runs after the timer phase, so
  even a real drain of distinct checks lets timers and the heartbeat run. A
  fresh check on an idle chain does not yield, so RPC and metadata fast paths
  keep their latency.
- **Keep awaiting the turn (deferred).** `runVisibleSessionTurn` registers the
  turn runtime synchronously on entry, so `getExecutionSnapshot().hasActiveTurn`
  would already guard a check that ran during the turn. But the promise returned
  by `enqueueSessionCheck` is treated as "the turn ran" by queue promotion
  (`processMessageQueue`), edit-and-resend's `enqueueDispatch`, RPC offers, and
  the test suite, and the checks that would then run during a turn each still
  read meta. Coalescing already bounds post-turn work to one check, so the
  larger change is recorded as a follow-up rather than made here.

## Alternatives considered

- Throttling or debouncing the mirror subscription: rejected. The session
  AGENTS.md forbids extra throttles, and a delay would add latency to the first
  follow-up message while still leaving one check per commit once the delay
  elapsed.
- Skipping `getHistory` when meta shows no pending activation: rejected as the
  primary fix. History is a turn-selection source after activation (legacy
  `read === false` entries, queue promotion), so a meta-only short-circuit would
  change dispatch semantics; coalescing removes the repeated reads without
  touching selection.

## Verification

- `apps/cli/tests/session-dispatch-watcher.test.ts`: with fake timers and an
  injected doc/mirror stub, a turn that receives 300 mirror commits plus one
  post-turn enqueue costs exactly one follow-up history read; that read is parked
  on a macrotask rather than run on microtasks; a timer armed during the turn
  fires while a later queued check is still parked; the promise returned to a
  coalesced caller resolves only after the shared check finishes; and the chain
  stays live afterwards. Ablating either mechanism fails the test: without
  coalescing the coalesced promise never resolves, without the yield the
  follow-up read runs on microtasks.
- `pnpm check` and `pnpm format` results are recorded in
  [PR #676](https://github.com/LodyAI/Lody/pull/676). The
  `worktree-gc` suite has a pre-existing failure on this machine caused by
  `/private/var` path resolution that is unrelated to this change.
- Not measured: the production log signature after the fix. The mechanism is
  reproduced deterministically in the unit test; a field confirmation on a
  13 MB session doc remains to be observed.

## Follow-up

- Stop awaiting the whole turn inside the dispatch branch, so the chain frees
  as soon as the runtime is registered. Requires redefining the returned
  promise contract for `processMessageQueue`, `enqueueDispatch`, and RPC offer
  callers, and checking that per-commit checks during a turn stay meta-only.
- `getHistory()` materializes and normalizes the entire history on every call.
  A cheaper "is there a dispatchable user turn" read over the mirror state would
  cut the remaining 130 ms per check on large docs.
