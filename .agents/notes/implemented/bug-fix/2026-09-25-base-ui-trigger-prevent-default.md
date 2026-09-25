# Base UI triggers ignore `preventDefault`; use `preventBaseUIHandler`

Status: implemented
Translation: current

[中文](2026-09-25-base-ui-trigger-prevent-default.zh.md)

## Abstract

After the settings dialog trigger migrated to `@lody/ui` (Base UI), the hidden
gesture that reveals Developer mode — double-clicking "View notices" on the
About tab — stopped working: the first click opened the attributions dialog and
the second landed on its backdrop. Base UI merges user and internal trigger
handlers, and `event.preventDefault()` does not suppress the internal one; only
Base UI's own `event.preventBaseUIHandler()` opts out. The trigger now calls it
and keeps the deferred single-click open (400ms timer) so a double-click can
cancel the pending open and reveal the Developer mode row. Verified in
Storybook with Playwright: double-click reveals the row without opening the
dialog, single click still opens it.

## Decision and ownership

`OpenSourceAttributionsDialog` owns the click-timing contract: single click
schedules `setOpen(true)` after 400ms, `onDoubleClick` clears the timer and
invokes the caller's reveal callback. The new element is the
`preventBaseUIHandler()` call in `onClick`, reached through a typed cast
because Base UI attaches the method to its merged event without surfacing it on
the React `MouseEvent` type.

The alternative considered was relying on the deferred timer alone and letting
Base UI's internal handler run — but the internal handler opens the dialog on
the first click regardless of the timer, so the gesture fails exactly as
before. Calling `preventBaseUIHandler` is required for the timer to gate the
open at all.

The same change also widens the desktop run-configuration menu
(`min-w-48` → `min-w-60`, about 194px → 240px) so its rows stop clipping, and
drops the redundant `Menu.GroupLabel` from the standalone permission-mode menu
whose trigger already carries the "Permission" label.

## Evidence and validation

- [Attributions dialog trigger](../../../../packages/components/src/components/settings/open-source-attributions-dialog.tsx)
- [Run-config and permission menus](../../../../packages/components/src/components/sessions/desktop-run-config-menu.tsx)
- [About-setting reveal wiring](../../../../packages/components/src/components/settings/about-setting.tsx)

Playwright before/after capture against the Storybook stories
`sessions-composerrunconfigmenu--menu` and
`settings-desktopsettingsmodal--about-tab`: run-config menu width went from
193.58px to 240px; the permission menu lost its duplicate heading; the
double-click outcome changed from "dialog opens, row stays hidden" to "row
revealed, dialog stays closed"; a single click still opens the attributions
dialog after the delay. Scoped `tsgo` typecheck, `oxlint`, `oxfmt --check`, and
`pnpm run docs check` all pass. The double-click window is a real wall-clock
timer, so coverage relies on the Playwright capture rather than a unit test.
