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

  | Active daemon/runtime                                 | Steer behavior                                                                                                                         |
  | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
  | Exact-item protocol and acknowledged native ACP Steer | Transfer the selected item to a daemon-owned operation, persist its `pending_apply` history and queue removal, then call native Steer. |
  | Exact-item protocol without native ACP Steer          | Persist and activate the selected row as the next user turn, remove it from the queue, then stop only the expected turn.               |
  | No supported `queueItemSteer` capability              | Queue Steer is unavailable on every row, including the head, regardless of native ACP capability.                                      |

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

  Successful native Steer reservation transfers the selected item's ownership from the shared
  editable Queue to the daemon-owned Steer operation. From that point ordinary edit, remove,
  reorder, and queue promotion cannot mutate or consume it, even if another client still
  displays a stale row. Reservation and ordinary mutations must share an authoritative
  ownership boundary: an edit committed first is included in the validated snapshot (or causes
  reservation to reject); a reservation that wins first causes later mutations to reject visibly.
  A rejected edit retains the user's draft. Neither optimistic UI success nor a client-local
  editing lease proves that an edit was accepted by that authority.

  `queueItemSteer` v2 binds this guarantee to `session/queue-mutate`: renderer edit/remove
  carry the observed row revision, and reorder carries the observed ID sequence. The owning
  daemon compares them under the reservation boundary and persists accepted changes before
  replying. A failed RPC never falls back to a direct CRDT write. Enqueue and ordinary sends
  retain their renderer authorship; this is not a generic write-intent protocol.

  The native submission order is:
  1. Validate the selected identity, content, editing ownership, and expected turn; establish
     exclusive reservation ownership against concurrent ordinary queue mutations.
  2. Persist the daemon-owned reservation marker.
  3. Append the frozen turn as `pending_apply` and make that history durable.
  4. Remove the selected row from the shared Queue and make its removal durable.
  5. Persist write-ahead submission evidence, then invoke `ActiveTurnSteerPort.steer` with
     the frozen turn. The port revalidates live-turn ownership before provider submission.

  Any failure to persist the reservation, history, or removal forbids provider submission.
  Removing the row before the network call is necessary but does not replace the ownership
  boundary during steps 1–4. Native recovery uses the machine-local marker plus frozen history,
  not an editable queue row as a retry token. A pre-history reservation interrupted by a crash
  must be reconciled as unsubmitted before its surviving row becomes editable again; it must not
  report a stale edit as saved or construct a turn from later queue content. Once history is
  durable, recovery can finish removal and recover the same turn without requiring the row to
  exist. A new missing-row request still fails; replay of the same reserved operation resolves
  through its marker or receipt.

  Native handoff remains non-atomic across storage and provider side effects. Existing
  machine-local markers record `reserved`, write-ahead `submitting`, provider `acknowledged`,
  locally committed `applied`, or `fallback`; their recovery must remain supported. A `reserved`
  entry that reached history, or a `fallback`, may become the exact ordinary turn after queue
  removal is durable. A surviving row from an older operation is reconciled under the same
  ownership boundary, never blindly deleted over an accepted edit. `submitting` is indeterminate
  and `acknowledged` may already have side effects, so neither is replayed after its prompt owner
  disappears. `applied` proves local handoff and recovers as accepted while ordinary crash
  handling makes an interrupted turn visible. This is the fail-closed boundary required because
  ACP supplies no idempotent submission key or delivery-query operation.

  For cancel-and-dispatch Steer, the selected queue row is the durable retry marker: append
  history first, publish `latestUserMsgId`, and remove the row only after both writes succeed.
  A retry after partial publication reuses the existing turn ID rather than duplicating history.

- Before reservation, a stale or conflicting exact Steer selection is a failed no-op. If the selected queue
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
- Editing of unreserved rows keeps its existing keyboard and focus behavior and disables
  reordering for that row until editing ends. A reserved item is operation-owned, not editable
  queue content; stale-client edit/remove/reorder requests cannot change it or succeed silently.

## Limits and review questions

The shortcut changes routing only when Queue and Steer are meaningfully distinct. An
idle session still dispatches normally, and a session without positive live prompt
activity retains the conservative queue barrier even if the inverse intent would be
Steer. Touch and pointer interactions share the same drag target; installed-app and
physical-device coverage remains separate from component tests. The provider boundary cannot
offer exactly-once recovery without protocol support: indeterminate native submissions are
reported, never silently replayed.

## Implementation evidence

The [Effect boundary decision](../.agents/notes/implemented/architecture/2026-09-14-queue-steer-effect-boundary.md)
records the implemented service/port split, v2 mutation authority, durable pre-submission removal,
capability-only availability, and verification limits. Deterministic tests cover reservation versus
second-client mutations, displaced drafts, persistence failures and marker-based recovery.
Real provider, installed-app and process-kill end-to-end verification remain outstanding.
The new availability policy applies to queued-row Steer, not composer submission routing.

- `packages/components/src/components/sessions/session-message-submit-route.ts`
- `packages/components/src/components/sessions/session-chat-input-area.tsx`
- `packages/components/src/components/sessions/message-queue/`
- `packages/components/tests/{session-message-submit-route,session-chat-input-submission,message-queue-row-editing}.test.*`
- `apps/cli/{tests/session-execution-service.test.ts,src/lib/loro/doc-user-turn.test.ts,src/session/session-queue-steer-operation-store.ts}`
- `apps/cli/src/session/{queue-steer-service,active-turn-steer-port}.ts`
- [Decision record](../.agents/notes/implemented/feature/2026-09-13-queue-steer-controls.md)

This is a draft for human review. Implementation and passing tests do not approve it.
