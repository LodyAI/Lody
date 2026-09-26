# Retain the desktop sidebar across Cmd+B

Status: implemented
Translation: current

English | [中文](2026-09-26-sidebar-toggle-hitch.zh.md)

## Abstract

Cmd+B rebuilt the entire desktop sidebar after each collapse, then animated a
layout-affecting margin for 220 ms. With many Session rows and working marks, that
combined a large React mount with repeated content-pane layout. The full-width
sidebar now stays mounted, slides by transform, and changes its flex footprint
once; its eager-sync and keyboard-navigation sources stop while hidden. This preserves scroll and
row-local state across ordinary toggles, at the cost of retaining hidden UI
subscriptions and paying its initial mount even in initially collapsed windows.

## Decision

- `WebWorkspaceLayout` keeps the full-width sidebar DOM in place. A negative
  right margin releases its flex width immediately; a transform slides the
  sidebar out of the clipped root without resizing the content on every frame.
  The hidden wrapper is inert and `aria-hidden` so it cannot be navigated.
- A memoized sidebar content boundary keeps the Cmd+B visibility update out of
  `LoroAppSidebar`. A small leaf alone observes effective sidebar visibility and
  mounts/unmounts its eager-sync and keyboard-navigation reporters. Thus hidden
  sidebar prefetch and navigation callbacks stop, while foreground Session/Tasks
  sync remains independent. The filter popover closes when the sidebar hides;
  focus leaves the inert subtree or its portal but stays in another panel/modal.
- Compact desktop still uses its overlay exit transition, and settings navigation
  still removes the sidebar. The existing per-workspace scroll restoration covers
  those remounts. The working-mark viewport gate remains useful: hidden marks do
  not need to keep all tile animations active.

Keeping the old conditional mount would preserve hidden CPU but reproduce the
toggle hitch. Retaining the subtree while continuing to animate `marginLeft`
would avoid React remounts but still resize the content pane on each animation
frame. This decision addresses both costs without changing the compact overlay.

## Evidence and limits

- `tests/web-workspace-sidebar-toggle.test.tsx` verifies DOM, scroll, and input
  identity through collapse/expand, including an initially hidden sidebar, and
  checks that the eager-sync source is absent while hidden. The existing scroll
  and working-mark suites also pass.
- The production-mode React + jsdom benchmark uses 180 synthetic mixed-status
  Sessions. In one run, a retained toggle averaged 17.44 ms (69 samples), versus
  193.56 ms to remount the 45-row preview and 727.95 ms to remount all 180 rows
  (16 samples each). This is a JavaScript proxy, not Electron frame timing: it
  excludes the full `LoroAppSidebar` data path, Chromium layout/paint, and real
  Web Animations. It supports eliminating remount work, not a claim of measured
  packaged-renderer frame rate.
- Hidden full-width sidebars still receive their ordinary metadata subscriptions;
  sidebar prefetch, keyboard-navigation callbacks, and offscreen mark animations
  pause. The first render now
  pays the sidebar mount even when collapsed. Those costs should be revisited if
  startup or background CPU regresses.

This changes the ordinary-toggle behavior described in the earlier
[scroll-restoration decision](../feature/2026-09-25-compact-desktop-layout.md)
and follows the [working-mark benchmark](../feature/2026-09-24-sidebar-working-grid.md).
Current intent: [desktop-window Spec](../../../../specs/desktop-windows.md).
