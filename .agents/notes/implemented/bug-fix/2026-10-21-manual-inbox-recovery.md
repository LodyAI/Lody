# Controlled manual Inbox recovery

Date: 2026-10-21
Status: implemented
Translation: current
PR: [#1778](https://github.com/LodyAI/Lody/pull/1778)

[中文](2026-10-21-manual-inbox-recovery.zh.md)

## Abstract

A stale Inbox owner can block every later send while its resource release remains
unproven. Stage 1 makes that state visible through the existing durable chat error
and offers an offline, snapshot-bound operator recovery path, including a missing
active execution pointer. Recovery requires exclusive Host ownership, verification
of recorded resources and explicit attestation covering unrecorded resources; it
preserves queued input and results without replaying uncertain requests. Windows
automatic recovery is deliberately deferred because root PID disappearance does
not establish descendant release.

## Decision and evidence

The [Inbox implementation](../architecture/2026-10-12-operation-inbox.md) already had
startup resource probing and an offline `recover-inbox` command. It was not a
missing startup scan. The automatic probe intentionally refuses Windows identities;
existing PID journals cannot prove tree disappearance. The original absent release
receipt behind issue [#1770](https://github.com/LodyAI/Lody/issues/1770) remains
unexplained; this change does not claim to fix its initiating cause.

Three gaps are addressed:

- Admission rejection occurred before the normal visible-turn error handler. Only
  a fresh blocked-state read now produces the durable `chat_failed` diagnosis with
  exact target context and an inspection-only command. Unrelated rejection retains
  its original semantics. Terminalized rejected input is retired exactly, but never
  changes a coincident active input. Failed admission cannot release an execution
  it never acquired, including deterministic ID collisions after restart.
- `blocked=1, active_execution=NULL` was omitted from the execution/resource join.
  Inspection now includes it and every unreleased resource record for that Session.
  A dedicated `--orphan <snapshot>` route never treats NULL as release proof.
- Ordinary Stop's pause helper canceled every pending input as `user_stop`.
  Operator recovery instead retires uncertain active/submitted input, keeps other
  queued inputs, releases only prepared claims back to held results, and pauses.
  History is never deleted. Submitted/unknown batches remain non-replayable.

## Authority, transaction and failure containment

The command runs outside Agent sessions on the owning machine/account/data root.
Its scoped Host lease excludes a live desktop/daemon before any database access.
Inspection uses a read-only handle, verifies schema compatibility and never migrates.
Mutation requires the inspected token plus all-resource attestation. Known roots
are observed, not killed; live processes, failed/uncertain probes, other platforms
and ambiguous ownership remain blocked.

A SHA-256 token identifies sorted Session ownership, unfinished resource journal,
input, batch, intent and host-owner facts. The writer rechecks it under `BEGIN
IMMEDIATE` after probing. New input, ownership or acquisitions invalidate an old
operation. Blocked-session revisions advance on Host activation, and resource journal
generations advance on every registration, so changed-then-restored values do not
reuse a token. Legacy v2 journals project generation zero without inspection writes.
Pause, resource release, uncertain-input retirement and a separate
nullable-execution recovery audit commit together; any write failure rolls back.
A completed retry is a non-mutating 'no longer blocked' error, never a new release.

Recovery affects only its blocked Session. It has no new background worker or
persistent confirmation gate. It creates no normal-release wake. Fresh human or
Agent-chat input clears the existing pause after restart, so this is not a
human-only stop barrier. Results arriving while paused stay held. Native Effect
workflow/scoped platform boundaries are retained; a larger Session/ACP migration
is unrelated and deferred.

## Correction: admission waits for the startup probe

A later incident showed a false manual-recovery diagnosis. A host rebooted during
a turn; the restarted daemon redispatched the interrupted user turn 15 ms into
startup. Admission read `blocked=1` before the startup probe had read the process
table, so it showed the quit-and-`recover-inbox` instructions. Seconds later, the
same probe proved the old roots gone and cleared the block. Bridge admission now
awaits that one-shot probe before reading block state. The interrupted input then
ends as an ordinary rejected input without replay, and fresh input proceeds. A
failed probe still leaves the block for the existing paths. Admission adds one
local process-table read to the first post-start dispatch only. A synthetic test
holds the probe and checks both cases before it resolves.

## Verification and limits

Synthetic SQLite, process-probe, Host-lease, command and durable-history tests are
provided for
missing/incomplete journals, orphan records, live roots/Host, changing snapshots,
unknown non-replay, retained queues/results, rollback and repeated recovery.
POSIX argument round-tripping and PowerShell quoting are tested. This executor
cannot bind the temporary Host sockets: those integration cases remain unverified
here, rather than being bypassed. Native workflow/SQLite cases use explicit injected
ports and do not claim to prove the OS lease. Validation is on
Linux; no real user store, live daemon or native Windows process tree is recovered.
The [Windows containment note](../../proposed/architecture/2026-10-21-windows-inbox-containment.md)
records the separate stage 2 decision and acceptance bar.
