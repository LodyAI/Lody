# Restore the project context pill's raised surface

Status: implemented
Translation: current

[中文](2026-09-27-project-context-pill-elevation.zh.md)

## Abstract

The project picker above the new-chat composer looked flat in dark mode beside
the raised machine and worktree controls. Its older Tailwind surface disabled
the dark shadow, leaving only a translucent fill. The picker and its Private
segment now use the shared raised background, sheen, and shadow tokens; the
menu and project selection behavior remain the same.

## Decision

The project picker owns a StyleX surface based on the same `@lody/ui` raised
tokens as the adjacent context controls. Hover and open states change its fill
through the semantic hover token. This follows the existing
[raised-control rule](../../../../packages/ui/src/tokens/RULES.md#edges) without changing
the product's material contract. The shared surface also covers the selected
Private segment so one project does not mix two materials. The adjacent worktree
control already followed the [session-controls StyleX decision](../simplification/2026-09-26-session-controls-stylex.md).

## Verification

Playwright captured the existing `UnifiedProjectSelector` Storybook scene before
and after the change at 800 × 400 in dark mode. The after image shows the raised
edge and top sheen that the before image lacks. Playwright also captured the
Private segment in dark mode and the ordinary project pill in light mode.
The two project-selector suites passed all 11 tests; `pnpm check` and
`pnpm run docs check` passed after installing the repository's declared ACP
submodules and local Electron binary. These fixtures verify the control surface,
not the entire authenticated desktop landing page.
