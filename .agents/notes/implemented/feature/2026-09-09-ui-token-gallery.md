# UI token gallery

Status: implemented
Translation: pending

## Abstract

`@lody/ui` shipped tokens and a Button with no place to see them: the design
reference for PR [#305](https://github.com/LodyAI/Lody/pull/305) was an external
Claude artifact that nobody in the repository can open, so the visual system had
no in-repo authority. This note records rebuilding that board as
`packages/ui/src/gallery`, a StyleX component that renders every semantic token,
elevation rung, control size, type step and Button state in both palettes and
reads each sample's value back off the rendered node, hosted as a Storybook story
in `@lody/components`. Building it exposed a real defect: component tokens that
point at semantic colours are declared once at the document root, so a palette
forced on a subtree left buttons carrying the root palette, which the board made
visible as light secondary buttons inside the Vesper panel. The fix re-declares
those tokens in a palette theme applied with each forced palette. Coverage of the
board is asserted from the token objects themselves, so a token without a sample
fails the package's tests; nothing asserts that a sample looks right.

## Problem

The token set landed with its Button, but the only picture of it lived at
`https://claude.ai/code/artifact/8a512704-cd50-4b69-805b-c3277f9d6405`, linked
from the PR description. That URL needs an authenticated Claude session, is not
versioned with the tokens, and cannot be reviewed in a diff. The PR's own note
listed "a token gallery" as a later step, and the takeover note closed with the
observation that no story or screenshot asserts the rendered look.

Without a board, a person choosing between `raisedBackground` and
`secondaryBackground`, or between `tone="destructive"` and
`variant="destructive"`, has to read `colors.stylex.ts` and `button.tsx` and
imagine the result in two palettes.

## Decision

Rebuild the board in the repository rather than fetch the artifact. `@lody/ui`
owns the gallery because it owns the tokens; `@lody/components` only hosts it,
through a `Design System / UI Gallery` story on the existing Storybook, which
already compiles this package's StyleX with the shared options. No new dev
server, package or dependency was added.

Two properties keep the board honest:

- Samples are rendered from the tokens. A swatch's fill is `colors.<name>`, a
  radius chip's corner is `radius.<name>`, a control bar's height is
  `control.<name>`; nothing in the board restates a palette value.
- The value printed under each sample is read back with `getComputedStyle` on the
  rendered node, so the board reports what the token produced in that palette. A
  token whose value changes needs no edit here. The read happens once per mount,
  which is sufficient because every sample is mounted under a fixed palette.

Each section renders its samples once per palette in labelled panels, side by
side, so the two values of a token are compared in place rather than by toggling
a theme. `palettes` selects `both`, one palette, or the ambient theme.

Coverage is asserted structurally: the test walks the keys of the token objects
and fails when a name has no entry on the board. That turns "the gallery is
current" into a test rather than a habit, and is why the AGENTS.md rule asking
for a board entry with each new token can be enforced.

## Discovered defect: component tokens froze at the document root

The first render of the board showed the Vesper panel with white secondary and
icon buttons. The cause is CSS custom property resolution, not StyleX: the button
token group is declared once at `:root` with values such as
`--button-secondaryBackground: var(--colors-raisedBackground)`. A custom property
is substituted at the element where it is declared, and the resolved value is
what descendants inherit. A palette applied to a subtree redefines
`--colors-raisedBackground` on that subtree, but `--button-secondaryBackground`
had already resolved against the root palette.

Production did not show this because `ThemeProvider` puts the forced classes on
`<html>`, the same element the tokens are declared on. `ThemeRoot` — exported and
documented as applying a theme to a subtree — was therefore broken for every
component token that derives from a colour, and the gallery is its first
consumer.

The fix adds `buttonPaletteTheme`, a `createTheme` over the same group that
re-declares only the colour-valued tokens as the same semantic references.
`ThemeRoot` and `forcedThemeClassNames` apply it with each palette, so the
declarations sit on the element that carries the palette and resolve against it.
One theme serves both palettes because the overrides are references, not values.

Alternatives considered:

- Reference `colors.*` directly from `button.tsx` and keep only dimensions in the
  component token file. Fewer moving parts, but it deletes the button's colour
  token surface and contradicts the package rule that component tokens live
  beside the component.
- Write literal palette values into per-palette button themes. This duplicates
  the palettes in a second place, which is the drift the token file exists to
  prevent.
- Leave the defect and render the board in one palette at a time. This gives up
  the side-by-side comparison that motivates the board, and leaves a documented
  guarantee of `ThemeRoot` broken.

## Verification

`pnpm --filter @lody/ui test` covers the board's token coverage, both palettes
being rendered, every Button variant and size appearing, and a single-palette
render carrying no classes of the other palette. `pnpm --filter @lody/ui
typecheck` passes.

The board was read in Chromium through Storybook at 1400px, in slices down the
full scroll height, before and after the palette-theme fix; the Vesper panel's
secondary, icon and pill buttons change from light to the dark palette between
the two. Measured values render as expected (for example `rgb(255, 255, 255)`
against `background` in Lody Light and `rgb(16, 16, 16)` in Vesper, `5px` for
`radius.mini`, `28px` for `control.small`). The console reported no errors.

Limits: no test asserts a rendered appearance, so a sample that renders in the
wrong place or with the wrong emphasis is caught only by a person reading the
board. The measured values are read once per mount, so a palette changed after
mount without remounting would show stale values; `palettes="ambient"` is the
only mode where that is reachable. Only Chromium was checked, which is also the
only engine that draws `corner-shape: squircle`. `pnpm check` was not run to
completion for the whole repository in this session.

## Follow-up, 2026-09-14: the board's own panel is a rung

Three separate reports of "this component looks wrong" turned out to be one
board defect, and none of them were the component.

`PaletteSplit`'s panel is `elevatedBackground` under `shadow.card` — **it is the
card rung**. So every sample that *is* a rung was being shown on itself. In the
light palette the card rung and the page are both white and the shadow still
separates them, which is why this survived review; in the dark palette
`elevatedBackground` is `rgb(22,22,22)` and the panel is the same value, so a
`Card` had no background step at all and the only thing left was a shadow
already spent on the panel behind it. The report was "did you change something
about `background`? the contrast is terrible" — nothing had changed; the board
had never shown it.

It reached further than the Card:

- The **elevation ladder** stood on `secondaryBackground`, and in the dark
  palette that is `rgb(22,22,22)` as well — the same value as
  `elevatedBackground`. A ladder of surfaces could not show its own `card` or
  `modal` step. It stands on the page rung now, where exactly one chip matches
  its ground: `page`, which is supposed to. A card that cannot be told from what
  it sits on is a lie; a page that cannot be is the truth.
- An **Alert** takes the card rung by the ladder's own table, so the four tones
  were four tints of the panel they sat on. They sit on the page now.
- The **modal stand-in** was painting two of the three things its own caption
  says the rung states — the background and the shadow, but not the overlay —
  on a surface that cancelled the first. It stands on the page under
  `colors.overlay`, painted as a `background-image` because `dialogReplica`
  needs that box to stay the containing block for its close button.

**The rule this leaves:** a sample that *is* a rung has to be given a different
rung to stand on. The badge section already did this — three explicit strips,
`on a page` / `on a card` / `on a menu` — and that was read as a badge-specific
flourish rather than as the general case it is.

Two things this does not fix, recorded rather than hidden. The card-to-page step
in the dark palette is `rgb(22,22,22)` against `rgb(16,16,16)`, six values of
255; it reads because the shadow carries most of the work, and moving it means
moving `elevatedBackground`, which every card, alert, dialog and panel in the
product reads. And the board's own panel still sits on the board's own page fill
with only its shadow between them — the same relationship a card has to a page,
which is the thing the panel is.

## Follow-ups

Primitives that migrate into `@lody/ui` after the Button add their states to the
board in the same change. If a second component token group with colour values
appears, the palette theme it needs is part of that group, and `ThemeRoot`
applies it the same way; a general mechanism is worth considering only once more
than one exists.
