# A turn releases its slot even when its failure handling fails

Status: implemented
Translation: current
PR: [#1652](https://github.com/LodyAI/Lody/pull/1652)

[中文](2026-10-17-turn-release-survives-failure-handling.zh.md)

## Abstract

A Session stopped answering for good after an Inbox-delivered turn failed and
its failure handler threw as well. The second exception skipped the Inbox
release, so the turn registration leaked without a recorded release failure:
every later input was refused as `active-session`, the live status read
`initializing`, and no recovery path owned the slot. The visible-turn owner
now always runs the release after classifying a failure. A slow yielded-turn
finalization is waited for instead of being recorded as a release failure,
and a release that genuinely cannot be confirmed is reported as a busy
`waiting` state. The next input that waits on that Session requests its
recovery. Releasing a turn never terminates the agent process; the
idle-document race that started this incident is handled separately by the
[Session residency work](https://github.com/LodyAI/Lody/pull/1670).

## Incident

On 2026-10-17 at 08:47:10, idle GC began cleaning a Session that had been
idle for 20 minutes. Two milliseconds after its agent process was killed, an
Inbox completion turn for the same Session started and took the cached
Session document. GC then destroyed that document. The turn's next status
write failed with `Mirror not initialized`, and the failure handler's final
`setStatus(idle)` failed again. That exception escaped the `catch` in
`runVisibleSessionTurnOwned`, so `inboxOwner.finish()` and
`releaseTurnRuntime()` never ran. Because `releaseFailure` was never set,
`recoverInboxExecution`, which acts only on a recorded release failure, could
not recover the Session either.

## Decisions

- **Release follows classification unconditionally.** Failure classification
  moved into `settleVisibleTurnFailure`, and the Inbox withdraw, finish and
  registration release moved into `releaseVisibleTurn`. When classification
  throws, the owner logs both the original error and the handling error, runs
  the release, and only then rethrows the handling error to its caller.
- **Slow is not failed.** The release finalizer used to wait at most 5 s for
  `yieldedFinalization`, the serialized bookkeeping of yielded handoff turns,
  and recorded a timeout as a release failure. On a normal turn the body
  already waits for that chain without a bound, so the bound only applied when
  the body exited early. The chain catches every failure, so it always
  settles. The finalizer now waits for it and logs a warning after 5 s.
  Treating slowness as a failure blocked the Session until a recovery that
  terminates its agent process; on the non-Inbox path nothing ever recovered it.
- **A real unconfirmed release stays blocking, visibly.** Orchestration requires
  that an unknown release block successors. The execution snapshot now carries
  `releaseBlocked` with its reason. Dispatch reports `release-blocked` instead
  of `active-session`. Live status reports `waiting` with that reason, not
  `initializing`: fork and MCP treat `unknown` as "not busy", so reporting
  `unknown` would have let a fork proceed past unconfirmed resources.
- **Recovery is driven by the waiting input.** A dispatch check that meets
  `release-blocked` and an Inbox readiness check for a blocked Session call
  `requestReleaseRecovery`. It is single-flight per Session and wraps the
  existing `recoverInboxExecution`. A failed attempt keeps the slot and the
  next waiting input retries; a successful one releases the slot and
  re-checks dispatch. The service gained no timer and no background task.

## The agent process is kept

Stop also persists [control-failure diagnostics](2026-10-29-session-stop-failure-notices.md)
for cancellation rejection, drain expiry and failed termination. These warnings
complement `releaseBlocked`; they do not release resources or block cleanup on
notice persistence.

Releasing a turn returns its ownership slot after in-flight ACP requests have
ended and the Inbox execution record is written. It does not terminate the
agent process, which stays alive for the next turn. Only idle GC
(`LODY_SESSION_GC_IDLE_TIMEOUT_MS`, 20 minutes by default), memory-pressure
eviction, archive, or an abnormal path ends the process. The abnormal paths
are an agent that ignores Stop for 5 s, a lost connection, and the recovery
of a blocked release, which proves release by terminating the process.

## Alternatives considered

- A timer-based retry of blocked releases was rejected. The service has no
  lifecycle owner or injected clock for such a task, and the retry would
  terminate agent processes even when no input is waiting on the Session.
- Daemon-side retries of SQLite busy errors during release were rejected: the
  orchestration rules forbid adding waits on top of the driver's
  `busy_timeout`.
- Treating `active-session` as stale after a deadline was rejected: it would
  admit a successor while the previous release may still be running.

## Verification

`apps/cli/tests/session-execution-service.test.ts` covers:

- an Inbox turn whose status writes and failure handling both throw releases
  its slot, keeps its agent process, and runs the next input;
- a prompt that fails while a yielded finalization outlives the old bound
  stays owned without `releaseBlocked`, then releases when the finalization
  settles;
- a blocked release is visible, a recovery request reports failure during an
  outage, concurrent requests share one recovery, and the recovery succeeds
  once the fault clears.

A temporary ablation confirmed the first two tests: restoring the old `catch`
or the old 5 s timeout makes them fail. Dispatch-logic and live-status unit
tests cover the new reason and state.

## Limits and follow-up

The original GC/document-cache race is now owned by the
[leased Session documents and atomic retirement](https://github.com/LodyAI/Lody/pull/1670)
implementation. This note continues to own failure-classification and release
ordering. That work follows the
[turn execution and ACP process ownership](../../proposed/architecture/2026-09-27-effect-turn-execution-and-acp-process-ownership.md)
target. The full `TurnRegistry` in that note, with registration as an Effect
`acquireRelease`, remains unimplemented: failure classification is still
Promise code, so the release here is guaranteed by the owner's control flow
rather than by a Scope finalizer.
