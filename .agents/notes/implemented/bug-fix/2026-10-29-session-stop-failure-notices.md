# Make Stop control failures visible in the conversation

Status: implemented
Translation: current

[中文](2026-10-29-session-stop-failure-notices.zh.md)

## Abstract

Stop could retain execution ownership after an unsuccessful cancellation while
showing no explanation beyond daemon logs. The execution service now emits durable
conversation warnings when provider cancellation fails, the existing five-second
drain expires, or forced termination fails. Notices show the original diagnostic
alongside localized guidance and are deduplicated per assistant turn and phase.
Reporting never blocks cleanup or permits reuse of unresolved execution. These
warnings complement the existing blocked-release recovery and dead-turn repair.

## Responsibility and behavior

The [release owner](2026-10-17-turn-release-survives-failure-handling.md) already
exposes unconfirmed cleanup as `releaseBlocked` and lets waiting input request
recovery. The [dead-turn repair](2026-10-26-dead-turns-and-orphaned-queue.md) already
makes ownerless unfinished replies stoppable after restart. Neither decision
requires the provider-cancel and drain failures to remain log-only. Their
execution and recovery guarantees are unchanged by these durable diagnostics.

- **Trigger:** a provider-cancel rejection, the current five-second drain expiring,
  or failed termination during cancellation. Normal cancellation produces no notice.
  Early renderer RPC timeout remains inconclusive because durable Stop delivery
  can still succeed.
- **Owner:** `SessionExecutionService` decides whether the current assistant needs
  a diagnostic and suppresses each repeated phase. A released runtime cannot emit
  a late cancellation-rejection warning. MessageHandler persists through the
  existing gated Session backend writer.
- **Cancellation and handoff:** warning persistence runs independently of raw-work
  drain and termination. Slow or rejected reporting cannot delay escalation, block
  a completed turn's release, or change pending-input policy. The warning itself
  does not finish the assistant or mark the user turn failed.
- **Failure recovery:** the conversation shows what failed and the raw error.
  Drain expiry says forced termination is being attempted; failed termination
  recommends restarting the owning machine's background service. This does not
  add a retry control, guarantee termination, or authorize replay of uncertain work.

## Storage and presentation

Reuse `agent_warning` with its existing `message` and `source` fields. The sources
`sessionCancelFailed`, `sessionStopTimedOut`, and `sessionTerminationFailed` select
localized titles and guidance; older clients retain a readable generic warning.
Each notice uses the assistant id and phase in its identity. Stop diagnostics bypass
global message-text deduplication so an identical error on a later turn is visible.
The existing render-time notice folding and always-open banner display the result.

A `chat_failed` notice would describe the whole chat as failed while its producer
may still be running. Returning only a failed Stop RPC would lose late cleanup
failure and would not cover durable metadata delivery. A new status protocol or
timer is unnecessary for exposing these existing failure boundaries.

The Effect migration assessment keeps this change within current integration:
Session cancellation, ACP transport and document/history ownership still have
unfinished Promise dependencies in the lifecycle ledger. Migrating that chain
would expand this diagnostic fix; no native-unit completion or ledger change is
claimed. The owned Effect cancellation finalizer composes its error observation
with `Effect.tapError`; the existing drain deadline is retained.

## Verification and limits

Execution regressions use the real AgentClient with controlled ACP transport,
explicit readiness/completion signals and fake timers. They assert the diagnostic
phase and raw error, preserved unfinished history and ownership, absence of a
second provider prompt while cleanup is unresolved, one report per repeated Stop
phase, ignored late cancellation rejection, and eventual release even while a
notice write is pending or rejected. MessageHandler coverage crosses the actual
SessionDocument writer and verifies that warnings persist without completing the
assistant and that later turns retain identical error text. Renderer coverage uses
the real system-message row and checks visible title, guidance and full raw error.

The cases live in
[`session-execution-service.test.ts`](../../../../apps/cli/tests/session-execution-service.test.ts),
[`message-handler-turn-history-gate.test.ts`](../../../../apps/cli/tests/message-handler-turn-history-gate.test.ts)
and [`chat-failed-detail-dialog.test.tsx`](../../../../packages/components/tests/chat-failed-detail-dialog.test.tsx).
The three states have real-component
[Storybook examples](../../../../packages/components/src/stories/AgentWarningNotice.stories.tsx).

Warning persistence is best effort: storage failure can still leave the diagnostic
only in the daemon log. Real OS process killing and a full desktop restart were
not part of this diagnostic change's verification.
