# Preserve reading gaps inside assistant work

Status: implemented
Translation: current
PR: [#1252](https://github.com/LodyAI/Lody/pull/1252)

[中文](2026-10-04-conversation-progress-spacing.zh.md)

## Abstract

Long progress paragraphs and tool summaries crowded together because expanded
completed work forced every child into a zero-padding process row. Progress prose
and group headers now retain a 6px conversation prose gap, while individual
tool details keep their compact pitch. Reading leading increases
from 22px to 24px at 14px text. Expanded conversations use more vertical space in
exchange for clearer separation between explanations and tool activity.

## Decision and evidence

This partially replaces the density choices in the [previous rhythm decision](../simplification/2026-10-03-conversation-rhythm-stylex.md).
The [rhythm Spec](../../../../specs/conversation-rhythm.md) owns the current formulas.
The virtual-row renderer chooses spacing by content kind even inside worked groups;
`isWorkedDetail` continues to own tone and grouping, not prose spacing. The first
assistant row still has no extra top gap. Response and next-round reserves retain
their existing ownership and values.

A 12px gap on both sides of each summary separated related work too much; the
final 6px gap keeps summaries close to their surrounding prose.
Increasing only reading leading would leave zero separation around progress text.
The synthetic progress stories therefore alternate wrapped Chinese/mixed-script
paragraphs with tool summaries, in completed and streaming states. No captured
conversation is used. Browser assertions measure both directions of the 6px gap
and verify that expanding a tool summary adds no gap before its first detail.

## Verification and limits

Validation uses an isolated copy with dependencies and current tracked source.
All 20 interface typography browser tests pass, covering reading leading, all
five sizes, light/dark and narrow layouts, folding, action access and theme overrides.
The virtual-row identity and turn-block suites pass all 26 tests. Components type
checking and formatting of changed TypeScript files pass. Before/after screenshots
of the same expanded synthetic story were visually inspected. The
[Playwright comparison](../../assets/conversation-progress-spacing/before-vs-after.png)
uses identical 1120 × 1200 viewports, 14px text, dark theme and expanded work.
Root checks in the primary worktree remain blocked by missing dependencies;
document checks report the same 62 pre-existing errors, with no new errors or
SHA-protected topics.
The Spec remains draft; implementation does not imply human approval.

## Collapsed user messages

The larger reading leading also applies to user text. A long user message
collapses behind "Show more" under a height cap. That cap was a fixed 160px,
chosen when user text used 20px lines (exactly 8 lines). At 24px it held 6.67
line boxes, so the clip edge ran through the glyphs of the seventh row. The cap
is now a whole number of the user text's own line boxes: seven, which is the
closest to the previous visual height. A `mask-image` fades the last visible
row, so the collapsed bubble reads as continuing without a matched overlay
colour. Expanding or searching removes both the cap and the mask. Any future
leading change keeps the clip between rows because the cap is derived from the
same token.

Browser assertions cover five theme, width and size combinations. In each, no
visible row extends past the clip edge, the cap equals seven line boxes, the
fade starts one line box above the edge, and expanding removes the mask. On the
previous 160px cap, all five fail because one row crosses the edge by 2–4px.
Before/after screenshots from the isolated desktop E2E harness are in
[#1293](https://github.com/LodyAI/Lody/pull/1293).
