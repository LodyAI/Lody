# Popup z-index belongs on the positioner, not the popup

Status: implemented
Translation: current

[中文](2026-09-23-popup-positioner-stacking.zh.md)

Related: [UI Radix call-site migration](../feature/2026-09-22-ui-radix-callsite-migration.md)

## Abstract

After the Radix-to-`@lody/ui` migration, every menu, popover, select,
combobox and tooltip painted UNDER any shell element carrying a positive
`z-index` — the E2E suite caught a composer `z-10` textarea covering the
run-config menu so completely that its rows could not be clicked. The cause
was the stacking declaration living on the popup inside the positioner: a
`position: fixed` positioner is a stacking context, so an inner `z-index`
orders siblings only and the positioner itself competes at `z-index: auto`,
below every positive rung. The fix moves each floating family's `z` token
onto its positioner style; `surface.positioner` now states the rule once for
all popup-family contents, and the tooltip chip does the same at its own
`z.tooltip` rung.

## Discovery

`pnpm e2e:smoke` (real Electron) failed `LODY-WORK-001`: Playwright resolved
the `Agent` menuitem as visible and stable, but `elementFromPoint` at its
center returned the composer textarea. The screenshot showed the menu drawn
beneath the composer's `z-10` surface.

The drawer had already learned this rule — `dialog/surface.ts` documents it
on `drawerViewport` ("the stacking belongs here, not on the panel") — but the
popup family's `z.popover` sat on `surface.popup`, the inner popup element.
The positioner is the element Base UI makes `position: fixed`; per CSS
painting order, positive `z-index` stacking contexts always paint above
`z-index: auto` positioned elements regardless of DOM order, so every `z-*`
element in the app won over every popup.

## What changed

- `popup/surface.ts` gained `surface.positioner` (`outlineStyle: none`,
  `zIndex: z.popover`) with the stacking rationale; `surface.popup` lost its
  `zIndex`.
- The five popup-family `Content` parts (`Menu`, `ContextMenu`, `Popover`,
  `Select`, `Combobox`) use `surface.positioner`; their per-file
  `{ outlineStyle: 'none' }` positioner styles were removed.
- `tooltip/chip.ts` moved `z.tooltip` from the chip to its positioner for
  the same reason.
- Dialog surfaces were already correct: backdrop and panel are themselves
  the fixed elements, and the drawer viewport states its own `z.dialog`.

## Companion fixes in the same pass

The smoke suite surfaced two more regressions with the same root theme —
migrated call sites missing a semantic they used to get for free:

- `Dialog.Content` renders a default close button; three migrated callers
  that previously used `DialogContentWithoutClose` regained
  `closeButton={false}` (settings modal, composer text preview, session file
  preview + its story).
- Base UI `RadioItem`/`CheckboxItem` default `closeOnClick={false}` (native
  checkmark-menu semantics), while every `Menu.RadioItem` call site is a
  pick-one-and-done picker that closed under Radix. The `@/ui/menu` adapter
  now defaults `MenuRadioItem`'s `closeOnClick` to `true`; checkbox rows
  keep the stay-open default.
- Base UI's Escape dismisses one menu level at a time (`closeParentOnEsc`
  is opt-in), so the work-session page object dismisses until no
  `[role="menu"]` remains rather than pressing once. The run-config menu's
  `OptionItem` deliberately keeps the menu open (`closeOnClick={false}`),
  so the parent menu legitimately outlives the submenu's Escape.

## Verification

`pnpm e2e:smoke` passes all five P0 scenarios in real Electron;
`pnpm check`, `pnpm format`, `pnpm run docs check` and the boundary guards
are green. No browser pass beyond the Electron suite ran.
