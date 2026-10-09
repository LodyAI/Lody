# Restore conversation scrolling over inline Mermaid

Status: implemented
Translation: current

[中文](2026-10-09-mermaid-scroll-chaining.zh.md)

## Abstract

Hovering an inline Mermaid diagram trapped conversation scrolling even though
its wheel handler left ordinary wheel events untouched. The bounded preview's
CSS contained native scrolling at its edges, including diagrams with no vertical
overflow. Restoring automatic scroll chaining keeps large diagrams scrollable
and lets the conversation scroll beyond their edges. Four isolated Chrome
regression cases cover fitting and tall diagrams in both activation states.

## Decision and evidence

This repairs the existing [inline view contract](../../../../specs/mermaid-inline-view.md),
without changing activation, pinch zoom, retained transforms, or viewer behavior.
The [earlier wheel fix](2026-09-09-mermaid-diagram-gestures.md) addressed event
cancellation; the remaining defect was `overscroll-behavior: contain` on the
preview's scroll container. Changing it to `auto` preserves the height bound and
internal overflow while allowing native scrolling to reach the ancestor.
Forwarding wheel events or manually scrolling the conversation would duplicate
browser behavior and is unnecessary.

The existing browser scroll suite now loads the actual stylesheet into synthetic
renderer-shaped diagram DOM. It checks ancestor scroll offsets at both edges,
and that a tall diagram scrolls internally before reaching an edge. jsdom event
dispatch cannot detect CSS scroll chaining, so its existing wheel tests alone
were insufficient.

## Verification and limits

The four cases pass in headless Chrome using cached Playwright and an isolated
temporary configuration, without Storybook or external requests. All four fail
against the original stylesheet, confirming they detect the reported defect. Full `pnpm check`
and `pnpm format` are blocked by missing workspace dependencies (`tsgo` and
`oxfmt`). The repository docs check retains unrelated broken links from absent
ACP submodules. Full application and touch-device verification remain unexecuted.
