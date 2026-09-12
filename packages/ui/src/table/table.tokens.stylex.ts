import * as stylex from '@stylexjs/stylex';
import { colors } from '../tokens/colors.stylex';
import { control, space, text } from '../tokens/scales.stylex';

/**
 * One token group for a table and the pager under it.
 *
 * They are one family for the reason `dialog` covers three modals and `field`
 * covers a checkbox and a select trigger: a pager exists because a table did
 * not fit, the two sit on the same rung of the page and state the same size,
 * and a row's line and the gap between two page buttons are the same decision
 * about how dense a list of records is. A pager that took a group of its own
 * would let a table go quiet while its pager stayed loud.
 *
 * A table has no surface of its own. It has no background, no shadow and no
 * radius: it is rows on whatever the surface around it already was — a page, a
 * card, a dialog — so the card that holds it keeps owning its own edges. What
 * the rules give a table is the one edge a list is allowed, `separator`
 * between one row and the next.
 *
 * The one exception is a head that stays while its rows scroll under it, which
 * is no longer a row: it is a band over them, and the ladder already has a rung
 * for a band over the page. Anything else on it would show through.
 *
 * The two fills are the palette's own `hoverFill` and `selectedFill` rather
 * than a mix of the surface, which is the opposite of what a popup row does.
 * The rules say why: those two were tuned against the page and card rungs, and
 * a table row is exactly the row they were named for. A popup derives its own
 * only because on the floating rung they collapse into the surface.
 */
export const table = stylex.defineVars({
  // A row is a control-height row that happens to hold values, so it takes the
  // control ladder the rest of the package takes: 28, 32 and 36. The height is
  // a minimum rather than a cap — a cell whose column wraps grows the row.
  rowHeightSmall: control.small,
  rowHeightMedium: control.medium,
  rowHeightLarge: control.large,
  cellPaddingXSmall: space[2],
  // 10px sits between space.2 and space.3; the 32px row needs the half step,
  // the same one the 32px control takes.
  cellPaddingXMedium: '10px',
  cellPaddingXLarge: space[3],
  cellPaddingY: space[1],
  // One step for the whole ladder, and it is the control step rather than the
  // prose one: a cell holds a value, not a sentence.
  text: text.subheadlineSize,
  leading: text.subheadlineLeading,
  // The head is about the columns rather than in them, so it takes the footnote
  // step the rules give a label — and the colour they give one.
  headText: text.footnoteSize,
  headLeading: text.footnoteLeading,
  // A head that stays while the rows scroll under it. It is the region rung,
  // because a head that stops being a row becomes a band over the page — and
  // because a transparent one is not a design choice but a bug: the rows show
  // through it.
  headStickyBackground: colors.secondaryBackground,
  // The arrow on the column a table is sorted by, and the room between it and
  // the column's name.
  sortMarkSize: '12px',
  sortGap: space[1],
  // The column that holds nothing but a checkbox: a 16px box with a cell's
  // padding either side of it, stated once so every table's first column lines
  // up with every other's.
  selectWidth: '44px',
  // Nothing to show. It is a row of the table rather than a panel over it, so
  // it takes a few rows' worth of height and the colour of a sentence about
  // the table rather than one in it.
  emptyHeight: '96px',
  empty: colors.secondaryLabel,
  captionText: text.footnoteSize,
  captionLeading: text.footnoteLeading,
  captionGap: space[2],
  value: colors.label,
  head: colors.secondaryLabel,
  // The one column the table is sorted by is the thing rather than about it, so
  // it takes the label colour its own values take. It is the only mark the head
  // carries: a fill there would be a second surface across the top of a part
  // that has no surface.
  headActive: colors.label,
  caption: colors.secondaryLabel,
  line: colors.separator,
  hover: colors.hoverFill,
  selected: colors.selectedFill,
  ring: colors.accent,
  ringWidth: '2px',
  // The pager. The buttons in it are `Button`s and bring their own tokens; what
  // is left is the room between them and the parts that are not controls — the
  // gap the pages are missing, and the count beside the page you are on.
  pagerGap: space[1],
  pagerHint: colors.tertiaryLabel,
  pagerPositionGap: space[1.5],
  // Wide enough for five digits, so a pager over a file of tens of thousands of
  // pages does not crop the number it is showing.
  pagerJumpWidth: '72px',
});

/**
 * Re-declares the colour-valued tokens on the element carrying a forced palette;
 * see `button.tokens.stylex.ts` for why a group declared only at the document
 * root keeps the root palette inside a themed subtree.
 */
export const tablePaletteTheme = stylex.createTheme(table, {
  headStickyBackground: colors.secondaryBackground,
  empty: colors.secondaryLabel,
  value: colors.label,
  head: colors.secondaryLabel,
  headActive: colors.label,
  caption: colors.secondaryLabel,
  line: colors.separator,
  hover: colors.hoverFill,
  selected: colors.selectedFill,
  ring: colors.accent,
  pagerHint: colors.tertiaryLabel,
});
