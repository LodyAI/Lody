# Availability-first local authority for Cloud same-machine recovery

Status: implemented
Translation: current

[中文](2026-11-21-cloud-same-machine-recovery-authority.zh.md)

## Abstract

Cloud daemon Operation recovery previously required remote Loro Streams catch-up (`syncRemoteDocOrThrow`) before replaying a missing target Turn, even when the target Session ran on the same daemon's own replica. During Streams outages or degradation, same-machine delegated work stalled in 8-second catch-up timeout loops despite the owning daemon being alive locally. By product-owner decision, `confirmTargetReadable` now prioritizes availability for Cloud same-machine targets by calling `repo.flush()` locally instead of waiting on Streams catch-up, while remote-machine and unresolved targets keep remote catch-up. This accepts a rare, unverified duplicate-delivery risk if a daemon crashes after uploading a Turn to Streams but before local persistence completes, and must be re-evaluated if duplicate same-machine replays are observed or if `LoroRepo` is shown to upload before durable local persistence.

## Problem

In Cloud workspaces, same-machine MCP delegation (`lody_session_create`, `lody_session_chat`, and batch variants) runs through the daemon's own `LoroDocumentManager` replica. When initial materialization hands off to `LodyOperationCoordinator` recovery (for example after a transient failure or daemon restart), `CoordinatorWorkflow` calls `confirmReadable` before checking whether the fixed `userTurnId` already exists and replaying it.

Requiring remote Streams confirmation on that path meant any Streams outage or stall prevented the daemon from recovering work destined for its own local Sessions, turning a cloud transport issue into a complete local orchestration outage.

## Decision

For Cloud workspaces, `confirmTargetReadable` in `apps/cli/src/lib/message-handler.ts` treats targets owned by the running daemon (`targetMachineId === this.machineId`, resolved from target metadata or—for cold `session_create` / `session_create_many`—from `resolveOperationTargetMachineId` in `apps/cli/src/orchestration/coordinator-model.ts`) the same way as OSS local targets: flush the authoritative local daemon repo (`repo.flush()`) and recheck the fixed `userTurnId` before replaying.

- Cross-machine targets (`targetMachineId !== this.machineId`) and targets whose machine cannot be confirmed locally (for example, a cold Role-based creation without an explicit machine id in the canonical command) keep mandatory remote Streams catch-up (`syncRemoteDocOrThrow` with an 8-second catch-up timeout and bounded backoff).
- Same-machine recovery still runs inside `Scope`-owned `FiberMap` fibers with bounded concurrency and rechecks `isTargetInputDurable` before calling `materializeTarget`.
- This partially supersedes [local Session orchestration](2026-09-29-local-session-orchestration.md), which originally left all Cloud recovery paths on remote Streams catch-up. PR: [#3050](https://github.com/LodyAI/Lody/pull/3050).

## Accepted risk and trigger conditions

Prioritizing local availability accepts one narrow, currently unverified duplicate-delivery window:

1. The daemon writes a fixed `userTurnId` to its in-memory Session document and uploads that update to Loro Streams.
2. The daemon process crashes or loses power before the corresponding local persistence write completes on disk.
3. On restart, the local replica does not contain that Turn, `repo.flush()` succeeds against the local replica, and `LodyOperationCoordinator` replays the Operation's fixed Turn—potentially triggering duplicate execution if another peer or a later remote sync also observed the pre-crash upload.

Whether this window is reachable in practice depends primarily on whether `LoroRepo` persists updates to local storage before transmitting them to Streams; that ordering has not been verified experimentally.

## Rejected alternatives

- **Keep mandatory remote Streams catch-up for all Cloud targets:** Eliminates the crash-before-persist duplicate window by consulting Streams first, but stalls same-machine orchestration whenever Streams is offline or degraded, which violates the availability priority.
- **Skip `repo.flush()` as well on same-machine targets:** Avoids even local persistence wait, but risks missing an un-flushed in-process write before rechecking `isTargetInputDurable`.

## Re-evaluation triggers

Revisit this decision if any of the following occurs:

- Duplicate Turn execution is observed during same-machine Cloud Operation recovery after a daemon crash or restart.
- `LoroRepo` is verified to upload mutations to Streams before durable local storage flush without a write-ahead guarantee.
- Future orchestration semantics require strict remote-confirmed exactly-once delivery before same-machine replay rather than availability during cloud outages.

## Verification and limits

- `apps/cli/src/orchestration/operation-coordinator.test.ts` pins that cold same-machine `session_create` recovery resolves `targetMachineId` from the canonical command / requester metadata, passes it to `confirmTargetReadable`, and recovers without `syncRemoteDocOrThrow`, while remote/hanging catch-up keeps Effect Clock timeout and bounded retry.
- `apps/cli/src/mcp/daemon-session-tools.test.ts` pins Cloud same-machine `lody_session_chat` and `lody_session_create` delivery while Streams sync fails, alongside remote, collaborator, and revoked guards.
- Unverified: `LoroRepo`'s exact local-persistence versus Streams-upload ordering under abrupt process termination, and live crash-recovery replay against a production Streams server.
