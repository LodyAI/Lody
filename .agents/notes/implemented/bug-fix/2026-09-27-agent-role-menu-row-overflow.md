# Agent Role menu rows keep their height

Status: implemented
Translation: current

[中文](2026-09-27-agent-role-menu-row-overflow.zh.md)

## Abstract

The Agent Role mention menu let its vertical flex container shrink rows back to
the 28px minimum when a disabled reason wrapped, so the reason overflowed into
the next Role and made the catalog look stacked. The shared mention row now
refuses flex shrinking, allowing its content to determine its height while the
capped list provides scrolling. This preserves the full reason text and applies
to every mention row, including narrow and mobile surfaces; runtime verification
is limited until the workspace dependencies are installed.

## Decision

`MentionItem` rows are children of the capped `styles.list` column. The row had
`min-height: control.small` but retained the default `flex-shrink: 1`. A wrapped
subtitle therefore overflowed after the flex algorithm compressed the row to its
minimum. `mention-surface.ts` now sets `flexShrink: 0`, so the list scrolls
additional rows instead of compressing their content.

Truncating the availability reason would avoid the overlap by hiding the
diagnostic the disabled row exists to provide. A fixed row height would have the
same failure for other wrapped content, so both alternatives were rejected.

## Evidence and verification

- The report screenshot shows every Role row carrying a two-line unavailable
  reason, with later names entering the preceding reason's line.
- The affected layout is the shared `MentionItem` surface used by the desktop
  popup and docked mobile menu.
- The existing `AgentRoleAvailabilityNarrow` Storybook story exercises wrapped
  disabled reasons and remains the visual regression fixture.
- The first CI run showed that this Vitest JSDOM setup does not load generated
  StyleX CSS: `getComputedStyle(row).flexShrink` was empty. That assertion was
  removed because it measured the test setup, not row layout; the existing
  Storybook story remains the visual regression fixture.
- `node scripts/docs/main.mjs status` was run before the edit. Full package tests
  were not run because dependencies were not installed in this checkout.
- Pull request: [#1032](https://github.com/LodyAI/Lody/pull/1032).
