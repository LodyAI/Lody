# Session start retries temporary system failures

Status: implemented
Translation: current

[中文](2026-10-16-session-start-transient-retry.zh.md)

## Abstract

Two restore attempts on a loaded machine failed within 20 milliseconds with
`spawnSync /usr/bin/git EAGAIN`, because the OS refused to fork. The user had to
resend, and the resend succeeded. Session start now starts again by itself when the
error chain carries `EAGAIN`, `EMFILE`, `ENFILE` or `ENOMEM`: at most three attempts,
waiting one and then three seconds, and only before the agent has produced anything.
A worktree setup script never runs twice for one start. A start that failed while
its script ran is not repeated, and a start that got past the script repeats as a
resume, which skips it. Every other failure, including authentication and resume
errors, still ends the turn on its first occurrence. The retried set is deliberately
narrow and grows only with observed failures that a resend fixes.

## Problem

The failure policy before this change had one automatic recovery: a failed ACP
resume falls back to history replay. Every other start error was final. A daemon
log scan over one week found four start failures. Three were transient environment
conditions, and a resend fixed each of them. The two `EAGAIN` failures happened
before any lasting work. The third, a lock-release timeout after the worktree was
ready, is fixed at its owner by
[file-lock holder release](../architecture/2026-10-16-file-lock-holder-release.md) and
does not need a retry. [Start failure attribution](../bug-fix/2026-10-16-session-start-failure-attribution.md)
provides the stage this policy reads.

## Decision

- **What retries.** Only an error whose `code`, anywhere in its `cause` or
  `AggregateError` chain, is `EAGAIN`, `EMFILE`, `ENFILE` or `ENOMEM`. These mean the
  OS was momentarily out of processes, descriptors or memory, so the same request
  can succeed once the resource frees up. Lock contention timeouts are excluded: a
  holder that kept the lock past its deadline (120 seconds for worktrees) is unlikely
  to let go within the retry window, and another full wait would approach the
  initialization budget.
- **How it repeats.** `sessionStartRetryMode` reads the failed start's stage:
  - `worktree-setup` never repeats. It is reported only when a setup script actually
    starts, and the following `sandbox` step repeats as a resume. A start with no
    script is therefore never mistaken for one that ran a script.
  - A restore repeats unchanged, because its worktree already exists and setup is
    skipped.
  - A new Session that failed before setup repeats unchanged.
  - A new Session that failed after setup repeats with `resume = true`, which only
    skips the setup script. The worktree, branch and credentials are recreated or
    reused as on any resume.
- **Bounds.** Three attempts, with delays of 1 and 3 seconds
  (`SESSION_START_RETRY_DELAYS_MS`), each jittered over its upper half. Each attempt
  calls `createSession` again, and its dedupe entry is gone, so the attempt is new work.
- **Whole-daemon stability over per-turn persistence.** A temporary OS failure is
  usually machine-wide. Fixed, synchronized delays would make every failed turn retry at
  the same instants and triple spawn pressure exactly when the machine is exhausted. So
  the delays are jittered, and one service-wide budget allows 6 retries per minute
  across all Sessions; beyond that, starts fail on the first error.
- **Retry only after confirmed cleanup.** If a failed attempt's cleanup could not
  terminate its agent or release its credentials, `SessionManager` marks the original
  error (a WeakSet, so the error object is unchanged) and the start is not retried.
  Each retry would otherwise stack a fresh attempt on leaked resources. The initialization
  stall watchdog still applies, and publishing
  `Retrying after a temporary system error` counts as progress.
- **Stop and stalls.** No retry once the turn is cancelled or stalled. Stop
  interrupts the delay, and the turn also checks for cancellation after the delay.
- **Reporting.** Each retry is logged at warn with its step and error. The last
  failure is recorded exactly as an unretried one would be.

## Behavior contract

| Question         | Answer                                                                                                                                     |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Trigger          | `createSession` rejects with a listed system code before the Session is bound to the turn.                                                 |
| Owner            | The visible turn's execution fiber owns the retry loop and its delay. `SessionManager` owns each attempt and its cleanup.                  |
| Cancellation     | Stop or a stall interrupts the delay, and no attempt starts afterwards.                                                                    |
| Handoff          | The next attempt starts only after the previous one rejected, which means its partial Session was terminated and its credentials released. |
| Failure recovery | The last attempt's error goes through the ordinary restore or pre-prompt failure path.                                                     |

## Alternatives

- **Retry every start failure once.** Rejected. Authentication, a missing Git
  executable, configuration and resume errors fail again identically, and a blind
  retry would also repeat work that is not idempotent.
- **Retry inside `SessionManager`.** Rejected. The turn owns cancellation, the stall
  latch and presence publication, and an attempt must not outlive a Stop.
- **Admission control under resource pressure.** A more complete answer for
  `EAGAIN` is to remove synchronous spawns from the daemon's main thread and gate
  turn admission on process headroom. That is separate work. This retry only covers
  the moment-to-moment variance.

## Limits

- Only Session start is covered. A transient failure after the Session is bound,
  for example while applying the run configuration, still fails the turn.
- The two `EAGAIN` failures are the only evidence for this set. The other codes are
  included because they share the same "momentarily out of an OS resource" meaning,
  not because they were observed.
- The delays are fixed rather than adaptive. Under sustained exhaustion, all three
  attempts fail and the turn reports the last error, as before.

## Verification

`tests/session-execution-service.test.ts`, using fake timers and the real execution
service:

- A restore that fails twice with `EAGAIN` and then with an ordinary error makes
  three attempts and reports the ordinary error with its step. Three `EAGAIN`
  failures make three attempts and report the last one.
- A restore or new Session that failed during `worktree-setup` makes one attempt.
  Every existing non-transient pre-prompt case also makes exactly one attempt.
- A new Session that failed at `agent-start` repeats with `resume` set. The first
  attempt had none.
- Stop during the delay makes no second attempt and records no failure.

Ablation: removing the switch to resume fails the resume case. The fence after the
delay is redundant with interruption in the Stop case: the test passes with or
without it.
