# CollapsibleSection returns to form-primitives, on StyleX

Status: implemented
Translation: current

[中文](2026-09-24-form-primitives-collapsible-section.zh.md)

## Abstract

Merging `origin/main` into the flat-material branch collided with upstream's new
`PiExtensionsField`, which renders inside a shared `CollapsibleSection` from
`settings/form-primitives.tsx`. Our branch had deleted that primitive and grown a
local `Section` inside `agent-config-dialog.tsx` with the identical prop contract
(title, count, action, disabled hint, default-open). The merge moves the dialog's
StyleX ruled-row implementation into `form-primitives.tsx` as the shared
`CollapsibleSection` and rewrites `PiExtensionsField` on the `@lody/ui` stack, so
the dialog's optional-settings block and the new field share one ruled-row grammar
instead of drifting as two copies.

## Decision

`agent-config-dialog.tsx`'s local `Section` and `form-primitives.tsx`'s upstream
`CollapsibleSection` were the same component under two names. Keeping both would
have re-created exactly the drift `form-primitives` exists to prevent (its own
doc comment: a local copy per editor is how dialogs that should look like one
surface drift apart). The shared export now carries our structure — a `sectionItem`
ruled row, chevron after the header action — while `PiExtensionsField`, which
upstream wrote against Tailwind `@/ui/*` primitives that no longer exist here, was
rebuilt with `@lody/ui` Checkbox/Input/Button/Spinner and StyleX tokens.

Related merge choices, for whoever audits the merge:

- `ui/menu-styles.ts` stays ours wholesale: upstream's Tailwind exports
  (`menuSurfaceClassName`, `menuItemClassName`, …) have zero consumers once menus
  are `@lody/ui` compound parts, and the per-theme edge mix it describes lives in
  `popup.separator` now.
- `ai-gui/view.tsx` keeps our compact `PermissionRequestBlock`; only the
  `sessionId` prop threading upstream added for `PlanPanel` analytics was ported.
- `web-archive-screen.tsx` takes upstream's `windowsCaptionRowPadClass` but with
  `bottomBorder: false` — the flat header draws no bottom edge, so the caption
  centerline compensation for a border does not apply.

## Verification limits

Verified by `tsc`/`tsgo` across the workspace, the four touched-area vitest files
(103 tests), i18n lint, and the boundary guards. The visual result of the restyled
`PiExtensionsField` and the Windows caption pad on a borderless header were not
rendered-checked.
