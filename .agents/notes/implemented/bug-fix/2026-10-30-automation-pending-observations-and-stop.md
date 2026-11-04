# Automation pending observations and Stop admission

Date: 2026-10-30
Status: implemented
Translation: current

[中文](2026-10-30-automation-pending-observations-and-stop.zh.md)

## Abstract

Automation recovery used hash identities as a scan cursor and advanced past
unconfirmed outcomes. Recovery now selects durable pending rows by their retry
deadline and removes the cursor entirely. Stop no longer rejects authorized
condition evaluation or reads: a matched continuation remains blocked at admission
until explicit restoration, and Cancel revokes it. This preserves the existing
Wait and receipt states while correcting the implementation of the
[coordinator contract](../../proposed/architecture/2026-10-25-session-automation-coordinator.md).

## Decisions and ownership

The pending table already represents unfinished observations, so a second recovery
cursor is unnecessary. Hashes retain their deduplication role. The workspace's
existing reconciliation pass selects at most 100 due rows, persists a 15-second
retry deadline before owner reads, and deletes only successfully observed rows.
Unconfirmed release and read failures retain their row without starving later
observations. New release evidence resets the deadline. SQLite schema version 2
adds the deadline atomically with the version update, retaining version 1 payloads.
Row order breaks scheduling ties only; it never records consumption progress.

The old cursor resets after an empty scan, so descending hashes were delayed until
wraparound rather than unconditionally lost forever. Continuous later batches could
still postpone new smaller identities and unfinished rows indefinitely. A monotonic
cursor would fix insertion ordering but would still need a separate pending scan;
using the existing pending table directly removes that dual responsibility.

Stop is an execution barrier, not a read permission. Session ownership, machine,
deletion and archive checks remain. Conditions can return false while stopped or
match into the existing blocked receipt. Admission reports `target_stopped`
separately from `target_archived`, and even an `onUnavailable: fail` target remains
blocked by Stop. Restoration rechecks admission before preparing/submitting the
same invocation; it does not create another wait. The local UI maps that reason to
the existing stopped nudge and invokes the existing tree collaboration action only
on a user click. Restoration failures are shown through the existing error message.

Fleet retains the workspace ledger and reconciliation loop. Raw Session/Repo reads
remain joined by the registered Legacy bridge; no new runtime, timer or detached
task is introduced. Cancel keeps its existing admission revocation and cleanup
ownership. The upstream Session/Repo APIs remain Promise-based, so a native
migration would pull in unfinished dependencies without helping this fix.

## Verification and limits

Behavioral cases cover descending hash insertion, more than one batch of pending
release, failed reads, restart, version 1 upgrade, release refresh, more than five
successful stopped checks, persistent blocked admission, cancellation, admission
recheck after restoration and one queued invocation. UI cases cover the stopped
reason, archive distinction and refreshed delivery. Tests use synthetic observations,
SQLite, controlled metadata and fake timers; no provider calls or real sleeps.
The 39 Automation tests, 19 continuation UI tests and two staged Session-release
regressions pass. CLI and component package typechecks and documentation checks
pass. Validation uses a sibling checkout’s installed dependencies, with Node 22.23.4
and CodeMode 2.2.0 isolated for this task and Effect kept at 4.0.2. Desktop visual
verification and full packaging remain unverified.

Current behavior and module navigation belong in the
[Automations guide](../../../../apps/cli/src/automations/README.md). This correction
also connects the explicit restoration action described by the
[continuation UI proposal](../../proposed/feature/2026-10-27-session-continuation-note-ui.md)
without approving that broader proposal.
