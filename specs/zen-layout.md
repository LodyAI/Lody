# Zen layout

Status: draft
Translation: current

[中文](zen-layout.zh.md)

On desktop, `Cmd+.` (`Ctrl+.` elsewhere) toggles sidebar visibility. If either
sidebar is visible, enter Zen and hide both without changing their saved open
preferences. Toggling again restores those preferences, including a layout with
only one sidebar open.

If all available sidebars are already closed, toggling reveals them immediately
and leaves Zen off. This explicit reveal updates the normal open preferences;
it also applies when Zen is active but the current surface has no saved open
sidebar to restore. A surface without a right panel reveals only navigation.
Right-panel tabs and selection remain intact; an empty panel shows its launcher.

Explicitly opening either sidebar leaves Zen and reveals that sidebar. Hidden
right-panel work pauses using effective visibility. Zen remains transient per
window, and the shortcut remains desktop-only and yields to editor key scopes.

## Evidence

- [State and toggle](../packages/components/src/atoms/layout-state.ts)
- [Session panel owner](../packages/components/src/components/sessions/session-detail.tsx)
- [Regression tests](../packages/components/tests/layout-state.test.ts)
- [Decision](../.agents/notes/implemented/bug-fix/2026-09-20-zen-collapsed-sidebars.md)
