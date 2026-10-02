# Pin agent-config option popups below with search

Status: implemented
Translation: current

[中文](2026-10-02-agent-config-selector-popup-pin.zh.md)

## Abstract

In the agent configuration dialog, a select whose option list is taller than
the dialog flipped upward over the entire form: the Devin provider publishes
about a hundred models, a ~3000px list against ~330px of space above and ~250px
below the trigger, so Floating UI's `bestFit` flip picked the larger side. The
title-generation selectors (`TitleGenerationFields` in
`agent-config-dialog.tsx`) now render `OptionSelector` instead of `Select`:
lists of six or more options get a search field, every popup is pinned below
its trigger (`side="bottom"`, `avoidCollisions={false}`), and the list height
is capped at `min(60vh, 320px, --available-height)`. The deliberate trade-off:
disabling flip means a trigger at the very bottom of the scroll area gets a
short scrollable popup rather than stealing space above; search makes that
usable.

## Evidence and decision

Measured live via the accessibility tree on the running desktop: the Model
trigger sat at y=716–748, the flipped popup rendered y=390–708 (318px, the
full `--available-height` of the dialog's scroll region), and the catalog held
108 items — far more than the ~10 visible rows suggested. No side could fit the
list; flip merely chose the taller one, at the cost of covering the section it
was opened from and leaving the selected row ~300px from the pointer.

`OptionSelector` was chosen over composing `Menu` + `MenuOptionSearchList`: it
is the field-appearance searchable control already used in settings surfaces,
it portals into the nearest `[data-lody-dialog-content]` (required for
dialog-contained menus), and it virtualizes above 60 options. The search
threshold reuses `shouldOfferOptionSearch` (≥6), so short lists like Thinking
render exactly as before. This follows the same intent as the
[composers model-search decision](2026-09-30-model-search-trigger-anchor.md):
a provider may publish dozens of models and scrolling is not a way to find
them.

Rejected alternatives: keeping `Select` and only capping `maxHeight` still
flips above the trigger when the top side is taller; Base UI's
`alignItemWithTrigger` (the native-popover overlap that would put the selected
row under the pointer) computes viewport-fixed coordinates that the
translate-centred dialog container reinterprets, which is why this package
disables it; and Select's built-in typeahead alone is undiscoverable.

## Verification and limits

`tsgo --noEmit`, `oxlint`, `oxfmt --check`, `check-i18n`, and the 44 tests in
`tests/agent-config-dialog.test.tsx` pass. The
[before](2026-10-02-agent-config-selector-popup-pin.before.png) and
[after](2026-10-02-agent-config-selector-popup-pin.after.png) captures come
from the `EditLongOptionLists` story driven by Playwright — before is the same
fixture with the component change stashed, so only the control differs. Not
verified: packaged-app visuals.
`agent-role-form.tsx`'s `ValueSelect` renders the same catalogs through a bare
`Select` and has the same unfixed behaviour; it is the same fix if it regresses
visibly. `@lody/ui`'s `Select` still animates its hidden state as if the popup
always arrives from below (`hiddenSurfaceForSide` is unused there), so any
other flipped `Select` keeps a reversed entrance — untouched here.
