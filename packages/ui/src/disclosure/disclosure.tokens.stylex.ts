import * as stylex from '@stylexjs/stylex';
import { colors, shadow } from '../tokens/colors.stylex';
import { radius, space, text } from '../tokens/scales.stylex';

/**
 * One token group for the three ways a surface shows one thing out of several:
 * the Tabs strip, the Accordion and the Collapsible.
 *
 * They are one family for the reason `dialog` covers three modals: what differs
 * is how the choices are laid out and how the thing arrives, not what either is
 * made of. A tab strip lays the choices side by side and swaps the panel under
 * them; an accordion stacks them and opens one in place; a collapsible is a
 * single one of those rows with no list around it. All three are a trigger and
 * the thing it shows, so the colour a closed row's label takes and the colour a
 * tab you are not on takes cannot drift apart into two decisions.
 *
 * It is deliberately not part of `field`: none of these three holds a value.
 * A Tab picks what is shown, not what is stored, so it takes no name, answers to
 * no `Field.Root` and has no invalid state — it only borrows the well the field
 * family also sits in, which is the elevation ladder's doing rather than a
 * shared component vocabulary.
 */
export const disclosure = stylex.defineVars({
  // A tab strip is a track with one thing raised out of it, which is the ladder
  // read twice over: the track is the well rung, and the indicator under the
  // selected tab is the same raised pair a secondary Button takes — because the
  // selected tab is the one that reads as a thing you can press.
  trackBackground: colors.wellBackground,
  trackWell: shadow.inset,
  // The inset the popup surface also takes, and for the same reason: the row
  // inside is the track less this on both sides, and its radius is the track's
  // less this. Nested radius is outer minus inset.
  trackInset: space[1],
  trackRadiusSmall: radius.small,
  trackRadiusMedium: radius.medium,
  indicator: colors.raisedBackground,
  indicatorShadow: shadow.raised,
  tabPaddingX: space[3],
  // A glyph and its label inside one tab; the gap a Button already uses.
  tabGap: '6px',
  tabText: text.subheadlineSize,
  // A tab you are not on is about the thing; the one you are on is the thing.
  // Hovering an unselected tab moves it to the second, because the fill in this
  // strip is the indicator's and nothing else may claim it.
  tabLabel: colors.secondaryLabel,
  tabActiveLabel: colors.label,
  // A disclosure row: the label, the chevron that says there is more under it,
  // and the line to the next row. A row has no fill of its own — it is a row in
  // a list, and `separator` is what the rules give one.
  rowPaddingY: space[3],
  rowGap: space[3],
  rowText: text.subheadlineSize,
  label: colors.label,
  chevron: colors.tertiaryLabel,
  chevronSize: '16px',
  separator: colors.separator,
  // What an opened panel holds is prose, so it takes the prose step rather than
  // the control step its own trigger takes, the way a popover's body does.
  panelText: text.bodySize,
  panelLeading: text.bodyLeading,
  panelPaddingBottom: space[3],
  // Between a tab strip and the panel it swaps: the panel is a second block
  // rather than part of the strip.
  panelGap: space[2],
  ring: colors.accent,
  ringWidth: '2px',
  // The family's one disabled value; the rules give the whole control 45%.
  disabledOpacity: '0.45',
});

/**
 * Re-declares the colour-valued tokens on the element carrying a forced palette;
 * see `button.tokens.stylex.ts` for why a group declared only at the document
 * root keeps the root palette inside a themed subtree.
 */
export const disclosurePaletteTheme = stylex.createTheme(disclosure, {
  trackBackground: colors.wellBackground,
  trackWell: shadow.inset,
  indicator: colors.raisedBackground,
  indicatorShadow: shadow.raised,
  tabLabel: colors.secondaryLabel,
  tabActiveLabel: colors.label,
  label: colors.label,
  chevron: colors.tertiaryLabel,
  separator: colors.separator,
  ring: colors.accent,
});
