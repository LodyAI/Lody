# Queue inversion and direct manipulation

Status: implemented
Translation: current

[中文](2026-09-13-queue-steer-controls.zh.md)

## Abstract

Queue and Steer previously required changing a persistent preference, later queued
items hid Steer, and reordering started only from the small leading handle. The adopted
interaction adds a one-shot inverse submission command, exposes Steer on every row, and
uses the row's message content as its drag target. Queue order and immediate Steer remain
independent: the daemon consumes a selected queue identity directly, and a missing identity
leaves the active turn untouched.

## Decision

- Register `session.sendWithInverseQueueBehavior` in the command system with
  `Mod+Shift+Enter` as its default. The composer calls
  `sendMessage({ queueBehavior: "inverse" })`; ordinary submission passes no option. The
  command-level predicate owns composer focus, content, and send readiness so user binding
  overrides cannot remove those rules. The routing resolver reverses only this submission.
- Show Steer for every row whenever the session-level action is available. The renderer sends
  the queue `$cid` and expected active turn through `session/queue-steer`, then waits for the
  daemon result without changing queue or history locally. Under its per-session mutation and
  history-rewrite leases, the daemon revalidates the turn and consumes that exact row into
  history in one Session Doc mutation before requesting exact-turn cancellation.
- Make the leading number and message body a single pointer and keyboard drag activator.
  Keep action buttons outside it, and disable it while the row editor owns interaction.

## Alternatives and trade-offs

Keeping Steer on the first row would require users to perform an unrelated reorder first.
Reorder-then-cancel was rejected because reorder can resolve after a concurrent peer deleted
the selected row, causing Stop to target the current turn without any message to promote.
Renderer-side history materialization was rejected because the renderer cannot atomically
validate daemon turn ownership and queue identity. Making the complete row draggable was also
rejected because Steer, edit, and remove would become accidental drag starters.

## Verification and limits

- Routing tests cover Queue → Steer and Steer → Queue inversion while a prompt is live.
- Command tests cover the default binding, explicit submission option, and command-level
  composer-focus rule.
- Queue component tests cover Steer on a later row and verify that message content, but
  not action buttons, belongs to the drag activator.
- CLI service and Session Doc tests cover consuming C from `[A, B, C]` as `[A, B]`, exact-turn
  cancellation after consumption, and the missing-C failure path that never calls Stop.
- Machine RPC schema tests cover both required identities.
- Component tests use synthetic pointer state. Physical touch dragging and a full
  provider-backed steer run were not exercised.

## References

- [Message queue interaction Spec](../../../../specs/message-queue-interactions.md)
- [Queue scope](../../../../packages/components/src/components/sessions/message-queue/AGENTS.md)
- [Submission routing](../../../docs/sessions-live-status.md)
