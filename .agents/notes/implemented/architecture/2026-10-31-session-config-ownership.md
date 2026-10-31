# One owner for session configuration

Status: implemented
Translation: current
Supersedes: [warning-only model rejection](../../archived/bug-fix/2026-10-09-model-rejection-gui-warning.md)

[中文](2026-10-31-session-config-ownership.zh.md)

## Abstract

Missing history bodies could invalidate a runtime report and revive an older Plan
request. Current configuration now belongs to the execution connection. Composer
selection combines its confirmed snapshot with private edits; frozen input remains
an execution requirement, never the next draft's baseline. Required configuration
failure stops submission and preserves actual partial changes.

## Decision and alternatives

The [Spec](../../../../specs/session-config-ownership.md) defines this ownership
boundary. A connection generation fences observations even if ACP reuses a session
id; a revision orders publication independently of history. First owner acceptance
checks the captured revision in the publication serial queue. An immutable Roost
receipt bypasses rechecking on retry/restart; local held-send admission is not that
receipt. Queued inputs keep their frozen values. A persisted snapshot cannot establish
live confirmation after restart: the local owner invalidates it until a connection
attaches. Admission and steer require the current revision to have completed local
persistence, not merely appeared in the document mirror.

The index-only hydration fix would retain competing baselines. Moving that priority
chain into another hook would preserve the ambiguity. A general command bus or
whole-Session migration would expand beyond the config responsibility. Existing
SessionDocument control persistence and raw-request release owners are retained.

The [held-send note](../bug-fix/2026-09-30-composer-pending-send-config.md) remains
active for Role/MCP provenance; its run-config bridge is replaced. The
[private draft decision](../bug-fix/2026-10-07-session-run-config-drafts.md) still
owns consumption of captured edit generations. Mode/model/dependent-option
[ordering](../bug-fix/2026-10-13-acp-model-effort-order.md) remains necessary.
Model-only warnings previously continued on the old model. All providers now fail
required refusals rather than continuing with misleading settings. Public errors
identify fields without exposing requested values or raw provider payloads.

## Lifecycle and native boundary

An accepted input triggers the Turn-owned native Effect application. It reads the
established connection, publishes applying, orders mode/model/options, verifies the
actual result, and awaits local persistence before prompting. It never awaits cloud
sync. Provider mutations are not transactional: mode success followed by model
refusal leaves that mode visible with failed state. There is no rollback or fallback
protocol attempt. Legacy acknowledgements are accepted only for the already chosen
operation; a missing response or method cannot count as confirmation.

Cancellation interrupts the waiter and stops subsequent mutation/submission; it does
not cancel an issued SDK request. AgentClient tracks those raw promises in its
existing pending-execution owner. Unknown outcomes flow to existing Turn release and
connection retirement, never automatic input replay. A later connection uses a new
generation. Notification publication bypasses transcript batching and preserves
applying/failed/unknown state. A notification write failure is visible and marks state
unknown; it neither replays nor silently cancels an active prompt. Local write errors
block dependent submission, not other sessions or Stop.

`AcpConfiguration` is the narrow service over SDK operations; the applier and both
initial/recovery consumers compose native Effects. Matching steer performs no
configuration mutation; immediately before injection it rechecks the connection,
durable confirmation and requested values after any asynchronous preparation. A
known mismatch queues; uncertainty fails explicitly. AgentClient transport/process release and SessionDocument
Repo persistence remain Promise-owned upstream boundaries; this is not a completed
ACP or Session lifecycle migration. The [migration ledger](../../proposed/architecture/2026-09-27-effect-lifecycle-migration-roadmap.md#unit-ledger)
records that limitation. No new runtime, cache, background retry or desired-state
store is introduced.

## Compatibility and evidence

`sessionConfiguration` version 1 gates sending from updated clients. History and
Stop remain available against older machines. Legacy snapshots do not establish
confirmation. Opening a session does not start an agent: unspecified values inherit
at dispatch, and concrete values must be applied. Import does not invent live state;
a fork publishes its target connection's actual response. Capability removal keeps
concrete selections visible with an error, never silently substitutes defaults.

Synthetic behavioral suites cover partial refusal, contradiction, boolean false,
interruption, reused ACP ids, local write failure, admission/restart, frozen queues,
missing bodies and draft retention.
Repository-wide checks and packaged/live-provider UI acceptance must be reported
separately; these tests do not establish the cause of every original live report.
