# Queue inversion and direct manipulation

Status: implemented
Translation: current

[中文](2026-09-13-queue-steer-controls.zh.md)

## Abstract

Queue and Steer previously required changing a persistent preference, later queued
items hid Steer, and reordering started only from the small leading handle. The adopted
interaction adds a one-shot inverse submission command, exposes Steer on every row when the
daemon can identify that row safely, and uses the row's message content as its drag target.
Queue order and immediate Steer remain independent. Exact-item steering is version-negotiated,
preserves native ACP steering, respects editing leases, and never stops the active turn when
the selected identity is missing.

## Decision

- Register `session.sendWithInverseQueueBehavior` in the command system with
  `Mod+Shift+Enter` as its default. The composer calls
  `sendMessage({ queueBehavior: "inverse" })`; ordinary submission passes no option. The
  command-level predicate owns composer focus, content, and send readiness so user binding
  overrides cannot remove those rules. The routing resolver reverses only this submission.
- Advertise `queueItemSteer` in `MachineMeta.protocolCapabilities`. The renderer calls
  `session/queue-steer` only when that version is present; missing means unsupported. The
  request names the queue `$cid` and expected active turn, and the renderer waits for the
  result without changing queue or history locally.
- Authorize a remote request before appending it, using the renderer's authenticated,
  Convex-authoritative visible-machine snapshot. Fail closed while that snapshot is unavailable
  or excludes the target. The RPC carries no requester identity because a target daemon cannot
  authenticate an identity claimed by a workspace stream writer. Same-host local IPC remains the
  trusted local control path.
- Let the daemon choose the execution mechanism after validating both identities and the
  target's editing lease. With acknowledged native ACP Steer, it atomically consumes the row
  as `pending_apply` and enters the existing `steerPrompt` handoff. Without native Steer, it
  writes the row as an ordinary pending turn, publishes its activation pointer, removes the
  queue row only after both writes succeed, then cancels only the expected active turn. A
  partial publication retains the row as a retry marker and reuses the existing history ID.
- Retain mixed-version behavior without reintroducing reorder-then-cancel. An older daemon
  with an authoritative acknowledged-Steer capability uses the legacy native path. Other
  older daemons retain only the established queue-head interrupt; later-row Steer controls
  are disabled with an upgrade explanation.
- Keep a bounded daemon receipt for each completed exact operation key. A response-loss retry
  returns the same result instead of consuming or cancelling twice. A cancellation failure
  after consumption leaves one durable follow-up and is also returned idempotently.
- Make the leading number and message body a single pointer and keyboard drag activator.
  Keep action buttons outside it, and disable it while the row editor owns interaction.

## Alternatives and trade-offs

Keeping Steer on the first row would require users to perform an unrelated reorder first.
Reorder-then-cancel was rejected because reorder can resolve after a concurrent peer deleted
the selected row, causing Stop to target the current turn without any message to promote.
Renderer-side history materialization remains only for old-daemon native compatibility; it
cannot provide exact-item atomicity. Removing native steering was rejected because
`steerPrompt` injects into the current prompt, while cancel-and-dispatch starts a new turn.
Making the complete row draggable was also rejected because Steer, edit, and remove would
become accidental drag starters.

## Verification and limits

- Routing tests cover Queue → Steer and Steer → Queue inversion while a prompt is live.
- Command tests cover the default binding, explicit submission option, and command-level
  composer-focus rule.
- Queue component tests cover later-row Steer, old-daemon head-only disabling, authoritative
  legacy native selection, and the drag activator boundary.
- CLI service and Session Doc tests cover exact C consumption, native `steerPrompt`, exact
  cancellation, missing and active-edit rejection, activation-publication failure,
  cancellation failure, and response-loss retries.
- Machine RPC and protocol-capability tests cover the queue/turn identities, rejection of a
  requester identity claim, source authorization, and mixed-version negotiation.
- Component tests use synthetic pointer state. Physical touch dragging and a full
  provider-backed steer run were not exercised.

## References

- [Message queue interaction Spec](../../../../specs/message-queue-interactions.md)
- [Queue scope](../../../../packages/components/src/components/sessions/message-queue/AGENTS.md)
- [Submission routing](../../../docs/sessions-live-status.md)
