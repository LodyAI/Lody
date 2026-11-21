# Lody-managed long commands and the standing guidance to use them

Status: implemented
Translation: current

[中文](2026-11-16-managed-long-runs.zh.md)

## Abstract

An Agent that started a long build or test suite in the background ended its turn,
and Lody treated the Session as idle: idle GC could stop the Agent together with
the processes it had started, nothing woke the Session when the work finished, and
users typed "continue" to check. `lody_automation` now has a `run` command: the
automation Host owns the process, keeps the Session's group unsettled while it runs,
and queues one continuation with the exit facts when it ends. The original broad recommendation is narrowed by the
[guidance scope decision](../simplification/2026-11-21-automation-guidance-scope.md).
Process ownership remains unchanged; agent selection frequency is unmeasured.

## Decision

- A run is an automation wait without a program. It reuses the ledger row, `list`,
  `show`, `cancel`, the Session-group pending-work query and the existing
  `external_event` continuation, so admission, Stop, permissions and encrypted-input
  signing are those of every other continuation.
- `runtime/managed-runs.ts` owns processes in the automation Host's Scope, not in the
  check that starts them: cancelling a check never kills a run, cancelling the wait
  does, and closing the owner terminates every run. The owner is acquired after the
  ledger's finalizer, so runs stop before the ledger closes.
- The start is persisted before spawn and is claimed once. A started run without a
  live owner is reported as interrupted, with its pid, and never started again: a
  rerun could repeat side effects the Agent cannot see. A Host crash can therefore
  leave an orphaned process, which the continuation states.
- Exit facts (outcome, code or signal, duration, log path, 4 KiB tail, truncation)
  are recorded by the process owner and make the wait due at once; the check turns
  them into the result. The result names a bounded command string rather than the
  argument array, which keeps it within the 64 KiB result limit.
- The environment is explicit: `PATH` from the login shell and the daemon, home and
  temp variables, and the caller's `env`. Agent provider credentials and the Session
  shell environment are not inherited.
- Guidance follows the [scope decision](../simplification/2026-11-21-automation-guidance-scope.md):
  per-prompt text carries no Automation recommendation; help and the skill reserve
  `run` for work that must outlive the current turn and resume on exit.

## Alternatives

- Extending idle GC protection to every Agent-started background process was not
  chosen: Lody cannot see inside the Agent, the existing native-activity protection
  covers only Agents that report it, and memory pressure or restart still kills
  those processes ([GC and native work](../bug-fix/2026-10-18-gc-respects-native-agent-work.md)).
- Running the command through `ctx.exec` inside a condition was rejected: a check has
  a 30-second deadline and 128 KiB output bound and may run again after interruption
  ([external checks](../../proposed/architecture/2026-10-28-automation-external-checks.md)).
- Inheriting the Session's full shell environment would also pass provider
  credentials configured for the Agent; the explicit allowlist was kept instead.
- Restarting interrupted runs was rejected for the side-effect reason above.

## Consequences

The [no-workflow prompt decision](../simplification/2026-11-11-agent-prompts-without-workflow.md)
governs agent-facing text, with the narrowed help guidance linked above. Logs live under
`<data dir>/automations/runs/` with a 16 MiB cap per run and seven-day retention,
pruned when another run starts in the same workspace.

## Verification

`apps/cli/src/automations/workspace.test.ts` ("Managed runs") runs real processes:
unsettled group while running, exit facts and the queued continuation, cancel
terminating the process, interruption reported after an owner restart without a
second start, and start failure and cwd containment.
`apps/cli/tests/session-execution-helpers.test.ts` pins the prompt text. Behavior
with Windows process trees and the effect on agent behavior are unverified.
