# Bound session initialization with a progress deadline

Status: implemented
Translation: current

[中文](2026-09-16-bounded-session-initialization.zh.md)

## Abstract

A Session turn whose initialization dependency never returned stayed in
`initializing` forever: it had no timeout, no failure path, and kept writing a
presence heartbeat every 10 seconds until the daemon was restarted. Two sessions
did this for 1h51m and 1h47m on 2026-09-16, ending only at a supervisor
shutdown. Initialization now carries a per-stage deadline measured from the last
published progress; exceeding it records a visible `session_init_failed`, stops
the heartbeat, and releases the turn. The budgets are calibrated from one
machine's logs and remain unvalidated against a slow managed-runtime download or
a large clone, which is why the stages that report progress are bounded by
silence rather than by elapsed time.

## Evidence

From `~/.lody/logs/2026-09-16.log.1`, session `1b227b98`:

```
04:58:53.133  trace-span start  dispatch.resolve_user
04:58:53.135  trace-span start  execution.visible_turn
04:58:53.136  presence heartbeat  status=initializing seq=1
04:58:53.138  ERROR  Failed to verify machine access (network): fetch failed
   ... 221 further heartbeats, all status=initializing, nothing else ...
06:49:32.563  Supervisor requested graceful shutdown
06:49:32.568  presence session entry cleared
```

`dispatch.resolve_user` never emitted its `end` span. Its very next attempt, in
the restarted process, took 70061ms before succeeding; the normal value is 1ms.
Session `8fc8fcee` stalled the same way from 05:02:43 and was cleared by the same
shutdown. `resolveUserForRequest` awaits that lookup unconditionally for any
session with a project or parent, so the turn body never advanced.

Across every retained log (923 initializations, 2026-09-09..16) the healthy
distribution is p50 0s, p90 4s, p99 13s. Only four samples exceed 60s: the two
stalls above, a third 31-minute stall, and one genuine 249s cold `codex-acp`
start. The only stage that ever tripped the existing 120s slow-stage report was
the generic `initializing` one, and only for the two stalls.

`CliPresenceRuntime.setSessionPresence` clears presence only for an `idle` or
absent status, so a status parked on `initializing` republishes indefinitely.

## Decision

The watchdog measures **silence, not duration**: the clock runs from the last
phase-or-detail change. `managed-runtime` publishes a rising download percentage
through `formatManagedRuntimeProgressDetail`, so a healthy transfer resets it
continuously and gets unlimited legitimate wall-clock time, while a wedged one
still trips. Stages with no progress signal degrade to elapsed time, which is the
only signal they offer.

Budgets differ per stage because the honest worst cases differ by orders of
magnitude: `initializing` 180s (3x the 60s `USER_PROFILE_TIMEOUT_MS`, the only
intentionally slow dependency there, and comfortably above the worst healthy
observation of 70s), `acp`/`resuming`/`managed-runtime` 900s (3.6x the worst
healthy 249s ACP start), `git-clone` 1800s (no progress signal and unbounded
input). A flat timeout was rejected: any value tight enough to help the
bookkeeping stage would kill a legitimate clone.

`SessionActivePresenceController` detects, because it already owns per-stage
timing for the 120s slow-stage report and is the single module allowed to publish
session presence. It does not clear presence itself — `loro/AGENTS.md` reserves
that for the owning Effect release — but it does stop its own heartbeat
immediately, so the 10-second wake-up of every presence subscriber ends at
detection rather than after the teardown round-trip.

`SessionExecutionService` enforces. `awaitInitializationStall` is raced against
the turn body with `Effect.raceFirst`; it never completes unless the watchdog
fires, so a turn that reaches `running` pays nothing. On a stall it goes through
the existing `recordKnownChatFailureAndHaltEffect` path with reason
`session_init_failed`, which is what produces the visible chat failure, marks the
user turn failed, and returns the session to `idle`. Interrupting the fiber
directly was rejected: the scope finalizer reads `Cause.isInterrupted` and would
have reported the stall as a user cancellation. The losing body fiber is still
interrupted by the race, so `initializationStalled` latches on the runtime and
excludes it from the finalizer's cancellation branch.

The hung promise itself is abandoned, not cancelled. As with the
[bounded identity lookup](2026-09-16-bounded-session-user-identity.md), CloudPort
offers no cancellation signal; the wait ends, the underlying request may not. No
message is automatically resent.

### Garbage collection

`SessionGCManager` does not read presence directly, but `isEligibleForCleanup`
calls `hasActiveTurn`, and `MessageHandler.hasActiveTurn` returns
`state.turn.phase !== 'idle' || hasSessionActivePresence(sessionId)`. A stalled
turn satisfies both halves, so such a session was permanently uncollectable. This
needs no separate fix: failing the turn releases the runtime and the presence
entry, which restores eligibility.

## Validation

`tests/session-execution-service.test.ts` gained two tests that wire the real
`SessionActivePresenceController` into the service, with an injected clock and
only `setInterval` faked so Effect's scheduler still runs — no real sleeps and no
mock-call assertions. They assert observable state: chat failure reason and
message, user-turn status, final `idle` status, the presence clear event, that no
further heartbeat is published however far the clock advances, and that
`hasActiveTurn` returns to false. The second test drives a managed-runtime
download 450 seconds past a 60-second budget while reporting progress, proving
the progress reset, then wedges it.

Ablation: disabling the watchdog, and separately removing the race while leaving
the watchdog, each make both tests hang until the 30s vitest timeout — the
production symptom. The full 130-test suite passes.

Not validated: the 900s and 1800s budgets have never been reached by a real
download or clone, so they are bounds rather than measurements. Only the
`initializing` budget is calibrated against observed stalls.
