# Codex overload recovery in Session automations

Date: 2026-10-27
Status: proposed
Translation: current

[中文](2026-10-27-codex-overload-automation.zh.md)

## Abstract

The `recoverCapacity` Session tweak handles both structured quota exhaustion and
Codex `serverOverloaded` failures in the machine-local automation owner. Overload
work retains its native Session and input and receives up to three attempts after
5, 10 and 20 second minimum delays. The existing renderer retry remains available
when the tweak is off; when it is on the Host owns automatic recovery. Claude
scheduled continuations use the same Session admission boundary for deduplication.

## Boundary and verification

Only structured Codex `serverOverloaded` triggers the overload path. The Host
persists the pending work before dispatch, requires release and tool boundaries,
and rechecks the Session, binding and authorization at admission. Stop and newer
input retain their existing semantics; interrupted work and uncertain submissions
use the existing ledger recovery. Settings apply to future observations; enabling recovery also admits the recorded failure for the current input once. The
renderer reads this setting even when the beta UI is hidden, so it does not start
a second automatic retry. Activities expose recovery status through CLI/MCP; the
Session note currently displays condition waits rather than native recovery work.

The [automation coordinator](../architecture/2026-10-25-session-automation-coordinator.md)
owns the durable Session boundary. [Scheduled continuations](../bug-fix/2026-10-27-quota-recovery-legacy-schedule-overlap.md)
retain their Schedule owner. Synthetic tests exercise staged quota and overload observations
across restart; live provider recovery remains unverified.
