# Token usage rules

Construction: depth without lines. No border token exists. Surfaces separate by
luminance step and shadow; controls are wells (sunken) or raised.

## Elevation ladder

One rung per component. The rung fixes background and shadow together.

| rung     | background            | shadow                     | examples                                                                          |
| -------- | --------------------- | -------------------------- | --------------------------------------------------------------------------------- |
| well     | `wellBackground`      | `shadow.inset`             | input, select, textarea, switch off, checkbox off, segmented track, selected item |
| page     | `background`          | none                       | app ground                                                                        |
| region   | `secondaryBackground` | none                       | sidebar, footer band, hover on a card                                             |
| card     | `elevatedBackground`  | `shadow.card`              | card, panel, composer                                                             |
| floating | `raisedBackground`    | `shadow.popover`           | menu, popover, select list; tooltip is `label` with `shadow.medium`               |
| modal    | `elevatedBackground`  | `shadow.large` + `overlay` | dialog, sheet                                                                     |

## Edges

- `separator`: next row. Dividers between list and table rows only. Never
  around a surface, never under a header.
- well: you can put something here. `wellBackground` + `shadow.inset`.
- raised: you can press this. `raisedBackground` + `shadow.raised`. Primary and
  destructive buttons are raised with `shadow.inkEdge` as their top highlight.
- shadow: above the page. Strength by rung.
- ring: attention here. A 2px `box-shadow` composed with the control's own
  shadow, tight to it, no offset, no glow. `accent` on focus, `destructive` on
  invalid. Not an `outline`: the product shell resets outlines with `!important`.

## Color

- `label` is the thing, `secondaryLabel` is about the thing, `tertiaryLabel`
  is a hint: placeholder, help text, chevron, icon at rest.
- Ink for stored state: primary button, checked, on. `label` fill,
  `background` text.
- `accent` for live state only: focus ring, link, live switch, running
  indicator. Never a button fill.
- Disabled is 45% opacity on the whole control, not a color.
- Semantic first, gray second. `gray…gray6` only for things with no role:
  scrollbar, tracks, kbd, skeleton.

## Fields

A control is the well rung: `wellBackground` plus `shadow.inset`, never a
border. One component token group, `field`, serves the whole family — input,
textarea, checkbox, radio, switch, and the selects that follow — so a state has
one colour in one place instead of one per component.

| state       | what it is                                                                     |
| ----------- | ------------------------------------------------------------------------------ |
| rest        | `field.background` and `field.well`; the value in `field.value`                |
| placeholder | `field.placeholder`, the hint colour; it is a prompt, not a label              |
| focus       | 2px `field.ring` (accent), tight to the control, no offset                     |
| invalid     | 2px `field.invalidRing` (destructive), at rest and while focused               |
| disabled    | 45% opacity on the control; the label and help dim with it                     |
| checked, on | ink: `field.checkedFill` under `field.checkedMark`, `field.checkedEdge` on top |
| mixed       | the checked appearance with the dash, and it announces `mixed`                 |
| selected    | `selectedFill` on the row that is current, not on the control                  |

A checkbox and a radio are the "16px things" the corner rule names: a
`field.boxSize` box at `radius.mini`, round for a radio. A switch is a
`field.switchWidth` by `field.switchHeight` track at `radius.full` holding a
`field.thumb` thumb raised with `field.thumbShadow`, the same height as the box
so a settings row carrying both lines up. Off is the well; on is the ink, which
is where the well's shadow gives way to `field.checkedEdge`. Because CSS cannot
append to a box-shadow list, a control that changes its edge restates the ring
with it, the way each Button variant does.

These three render a real `<button>` with Base UI's hidden input beside it, so
`:disabled` and `:focus-visible` reach them the way they reach an `<input>` and
a `<label>` can point at them.

The control's own text follows the control rule at every size on the ladder: 13
at weight 500 with `text.controlTracking`. Label at 12 weight 500 in
`field.label`, help at 12 weight 400 in `field.hint`, error at 12 weight 400 in
`field.error`, stacked at `field.gap`. Disabled reads `field.disabledOpacity`
rather than a literal, so the control and its label cannot drift apart.

`Field.Root` owns the name, the disabled flag and validity. A control reads that
state and picks its own classes from it; it does not take a second `invalid` or
`disabled` prop for the caller to keep in sync.

The invalid ring follows `aria-invalid`, which `Field.Root` renders onto its
control, so the attribute is the state rather than a copy of it. What a screen
reader announces and what a sighted person sees cannot disagree, and a surface
that owns its own validation marks one control without a field around it. Every
ARIA value except `false` is invalid, `grammar` and `spelling` included.

## Corners

- `corner.shape` (squircle) on every radius except `radius.full`. Round fallback
  outside Chromium.
- `radius.full` is a pill or a circle, and takes `corner.round`. A squircle at
  that radius is a superellipse, not a stadium: it turns a switch track into a
  rounded rectangle and a radio into a squircle.
- Radius by size: `mini` 5 for 16px things, `small` 8 for 28px controls and
  tooltips, `medium` 10 for 32 and 36px controls, `large` 14 for surfaces.
- Nested radius is outer minus inset. A 14px popup with 4px inset holds 10px
  items. Never the child's own token.
- Icon-only buttons are square at the size's height.

## Type

- Controls at 13 (`subheadline`), weight 500, `text.controlTracking`.
- Prose at 14 (`body`), weight 400. Field labels and help at 12 (`footnote`).
- Dialog title is `headline`; `title` is for sheets and full pages.
- Sizes: 28 / 32 / 36. Default 32. 36 only for empty states and onboarding.

## Motion

- Press: `translateY(1px)` and drop `shadow.inkEdge`, `duration.fast`.
- Rise: popups from 4px below at opacity 0, `duration.regular`.
- Colors and fills cross-fade at `duration.fast`. One easing: `ease.standard`.
