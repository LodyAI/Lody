# Compact navigation owns modal focus

Status: implemented
Translation: current

English | [中文](2026-10-01-compact-navigation-modal-focus.zh.md)

PR: [#1199](https://github.com/LodyAI/Lody/pull/1199) (draft).

## Abstract

Opening navigation in a narrow desktop browser left background controls in the
keyboard focus order, so a machine picker could open above its backdrop. Compact
navigation now uses the existing Dialog boundary and makes the content scope inert.
Closing restores the opening control or the content scope, and nested overlays
receive Escape first. Synthetic Chromium coverage at 500×745 passes; production
cloud, packaged Electron and native iOS remain unverified.

## Cause and decision

At main `7d502f3d99fdcdbbdd43d032c6d903d4ed497e04`, the compact branch in
`web-workspace-layout.tsx` rendered two ordinary motion elements: a click-dismissed
scrim and the sidebar. Neither owned modal focus; the adjacent content scope stayed
interactive. The owning layout regression failed because that scope was not inert.
The current open PR list and sidebar/navigation/focus searches contained no effective
fix for this branch. Image-preview focus work in PR #1177 concerns another surface.

`CompactNavigationDialog` reuses the product Dialog adapter for focus containment,
outside presses, nested overlay ownership and popup portal containment. Its panel
mounts in the workspace layout with the existing compact width and slide motion.
The layout records the last focused content control before opening can blur it,
and makes that content scope inert only while compact navigation is visible.
Closing through Escape, backdrop or the layout action writes the existing persisted
collapse state. Widening removes the modal boundary without changing that state.

If the original control is disconnected, disabled or hidden, focus falls back to the
content scope. Base UI resolves a non-tabbable final-focus element to its first
tabbable child, so this fallback focuses the scope explicitly after trap cleanup.
A nested popup may return focus to the navigation panel; a nested Dialog restores
its own trigger. Both must keep focus inside navigation until it closes.

An inert-only fix would block the background but omit modal semantics and dismissal
ownership. A separate hand-written trap would duplicate the existing Dialog behavior.
The general `ui/sidebar` mobile drawer and native-shell behavior are outside scope.
This supplements the [compact layout decision](../feature/2026-09-25-compact-desktop-layout.md)
without changing its breakpoint or suppression policy. Intent remains a
[draft Spec](../../../../specs/desktop-windows.md).

## Verification and limits

- Owning layout, compact-state and focus-scope suites: 17 tests pass. Coverage includes
  two Escape/open cycles, persisted collapse, desktop sidebar state and widening.
- Owning sidebar Playwright suite, compact group: 4 tests pass in Chromium at 500×745,
  with reduced motion and an animated-close case. Covers Tab/Shift+Tab wrapping twice, rejected background focus,
  backdrop dismissal, background reactivation, nested popup/Dialog Escape order,
  opener restoration and removed-opener fallback.
- `pnpm format` passes. Full `pnpm check`, `pnpm check:quick` and components typecheck
  do not pass with the available dependency setup: missing package types and outdated
  installed dependencies produce errors in untouched sources. Changed files have no
  diagnostics in the components typecheck. This is not a passing full check.
- Changed-file Oxlint and `pnpm lint:i18n` pass. `pnpm run docs check` reports 45
  broken links to unavailable submodule sources, none in this change; there are no
  registered SHA-protected topics. `pnpm check:public-boundary` reports six unresolved
  workspace dependencies from uninitialized ACP submodules.
- Browser coverage uses the actual compact modal in a synthetic Storybook harness;
  layout integration is exercised separately with a synthetic sidebar in jsdom.
  No production login, real machine selection, cloud account mutation, screen reader,
  packaged Electron or native iOS was exercised.

Evidence: [layout suite](../../../../packages/components/tests/web-workspace-sidebar-toggle.test.tsx),
[browser suite](../../../../packages/components/tests/e2e/sidebar-nav-leading-column.spec.ts),
[story](../../../../packages/components/src/stories/CompactNavigationDialog.stories.tsx).
