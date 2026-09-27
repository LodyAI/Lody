# Keep duplicate turn copies in step and guard queue promotion

Status: proposed
Translation: current

[中文](2026-09-27-duplicate-turn-copy-writes-and-queue-guard.zh.md)

## Abstract

Renderer queued-message steering and CLI queue promotion can each append the same
queued turn on different replicas ([#1040](https://github.com/LodyAI/Lody/issues/1040)).
The [dispatch repair decision](../../implemented/bug-fix/2026-09-27-duplicate-turn-dispatch-repair.md)
made those duplicates safe to select, but status writes still reached only the last
copy, and promotion could append a turn that execution had already taken as a steer.
User-status writes now update every copy under explicit per-action rules, and promotion
rereads meta to hold, drop or promote the queued row. Duplicates can still be created;
this change stops them from diverging or running twice, without a protocol change.

## Problem and evidence

Before [#460](https://github.com/LodyAI/Lody/pull/460), `setUserTurnStatus` mapped
over the whole history and updated every user row with the ID. The shared writer
replaced that with a reverse `locate`, so only the last copy changed; the forward
dispatch scan then kept repairing a stale first copy until the daemon ran out of
memory. #1043 aligned reads with the last copy. Other readers that still match the
first row, and future writes, would otherwise leave the stale copy visible.

Steer RPCs and document sync are separate channels. Execution can apply a queued
row's steer, recording `steerTurnStatuses[id]`, before the renderer's `pending_apply`
row and queue removal reach the CLI. Promotion used only local history, so it could
append the same input again and run it as a new turn.

## Decision

- `HistoryWriter.updateCopies` mutates every stored row with an ID. It prepares and
  validates every replacement before the first CRDT mutation, then commits once.
- `user-status` uses it. Ordinary writes set the last copy and bring earlier copies
  along unless that would move a settled copy back. A steer projection requires the
  last copy to be `pending_apply` or `processing` and moves only copies in those
  states. `requeueUndelivered` and `onlyPendingApply` grant execution again, so any
  started or settled copy vetoes them, even when the last copy alone would allow it.
- Queue promotion without a history row rereads meta inside the queue lease. A
  `pending` steer status holds the row: that input still runs, once, through the
  steer's own history. Applied or settled steer status, an active turn, or the
  existing settled evidence (`lastHandled`, settled activation, missing-history
  tombstone, completed assistant) removes the row without appending. That evidence
is checked first: recovery writes its tombstone before clearing the steer status,
so a crash between the two must not leave a permanent hold at the queue head.

A refused steer whose history never arrives ends through missing-history recovery,
and the tombstone then drops the held row. The user resends explicitly. Promoting
the retained queue payload was rejected: `pending` proves the provider did not take
the steer, not that the queued payload matches what the renderer sent, and it would
defeat the tombstone's no-replay guarantee.

## Alternatives

Making the CLI the only queue consumer removes the race at its source, but needs a
steer request that names the queue row, negotiated capability, and upgraded clients
(including those outside this repository). It stays a separate decision. Plain
last-copy rules for requeue were rejected after review: an earlier `handled` copy is
positive evidence the turn already ran, and `lastHandledUserMsgId` keeps only the
latest turn. Deleting or deduplicating stored rows would mutate history to select work.

## Limits

Duplicate rows are still created and may render twice. Existing stale copies change
only when that ID is written again. Edit & Resend with `pendingInput: 'preserve'`
refuses a concurrent steer without recording it, so promotion can still run that
queued input as an extra turn; this pre-existing gap needs an execution-owned marker.
Readers such as `readTurnOutput`, fork and copy range still match the first row.

## Verification

Shared tests use the real Loro writer: concurrent copies update together, an invalid
second replacement leaves the document version unchanged, projections skip ordinary
and settled copies, and a started or settled copy vetoes both requeue flags. A CLI
test forks a queued document into two replicas, records the execution state on fresh
meta while passing stale meta, and covers applied, refused, tombstoned and ordinary
turns, plus a refused steer whose tombstone is already written, through the
renderer's later merge. Removing each mechanism made its tests fail: last-copy-only
writes (4), settled regression (1), requeue veto (2), projection filter (1), the
queue guard (3), fresh meta (3), holding refused steers (1), and checking settled
evidence before the hold (1).
Design reviewed with the Reviewer Agent Role; no live provider or UI run.
