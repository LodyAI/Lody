# Effect ownership for queue Steer

Status: proposed
Translation: current

[中文](2026-09-14-queue-steer-effect-boundary.zh.md)

## Abstract

Queue Steer currently distributes delivery decisions across the renderer and
operation bookkeeping across `SessionExecutionService`. The proposed boundary
gives `QueueSteerService` exact selection, validation, durable recovery evidence,
fallback policy, and results; `ActiveTurnSteerPort` owns native submission and
live-turn handoff. Effect expresses local resource lifetimes and typed failure
semantics without making provider submission reversible. Native reservation transfers
the item out of editable Queue ownership; frozen history and queue removal must be durable
before provider submission. Queue Steer requires a
supported `queueItemSteer` capability, with no old-daemon compatibility path.
The design is revised; implementation and behavioral verification remain pending.

## Source evidence

The [workspace catalog](../../../../pnpm-workspace.yaml) pins `effect: 3.18.4`,
and [CLI dependencies](../../../../apps/cli/package.json) consume `catalog:`.
[SessionExecutionService](../../../../apps/cli/src/session/session-execution-service.ts)
already uses `Effect.gen` and `Effect.acquireRelease` for turn ownership and
finalization. The proposal extends that existing approach.

The installed package has source but no `AGENTS.md`. The official v3 checkout has
[agent instructions](https://github.com/Effect-TS/effect/blob/1af4232fea7bc613e1dc68db9bec7b1f596d9e68/AGENTS.md)
and a [documentation entry](https://github.com/Effect-TS/effect/blob/1af4232fea7bc613e1dc68db9bec7b1f596d9e68/docs/index.md).
Upstream v4 examples using `Context.Service` or `Effect.catch` must not be copied
into this v3 application. CLI instructions reference `context/cli-effect-ts.md`,
which is absent from this checkout.

The installed implementations of `acquireUseRelease` in `src/internal/core.ts`,
`acquireRelease` in `src/internal/fiberRuntime.ts`, `tryPromise` in
`src/internal/core-effect.ts`, and the `ManagedRuntime` API were inspected.
The corresponding [3.18.4 source](https://github.com/Effect-TS/effect/tree/ede2ea11c2abe7038bac3c83fb7b5eef101858d2/packages/effect/src)
is the API authority. Upstream v3
[resource tests](https://github.com/Effect-TS/effect/blob/1af4232fea7bc613e1dc68db9bec7b1f596d9e68/packages/effect/test/Effect/acquire-release.test.ts)
and [interruption tests](https://github.com/Effect-TS/effect/blob/1af4232fea7bc613e1dc68db9bec7b1f596d9e68/packages/effect/test/Effect/interruption.test.ts)
were read as supplementary evidence, not run or assumed identical to the pinned release.

## Responsibilities

| Owner                 | Responsibility                                                                                                                 |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| UI                    | Pass `{ sessionId, queueItemId, expectedTurnId }` for the selected row; display the result.                                    |
| `QueueSteerService`   | Exact queue-item selection, validation, durable recovery evidence, fallback policy, result and receipt.                        |
| `ActiveTurnSteerPort` | Live-turn ownership, provider native submission, prompt handoff, and serialization with Stop and other active-turn operations. |
| Queue storage         | Existing history and activation publication responsibilities.                                                                  |
| Integration boundary  | Provide v3 `Context.Tag` services through `Layer`; execute the composed operation and map its result to the response contract. |

The active-turn implementation stays with the execution owner. QueueSteerService
must not access `runtime.session.agentClient`, runtime maps, `promptInFlight`,
`successor`, or `invocation`. The port derives the frozen requester identity
from the active invocation and validates the expected turn under its own
serialization boundary; caller validation never replaces that check.

The native operation exposes a domain result, conceptually:

```ts
interface ActiveTurnSteerPort {
  steer(input: {
    sessionId: SessionId;
    expectedTurnId: string;
    turn: SteerTurn;
  }): Effect.Effect<NativeSteerApplied, StaleTurn | ProviderRejected | ProviderDeliveryUnknown>;
}
```

`SteerTurn` is validated immutable turn data, not a runtime handle.
`NativeSteerApplied` proves successful local handoff, not prompt completion.
`StaleTurn` proves rejection before submission. Lost ownership after submission
cannot be reported as that safe rejection.

This is the native operation's contract, not an exhaustive interface for every
execution operation. Native-support discovery and expected-turn cancellation
also stay behind execution-owned operations. QueueSteerService chooses the policy
without inspecting the provider client. Never expose `onSubmitting`,
`onAcknowledged`, `onApplied`, or `onUndelivered` callbacks to advance a queue
journal. The new service must not be the existing runtime-dependent code moved
to another file.

## Resource and failure model

`Effect<A, E, R>` describes a lazy computation with explicit expected failures
and dependencies. Use `Effect.gen` to compose operations, with typed recovery
handlers at the owner of the policy. A single `Effect.tryPromise` around the
existing async workflow would not change lifecycle ownership.

Rewrite leases and local live-turn ownership/serialization guards belong to
`Scope`. Provider submission is an irreversible external side effect, not a
resource that can be released. The sequence is acquire local ownership, submit
the provider side effect, then release local ownership when its contract allows.
Finalizers prevent local ownership leaks; they do not prove non-execution.
An existing adapter acknowledgment handle is only a local synchronization
resource and stays internal to the port.

The expected error model has three categories:

| Category               | Evidence and examples                                                                                     | Recovery policy                                                                                                                                               |
| ---------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Safe rejection         | Provider did not execute: `ProviderRejected`, pre-submission `StaleTurn`.                                 | Fallback/retry is eligible only if operation preconditions still hold. Stale, missing, or editing selections remain failed no-ops; they must not stop a turn. |
| Indeterminate delivery | `ProviderDeliveryUnknown`: submission may have executed, including acknowledgment or handoff uncertainty. | Propagate the failure; no fallback handler and no replay.                                                                                                     |
| Local failure          | `PersistenceFailure`, validation or lease acquisition failure.                                            | Recover from durable evidence; a local error alone never establishes non-delivery.                                                                            |

Use distinct v3 `Data.TaggedError` classes for `ProviderRejected`,
`ProviderDeliveryUnknown`, and `PersistenceFailure`. The native port classifies
delivery evidence; the operation's persistence boundary owns `PersistenceFailure`.
A local failure after submission must preserve possible delivery and cannot be
reclassified as `ProviderRejected`.

The policy handler is `Effect.catchTag("ProviderRejected", fallbackToDispatch)`.
There is no corresponding fallback handler for `ProviderDeliveryUnknown`.
Defects and interruption remain distinguishable through `Cause`/`Exit`;
neither a timeout nor an interrupted Promise establishes provider non-execution.
Do not retry the complete delivery operation.

## Durability and capability policy

Keeping an editable queue row after freezing its history permits a lost edit:
another client saves changed content, native delivery executes the earlier snapshot,
then row deletion discards the accepted edit. The current native consumption path in
`SessionDocument.consumeMessageQueueItemAsUserTurn` retains the row, and
`updateMessageQueueItem` does not check operation ownership. This is an ownership
contract defect, not merely a missing cleanup step.

The [Spec](../../../../specs/message-queue-interactions.md) now assigns the item to
the daemon-owned operation when reservation succeeds. The selected sequence is:

```text
validate and claim exclusive reservation ownership
→ durable reservation marker
→ append frozen pending_apply history → history durable
→ remove selected shared Queue row → removal durable
→ write-ahead submission evidence
→ ActiveTurnSteerPort.steer(frozen turn)
→ durable result / receipt
```

The queue write authority must serialize reservation with ordinary edit/remove/reorder
and promotion, including while persistence is awaited. An edit committed first is
included or causes reservation rejection. Reservation winning first rejects later
mutations visibly, retaining an editor's draft. A stale client must not receive a
successful no-op save. A machine-local marker or disabling buttons in one renderer
cannot by itself enforce this across clients; all mutation paths need the same authority.
The implementation of that boundary remains pending, and early row removal alone does
not establish it.

QueueSteerService owns the journal and receipts. Recovery uses its machine-local marker
and frozen history, not an editable queue row. Before history becomes durable, recovery
reconciles the reservation as unsubmitted before returning any surviving row to editing.
After history is durable, recovery can finish removal and recover that same turn even if
the row is absent. A failed removal commit prevents provider submission. After write-ahead
submission evidence, a crash remains conservatively indeterminate unless authoritative
evidence proves otherwise. Reserved-operation retries resolve through the marker or
receipt rather than ordinary missing-row validation.

Implement these boundaries without phase callbacks or exposing live runtime state.
Preserve recovery of existing markers and their fail-closed replay guarantees from the
[original decision](../../implemented/feature/2026-09-13-queue-steer-controls.md), but
supersede its requirement to retain the shared row until delivery finishes. Reconcile any
legacy surviving row without deleting accepted edits. Do not add a durable phase for every
Effect step. The exact ownership, ordering, and failure guarantees have one owner in the Spec.

Core Scope cleanup cannot survive process death. Stop must retain the ACP owner
until raw completion or confirmed termination; a Promise wrapper cannot cancel
external work without its cooperation. A workflow engine is a separate
architectural decision, not required for these two delivery paths.

Queue Steer has no old-daemon compatibility path. Without an advertised supported
`queueItemSteer` version, every row's Steer action is unavailable, including the
queue head. Do not fall back to renderer history materialization, legacy native
Steer, or queue-head cancel. On supported daemons every row passes its own queue
identity; the daemon chooses native delivery or cancel-and-dispatch.

This supersedes the original decision's old-daemon compatibility policy for
queue Steer only. Composer submission behavior is outside this change.
The draft [interaction Spec](../../../../specs/message-queue-interactions.md)
records the revised intent; the renderer still contains the old paths.

## Verification still required

Retain observable coverage for selecting C while preserving A/B, missing/editing
rows, stale expected turns, native acceptance/refusal, Stop racing acknowledgment,
failed persistence, and response-loss/restart recovery. Verify each error category:
only eligible safe rejections dispatch fallback; indeterminate outcomes never
replay; local failures recover according to durable evidence. Deterministic
failure/interruption tests must prove local guards release without relinquishing
a still-running ACP owner. Unsupported daemons must expose no usable queue Steer
action on any row and issue no legacy submission or cancellation.

Add two-client tests for both orderings of reservation versus edit/save/remove/reorder,
including a stale client that has not observed removal. A rejected save must retain its draft;
an accepted edit must not disappear behind the frozen prompt. Exercise failure/crash boundaries
before history durability, between history and removal durability, and after durable removal
before submission. Prove provider submission waits for durable removal, ordinary promotion
cannot consume the reserved row, and recovery succeeds with marker plus history while the row
is absent. Existing row-retention tests must be revised to the ownership-transfer contract.

Business code and dependency versions are unchanged. This revised design and
Spec are not implementation evidence; no runtime tests were executed.
