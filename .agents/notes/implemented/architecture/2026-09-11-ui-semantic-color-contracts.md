# UI semantic colour contracts

Status: implemented
Translation: pending

## Abstract

The original `@lody/ui` palette was a coherent Button-sized StyleX foundation,
but later primitives reused its aspirational roles without a contrast contract
and relayed semantic colours through component variable groups that had to be
manually re-themed. This change restores one semantic colour layer, keeps
component variables for component-specific dimensions, and makes normal text and
required non-text indicators meet explicit WCAG contrast thresholds in both
palettes. Subtle fills remain for visual texture, but an inset edge or ring now
carries identification and keyboard focus when the fill cannot.

## Problem

The first UI package change defined semantic `colors` and `shadow` groups, then a
Button group whose colour values pointed back at those semantic variables. That
worked when the forced theme lived on the document root. A gallery later forced
two themes on subtrees and exposed that an inherited component custom property
had already resolved its semantic alias where the component group was declared.
The repair added a component `createTheme` and registered it centrally; Field and
Popup copied that relay, so every colour-bearing component group expanded the
theme registry and portal handoff.

The palette values themselves were copied from the existing Lody Light and
Vesper designs rather than selected against declared foreground/background
pairs. Chromium resolution exposed the consequences once more primitives used
the planned roles:

- light `accent` used by a 13px link reached only 3.22:1 on the page;
- `tertiaryLabel` used for placeholders and help reached 2.29:1 in light fields
  and 3.59:1 in dark fields;
- the off switch thumb and well fill differed by about 1.1:1;
- a popup's 6% highlighted fill differed from its surface by about 1.15:1 even
  though it was the row's only package-owned keyboard focus signal.

The structural gallery test proved that every token had a sample. It did not say
whether a rendered pairing was readable or identifiable.

## Decision

There remains one themeable semantic colour group. Component styles reference
`colors` and `shadow` directly, while Button, Field and Popup variable groups keep
only dimensions and other component-specific metrics. The component palette
themes and `componentPaletteThemes` registry are removed; a forced or portalled
theme now carries only the semantic colour and shadow themes it actually changes.

Semantic roles now distinguish readable hint text from tertiary non-text ink.
`label`, `secondaryLabel`, `hintLabel`, `accent` when used as link text, and
`destructive` maintain 4.5:1 against every surface rung. `tertiaryLabel`,
`controlEdge`, focus and invalid indicators maintain 3:1. The light accent and
destructive values move darker, while light secondary and hint labels move only
as far as their worst allowed surface requires; the dark hint moves lighter.

Interactive wells include a one-pixel `controlEdge` in `shadow.inset`. The switch
thumb composes that edge with its raised shadow. Popup selected and highlighted
rows retain their quiet OKLab-derived fills, but highlighted rows additionally
carry a two-pixel accent inset ring; the tick remains the redundant selected
indicator. Decorative separators and disabled controls are not promoted into
contrast-bearing roles.

`test/color-contrast.test.ts` reads the literal light and dark theme maps and
enforces the semantic contracts. This test deliberately validates palette
invariants without requiring a browser download in unit-test environments. The
same values and every remaining `color-mix(in oklab, ...)` are separately resolved
through Chromium for rendered-colour evidence.

## Alternatives

A public Neutral/Blue/Red numbered palette would make raw colour selection more
regular, but it would not state which foreground/background combinations are
valid and would give components a second, non-semantic API. It may still be a
private authoring input if the number of themes or hues grows.

Keeping component colour variables and applying their palette theme on every
component root would avoid the central registry. No current consumer overrides
those internal colour groups, however, so the extra variables and classes would
preserve machinery without a capability.

Making the popup fill itself differ by 3:1 would satisfy a numerical state delta,
but produces a much louder selected-list language. A high-contrast inset ring
keeps the quiet fill and gives keyboard focus an independent signal.

## Relationship to earlier decisions

