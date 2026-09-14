# Effect ownership for queue Steer

Status: proposed
Translation: current

[中文](2026-09-14-queue-steer-effect-boundary.zh.md)

## Abstract

Queue Steer currently distributes delivery decisions across the renderer and
operation bookkeeping across `SessionExecutionService`. The proposed boundary
puts exact-item selection behind one daemon operation and gives `QueueSteerService`
ownership of delivery, resource lifetimes, receipts, and recovery. Effect can
express those lifetimes and failures compositionally, but its core runtime does
not make ACP delivery transactional or durable. This source investigation establishes
implementation constraints; the refactor and its behavioral verification remain pending.

## Source evidence

The installed package is `effect@3.18.4`. Its npm package contains source, but no
`AGENTS.md`. The official v3 checkout has an
[AGENTS.md](https://github.com/Effect-TS/effect/blob/1af4232fea7bc613e1dc68db9bec7b1f596d9e68/AGENTS.md)
and a [documentation entry](https://github.com/Effect-TS/effect/blob/1af4232fea7bc613e1dc68db9bec7b1f596d9e68/docs/index.md).
Current upstream `main` develops v4; examples using `Context.Service` or
`Effect.catch` must not be copied into this v3 application. CLI instructions
reference `context/cli-effect-ts.md`, which is absent from this checkout.

| Principle                        | Verified meaning                                                                                                                              | Consequence for Steer                                                                                                                            |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| A program is a value             | `Effect<A, E, R>` describes a lazy computation, its expected failures, and required services.                                                 | Compose the operation before running it; Promise execution belongs at the integration boundary.                                                  |
| Failures have different meanings | Expected failures are typed; defects and interruption remain distinguishable through `Cause` and `Exit`.                                      | Model missing, editing, stale, rejected, and indeterminate outcomes explicitly; never turn every failure into fallback delivery.                 |
| Resources have an owner          | `acquireRelease` protects acquisition and finalizer registration against interruption; `acquireUseRelease` restores interruptibility for use. | Scope rewrite leases and provider application leases; cleanup must also run on failure and interruption.                                         |
| Concurrency has a lifetime       | Fibers have supervision and scope relationships. A Promise adapter cannot cancel external work without cooperation.                           | Keep session serialization shared with prompt completion; Stop must preserve the ACP owner's lifetime until completion or confirmed termination. |
| Dependencies are explicit        | v3 `Context.Tag` identifies a service and `Layer` constructs its implementation.                                                              | Inject storage and execution ports; avoid passing the entire execution service or its mutable maps into the new service.                         |

The installed implementation was inspected in `src/internal/core.ts`
(`acquireUseRelease`), `src/internal/fiberRuntime.ts` (`acquireRelease`),
`src/internal/core-effect.ts` (`tryPromise`), and `src/ManagedRuntime.ts`.
The corresponding [3.18.4 source](https://github.com/Effect-TS/effect/tree/ede2ea11c2abe7038bac3c83fb7b5eef101858d2/packages/effect/src)
is the API authority. Upstream v3
[resource tests](https://github.com/Effect-TS/effect/blob/1af4232fea7bc613e1dc68db9bec7b1f596d9e68/packages/effect/test/Effect/acquire-release.test.ts)
and [interruption tests](https://github.com/Effect-TS/effect/blob/1af4232fea7bc613e1dc68db9bec7b1f596d9e68/packages/effect/test/Effect/interruption.test.ts)
were read as additional semantic evidence, not run or assumed identical to the pinned release.

## Proposed boundary

The UI supplies `{ sessionId, queueItemId, expectedTurnId }` for the selected row.
It displays the result without choosing provider delivery. The daemon operation
validates those identities and editing ownership, then chooses native delivery
or cancel-and-dispatch inside `QueueSteerService`. Effect owns composition,
typed failures, leases, and finalization within that service.

`SessionExecutionService` retains ownership of the live turn and exposes narrow
execution operations. It should not receive queue phases or callbacks such as
`onSubmitting` solely to advance a queue recovery journal. Queue storage retains
its existing history and activation publication responsibilities. Request handlers
convert Effect results to the existing response contract at one boundary.

Native preparation, provider submission, acknowledged ownership handoff, and
receipt completion form one composed delivery path. Cancel-and-dispatch forms
the other. Use `Effect.gen` for sequencing and tagged recovery handlers for
specific recoverable failures. Merely wrapping the current async method in
`Effect.tryPromise` would leave lifecycle ownership unchanged.

The existing renderer also supports older daemons. That compatibility policy
must be reconciled with the single-operation UI before implementation: preserving
it requires encapsulating legacy behavior below the UI; removing it requires
updating the draft [interaction Spec](../../../../specs/message-queue-interactions.md)
and compatibility tests. This investigation does not silently remove it.

## Recovery boundary

Finalizers release owned resources; they cannot undo provider acceptance. A typed
provider refusal can authorize ordinary dispatch, while an indeterminate submission
cannot. Do not apply `Effect.retry` to the complete delivery operation or interpret
timeout/interruption as evidence of non-delivery.

Keep the existing machine-local recovery evidence and fail-closed replay rules
from the [original decision](../../implemented/feature/2026-09-13-queue-steer-controls.md).
Move its ownership into the operation service; do not add a durable phase for
each Effect step. Core `Scope` cleanup does not survive process death. A workflow
engine would be a separate dependency and architectural decision, and is not
required merely to express these two delivery paths.

## Verification still required

Implementation should retain observable coverage for selecting C while preserving
A/B, missing or editing rows, stale expected turns, native acceptance/refusal,
Stop racing acknowledgment, failed persistence, and response-loss/restart recovery.
Add deterministic failure/interruption coverage that proves leases are released
without relinquishing a still-running ACP owner. Check UI invocation through the
single operation and verify legacy compatibility at its chosen boundary.

This note records source inspection and a proposed decomposition only. Business
code, dependency versions, and the existing Spec are unchanged; no runtime tests
were executed for the proposal.
