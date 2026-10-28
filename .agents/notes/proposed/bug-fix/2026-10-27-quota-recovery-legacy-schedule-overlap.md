# Quota recovery and retained legacy reservations

Date: 2026-10-27
Status: proposed
Translation: current

[中文](2026-10-27-quota-recovery-legacy-schedule-overlap.zh.md)

## Abstract

Retiring the quota shortcut leaves existing one-time `continue` schedules intact.
An enabled Session recovery policy can also submit a continuation, but neither
owner coordinates with the other's accepted work. Newer input can supersede
pending recovery, yet it does not establish mutual exclusion in both orderings.
The user chose not to handle old Schedules in the current work; the overlap remains
possible and no existing schedule should be deleted automatically.

## Evidence and decision needed

The [retirement decision](../../implemented/feature/2026-10-27-retire-quota-continue-shortcut.md)
preserves reservations. The former helper derived a UUID from workspace, Session
and five-hour reset and saved a normal one-time message for reset plus one second.
The [automation coordinator](../architecture/2026-10-25-session-automation-coordinator.md)
uses a separate local ledger, preserves native unfinished work, and can schedule
recovery at or after its observed capacity and backoff deadlines. It does not
consult the Schedule registry. The Session action checks for newer input and the
observation owner cancels older pending work, but the Schedule can remain due
after recovery has already been accepted or executed. Same-Session busy handling
can defer work; it is not proof that two effects cannot execute.

If addressed later, options are a precisely scoped arbitration at the owners' dispatch boundary, or
an explicit warning that lets the user cancel a retained reservation. A warning
alone does not guarantee exclusion; a one-time lookup alone does not close races.
Recognition must use verified persisted identity and current schedule state, account
for edits, cancellation, uncertain dispatch and changed resets, and must not
suppress ordinary messages merely because their text is `continue`. Preserve the
existing Session release, permission and ownership checks.

Settings apply to future observations. Enabling recovery after a quota failure does
not replay a previously published event. Local developer-gated UI now exposes the
setting; it has not been verified against a live provider. This note records code
inspection only: no real Schedule was inspected, and no test reproduces both
dispatch orders or proves the exact rate of duplicate effects.
