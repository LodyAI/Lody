# Codex overload recovery in Session automations

Date: 2026-10-27
Status: proposed
Translation: current

[中文](2026-10-27-codex-overload-automation.zh.md)

## Abstract

The existing Codex overload retry is owned by a mounted renderer, so it does not
survive closing the Session. The requested direction moves that behavior into
Session automations and permits removing the old retry UI. This migration is not
complete: structured overload classification is recorded in Session observations,
but no automation policy consumes it yet and the existing retry remains active.

## Boundary and verification

Only the structured Codex `serverOverloaded` error is classified as overload;
generic server errors and quota exhaustion remain distinct. A completed migration
must specify opt-in, bounded retries and timing, exact native input and release
evidence, cancellation and restart behavior, plus a user-visible state and a single
dispatch owner. Removing the renderer retry before those paths work would lose
the existing capability; enabling both would risk duplicate continuations.

The [automation coordinator](../architecture/2026-10-25-session-automation-coordinator.md)
owns the durable Session boundary. The user chose to leave
[retained legacy schedules](../bug-fix/2026-10-27-quota-recovery-legacy-schedule-overlap.md)
out of this work, so their overlap remains possible. Classification is tested with
synthetic ACP errors; live Codex recovery and end-to-end migration are unverified.
