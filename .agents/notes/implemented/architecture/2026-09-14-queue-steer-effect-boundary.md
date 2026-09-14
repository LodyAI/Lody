# Effect ownership for queue Steer

Status: implemented
Translation: current

[中文](2026-09-14-queue-steer-effect-boundary.zh.md)

## Abstract

QueueSteerService owns exact selection, validation, recovery evidence, fallback and receipts;
ActiveTurnSteerPort retains live-turn and provider ownership. Effect 3.18.4 expresses local
resource lifetimes and typed failures without treating provider submission as reversible.
Native reservation makes frozen history and queue removal durable before submission;
conflicting stale edits fail visibly and retain their drafts. Queue Steer requires
queueItemSteer v2, without old-daemon compatibility. Indeterminate delivery never replays;
real process-crash and installed-app verification remain outside the completed checks.

## Source evidence

The [workspace catalog](../../../../pnpm-workspace.yaml) pins `effect: 3.18.4`,
and [CLI dependencies](../../../../apps/cli/package.json) consume `catalog:`.
[SessionExecutionService](../../../../apps/cli/src/session/session-execution-service.ts)
already uses `Effect.gen` and `Effect.acquireRelease` for turn ownership and
finalization. The implementation extends that existing approach.

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

## Boundaries and implementation

| Owner                                                                             | Responsibility                                                                                        |
| --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| UI                                                                                | Pass session, exact queue item and expected turn; no native/fallback policy.                          |
| [QueueSteerService](../../../../apps/cli/src/session/queue-steer-service.ts)      | Exact selection, validation, durable marker, recovery, fallback and bounded receipts.                 |
| [ActiveTurnSteerPort](../../../../apps/cli/src/session/active-turn-steer-port.ts) | Live ownership, native submission, prompt handoff, exact Stop and local guards.                       |
| SessionExecutionService                                                           | Implement the port; compose Context.Tag/Layer and execute domain operations on its per-session queue. |
| SessionDocument                                                                   | Compare row revisions and mutate synchronously; write history only through shared HistoryWriter.      |

The queue service never reads runtime maps, agentClient, promptInFlight, invocation or successor,
and receives no onSubmitting/onAcknowledged/onApplied/onUndelivered callbacks.
It defines its own narrow dependency contract, without importing SessionExecutionServiceDeps.
Provider requester identity comes from the active invocation, not the shared queue author.
Ordinary turn and composer routing remain unchanged.

The source facade shares [session authorization](../../../../packages/components/src/providers/session-control-authorization.ts)
between queue Steer and mutation, using complete authenticated machine/project snapshots.
Control requires machine access plus matching project access for local-project sessions.
Reusing UI visibility was incorrect: its intentional session-owner fallback permits display
after machine access is revoked, but must not grant control. The control contract therefore
contains no currentUserId or session-owner input and does not call the visibility predicate.
RuntimeProvider supplies a workspace-fenced snapshot; missing metadata or authorization
fails closed. Routing plane is decided independently of sender availability: local failure cannot
fall through to Streams. The target daemon cannot authenticate a caller identity from this RPC.

## Resources and failures

Rewrite/ownership guards and the adapter's local ACK gate belong to Scope through
Effect.acquireRelease. Interruption is masked between submission and ACK cleanup registration
so local cleanup ownership cannot be abandoned. Stop still cancels ACP, not its owner fiber.
Scope neither reverses external submission nor runs after process death.

| Category                                   | Behavior                                                                                                                                                      |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ProviderRejected, pre-submission StaleTurn | Only proven non-delivery and eligible preconditions allow ordinary dispatch recovery. Missing, editing or stale selection before reservation remains a no-op. |
| ProviderDeliveryUnknown                    | Return the error without fallback or replay, including ownership loss or handoff failure after submission.                                                    |
| PersistenceFailure                         | Local preparation/persistence failure; retain durable evidence, never infer non-delivery from a local failure.                                                |

A crash after write-ahead submission evidence but before local preparation finishes remains
conservatively indeterminate. Do not introduce a phase per Effect step or retry the whole operation.

## Authoritative mutation and recovery

Early removal alone cannot prevent another client saving during the history persistence await.
queueItemSteer therefore advances to v2: edit/remove/reorder use the narrow
`session/queue-mutate` domain RPC, sharing reservation's serialization and rewrite conflict guard.
Update/remove carry canonical row revisions; reorder carries the original ID snapshot.
Conflicts and missing rows fail explicitly; failed RPC never falls back to direct writes.
Enqueue, ordinary sends and other UI data remain renderer-authored, without a generic
write-intent mirror. Old daemons do not expose Queue Steer.

Native order is reservation marker → pending_apply history durable → queue removal durable
→ submitting marker → native port → durable receipt. Every pre-submit barrier gates provider calls.
Recovery uses marker and frozen history, without requiring a surviving row. Existing markers
remain readable. A legacy row without a revision may be removed only when its frozen content
is provably unchanged and it is not being edited; otherwise preserve it for reconciliation.

Reserved without history clears its marker and leaves the queue untouched, with no terminal
receipt. Same C/T retries revalidate and reserve anew, either after startup recovery or within
the current request; a failed clear prevents proceeding. A cached error here would incorrectly
make a proven-unsubmitted operation permanently unsteerable for the remaining active turn.
Reserved with history/fallback recover the same ordinary turn; submitting/acknowledged never replay;
applied recovers an accepted receipt. Ordinary cancel-and-dispatch retains its history/activation
publication order and in-memory receipts. The [Spec](../../../../specs/message-queue-interactions.md)
owns the full contract and remains draft. This supersedes the
[original decision](../feature/2026-09-13-queue-steer-controls.md)'s editable-row retention and
old-daemon compatibility policies.

The editor stays mounted after the last row disappears, shows the conflict, and retains its
unsaved draft until explicitly dismissed. Direct CRDT writes from old software are not v2
authority acceptance; this is not compatibility with arbitrary old renderers.

## Verification and limits

Existing suites cover exact C preserving A/B, provider rejection and uncertainty, Stop/late ACK,
consecutive handoffs, receipts/restart, and reservation versus edit/remove/reorder on a real LoroDoc.
Explicit promise gates prove durable removal before submission, zero submissions after
reservation/history/removal/submission-marker persistence failure, marker-plus-history recovery,
and local guard release. Components verify displaced-draft retention; shared negotiation rejects v1.
No race assertion depends on sleeps or real network scheduling.

The execution suite connects the real source facade, Streams client/server, LoroDoc and execution
service over an in-memory transport. A visible machine with a denied private project rejects
both controls with zero appends, no marker, and unchanged queue/history/active turn. The same
trace covers session creators with revoked machine or denied project access, even while UI
visibility remains true; a retained project grant cannot override machine revocation. Local routing
with no sender also rejects without constructing the remote client. A positive project-access
control reaches the daemon and applies C. Restart and in-request pre-history recovery both allow
the same C/T to proceed. These are deterministic synthetic traces, not production-user traces.

Direct CLI/components typechecks and targeted tests were run. Root pnpm check / pnpm format
cannot start because corepack is absent; installed pnpm runs targeted checks and Prettier instead.
No real-provider, full desktop end-to-end, process kill/restart, or arbitrary mixed-old-client
verification was performed.
