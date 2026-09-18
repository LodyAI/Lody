# Show the desktop live duration in the activity status

Status: implemented
Translation: current

[中文](2026-09-18-desktop-live-duration-alignment.zh.md)

## Abstract

The desktop live-turn footer rendered elapsed time as a separate row under the thought stream.
The live activity status now carries that time itself, such as "Exploring (Worked for 35s)".
The desktop footer is not created only to display a duration. Mobile keeps its explanatory label
because its leading slot is an accessibility and gesture inset; completed-turn labels are unchanged.

## Decision

`AgentActivityRow` receives the current unfinished assistant message and samples its duration in a
leaf component. Its localized label combines the activity and elapsed time. The existing mobile
footer continues to own its separate duration label, while desktop footers appear only for actual
actions or finished-turn metadata. This corrects the visual hierarchy without changing elapsed-time
semantics or the reserved mobile action-bar width.

This corrects the earlier [desktop live-duration decision](../feature/2026-09-17-desktop-live-turn-duration.md),
which described desktop copy as `Worked for ...`.

## Verification

`packages/components/tests/assistant-turn-action-inset.test.ts` renders the real stream with fake
timers and verifies that its live activity label advances from `Exploring (Worked for 5s)` to
`Exploring (Worked for 7s)`, without a desktop footer. The same suite retains the mobile assertions
for `Worked for 5s`.
