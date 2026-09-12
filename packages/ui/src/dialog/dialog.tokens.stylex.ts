import * as stylex from '@stylexjs/stylex';
import { colors, shadow } from '../tokens/colors.stylex';
import { radius, space, text } from '../tokens/scales.stylex';

/**
 * One token group for every surface on the modal rung — the Dialog, the
 * AlertDialog that asks a question before it will go away, and the Drawer that
 * arrives from an edge of the window. They are one family for the reason
 * `field` is one: the three differ in how they arrive and in what may dismiss
 * them, not in what they are made of, so a padding or a title colour has one
 * place to change rather than three.
 *
 * The modal rung is the elevated background under the large shadow, over the
 * overlay — the one rung in the ladder that states all three together, because
 * a panel that owns the whole window has to separate from a page it is still
 * showing.
 */
export const dialog = stylex.defineVars({
  background: colors.elevatedBackground,
  shadow: shadow.large,
  overlay: colors.overlay,
  // A surface takes the large radius; nested radius is outer minus inset, which
  // is why nothing inside a panel reaches for this one.
  radius: radius.large,
  padding: space[4],
  // Between the header, the body a caller writes and the footer.
  gap: space[4],
  // Inside the header: a title and the sentence under it are one block.
  headerGap: space[1.5],
  footerGap: space[2],
  // The panel's own width, and the room left around it. A dialog is a column of
  // prose and controls rather than a page, so it stops growing; the inset is
  // what the window keeps on both sides when the viewport is narrower than that.
  width: '512px',
  // A drawer's short edge. Anchored start or end this is its width; anchored
  // top or bottom the panel takes the width of the window and this is unused,
  // so one token states "how far the drawer comes in".
  drawerSize: '380px',
  // The gap an inset drawer keeps from every edge. A flush drawer meets the
  // window and squares the two corners that touch it; an inset one floats at
  // this distance and keeps all four. It is the viewport's padding rather than
  // the panel's margin, because the viewport is what Base UI lays the panel out
  // in and a margin would fight the swipe transform.
  drawerInset: space[2],
  inset: space[8],
  title: colors.label,
  // The rules put a dialog title at `headline` and reserve `title` for a full
  // page. A drawer is a panel rather than a page, so it takes the same heading
  // as the dialog it is.
  titleSize: text.headlineSize,
  titleLeading: text.headlineLeading,
  // The sentence under the title is about the title, so it is the secondary
  // label at prose size rather than a second heading.
  description: colors.secondaryLabel,
  descriptionSize: text.bodySize,
  descriptionLeading: text.bodyLeading,
  // The motion rule's rise, restated for a panel that is centred rather than
  // anchored: it arrives from this far below its resting position. A drawer
  // does not use it: it arrives from off the edge it belongs to.
  rise: '4px',
});

/**
 * Re-declares the colour-valued tokens on the element carrying a forced
 * palette; see `button.tokens.stylex.ts` for why a group declared only at the
 * document root keeps the root palette inside a themed subtree.
 */
export const dialogPaletteTheme = stylex.createTheme(dialog, {
  background: colors.elevatedBackground,
  shadow: shadow.large,
  overlay: colors.overlay,
  title: colors.label,
  description: colors.secondaryLabel,
});
