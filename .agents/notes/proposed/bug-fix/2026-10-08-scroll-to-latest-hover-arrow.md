# Reveal the scroll-to-latest action during live work

Status: proposed
Translation: current

[中文](2026-10-08-scroll-to-latest-hover-arrow.zh.md)

## Abstract

The working spinner communicates incoming output but obscures the scroll control's
navigation action. Hover or keyboard focus now reveals the down arrow, restoring
the spinner when interaction ends. This preserves the existing working-state
signal and scroll action; browser acceptance remains pending.

## Decision and evidence

This extends the [working-state decision](../../implemented/bug-fix/2026-09-27-scroll-to-latest-working-state.md)
and the draft [scroll intent](../../../../specs/conversation-scroll.md). The owner
remains `SessionChatStreamView`: StyleX ancestor selectors switch the two icons,
without additional presence state or changes to the scroll engine. Permission
waits and idle states retain their ordinary arrow.

The existing `agent-activity-row.test.tsx` suite checks that the running control
keeps both icons available and clicking returns to following. Component tests do
not prove hover/focus rendering; real-browser acceptance remains outstanding.
