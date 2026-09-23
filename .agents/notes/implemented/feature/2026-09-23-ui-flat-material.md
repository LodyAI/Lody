# UI flat material: one light above, crisp edges, no grime

Status: implemented
Translation: current

[中文版](2026-09-23-ui-flat-material.zh.md)

## Abstract

The owner asked for Lody's V2 interface to feel slightly physical — flat, lightly
skeuomorphic — without looking dirty. On the token board, the dirt came from two
things. In Lody Light every raised part was a mid-gray (`hsl(216 17% 94.3%)`) on
gray or white: a tab's pill sat 6/255 above its track, and the switch thumb was
gray on the accent. Every shadow was also a single soft blur, which spreads into
a gray haze. The fix is the logic of one overhead light rather than any picture
of a material. Raised parts are white and read by a 0.5px hairline, a contact
shadow and a short, negatively spread lift. Wells stay recessed. A new `sheen`
token group lays a light fall-off of a few percent over raised faces, and a press
removes it. No grain, noise, gloss or grooves were added, which follows the
brand research's standing rejection of realistic material.

## Problem

The elevation ladder was right in structure and wrong in light. A raised part
that is darker than the card it rests on reads as a stain rather than an object,
and a gray raised part under a 1px 2px blur has no edge at all: the secondary
button, the tab indicator, the switch thumb and the whole floating rung had this.
The popover shadow `0 18px 50px / 0.14` drew a gray cloud around every menu.

## Evidence from the brand research

`LodyAI/lody-ui-v2-brand-research` was consulted as a secondary input. Its
relevant findings:

- Rounds 11, 20 and 21 rejected realistic light, reflections, recessed grooves,
  grain and photographic textures ("I don't need such realistic materials").
  Physicality here therefore has to come from luminance, edge and offset.
- The product CSS it quotes already prefers "true-white elevated cards" over a
  cool off-white canvas, and warns that warm cream grounds make white dropdowns
  look pasted on. The palette hue (216–225) is kept for that reason.
- Paper tones, powder/lime accents and offset outline sheets are brand-layer only
  and were not brought into tokens.

## Decision

- `raisedBackground` in Lody Light is white. Vesper is unchanged.
- Every lifted shadow is a hairline, a contact shadow and a lift with negative
  spread. Vesper draws the hairline in light at 6–10% and keeps the inset top
  highlight. Values live in `colors.stylex.ts`. `RULES.md#material` is the rule.
- `shadow.inkEdge` gains a contact shadow, so ink and tone fills — primary,
  destructive, checked box — sit on the surface instead of being printed on it.
  The destructive button now reads this token instead of a literal.
- New `sheen.raised` / `sheen.ink` tokens, used through component tokens
  (`button.primarySheen`, `button.secondarySheen`, `field.checkedSheen`,
  `field.thumbSheen`, `disclosure.indicatorSheen`) and re-declared by `ThemeRoot`.
- Pressing drops the sheen with the lift. A secondary button keeps its hairline
  and gains a one-hair inset (`button.pressedEdge`), because on the white card
  rung it would otherwise vanish under the finger.

## Alternatives not taken

- **Noise or grain overlay.** It is the quickest route to "physical", and it is
  exactly what the owner's research rejected. At small UI sizes it also reads as
  dirt, which is the problem being fixed.
- **Off-white page ground with white cards.** This would give cards lift in the
  light palette. But it moves the page token that product surfaces and several
  rules (the neutral alert's tint, card nesting) depend on. It is a separate
  decision.
- **A lighter Vesper raised rung.** The dark tab pill (35 on 28) is still quiet.
  The top highlight and hairline carry it for now. Raising the rung changes
  `selectedFill` parity and would need its own board pass.

## Verification

- The Storybook token board (`Design System/UI Gallery`, Lody Light and Vesper)
  was captured in Chromium before and after. Buttons, tabs, switch, menus,
  dialog and card were read by eye in both palettes.
- `@lody/ui`: 276 tests pass (`NODE_ENV=development vitest run`), and
  `tsc --noEmit` is clean. The gallery test now also requires every `sheen`
  token on the board.
- Limit: product surfaces still on Tailwind tokens do not change. The board and
  migrated `@lody/ui` callers are the only verified surfaces. No human visual
  sign-off yet.
- The Storybook preview imported the deleted Radix `src/ui/tooltip`, and every
  story failed to load. It now uses `@lody/ui/tooltip`'s `Tooltip.Provider`.

Related: [token gallery](2026-09-09-ui-token-gallery.md),
[call-site migration](2026-09-22-ui-radix-callsite-migration.md).
