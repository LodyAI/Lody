# Session presence during cancelled Turn release

Status: implemented
Translation: current
PR: [#1518](https://github.com/LodyAI/Lody/pull/1518)

[中文](2026-10-12-session-presence-cancellation-release.zh.md)

## Abstract

A cancelled visible Turn cleared its active presence before finalizing cancellation and
joining the original ACP prompt. Users could therefore see no active work while the
agent remained busy and the next Turn was correctly blocked. The cancellation Effect finalizer
now closes raw-work ownership first, the presence child Scope second, and the Turn slot
last. This fixes release ordering without claiming completion of the P6 native heartbeat
and session-lease migration.

## Ownership and decision

The trigger is visible-turn Scope closure, including external interruption and the
initialization watchdog. The visible Turn owns both cancellation finalization and its
presence child Scope; its cancellation finalizer explicitly orders cancellation/drain →
presence clear → Turn-slot release. Presence is acquired into the child Scope only after the
collaboration-stop check, while cancellation finalization remains registered for early
exit. Uninterruptible acquireRelease creates the child Scope and registers cancellation
cleanup together, so interruption cannot fall between registration steps. The parent
also attempts child closure if cleanup fails, but the Turn owner remains retained. Only
successful cleanup and presence closure permit handoff, following the pinned Effect
4.0.2 Scope semantics.

Stop cancels local prompt waiting; it does not prove raw prompt completion. The existing
cancellation finalizer retains ownership until the original ACP work settles or
termination succeeds, including failed termination followed by eventual settlement.
No new timeout, replacement path or error projection is introduced. A successor cannot
start through the release waiter before the old presence is removed.

This repairs the consumer-ordering defect against the existing
[presence contract](../../../docs/cli-lib-loro-presence.md) and preserves the
[compaction cancellation decision](2026-09-10-context-compaction-terminal-state.md).
A complete P6 migration also requires the controller's timers, monitoring and actual
MessageHandler phase/cleanup consumers. Those unfinished dependencies would expand this
fix substantially, so that migration remains separate; no Legacy timer is presented as
a native capability. The P5 owner remains as described in its
[decision](../architecture/2026-10-12-effect-workspace-presence.md).

## Verification

The existing raw-ACP-drain suite now connects the real presence controller to an
observable local presence map. Four deterministic completion branches cover resolution,
rejection, successful termination after the drain deadline, and failed termination.
Each verifies presence while raw work is retained, blocked successor submission, and
presence absence when the release waiter permits handoff. All four fail against the
unchanged implementation because presence has already been cleared during drain.
All 258 session execution/controller tests pass. Root typechecking, formatting,
`check:quick` and document checks pass. The complete local check encountered the
inherited production React test environment and existing Git/process fixture failures;
CI must validate the submitted revision in its clean environment.
