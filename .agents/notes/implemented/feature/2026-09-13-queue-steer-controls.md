# Queue inversion and direct manipulation

Status: implemented
Translation: current

[中文](2026-09-13-queue-steer-controls.zh.md)

## Abstract

Queue and Steer previously required changing a persistent preference, later queued
items hid Steer, and reordering started only from the small leading handle. The adopted
interaction adds a one-shot inverse submission command, exposes Steer on every row, and
uses the row's message content as its drag target. Providers without acknowledged native
steering preserve their compatibility path by moving a selected later item to the head
before cancellation; a failed reorder leaves the active turn untouched.

## Decision

- Register `session.sendWithInverseQueueBehavior` in the command system with
  `Mod+Shift+Enter` as its composer-focused default. The composer sends an explicit
  per-submission option; the routing resolver reverses the effective preference without
  writing settings or bypassing activity guards.
- Show Steer for every row whenever the session-level action is available. Native steer
  continues to materialize and remove the selected item by identity. The compatibility
  path retains one queue consumer: it reorders the selection to the head, then uses the
  existing cancel-and-promote flow.
- Make the leading number and message body a single pointer and keyboard drag activator.
  Keep action buttons outside it, and disable it while the row editor owns interaction.

## Alternatives and trade-offs

Keeping Steer on the first row would preserve the old fallback assumption but require
users to perform a separate reorder. Sending a selected compatibility item through a new
direct-dispatch path was rejected because it would duplicate the daemon's queue promotion
ownership and create a second ordering boundary. Making the complete row draggable was
also rejected because Steer, edit, and remove would become accidental drag starters.

## Verification and limits

- Routing tests cover Queue → Steer and Steer → Queue inversion while a prompt is live.
- Command registry tests cover the default binding in web and Electron environments.
- Queue component tests cover Steer on a later row and verify that message content, but
  not action buttons, belongs to the drag activator. Queue-steer tests cover later-item
  preparation, an already-first item, and a stale selection.
- Component tests use synthetic pointer state. Physical touch dragging and a full
  provider-backed steer run were not exercised.

## References

- [Message queue interaction Spec](../../../../specs/message-queue-interactions.md)
- [Queue scope](../../../../packages/components/src/components/sessions/message-queue/AGENTS.md)
- [Submission routing](../../../docs/sessions-live-status.md)
