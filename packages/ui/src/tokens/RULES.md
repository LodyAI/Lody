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
- ring: attention here. 2px, tight to the control, no offset, no glow.
  `accent` on focus, `destructive` on invalid.

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

## Corners

- `corner.shape` (squircle) on every radius. Round fallback outside Chromium.
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
