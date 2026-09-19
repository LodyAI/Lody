# Keep narrow Session Monaco Find tooltips off their buttons

Status: implemented
Translation: current

[中文](2026-09-16-session-monaco-find-tooltip.zh.md)

## Abstract

Monaco 0.55 renders Find action labels with inline wrapping, so a long tooltip in
Lody's 320px session editor can wrap back over the button that opened it. Crossing
that button boundary makes Monaco repeatedly remove and recreate the tooltip, which
flickers and prevents reliable clicks. Lody now keeps those labels on one line only
while a Session Monaco Find widget is visible; ordinary editor hovers retain Monaco's
wrapping behavior. The existing narrow Storybook surface verifies the tooltip's
layout and the button's click behavior.

## Decision

The workaround belongs to `SessionMonacoTextViewer`, not Monaco globally. The viewer
adds a stable scope class, and its adjacent stylesheet overrides the inline
`white-space: pre-wrap` only when that scope contains a visible `.find-widget`.
This preserves `fixedOverflowWidgets: true`, which allows Monaco's other overflow
widgets to escape the editor's clipped content area, and avoids disabling tooltips
or changing wrapping for code, diagnostics, and Markdown hovers.

The selector deliberately uses the visible Find widget as the state signal. Monaco
mounts the action hover beside the editor content rather than beneath the button, so
the tooltip cannot be scoped through an ordinary descendant selector. The desktop
renderer and supported Storybook browser both provide `:has()`, allowing the fix to
remain declarative and avoid a mutation observer that would mirror Monaco lifecycle
state in application code.

## Evidence and limits

`code-collab-stories-smoke.spec.ts` drives the real
`RealtimeStatusBarNarrow` story: it focuses Monaco, opens Find, hovers the Close
action, verifies the tooltip computes to `white-space: nowrap`, verifies its rectangle
does not intersect the action rectangle, and clicks the action to close Find. This
covers the deterministic 320px regression without adding a second harness.

The workaround depends on Monaco's current `.find-widget.visible`,
`.workbench-hover-container`, and `.hover-contents` DOM classes. It is intentionally
local and should be removed when the upstream Find tooltip positioning defect is
fixed and the regression passes without it. It does not change narrow tooltips in
other Monaco consumers.
