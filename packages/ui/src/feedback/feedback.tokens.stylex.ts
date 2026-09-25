import * as stylex from '@stylexjs/stylex';
import { colors, shadow } from '../tokens/colors.stylex';
import { radius, space, text } from '../tokens/scales.stylex';

/**
 * One token group for everything the system says back to a person: what
 * happened, and that it is still working.
 *
 * An Alert and a Toast are the same message on two rungs — one kept on the page
 * it is about, one arriving over it — so the tone that marks a message, the
 * title and the sentence under it are stated once here rather than twice. The
 * Progress, the Skeleton and the Spinner are the other half of the same
 * sentence: not "here is what happened" but "this is not finished". They share
 * the group for the reason `field` covers a checkbox and a select trigger —
 * what changes between them is what they are made of, not what they are for.
 *
 * A tone here is a tint and a mark, never a fill. The elevation ladder gives a
 * message its background, and a coloured panel would both leave the ladder and
 * claim the attention a modal is for; `popup.destructiveHighlight` already
 * settles how this system says "this one is dangerous" on a surface, and this
 * is that derivation applied to four outcomes.
 */
export const feedback = stylex.defineVars({
  // A message kept on the page it is about: the card rung.
  noticeBackground: colors.elevatedBackground,
  noticeShadow: shadow.card,
  noticeRadius: radius.large,
  // A message arriving over the page: the floating rung, the same pair a menu
  // and a popover take. It is not the modal rung — a toast does not have to be
  // answered, and nothing behind it recedes.
  toastBackground: colors.raisedBackground,
  toastShadow: shadow.popover,
  // Wide enough for two lines of a sentence, narrow enough to stay a message
  // rather than becoming a panel.
  toastWidth: '360px',
  toastGap: space[2],
  viewportInset: space[4],
  padding: space[3],
  // The mark, the text beside it, and the room between them.
  gap: space[3],
  markSize: '16px',
  title: colors.label,
  titleSize: text.subheadlineSize,
  titleLeading: text.subheadlineLeading,
  description: colors.secondaryLabel,
  descriptionSize: text.footnoteSize,
  descriptionLeading: text.footnoteLeading,
  // The four outcomes a message can report. Each is the colour of its mark, and
  // the surface under the message takes 8% of that colour — the mix
  // `popup.destructiveHighlight` already uses to say "this one is dangerous"
  // about a row, at the strength that survives both palettes. The tint is not a
  // token of its own because it is a mix *of a surface*, and the two surfaces
  // here are on different rungs: `feedback/surface.ts` states it once per rung
  // from the rung's own background, rather than freezing one base into six
  // tokens that could then disagree with the ladder.
  mark: colors.secondaryLabel,
  success: colors.success,
  warning: colors.warning,
  danger: colors.destructive,
  // Still working. A bar is a track on the well rung with the accent running in
  // it: the rules give `accent` to live state and name the running indicator by
  // name, which is the one thing a progress bar is.
  trackBackground: colors.wellBackground,
  trackWell: shadow.inset,
  trackHeight: '6px',
  indicator: colors.accent,
  // Content that has not arrived has no role, which is what the rules reserve
  // the grays for: a scrollbar, a track, a kbd, a skeleton.
  skeleton: colors.gray5,
  // The spinner is drawn in `currentColor` so it takes the ink of whatever
  // holds it — a ghost button's label, a page's secondary text — and only its
  // measurements are tokens. The ring behind the arc is that same colour at a
  // fraction, so one declaration serves every context.
  spinnerSmall: '16px',
  spinnerMedium: '20px',
  spinnerLarge: '24px',
  spinnerWidth: '2px',
});

/**
 * Re-declares the colour-valued tokens on the element carrying a forced palette;
 * see `button.tokens.stylex.ts` for why a group declared only at the document
 * root keeps the root palette inside a themed subtree.
 */
export const feedbackPaletteTheme = stylex.createTheme(feedback, {
  noticeBackground: colors.elevatedBackground,
  noticeShadow: shadow.card,
  toastBackground: colors.raisedBackground,
  toastShadow: shadow.popover,
  title: colors.label,
  description: colors.secondaryLabel,
  mark: colors.secondaryLabel,
  success: colors.success,
  warning: colors.warning,
  danger: colors.destructive,
  trackBackground: colors.wellBackground,
  trackWell: shadow.inset,
  indicator: colors.accent,
  skeleton: colors.gray5,
});
