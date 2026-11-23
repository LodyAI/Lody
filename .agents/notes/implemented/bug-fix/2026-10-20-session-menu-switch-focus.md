# Session menu switch focus

Status: implemented
Translation: current

[中文](2026-10-20-session-menu-switch-focus.zh.md)

PR: [#1741](https://github.com/LodyAI/Lody/pull/1741)

## Abstract

Opening the session actions menu with the pointer highlighted Full width while
the pointer remained on the trigger. Its nested switch was tabbable, so the
menu's initial focus chose it and highlighted its containing row. The switch
now stays outside the tab order, leaving keyboard navigation with the menu row.
The switch remains directly clickable, and keyboard opening still focuses an
action; opening alone does not change the preference.

## Decision and evidence

This corrects the focus behavior of the trailing switch introduced by
[conversation full-width mode](../feature/2026-09-28-conversation-wide-mode.md).
Base UI 1.7's menu popup focuses its first tabbable descendant on pointer open;
menu rows initially have `tabIndex=-1`, but the nested switch did not. Setting
`tabIndex=-1` on that switch allows the popup surface to receive pointer-open
focus, while Base UI's existing keyboard navigation still reaches the row.
There is no shared menu autofocus override or hidden highlight styling.

The containing row keeps its keyboard activation and `closeOnClick=false`;
the switch retains its own click handler and propagation stop. This preserves
both direct pointer activation and the visible switch design without giving
the nested control a second keyboard stop.

## Verification

The owning session-header and full-width suites pass all 15 tests. Regression
coverage checks pointer opening, arrow navigation, keyboard opening, dismissal,
and preference changes through both row activation and direct switch clicks.
A real SessionHeaderMenu Storybook browser run also verifies pointer opening,
hover, keyboard opening, row activation, direct switch clicks, and Escape dismissal.
The full `pnpm check` passes, including workspace type checking, typed and Effect
lint, all configured workspace tests, i18n validation, and boundary guards.
`pnpm format` also passes.
The documentation check still reports six existing missing local Kimi/Pi
submodule links in the subagent-events note; this change adds no broken links.

The synthetic Storybook fixture omits optional Share and owner-transfer callbacks;
those production entries retain their existing conditions. The pointer remains
on the trigger when this screenshot is captured.

![Pointer-opened menu](../../assets/session-menu-switch-focus/after.png)
