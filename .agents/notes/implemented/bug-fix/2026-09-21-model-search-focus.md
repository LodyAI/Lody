# Preserve composer model and project search focus

Status: implemented
Translation: current

[中文](2026-09-21-model-search-focus.zh.md)

## Abstract

Desktop model and project menus could lose search focus to Radix menu items,
so typing missed the search field. The model submenu trigger now preserves its
own search focus during pointer interaction, and the project picker uses the
shared menu search input to claim typing after a row takes focus. Search
initialization belongs to the mounted input rather than a pre-mount open callback.
Browser regressions cover opening, pointer movement, reopening, filtering, and
keyboard navigation; the shared field leaves touch activation explicit.

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

The project picker used a plain `Input` and scheduled focus from `onOpenChange`,
before the field was mounted. Its key handler only protected an already-focused
input: hovering a project row moved focus away, and subsequent typing drove
Radix typeahead. Reusing `DropdownMenuSearchInput` gives the picker mount-owned
autofocus, typing recovery from rows, and arrow navigation without another focus
listener. Project matching, recency, selection, and the render cap remain owned
by `UnifiedProjectSelectorView`.

## Evidence

The existing Playwright
[composer focus suite](../../../../packages/components/tests/e2e/composer-submission-focus.spec.ts)
uses the real `ComposerRunConfigMenu/ModelSearch` and
`UnifiedProjectSelector/SelectedPrivate` stories. Before the fix, continued
movement over Model failed the focus assertion in both mouse cases while keyboard
opening passed. After the fix, all three cases passed, including reopening and
typing `54m` without clicking the field. The suite also covers ArrowDown into the
filtered result and touch activation. Both project cases failed before the fix
when typing after hovering a row; all six browser cases now pass. Project tests
also verify that reopening resets the query and immediate typing filters the list.
These are renderer browser tests, not a
full Electron/CLI journey; no model service or captured conversation is used.

PR: [#864](https://github.com/LodyAI/Lody/pull/864).
