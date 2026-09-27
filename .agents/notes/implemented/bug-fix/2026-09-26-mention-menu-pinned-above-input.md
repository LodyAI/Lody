# The composer mention menu is pinned above the input

Status: implemented
Translation: current

[中文版](2026-09-26-mention-menu-pinned-above-input.zh.md)

## Abstract

`positionAnchor="composer"` already anchors the `@`/`$`/`/` menu to the
composer's `[data-mention-frame]` and chooses its side once per open — above
unless the room below beats the room above — but the product requires the menu
to always sit above the composer. `MentionContent` now honors an explicit
`side` as a pin that skips the room pick, and `MentionTwoLevelMenu` passes
`side="top"`: the menu can no longer open below the composer, and a level
change still resizes it in place. The trade-off is intended: a composer flush
against the top of its layer clips the menu to the room above rather than
borrowing the space below.

## What changed

- `MentionContent` treats an explicit `side` prop on a composer-anchored menu
  as a pin: `placedSide` prefers it over the measured `lockedSide`, and the
  room-based pick no longer runs for that menu. The frame anchor, the
  `--mention-input-width` cap, the no-flip lock, and the `maxHeight` room cap
  are unchanged — a pinned menu still shrinks to the room on its side.
- `MentionTwoLevelMenu` passes `side="top"`. Before this, a composer whose
  frame had less than `COMPOSER_MENU_ROOM_PX` (360px) above it and more room
  below opened the menu under the composer — the reported defect. Now every
  open lands above the frame, 8px away.
- The room pick remains for composer-anchored menus without an explicit
  `side`, and the default `caret` anchor is untouched; `file-at-mention` is
  its only caller.

## Alternatives considered

- **Leave the room pick.** It still opens below whenever `above < 360px` and
  `below > above` — a composer near a layer's top, exactly the reported case.
  The pin is what the product asked for.
- **Hard-code `top` inside the composer anchor.** Equivalent for today's only
  caller, but removes the escape hatch for a future bottom-preferring surface
  and hides the product choice inside the primitive. An explicit prop at the
  call site documents it.
- **Raise `COMPOSER_MENU_ROOM_PX`.** Moving the threshold only changes which
  squeezed composers open below; no threshold can express "always".

## Verification

- New `composer placement` case in `tests/mention-two-level-menu.test.tsx`:
  with 24px of room above the frame and 612px below — a layout that opened
  below before — `side="top"` keeps the menu above, capped to 16px
  (`maxHeight` = room − gap). The existing room-pick and side-lock cases pass
  unchanged.
- `packages/components` mention vitest suites, `pnpm --filter @lody/components
typecheck`, oxlint and oxfmt clean; `pnpm run docs check` passes.
- Playwright before/after screenshots of the same fix were captured against
  the earlier `input-top` implementation; after the rebase onto
  `positionAnchor="composer"` the behavioral evidence is the jsdom cap
  assertions above. Not verified in the packaged Electron app; the mobile
  docked strip is untouched (it already docks above the composer).

## Links

- Extends the placement fix in
  [composer mention menu v2](../feature/2026-09-25-composer-mention-menu-v2.md)
  ("Design review round 2"), which introduced `positionAnchor="composer"` and
  its once-per-open room pick; this change pins the pick for the `@` menu.
