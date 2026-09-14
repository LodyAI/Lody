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

  | Active daemon/runtime                                         | Steer behavior                                                                                                                   |
  | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
  | Exact-item protocol and acknowledged native ACP Steer         | Atomically consume the selected row as `pending_apply`, then inject it into the current prompt through `steerPrompt`.            |
  | Exact-item protocol without native ACP Steer                  | Persist and activate the selected row as the next user turn, remove it from the queue, then stop only the expected turn.         |
  | Older daemon with authoritative acknowledged native ACP Steer | Preserve the legacy native Steer path.                                                                                           |
  | Older daemon without acknowledged native ACP Steer            | Keep the established queue-head interrupt behavior; disable Steer on later rows and require a daemon update for exact selection. |

  No compatibility path may reorder a later item and then cancel. Selecting C from
  `[A, B, C]` through the exact protocol consumes C and leaves `[A, B]` in that order.

  A remote renderer must authorize the target before writing the request, using its
  authenticated authoritative machine-access snapshot and failing closed if that snapshot is
  unavailable. The request carries no requester identity: workspace Machine RPC cannot
  authenticate a caller-supplied member ID, and the target daemon must not use one for an owner
  fast path. Same-host local IPC is already the trusted local control boundary.

  For cancel-and-dispatch Steer, the selected queue row is the durable retry marker: append
  history first, publish `latestUserMsgId`, and remove the row only after both writes succeed.
  A retry after partial publication reuses the existing turn ID rather than duplicating history.

- A stale or conflicting exact Steer selection is a failed no-op. If the selected queue
  identity is missing, its editing lease is active, or the expected turn no longer owns
  execution, the daemon must not submit native Steer or stop any turn. The renderer waits for
  this acknowledgement and never removes or materializes an exact-protocol row itself.
- The daemon retains a bounded receipt for each recently consumed exact-item request, keyed by
  session, expected turn, and queue identity. A same-process retry after a lost response returns
  the recorded result without consuming or cancelling again. If consumption succeeded but
  cancellation failed, the message remains a durable follow-up and a retained-receipt retry must
  not duplicate it.
- The number and non-editing message body form the drag target for queue reordering.
  Steer, edit, and remove remain separate controls and must not begin a drag.
- Editing keeps its existing keyboard and focus behavior and disables reordering for
  that row until editing ends.

## Limits and review questions

The shortcut changes routing only when Queue and Steer are meaningfully distinct. An
idle session still dispatches normally, and a session without positive live prompt
activity retains the conservative queue barrier even if the inverse intent would be
Steer. Touch and pointer interactions share the same drag target; installed-app and
physical-device coverage remains separate from component tests.

## Implementation evidence

- `packages/components/src/components/sessions/session-message-submit-route.ts`
- `packages/components/src/components/sessions/session-chat-input-area.tsx`
- `packages/components/src/components/sessions/message-queue/`
- `packages/components/tests/{session-message-submit-route,session-chat-input-submission,message-queue-row-editing}.test.*`
- `apps/cli/{tests/session-execution-service.test.ts,src/lib/loro/doc-user-turn.test.ts}`
- [Decision record](../.agents/notes/implemented/feature/2026-09-13-queue-steer-controls.md)

This is a draft for human review. Implementation and passing tests do not approve it.
