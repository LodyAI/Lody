import * as stylex from '@stylexjs/stylex';
import { colors, shadow } from '../tokens/colors.stylex';
import { radius, space, text } from '../tokens/scales.stylex';

/**
 * The card rung, made a component: `elevatedBackground` under `shadow.card` at
 * the large radius, with no border, because no border token exists.
 *
 * A Card is the same block a Dialog's panel is, one rung down the ladder — a
 * heading, a sentence about it, what a person came for, and the answers — so
 * the parts and the gaps read the same. It does not *share* `dialog`, though,
 * and that is the point the rules make about a menu reaching for
 * `field.background`: a card and a modal panel are on two rungs, and a group
 * named for one of them would be the wrong name for the right value the day
 * either rung moves.
 *
 * The type is where the two genuinely differ. A dialog owns the window while it
 * is open, so it takes `headline`; a card owns a region of a page it shares with
 * other cards, and the rules reserve `title` for a page that is a page. A card
 * therefore takes the same `headline` a dialog does — it is the largest step
 * this system gives to a panel — and nothing here reaches past it.
 */
export const card = stylex.defineVars({
  background: colors.elevatedBackground,
  shadow: shadow.card,
  // A surface takes the large radius. Nested radius is outer minus inset, which
  // is why nothing inside a card reaches for this one.
  radius: radius.large,
  padding: space[4],
  // Between the header, the body a caller writes and the footer.
  gap: space[4],
  // Inside the header: a title and the sentence under it are one block.
  headerGap: space[1.5],
  footerGap: space[2],
  title: colors.label,
  titleSize: text.headlineSize,
  titleLeading: text.headlineLeading,
  // The sentence under the title is about the title, so it is the secondary
  // label at prose size rather than a second heading.
  description: colors.secondaryLabel,
  descriptionSize: text.bodySize,
  descriptionLeading: text.bodyLeading,
  /**
   * A card a person can press, under the pointer.
   *
   * The ladder names the region rung — `secondaryBackground` — for "hover on a
   * card", and measured in the dark palette that is the card rung's own value:
   * `elevatedBackground` and `secondaryBackground` are both `hsl(0 0% 8.6%)`,
   * so the hover would be invisible in exactly one of the two palettes. Mixing
   * the rung toward `label` steps away from the surface in both directions at
   * once, which is the derivation `popup.highlight` already uses for a row and
   * a secondary Button for its own hover — at that Button's 4%, because a card
   * is a large area and a row's 6% over one reads as a fill.
   */
  hover: `color-mix(in oklab, ${colors.elevatedBackground}, ${colors.label} 4%)`,
});

/**
 * Re-declares the colour-valued tokens on the element carrying a forced
 * palette; see `button.tokens.stylex.ts` for why a group declared only at the
 * document root keeps the root palette inside a themed subtree.
 */
export const cardPaletteTheme = stylex.createTheme(card, {
  background: colors.elevatedBackground,
  shadow: shadow.card,
  title: colors.label,
  description: colors.secondaryLabel,
  hover: `color-mix(in oklab, ${colors.elevatedBackground}, ${colors.label} 4%)`,
});
