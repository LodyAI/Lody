# Preserve model search focus while opening its submenu

Status: implemented
Translation: current

[中文](2026-09-21-model-search-focus.zh.md)

## Abstract

The desktop model search initially received focus, but subsequent mouse movement
or a click over its parent Model row returned focus to that row. Typing then
missed the search field. The shared submenu trigger now directs precise-pointer
interaction to its own open search field instead of allowing Radix to refocus
the trigger. Browser regression coverage exercises opening, continued pointer
movement, reopening, filtering, and keyboard navigation; touch keeps explicit
field activation.

## Cause and decision

`DropdownMenuSearchInput` already focuses after mounting on a fine-pointer device.
Radix's submenu trigger focuses itself on every mouse move and click. Immediate
hover opening lets the search mount before the pointer has finished moving over
the trigger, so changing the mount delay would only move the race.

The trigger identifies its content through `aria-controls` and only takes over
when that content owns a `DropdownMenuSearchInput`. Disabled triggers, prevented
caller events, touch devices, and ordinary submenus retain their existing behavior.
This restores the existing search intent without changing model selection or
provider contracts. The [run-config explanation](../../../docs/sessions-run-config.md)
owns the implementation overview; the earlier
[submenu geometry decision](2026-09-15-menu-submenu-gap-and-viewport-margin.md)
remains independent.

## Evidence

The existing Playwright
[composer focus suite](../../../../packages/components/tests/e2e/composer-submission-focus.spec.ts)
uses the real `ComposerRunConfigMenu/ModelSearch` story. Before the fix, continued
movement over Model failed the focus assertion in both mouse cases while keyboard
opening passed. After the fix, all three cases passed, including reopening and
typing `54m` without clicking the field. The suite also covers ArrowDown into the
filtered result and touch activation. These are renderer browser tests, not a
full Electron/CLI journey; no model service or captured conversation is used.
