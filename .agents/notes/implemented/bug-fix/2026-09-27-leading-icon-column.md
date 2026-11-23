# Selector popups and sidebar nav share the leading-icon column

Status: implemented
Translation: current

[中文](2026-09-27-leading-icon-column.zh.md)

## Abstract

Two surfaces silently established a second leading grid. The desktop run-config
and permission popups opened flush to their triggers, but the popup surface adds
its own 4px `popup.inset` before the rows' item padding, so every row icon sat
~4 CSS px right of the trigger's icon. Separately, the sidebar's nav rows (New
chat / Schedules / Search) wrapped a 16px icon in a 20px `w-5` slot, pushing
every nav glyph 2px right of the sidebar's leading column that the wordmark
text, group labels, and project rows already share. Both were fixed the same
way the contract reads: the popup keeps its painted edge on the trigger's edge
while its rows reach back through `popup.inset` (`marginInline: -4px`, the same
reach `composerSurface.popupList` documents), so their leading column lands on
the trigger's own column — the shared edge plus one item pad; the nav slot
shrank to the 16px icon box (`w-4`) so it lands on the +14 edge and labels on
the shared +38 text column. The icon-only permission trigger's glyph takes a
start margin so its box also holds the shared column, and the settings account
avatar rides the nav icon column's centreline. The machine selector keeps its
original geometry by owner decision: an earlier `alignOffset` attempt was
rejected (it slid the whole painted surface off the trigger), and the owner
then exempted the machine menu from the reach-back fix as well. Playwright
measurements and two durable e2e specs pin every fixed axis, including the
popup's edge staying flush.

## The popup constraint

`@lody/ui`'s menu surface wraps its list in `popup.inset` (4px) and each item
in `itemPaddingX` (8px): a row's leading 16px icon box starts at popup-left+12.
A labeled composer trigger pads 8px, so its leading glyph starts at
trigger-left+8. `align="start"` anchors popup-left to trigger-left, which lands
the row icons 4px right of the trigger's leading edge — and, with a 14px
trigger glyph, 5px right of its centre. At 2x device pixels that is the
~8-10px offset users could see.

The machine selector keeps exactly this geometry: its popup stays flush to its
trigger and its rows keep the inset — the owner exempted it after reviewing
the alternatives, so the offset below is intentional there, not a defect.

The constraint is two-sided, which is what makes it non-obvious:

