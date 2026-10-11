# Menu rows drew glyphs at 24px: the icon slot was bypassed twice

Status: implemented
Translation: current

[中文](2026-10-03-menu-row-glyph-slots.zh.md)

## Abstract

The merge-method dropdown in the session info bar drew its selected-method
checkmark at 24px — far larger than the row's text — because `PrMergeButton`
placed a bare lucide `<Check>` inside `Menu.Item` children, where it lands on the
label's flex line at the icon library's default size. The same failure existed
at scale the other way around: ~48 `Menu.Item`/`ContextMenu.Item`/`Menubar`
callers pass a lucide icon through the `icon` prop with no size, so it renders at
24px inside the slot's fixed 16px box, and several single-select pickers
hand-drew their own checkmark inside the label instead of using
`Menu.RadioItem`. The rows now use the slots the primitive defines (`icon`,
`endContent`, `tone`, `indicator`/`indicatorSide`), the fake-checkmark pickers
became real radio rows, and the `icon` prop itself now takes the glyph
_component_ (`icon={Check}`): the box mounts it with a 100%-fill class, so a
missing size can no longer silently overflow. An element form remains for
glyphs carrying props (a `Spinner`'s `size`/`label`, a tuned `strokeWidth`)
and keeps whatever size it declares. Deliberate composite rows (avatars,
multi-column project entries) keep custom children.

## Evidence

- `Menu.Item` children are wrapped in `itemText`, the label's single flex line
  (`packages/ui/src/popup/surface.ts`, `row-label.tsx`). A lucide icon there is
  an element child, rendered at its `width`/`height` attributes — 24px — against
  a ~13px label. Screenshot evidence: the check glyph overtook the row in the PR
  info-bar merge dropdown (`pr-merge-button.tsx`).
- The `icon` prop places the glyph in `itemIcon`, a fixed 16px box, but the box
  does not constrain the child (StyleX has no descendant selector, so
  `@lody/ui`'s documented contract is that a caller's glyph "states them as
  100%"). A `<svg width="24">` flex item cannot shrink below its intrinsic size,
  so every `icon={<X />}` without a size rendered 24px centred over the 16px
  slot — ~48 sites, mostly migrated in #999 ("route sidebar context-menu icons
  through the icon box") which moved icons into `icon=` while keeping their old
  unsized elements.
- Hand-rolled selection marks duplicated `Menu.RadioItem`'s reserved indicator
  box: `mobile-account-settings` (member/admin), `acp-session-select`,
  `workdir-mode-selector`, the session header's IDE-launcher picker (twice), its
  owner picker, `organization-switcher`, and `unified-project-selector`'s
  project rows. Each drew `<Check>` manually —
  sized, so visually fine, but one missing size class away from this exact bug —
  and all of them reported `role="menuitem"` rather than `menuitemradio`.
- Roughly 30 more rows, concentrated in `session-chat-interface.tsx`'s session
  header menu, placed correctly-sized lucide icons inside children anyway —
  recreating the slot by hand with inconsistent sizes (`h-3.5`, `h-4`) and
  colours (`text-muted-foreground` or inherited label) instead of the slot's one
  box and hint colour; `tone="destructive"` was also bypassed with a
  `text-destructive` class on the delete row.

## Decision

- `pr-merge-button.tsx` renders the merge-method choice as a real
  `Menu.RadioGroup` + `Menu.RadioItem indicator="check"` — the same vocabulary
  `PrPrimaryAction` already uses for its merge-method menu.
- `MenuRowProps.icon` widened to `ReactNode | ElementType<{ className?: string }>`.
  A component value is mounted by `itemIcon` itself through `createElement` with
  `surface.itemIconGlyph` (`width/height: 100%`), which beats an svg's px
  attributes. An element value renders as given — the form for a glyph that
  carries props — and keeps its stated size. Every lucide call site moved to
  component form (`icon={Check}`); element form stays only where a glyph
  declares real props (`<Spinner size="small" label={null}/>`, tuned
  `strokeWidth`, a per-row `SidePanelTabIcon tab={panel}`), which for lucide
  still means `size="100%"`.
- The hand-rolled checkmark pickers became `Menu.RadioGroup` + `Menu.RadioItem`;
  rows whose leading slot carries an identity mark (avatar, launcher brand icon)
  use `indicatorSide="end"`, the case the API exists for.
- Plain leading-glyph rows moved their glyph to `icon=`, trailing marks
  (copy affordances, status spans, the popover info button, `Switch`) to
  `endContent`, and the destructive delete row to `tone="destructive"`.
- The primitive owns the default, not the caller: component form makes "fill
  the box" impossible to omit, because the box instantiates the glyph and
  hands it the fill class. A `cloneElement`-based backstop for bare elements
  was tried first and dropped — injecting props into a caller's element is
  guesswork (fragments, components that swallow `style`) where component form
  makes the ownership explicit instead.
- Left alone: rows that are genuinely composite (`recent-run-config-menu-group`,
  `settings-line-tabs`, `organization-switcher`'s avatar rows, the centred "+"
  create-role row, the disabled agent value row in `desktop-run-config-menu`) —
  `itemText` is designed to hold a caller's marks, and those were already sized.

## Alternatives considered

- **`cloneElement` to inject a fill style into bare icon elements**: tried and
  dropped. It mutates a caller's element behind its back, cannot help
  fragments or components that swallow `style`, and leaves the API still
  answering "who owns the size?" with "nobody". Component form answers it:
  the box owns the size because the box creates the glyph.
- **Forcing 100% on every glyph in `itemIcon`**: element form still honours a
  stated size — the box legitimately holds deliberately non-100% glyphs
  (a tuned `strokeWidth` icon, a smaller mark centred in the 16px box).
- **A global CSS rule sizing `svg` inside glyph boxes**: StyleX has no
  descendant selector and the package ships no global sheet by design.
- **Leave sized children alone**: the oversized check is the only _visibly_
  broken row, but the ~48 unsized `icon=` sites overflow the same way and every
  hand-rolled check is one missed class from it. Converging on the slot API is
  the durable fix and gives pickers correct `menuitemradio` semantics.

## Verification limits

- `vitest` `session-header-menu` + `session-info-context-actions`: 16/16 pass,
  including the radio-based launcher and merge-method pickers (selectors updated
  to `menuitemradio`). `tsgo` reports no errors in touched files (a grafted
  `node_modules` from the sibling checkout produced unrelated missing-dep noise).
- Storybook + Playwright audit: every opened menu's glyphs measured — merge-method
  split button, session header menu (IDE/owner radio submenus), project selector,
  attachment menu, workdir selector, file actions, side-panel tab bar, composer
  run config, sidebar help, workspace picker, mobile role picker, and
  session/worktree/pinned context menus all render ≤18px icons with correct
  `menuitemradio` semantics. The audit caught one residual class the first
  source sweep missed — `icon` props carrying _ternary_ icons
  (`<PinOff/>/<Pin/>`, `<Users/>/<Spinner/>/<LockKeyhole/>`, `<Pause/>/<RotateCcw/>`
  in the six sidebar/task/schedule list files, measured at 16x24 before the fix,
  16x16 after). Field/Badge/ActionCard `icon=` props outside menus were left as-is.
- `Select`/`Combobox` rows and non-menu popovers were not audited; the scan
  covered `Menu`/`ContextMenu`/`Menubar` item parts only. The fork-destination
  story's trigger does not open the menu in Storybook (pre-existing
  uncontrolled→controlled story quirk; covered by controlled-open tests).
