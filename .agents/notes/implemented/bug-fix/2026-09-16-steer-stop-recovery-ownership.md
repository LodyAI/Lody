# Steer Stop and recovery ownership

Status: implemented
Translation: current

[中文](2026-09-16-steer-stop-recovery-ownership.zh.md)

## Abstract

Stop could leave a steer holding the session's operation queue while its preparation or
application verdict never completed. Request-transport steers were also absent from the
raw ACP drain, and delayed results could overwrite a newer input or revive terminal history.
Local waits now end independently of raw execution: execution retains ownership through
completion or confirmed termination and projects results by exact user-turn identity.
Unknown delivery has a visible, explicit-new-send recovery path, without blind replay or
a new provider reconciliation protocol. This is not a crash-atomic provider receipt system.

## Scope and evidence

This completes the Stop and orphaned-guidance paths described in
[#477](https://github.com/LodyAI/Lody/issues/477) and
[#666](https://github.com/LodyAI/Lody/issues/666). It extends the
[pending-input decision](2026-09-14-interrupt-pending-input-exactly-once.md), retaining its
adapter `applied` / `not-applied` / `unknown` evidence and cancellation policies. Provider-side
reconciliation is unchanged; a timeout or absent notification is not evidence of refusal.
The current behavioral contract remains a [draft Spec](../../../../specs/session-history-writes.md).

## Ownership

| State                                         | Owner and release boundary                                                                                            |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Local preparation / application wait          | Target-turn abort signal; Stop and prompt completion release the steer lane and rewrite lease.                        |
| Submitted ACP/configuration work              | Existing execution owner; completion or confirmed termination, using one five-second drain.                           |
| Refused input                                 | Exact-id pending activation in daemon-owned `steerTurnStatuses`; ordinary claim or missing-history failure clears it. |
| Applied/unknown result before history arrives | Exact-id projection in the same map; terminal projection clears it, applied processing remains until finalization.    |
| Renderer RPC acknowledgement                  | Presentation only; never writes processing over a terminal history row.                                               |

An already-applied handoff finishes its serialized ownership transfer before completion.
Steer configuration uses the target signal between mutations, while its outstanding call
remains tracked. A repeated Stop cannot interrupt an owner still draining a steer after its
main prompt returned. Outcome-write failure releases the application lease in `finally`.

The recovery map never rewrites `latestUserMsgId` or clears another input's missing-history
tombstone. All map changes serialize in the execution service. The watcher projects results
before selecting work. Applied provenance is excluded from ordinary restart dispatch;
an abandoned applied-processing projection becomes canceled. Unknown is stored as the
declared `delivery_unknown` history status and never selected for dispatch or edit-and-resend.
Its dialog warns about possible duplicate work before authorizing a new user turn.

New daemon responses identify recovery ownership. A failed promotion is retried once through
that owner; persistent failure is surfaced. Legacy responses retain their existing renderer
fallback. This does not promise arbitrary compatibility with old execution-status writers.

## Alternatives and limits

Writing only history loses the wakeup when metadata and history arrive independently.
Repointing the latest input can erase a newer producer activation; a queue timestamp alone
does not retain which refused input still needs its late history. The exact-id projection
avoids both without moving provider delivery decisions into dispatch.

A full durable receipt/admission ledger was not added. Queue rows still hand off on history
acceptance; producer crash before offering a steer and process death before recording a
provider verdict are not transactionally recovered. A recorded result survives via existing
metadata persistence, but cannot prove an unrecorded result. Missing result projections remain
until the matching row arrives; missing ordinary recovery inputs use the existing bounded
history wait. No live-provider frequency or universal exactly-once guarantee is claimed.

## Verification

Deterministic executor tests cover Stop and natural completion during document, prompt-block,
and configuration waits, a second queued steer, raw request drain after main prompt completion,
late applied/refused/unknown results before history, newer activation preservation, and later
ordinary execution. Shared tests exercise terminal guards and unknown status through real
HistoryWriter/Loro peer import. Renderer tests cover delayed terminal ACKs and explicit unknown
resend confirmation. Existing termination-failure and internal-cancellation suites remain.

CLI typechecking is blocked by pre-existing DeepSeek submodule/profile export mismatches in
this checkout. Documentation checks also already report missing DSH usage-test links. The
pre-existing submodule checkouts are not modified by this change. Live provider testing is
not part of this verification.
