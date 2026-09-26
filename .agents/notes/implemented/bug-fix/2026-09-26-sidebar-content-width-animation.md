# Animate the content width with the retained sidebar

Status: implemented
Translation: current

English | [中文](2026-09-26-sidebar-content-width-animation.zh.md)

## Abstract

The retained-sidebar fix removed a large remount cost, but its immediate flex-space
change made the conversation pane jump to its final width while the sidebar still
slid. The full-width desktop layout now transitions the sidebar transform and its
negative right margin together, so the adjacent pane resizes throughout the same
220 ms motion; reduced-motion users get an immediate change. Animating width
requires layout work during the transition, but keeps the sidebar mounted and its
scroll and row state intact.

## Decision

- `WebWorkspaceLayout` owns both CSS transitions on the same retained wrapper.
  This keeps the sidebar position and the flex space it occupies synchronized.
  The wrapper remains inert and `aria-hidden` while closed, and sidebar-only
  sources remain paused.
- CSS transitions update layout every frame for the content pane. This is needed
  for real text and pane geometry to follow the width, rather than stretching or
  clipping a final-size image. Keeping the sidebar subtree mounted and memoized
  avoids the original session-row rebuild. Reduced motion sets the duration to
  zero. Compact overlay behavior stays separate.

The [earlier sidebar toggle decision](2026-09-26-sidebar-toggle-hitch.md) chose a
once-only flex change to avoid layout work. That was an incomplete UX trade-off:
the content-width jump was visible even though the sidebar itself moved smoothly.
This decision supersedes only that flex-motion choice, not DOM retention, source
gating, or remount scroll restoration.

## Evidence and limits

- The sidebar toggle test checks synchronized transform/margin targets, the CSS
  transition configuration, DOM identity, scroll retention, and focus behavior.
  The five related suites pass (46 tests).
- A deterministic Chromium geometry probe paused both generated CSS transitions
  at 110 ms. In a 1000 px synthetic flex row, content width moved from 720 px to
  987.34 px halfway through closing and to 1000 px at completion; reopening
  sampled 732.64 px halfway and finished at 720 px. This validates browser
  interpolation, not the full Electron renderer or a frame-time budget.
- The earlier React + jsdom toggle benchmark measures remount work only; it
  cannot establish the cost of this new layout animation. If real-world jank
  returns with large content panes, capture a packaged-renderer frame trace
  before changing the interaction again.

Current intent: [desktop-window Spec](../../../../specs/desktop-windows.md).
