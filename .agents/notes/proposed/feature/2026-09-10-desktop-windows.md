# A simplified implementation of desktop multi-window

Status: proposed
Translation: current

[中文](2026-09-10-desktop-windows.zh.md)

## Abstract

Multi-window requires the existing main-window operations to be dispatched by origin; otherwise
navigation crosses windows, the wrong window closes, and notifications duplicate. This round reuses
the existing window factory, pages and CLI, routing every window-opening interaction through one
entry point. Background ownership uses Web Locks with automatic release, adding no leader-election
IPC, heartbeat or separate window-manager class. The implementation is on the current branch;
drag-out window creation was removed at the user's request, and hosted multi-workspace still awaits
acceptance on real hardware.

## Decision

- The main process registers product windows only and validates IPC origin. Embedded browsers are
  held by their originating window; auxiliary windows really close.
- The main window keeps its existing storage; auxiliary windows save layout and Repo cache
  independently, avoiding several snapshots overwriting the same database.
- Auxiliary-window caches are not deleted: window destruction does not prove pending writes have
  synced. An application-level cache clear closes the other windows.
- Hiding the sidebar only pauses prefetching and the sidebar subtree; it does not unmount the Task
  Index. Workspace background checks use a single mutex.
- Drag-out window creation is not implemented for now, because of native-event risk and complexity;
  the drag IPC, tokens, native event listeners and drop-point positioning are deleted, restoring the
  original mention drag.
- Only tests that verify state, release and security boundaries are added; no assertions on button
  callback arguments or source strings.
- The context-menu entry for opening a window wraps a `ContextMenuTrigger` only under Electron and
  only when the workspace has a slug, instead of turning it off with `disabled`: Radix's disabled
  trigger stamps `data-disabled` onto the menu item wrapped by `asChild`, and the shared menu styles
  render that attribute as `pointer-events-none`, which made the whole workspace-switch row
  unclickable on the web.
- The workspace picker compensates for discoverability with a bottom modifier-key hint and a context
  menu instead of more buttons. The session menu is ordered as organize, copy/share, navigate,
  archive; expanding/collapsing sub-sessions is list organization and comes first, while going to the
  source session stays in the navigation group. The infrequent open-window entry is second from last,
  and archive is last. All three sidebar lists share the same order, and the source-session menu
  fragment no longer inserts its own separator, avoiding empty groups.

## Verification and limits

- Before drag-out removal, build, typecheck, static/public-boundary and document checks passed;
  after the fix the complete `NODE_ENV=test pnpm test:ci` passed, with 3321 component and 104
  Electron tests. Eight macOS window acceptance checks passed.
- Retested before committing the removal: the complete `NODE_ENV=test pnpm check` and `pnpm format`
  passed; the build and native E2E were not rerun.
- Isolated macOS Electron acceptance verified shortcut-click and context-menu window opening, input
  focus, reload layout isolation, rejection of invalid targets, bidirectional message sync, unique
  background ownership, and continued control of an Agent after the originating window closed.
- Multi-workspace under hosted mode, Windows/Linux, and the performance benefit are not measured.
- The source-string scan test involving MainLayout is deleted; the new test only asserts that
  auxiliary-window navigation does not pollute the main window's history.
- The full check revealed that an Electron simulation without a DOM triggers a `location` read error;
  an environment check was added, and the corresponding 26 restoration and navigation tests passed
  on rerun.
- That regression came from missing coverage of the browser path: the existing workspace
  context-menu test only exercised the Electron branch. A browser case was added to the same suite,
  asserting that the workspace row carries no `data-disabled` and that clicking still switches.

Behavior is in the [Spec](../../../../specs/desktop-windows.zh.md); background on the alternatives is
in [closed PR #519](https://github.com/LodyAI/Lody/pull/519).
