# Reconcile a stopped steer without blind replay

Status: implemented
Translation: current

[中文](2026-09-13-stopped-steer-reconciliation.zh.md)

## Abstract

A steer could remain `pending_apply` forever when Stop ended its target turn while the ACP delivery verdict was unresolved. The fix cancels only the local application wait, retains the raw request in existing ACP cleanup, and records either a proven refusal for ordinary dispatch or an explicit delivery-unknown terminal result. This avoids both orphaned history and blind replay, while preserving a newer turn's dispatch ownership.

## Problem and boundaries

[Issue #666](https://github.com/LodyAI/Lody/issues/666) isolates the lifecycle gap left by the Stop ownership work in [#571](https://github.com/LodyAI/Lody/pull/571). A five-second renderer RPC timeout intentionally does not prove non-delivery, but Stop previously had no way to release the application waiter or settle its `pending_apply` row. The related [#477](https://github.com/LodyAI/Lody/issues/477) and closed [#471](https://github.com/LodyAI/Lody/pull/471) also establish that requeueing old steer B must not overwrite a newer user turn C; [#530](https://github.com/LodyAI/Lody/issues/530) asks for the broader visible recovery experience.

This change does not add a new persisted state machine or resend an ambiguous request. It extends the existing history metadata and Stop cleanup boundaries.

## Decision

- `AgentClient` exposes the submitted steer's delivery promise and keeps request-method steering in `pendingPrompts`. Aborting the application wait therefore unblocks the session queue without discarding the provider verdict.
- Stop waits for the steer mutation queue to release, then uses the existing prompt drain/termination path. A definite `AgentSteerNotDeliveredError` restores the exact row to `pending` and bumps `messageQueueUpdatedAt`; it never writes producer-owned `latestUserMsgId`.
- Accepted or transport-unknown delivery without an application commit records the exact id in a bounded durable metadata fence, then terminalizes a visible row as `failed` with `_lodySteerOutcome: delivery_unknown`. The fence prevents restart or a late history replica from dispatching the old steer; the UI offers an explicit resend as a new turn and warns that the provider may already have received the original.
- Finalization fences late results, so they cannot transfer ownership, mark the stopped source handled, or revive the old row.

## Alternatives and trade-offs

Automatically requeueing every stopped steer would be simpler but could duplicate work after ambiguous delivery. Treating a successful request response as applied would conflate provider acceptance with the successor-turn application commit described by the acknowledged-steer contract. A bounded exact-id list in existing session metadata supplies the restart fence without introducing a separate state store or mutable replay queue.

The visible retry remains user-directed. Lody cannot prove whether an ambiguous provider performed side effects, so the dialog describes that risk instead of claiming exactly-once execution.

## Verification

Deterministic CLI tests hold a steer request unresolved across Stop and termination, including a case where its history row has not synced, and verify that cleanup releases, the durable fence survives independently of history, and the newer turn retains dispatch ownership. Dispatch tests verify that the fence suppresses only matching RPC/history activation; component tests verify marker detection and the new-turn resend boundary.
