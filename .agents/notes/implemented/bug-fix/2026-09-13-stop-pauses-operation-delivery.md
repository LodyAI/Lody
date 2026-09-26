# Keep Operation completions paused after Stop

Status: implemented
Translation: current

[中文](2026-09-13-stop-pauses-operation-delivery.zh.md)

## Abstract

A successful Stop interrupted the active turn, but a later Operation completion
could immediately start another assistant turn in the same Session. Stop now
persists a Session-scoped completion-delivery pause at the stopped assistant
turn. Pending completions remain durable and visible to reconciliation without
calling the agent until a user-authored turn explicitly resumes the Session.

## Ownership and scope

`SessionExecutionService` owns successful Stop finalization and user-turn
ownership. It writes `operationDeliveryPausedAtTurnId` before releasing the
cancelled turn. A subsequent user turn clears that marker only after it has won
the existing Session mutex and opened its assistant entry. Delivery and goal
turns intentionally have no user dispatch id at that boundary, so they cannot
resume themselves.

`LodyOperationCoordinator` continues to retain pending Deliveries in the SQLite
store. It reads the durable Session metadata before claiming execution and
returns while the pause marker exists. The marker is scoped to one Session, so
new Sessions are unaffected; the Session mutex and pending-user checks still
protect newer turn ownership.

The execution service also arms a process-local fail-closed barrier before it
writes the replicated marker. It consumes the already-durable Stop request only
in the same successful metadata patch that establishes that marker. If the
write fails, the current daemon gates on the local barrier and a restarted
daemon gates on the retained Stop request; after confirming the stopped user
turn when available—or from the exact durable Stop request when history has not
synced—restart heals the canonical marker before consuming the request. A real
user dispatch clears both durable fields first and only then removes the local
barrier, so a failed clear cannot accidentally resume delivery.

This uses the existing metadata replication and Operation store rather than a
second pause table or changing Delivery attempt state. Stop during a Delivery
still uses its established cancellation-and-consume rule; this change covers
pending or subsequently completed Operations after a stopped user turn.

## Evidence and verification

- The coordinator regression keeps a finished Delivery pending behind a Stop
  marker, then delivers it after the marker is cleared by the explicit-resume
  boundary.
- Session execution coverage verifies successful Stop writes the exact stopped
  assistant turn, retains the local barrier and durable request when that write
  fails, heals the marker after restart, and lets a user dispatch clear the
  marker separately from producer pointers.
- The executable orchestration model retains the pause through Worker restart,
  blocks automatic scheduling, and lets a queued user turn take ownership and
  clear it before later delivery.

Full Electron interaction acceptance is not established by these deterministic
service and coordinator tests.

Implemented in [PR #687](https://github.com/LodyAI/Lody/pull/687).