This decision narrows the component-token and no-line portions of the historical
[token gallery note](../feature/2026-09-09-ui-token-gallery.md),
[field note](../feature/2026-09-09-ui-field-primitives.md),
[choice-controls note](../feature/2026-09-10-ui-choice-controls.md), and
[Select/Combobox note](../feature/2026-09-10-ui-select-combobox.md). Those notes
remain useful records of why each primitive was introduced; the current contract
lives in the draft [Shared UI primitives Spec](../../../../specs/ui-primitives.md)
and `packages/ui/src/tokens/RULES.md`.

## Verification

The package unit suite and typecheck cover the token surface and component
composition. A Chromium audit resolves both palettes, including the OKLab mixes,
and checks the resulting sRGB contrast pairs. The remaining low-contrast fills
are supplemental or decorative rather than the only signal. Screenshot-based
pixel regression remains out of scope, so the exact antialiased shape of the new
one-pixel edges is still a visual-review responsibility.

### Chromium evidence

Headless Chromium 148 resolved the complete colour group to these sRGB values.
The overlay values retain their alpha; every other value is opaque.

| token                 | Lody Light          | Vesper           |
| --------------------- | ------------------- | ---------------- |
| `background`          | `#ffffff`           | `#101010`        |
| `elevatedBackground`  | `#ffffff`           | `#161616`        |
| `raisedBackground`    | `#eef0f3`           | `#232323`        |
| `secondaryBackground` | `#f7f8fa`           | `#161616`        |
| `wellBackground`      | `#e8eaed`           | `#1c1c1c`        |
| `label`               | `#1a1b1e`           | `#ffffff`        |
| `secondaryLabel`      | `#5d636f`           | `#a0a0a0`        |
| `hintLabel`           | `#636874`           | `#949494`        |
| `tertiaryLabel`       | `#7e8491`           | `#737373`        |
| `controlEdge`         | `#7e8491`           | `#737373`        |
| `separator`           | `#e6e8ed`           | `#282828`        |
| `hoverFill`           | `#f0f1f4`           | `#282828`        |
| `selectedFill`        | `#e8eaef`           | `#232323`        |
| `accent`              | `#175de8`           | `#ffc799`        |
| `onAccent`            | `#ffffff`           | `#000000`        |
| `destructive`         | `#ca212c`           | `#ff8080`        |
| `onDestructive`       | `#ffffff`           | `#000000`        |
| `overlay`             | `rgba(26,27,30,.5)` | `rgba(0,0,0,.6)` |
| `gray`                | `#969ca6`           | `#6b6b6b`        |
| `gray2`               | `#acb0b9`           | `#575757`        |
| `gray3`               | `#c1c5cd`           | `#454545`        |
| `gray4`               | `#d4d7de`           | `#383838`        |
| `gray5`               | `#e6e8ed`           | `#2e2e2e`        |
| `gray6`               | `#f7f8fa`           | `#232323`        |

Chromium preserved the OKLab interpolation in computed style and rendered the
six package mixes to the following sRGB pixels:

| mix                                    | Lody Light  | Vesper      |
| -------------------------------------- | ----------- | ----------- |
| primary hover, 12% toward page         | `#313234`   | `#dedede`   |
| secondary hover, 4% toward label       | `#e4e6e9`   | `#2a2a2a`   |
| destructive hover, 10% toward label    | `#b7252c`   | `#ff8d8c`   |
| destructive tone, 10% over transparent | `#ce1d271a` | `#ff80801a` |
| popup highlight, 6% toward label       | `#e0e1e4`   | `#2e2e2e`   |
| popup selected, 3% toward label        | `#e7e9ec`   | `#282828`   |

Across all five surface rungs, the worst normal-text pair is light `accent` on
`wellBackground` at 4.62:1 and dark `hintLabel` on `raisedBackground` at
5.18:1. The worst required non-text pair is light `controlEdge` on
`wellBackground` at 3.11:1 and dark `tertiaryLabel` on `raisedBackground` at
3.31:1. The popup highlight ring reaches 4.26:1 in light and 8.98:1 in dark
against its mixed fill. The quiet popup fills and destructive-tone wash remain
below 3:1 by design because the ring, tick, or readable label carries the state.
