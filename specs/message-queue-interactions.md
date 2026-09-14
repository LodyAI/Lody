# Message queue interactions

Status: draft
Translation: current

[中文](message-queue-interactions.zh.md)

## Scenario

A user writes while an agent is working and chooses Queue or Steer as the default
behavior. They may need the opposite behavior for one message, or may decide that
any already queued message should steer the active response without first rearranging
the queue by hand.

## Contract

- `Mod+Shift+Enter` sends the current composer draft with the opposite of the stored
  Queue/Steer preference. The command passes `queueBehavior: "inverse"` directly to that
  submission; ordinary Enter passes no override. This one-shot intent does not mutate the
  preference and still obeys the ordinary availability, live-activity, and unfinished-
  transcript safeguards. Composer focus, content, and send readiness are command-level
  availability rules so user-rebound shortcuts retain them.
- Exact-item steering is a versioned daemon workflow. A renderer may call
  `session/queue-steer` only when `MachineMeta.protocolCapabilities.queueItemSteer` advertises
  a supported version; a missing capability means unsupported. The request carries the
  durable queue identity and expected active turn. The daemon, not the renderer, chooses the
  execution mechanism:

  | Active daemon/runtime                                 | Steer behavior                                                                                                                 |
  | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
  | Exact-item protocol and acknowledged native ACP Steer | Reserve the selected row as `pending_apply`, retain it through the durable handoff saga, then inject it through `steerPrompt`. |
  | Exact-item protocol without native ACP Steer          | Persist and activate the selected row as the next user turn, remove it from the queue, then stop only the expected turn.       |
  | No supported `queueItemSteer` capability              | Queue Steer is unavailable on every row, including the head, regardless of native ACP capability.                              |

  Queue Steer provides no old-daemon compatibility path: no renderer-side history
  materialization, legacy native Steer, or queue-head cancellation. The UI exposes one
  exact-item operation and does not choose provider delivery. Selecting C from
  `[A, B, C]` through the exact protocol consumes C and leaves `[A, B]` in that order.

  `QueueSteerService` owns exact selection, validation, durable recovery evidence, fallback
  policy, and results/receipts. `ActiveTurnSteerPort` owns live-turn ownership, native provider
  submission, prompt handoff, and serialization with Stop. The queue operation never accesses
  runtime maps or the provider client and receives domain results rather than phase callbacks.
  Local ownership guards may be scoped resources; provider submission is an irreversible
  external side effect. Only proven non-delivery is eligible for fallback, subject to operation
  preconditions. Indeterminate delivery must propagate without replay; local failures recover
  from durable evidence and never imply non-delivery by themselves.

  A remote renderer must authorize the target before writing the request, using its
  authenticated authoritative machine-access snapshot and failing closed if that snapshot is
  unavailable. The request carries no requester identity: workspace Machine RPC cannot
  authenticate a caller-supplied member ID, and the target daemon must not use one for an owner
  fast path. Same-host local IPC is already the trusted local control boundary.

  Native exact Steer must derive its requester identity from the authenticated active
  invocation, never from the shared queue row. If that frozen identity is unavailable, the
  daemon fails before consuming the row, submitting to the provider, or stopping the turn.

  Native handoff is a durable saga, not an atomic CRDT/provider operation. A machine-local,
  daemon-owned marker records `reserved`, write-ahead `submitting`, provider `acknowledged`,
  locally committed `applied`, or `fallback`, and keeps the selected queue row until the result
  is durable. A `reserved` entry that reached history, or any `fallback`, may become the exact
  ordinary turn;
  a reservation interrupted before history leaves the row queued. `submitting` is indeterminate
  and `acknowledged` may already have side effects, so neither is replayed after its prompt owner
  disappears. `applied` proves local handoff and recovers as accepted while ordinary crash
  handling makes an interrupted turn visible. This is the fail-closed boundary required because
  ACP supplies no idempotent submission key or delivery-query operation.

  For cancel-and-dispatch Steer, the selected queue row is the durable retry marker: append
  history first, publish `latestUserMsgId`, and remove the row only after both writes succeed.
  A retry after partial publication reuses the existing turn ID rather than duplicating history.

- A stale or conflicting exact Steer selection is a failed no-op. If the selected queue
  identity is missing, its editing lease is active, or the expected turn no longer owns
  execution, the daemon must not submit native Steer or stop any turn. The renderer waits for
  this acknowledgement and never removes or materializes an exact-protocol row itself.
- The daemon retains a bounded in-memory receipt for each recently consumed exact-item request,
  keyed by session, expected turn, and queue identity. Native saga completion also persists its
  latest receipt in the operation marker, so an immediate retry survives daemon restart; a later
  native operation may replace that terminal marker. Shared Session metadata is not a recovery
  authority because collaborators can write it. If consumption succeeded but
  cancellation failed, the message remains a durable follow-up and a retained-receipt retry must
  not duplicate it. A native rejection is receipt-eligible only after its history status,
  activation pointer, and queue-row cleanup are durable; failed recovery remains retryable.
- The number and non-editing message body form the drag target for queue reordering.
  Steer, edit, and remove remain separate controls and must not begin a drag.
- Editing keeps its existing keyboard and focus behavior and disables reordering for
  that row until editing ends.

## Limits and review questions

The shortcut changes routing only when Queue and Steer are meaningfully distinct. An
idle session still dispatches normally, and a session without positive live prompt
activity retains the conservative queue barrier even if the inverse intent would be
Steer. Touch and pointer interactions share the same drag target; installed-app and
physical-device coverage remains separate from component tests. The provider boundary cannot
offer exactly-once recovery without protocol support: indeterminate native submissions are
reported, never silently replayed.

## Implementation evidence

The service/port split and capability-only availability above are intended changes, not
completed implementation. The renderer still contains old-daemon native/head paths and the
execution service still owns queue orchestration. Removal and regression verification remain
pending under the [Effect boundary proposal](../.agents/notes/proposed/architecture/2026-09-14-queue-steer-effect-boundary.md).
The new availability policy applies to queued-row Steer, not composer submission routing.

- `packages/components/src/components/sessions/session-message-submit-route.ts`
- `packages/components/src/components/sessions/session-chat-input-area.tsx`
- `packages/components/src/components/sessions/message-queue/`
- `packages/components/tests/{session-message-submit-route,session-chat-input-submission,message-queue-row-editing}.test.*`
- `apps/cli/{tests/session-execution-service.test.ts,src/lib/loro/doc-user-turn.test.ts,src/session/session-queue-steer-operation-store.ts}`
- [Decision record](../.agents/notes/implemented/feature/2026-09-13-queue-steer-controls.md)

This is a draft for human review. Implementation and passing tests do not approve it.
