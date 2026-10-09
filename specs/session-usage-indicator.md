# Composer usage indicator

Status: draft
Translation: current

[中文](session-usage-indicator.zh.md)

When a provider reports both weekly and five-hour subscription usage, a composer
without context usage shows the five-hour percentage in its compact indicator.
For example, weekly usage of 29% and five-hour usage of 11% produces an 11% indicator.

## Display contract

Valid context usage takes precedence. While context is compacting, the indicator
shows the compacting state. Subscription usage is eligible only when the caller
enables display without context, using the selected provider and model's limits.

For subscription usage, select a valid five-hour window even when its usage is 0%.
If no valid five-hour window exists, keep the existing longest-window selection.
If neither valid context nor eligible subscription usage exists, hide the
indicator unless context is compacting.

The detail popover displays all valid reported windows in descending duration
order, retaining provider-supplied labels and reset information. Compact indicator
selection is independent of that presentation order.

## Evidence

- [Indicator and detail popover](../packages/components/src/components/sessions/session-usage-popover.tsx)
- [Behavioral tests](../packages/components/tests/session-usage-popover.test.tsx)
- [Decision](../.agents/notes/implemented/bug-fix/2026-10-01-five-hour-usage-indicator.md)
