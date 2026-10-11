# Onboarding analytics boundaries

Status: draft
Translation: current

[中文](onboarding-analytics.zh.md)

A person choosing an agent or project in ordinary Chat Landing is using the
product, not progressing through desktop setup. Those selections and restored
defaults must not emit `onboarding/agent_config_selected`, `project_selected`,
or `project_source_ready`. These legacy landing events are retired, without
replacement traffic. Desktop setup continues to use its flow, step and operation
contract, gated by the platform telemetry capability; OSS local emits nothing.

## Completion stages

| Event                             | Meaning                                                                                                          |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `onboarding/completion_started`   | One accepted attempt to enter the product. Concurrent triggers share the attempt.                                |
| `onboarding/completion_succeeded` | Navigation succeeded, regardless of the native completion write. Duration measures product entry.                |
| `onboarding/flow_completed`       | Navigation and native completion write both succeeded. Duration measures time until both completed.              |
| `onboarding/completion_failed`    | Navigation failed; the action remains retryable.                                                                 |
| `onboarding/persistence_failed`   | Native write failed or was unavailable; navigation may still succeed. Duration measures time until that failure. |

Use distinct `flow_id` values with `flow_completed` for durable funnel conversion;
do not sum the three completion stages. Product-entry conversion uses
`completion_succeeded`. A monotonically increasing `attempt` number correlates
completion outcomes during one route mount; it resets on reload and is not a
globally unique attempt identifier. Flow identity remains session-scoped.

Native persistence and navigation run concurrently. A pending or failed write
never delays product entry. Renderer resume state is cleared only after both
succeed. Do not collapse the stage events into one: that would hide navigation
success with failed/pending persistence, or erase the attempt denominator and
entry latency. Pending persistence has no invented success or timeout outcome.

## Evidence and limits

Implementation: `packages/components/src/routes/onboarding.tsx`,
`components/onboarding/desktop-onboarding-completion.ts` and
`components/chat/chat-landing.tsx` within the same package's `src` directory.
The completion suite exercises both resolution orders and independent failure
paths. Aggregate counts alone cannot establish the contribution of these
listeners to production volumes; historical data is not corrected by this change.
