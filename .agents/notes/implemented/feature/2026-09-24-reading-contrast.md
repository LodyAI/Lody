# Reading contrast for long-form text

Status: implemented
Translation: current

[中文](2026-09-24-reading-contrast.zh.md)

## Abstract

Long conversations were tiring to read in dark themes whose foreground is pure white: in
Vesper every prose line, heading, user bubble and sidebar title was #FFFFFF on #101010
(19.7:1), so strokes halated, dense CJK text blurred and nothing marked the reading column
as the brightest area. The theme layer now derives a contrast-capped reading color (13:1 in
dark themes, still above WCAG AAA) for prose and user bubbles, keeps the full foreground for
headings and bold, and caps unselected sidebar titles at 6.5:1 with dimmed row icons, so
only the selected row outshines the prose. Themes already below the caps and high-contrast
themes are unchanged; a warm tint was not applied.

## Decision

- `vscode-theme-css.ts` derives `--reading-foreground` and `--sidebar-row-foreground` by
  moving the foreground toward its background until the contrast meets the cap (dark 13:1
  and 6.5:1, light 16:1 and 9:1). Unthemed builds fall back to the plain foregrounds.
- Markdown body text and user bubbles use `text-reading`; headings and `strong` keep
  `text-foreground`, so hierarchy reads by brightness.
- Inline code: 7% fill instead of 14%, text in the reading color, so chips no longer read
  as bright patches in a sentence.
- Unselected session rows use the row color and `SIDEBAR_ROW_REST_ICON_CLASS` (icons 55%, full
  on hover; avatars keep full opacity, since a faded face reads as a disabled account); the selected row is unchanged.
- List items are 0.5rem apart, more than wrapped lines of one item; the outline rail rests
  at /32 instead of /45 and lifts while the pointer is on it.

## Alternatives

- Changing the bundled theme colors: the theme is the user's choice and other surfaces
  (editor, terminals) rely on its values; derived reading tokens only touch long-form text.
- A warm tint (for example #E4DFD6 on #151413): changes the theme's character; left as an
  option.
- Narrowing the column to 40em for CJK line length: a larger layout change, not done here.

## Verification and limits

- `tests/vscode-theme-css.test.ts`: Vesper's reading color is at most 13:1 (foreground
  still 19.7:1), sidebar rows at most 6.5:1 and below the reading color; a soft theme and a
  high-contrast theme get no derived color. Components suite passes.
- Local production build with Vesper: prose #D5D5D5, unselected sidebar titles #9A9A9A,
  selected row unchanged. Other bundled themes were not inspected one by one.
- File names in tool cards and other non-prose chrome still use the full foreground.
