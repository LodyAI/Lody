# Close the window from the last conversation tab

Status: implemented
Translation: current
PR: [#866](https://github.com/LodyAI/Lody/pull/866)

English | [中文](2026-09-21-last-tab-window-close.zh.md)

## Abstract

Cmd/Ctrl+W closed the sole conversation tab in a newly opened Session window,
leaving a draft instead of closing the window. The close resolver now yields to
native window close when one conversation tab remains, including a child or draft.
Focused side-panel tabs retain priority, and explicit tab × keeps its existing
lifecycle behavior. The same rule applies to primary and auxiliary windows.

## Decision and evidence

The resolver accepted but ignored the visible conversation count. It now returns
an explicit window target, which SessionDetail forwards to the existing shell
close fallback without calling the shared tab mutation. This avoids special-casing
window origin and preserves native main-window hide versus auxiliary-window close.
Multiple conversation tabs still close individually.

This changes only shortcut routing; the [empty-tab deletion decision](2026-09-18-empty-tab-close-exact-delete.md)
still governs explicit tab closure. Intent: [desktop windows](../../../../specs/desktop-windows.md).
Regression cases in [the owning suite](../../../../packages/components/tests/session-tab-close-target.test.ts)
cover parent, child, draft, focused/hidden side panel, multiple tabs, and empty surfaces.

## Verification limits

Oxfmt passes for the three changed TypeScript files. The checkout has no installed
dependencies: `pnpm check`, `pnpm format`, and targeted Vitest are blocked by missing
tsgo, oxfmt, and vitest respectively. Documentation checks retain existing submodule
link failures. Native Electron interaction has not been exercised in this checkout.