1. The popup's painted edge must stay on the trigger's edge — the popup is
   spatially the trigger's child, so moving the surface to reach the column
   unparents it (the first implementation's mistake).
2. The rows' leading column must continue the trigger's leading column.

With the inset baked into the shared surface, those two together pin the
interior: the rows' leading column sits at `edge + itemPaddingX` = +8, so the
rows' boxes must reach back through the 4px inset to the painted edge. That
reach is a product-side content box — `composerSurface.menuList` applies
`marginInline: calc(-1 * space[1])` around the `Menu.Content` children — the
same documented reach `popupList` makes inside a `Popover.Content` (its
`margin: space[1] - space[3]` pulls a list back to a popover's inset line).
The surface's own padding is untouched; `popupMenu`'s `overflowX: hidden`
clips a `Menu.Separator` inside the list to exactly the edge-to-edge line it
already draws.

```text
trigger          popup edge = trigger edge
[+8][glyph] ->   rows reach back through inset: icon box at +8
                 \-> same 16px box, same column; fills span the surface inline
```

## What the reach-back expresses

`menuList` encodes "the popup shares the trigger's content grid": leading
column at edge+8, trailing content at edge−8, and row fills spanning the
surface's full inline width (consistent with separators, which already bleed
to the popup's edges by design).

- Run-config menu (`desktop-run-config-menu.tsx`): its labeled trigger pads
  8px with a 16px leading glyph — `menuList` lands the rows' icon box on that
  same +8 box exactly.
- Permission menu: its icon-only trigger is a 28px square that centres a 16px
  box at +6 — a box the rows cannot reach without overflowing the surface. The
  trigger instead takes `iconOnlyGlyphLead` (`marginInlineStart: space[1]`):
  centred-margin-box math lands its border box at [+8, +24], the same +8
  column the labeled triggers and the menu rows hold.
- The machine menu (`DesktopMachineMenu`) uses neither: its rows keep the
  inset's +12 column and its trigger keeps the 14px Monitor — the original
  state, kept by owner decision.

## Settings account avatar

The settings nav's `listRow` places a 16px icon box at +8..+24 (centre +16)
and its label at +32. The account entry's 24px `UserAvatar` shared the box's
left edge, putting its centre 4px right. `surface.listRowAvatar` wraps the
avatar with `marginInline: -4px`: the avatar's border box overshoots the 16px
column slot by 4px on each side, its centre lands on the icon centreline, and
its margin box still ends at +24 so the label keeps the shared +32 column.
Only the desktop entry uses it; the mobile account row keeps its own geometry.

## Sidebar nav rows

`NavButton` wrapped each 16px glyph in a `h-5 w-5` (20px) slot inside a `px-2`
button in a `px-1.5` column: icon box at +16, ink at ~+18, label at +42. Every
other leading element in the sidebar uses the +14 content edge — the wordmark
span's text (+14.5 ink), the session-row leading slot (+15), project folder
icons (+14 box / +15.5 ink), and the +38 text column under them. The slot is
now `w-4`: the 16px glyph fills it, the icon box lands at +14, its centre at
+22 (exactly the session leading slot's centre), ink at +15.5-16 matching the
folder icons, and labels land on the shared +38 column. Height stays `h-5`
(20px) so the row's optical line is unchanged.

The same story pass now mounts all three nav rows: `LoroSidebar` stories
previously omitted `onSchedulesClicked`, which production always passes, so the
Schedules row was invisible in every story screenshot.

## Alternatives considered

- Slide the whole popup back by `popup.inset` via `alignOffset={-4}` (-6 for
  permission): aligns the icons but moves the painted surface off the trigger
  — the popup's edge hangs over empty canvas and it visibly unparents itself.
  Rejected on visual review; the offset belongs to the content, not the
  surface.
- Move the trigger's leading glyph to the popup's +12 column instead
  (padding it 4px deeper): keeps the menu untouched but makes the selector
  chips read 12/8 asymmetric next to sibling chips, and an icon-only 28px
  trigger cannot place its glyph at +12 without visibly cramming it against
  its own edge. Rejected; the popup must follow the trigger's column, not
  the reverse.
- Shrink `popup.inset` to 0 or item padding to 4px: changes every menu
  surface's outer gutter globally, not just selector popups. Rejected as too
  broad.
- Restyle each row's leading slot (`paddingInlineStart` on `Menu.Item`): the
  item's own padding is `@lody/ui`'s visual design, which a caller's className
  may not restyle. Rejected; the reach-back margin is the caller-owned part.
- Sidebar: shift the row's `px-2` (`pl-1.5`) instead of shrinking the slot —
  same icon box position but keeps a 20px invisible frame and lands labels at
  +40, off the shared +38 text column. Rejected; the padded slot was the
  defect.

## Verification

- `LockedAgent` story: run-config popup edge 48 = trigger edge 48, Plan/Fast
  icon boxes at +8; permission popup edge 207.5 = trigger edge 207.5, row icon
  centres at +16 = the nudged trigger glyph's centre.
- `DesktopSettingsModal` preferences story: account avatar centre 134.4 before
  vs nav icon centreline 130.4; after, avatar centre 130.4 exactly, label still
  on the +32 column.
- `LoroSidebar` default story: nav icon ink 17.5 before vs wordmark axis 14.5;
  after, icon box +14 = wordmark text edge, icon ink +15.5 matching project
  folder ink, all three labels on the +38 text column.
- `composer-submission-focus.spec.ts` asserts, for the run-config and
  permission menus, both that the popup's left edge is within 0.75px of the
  trigger's (the surface stays parented) and that every row's leading-icon
  centre is within 0.75px of the trigger glyph's — it fails on both the
  pre-fix code and the rejected `alignOffset` variant. The machine case is
  deliberately absent: it pins nothing while the selector keeps its own grid.
- `sidebar-nav-leading-column.spec.ts` pins each nav icon's box left edge to
  the wordmark's text edge and each label to axis+24 — it fails with exactly
  the 2px slot padding on the pre-fix code.

## Limits

- The contract is per-surface and explicitly partial: the machine selector is
  exempt by owner decision (its popup keeps the inset grid), and other aligned
  `Menu.Content` popovers were not audited. Applying the rule means wrapping
  rows in `menuList` and placing the trigger's leading mark on the same +8
  box — the project selector's search popover (`unified-project-selector.tsx`)
  is a known instance of the same offset still pending.
- Row hover fills in these menus now touch the popup's inline edges (same
  reach the separator already had); that is the visible cost of consuming the
  inset and is what "the popup is the trigger's child" looks like.
- Tolerance is subpixel (0.75-1px): popup anchoring lands on fractional
  coordinates that can differ below one CSS pixel across environments, and
  glyph inks inset ~2px inside their boxes by design.
- `tsgo` typecheck reports ~321 pre-existing `TS7006` errors in unrelated
  files in this worktree (identical count on the clean tree); none touch the
  changed files.
