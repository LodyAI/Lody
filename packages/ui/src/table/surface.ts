import * as stylex from '@stylexjs/stylex';
import { button } from '../button/button.tokens.stylex';
import { corner, duration, ease, radius, text } from '../tokens/scales.stylex';
import { table } from './table.tokens.stylex';

/**
 * What a table is made of, and what the pager under it is made of.
 *
 * A table has no surface: no background, no shadow, no radius. It is rows on
 * whatever the surface around it already was, which is why the one thing it
 * draws is the line between one row and the next — the single edge the rules
 * give a list. The head is a row like any other and takes that same line; the
 * rule against a line under a header is about a heading over a surface, not
 * about a row of column names, and a head separated from its rows by nothing
 * reads as the first record.
 *
 * That line is a border rather than the inset shadow a disclosure row draws,
 * and this is the one place in the package where it has to be. A table is laid
 * out by the CSS table model: under `border-collapse: collapse` a row's own
 * box-shadow is not painted, and under `separate` a row's border is ignored.
 * Collapse is the mode that lets the line ride on the row — where `:last-child`
 * can take it away again — rather than on every cell in it.
 */
export const tableSurface = stylex.create({
  /**
   * A table is as wide as its columns need, and the surface holding it rarely
   * is. The scroller is the primitive's rather than the caller's so a table
   * that outgrows its column scrolls instead of pushing the page sideways.
   */
  scroller: {
    position: 'relative',
    width: '100%',
    overflowX: 'auto',
  },
  root: {
    width: '100%',
    borderCollapse: 'collapse',
    borderSpacing: 0,
    margin: 0,
    color: table.value,
    fontSize: table.text,
    lineHeight: table.leading,
    fontWeight: 400,
    textAlign: 'start',
  },
  /** Columns share the width equally instead of following their contents. */
  fixed: { tableLayout: 'fixed' },
  /**
   * What the table is, for someone who cannot see it is a table. It sits under
   * the rows rather than over them, because a caption over a table is a heading
   * and a heading belongs to the surface.
   */
  caption: {
    captionSide: 'bottom',
    marginBlockStart: table.captionGap,
    color: table.caption,
    fontSize: table.captionText,
    lineHeight: table.captionLeading,
    textAlign: 'start',
  },
  row: {
    borderBlockEndWidth: '1px',
    borderBlockEndStyle: 'solid',
    borderBlockEndColor: table.line,
    backgroundColor: 'transparent',
    transitionProperty: 'background-color',
    transitionDuration: duration.fast,
    transitionTimingFunction: ease.standard,
  },
  /**
   * The last record is the end of the table, so it draws no line to a next row
   * there is none of — the same reading a disclosure row makes of its own
   * position. A head row keeps its line: the next row is the first record.
   */
  bodyRow: { borderBlockEndColor: { default: table.line, ':last-child': 'transparent' } },
  /**
   * A totals row is under the records rather than among them, so the line it
   * carries is the one above it.
   */
  footRow: {
    borderBlockEndStyle: 'none',
    borderBlockStartWidth: '1px',
    borderBlockStartStyle: 'solid',
    borderBlockStartColor: table.line,
    fontWeight: 500,
  },
  /**
   * The pointer is answered only where pressing a row does something. The
   * package's first table lit every row on hover and its one caller had to turn
   * that off again with a class, which is the shape of a default that was
   * wrong: a table of facts is read, not operated.
   */
  interactiveRow: { backgroundColor: { default: 'transparent', ':hover': table.hover } },
  /**
   * The row that holds the value, which stays marked while the pointer is
   * somewhere else — the same split a popup row makes between where the pointer
   * is and which row is current.
   */
  selectedRow: { backgroundColor: { default: table.selected, ':hover': table.selected } },
  cell: {
    paddingBlock: table.cellPaddingY,
    textAlign: 'start',
    verticalAlign: 'middle',
    fontWeight: 'inherit',
  },
  cellSmall: { height: table.rowHeightSmall, paddingInline: table.cellPaddingXSmall },
  cellMedium: { height: table.rowHeightMedium, paddingInline: table.cellPaddingXMedium },
  cellLarge: { height: table.rowHeightLarge, paddingInline: table.cellPaddingXLarge },
  /**
   * A column's name is about the column rather than in it, so it takes the
   * footnote step and the secondary colour the rules give a label. It does not
   * wrap: a name that needs two lines is a name, not a sentence.
   */
  headCell: {
    color: table.head,
    fontSize: table.headText,
    lineHeight: table.headLeading,
    fontWeight: 500,
    letterSpacing: text.controlTracking,
    whiteSpace: 'nowrap',
  },
  /** The one column the table is sorted by, which is the thing rather than about it. */
  headCellSorted: { color: table.headActive },
  alignStart: { textAlign: 'start' },
  alignCenter: { textAlign: 'center' },
  alignEnd: { textAlign: 'end' },
  /**
   * Figures that are read down a column rather than across a line, so the
   * digits have to be one width: a proportional 1 puts every number in the
   * column at a different place.
   */
  numeric: { fontVariantNumeric: 'tabular-nums' },
  /**
   * A sortable column's name is a control, so it is a real button — and the one
   * control a table holds. The ring is a box-shadow for the reason every ring
   * in this package is, and the button pads itself by the ring's own width and
   * takes that width back as a margin, so the ring has room without the name
   * moving away from the column under it.
   */
  sortButton: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: table.sortGap,
    margin: 0,
    marginInline: `calc(-1 * ${table.ringWidth})`,
    padding: 0,
    paddingInline: table.ringWidth,
    borderWidth: 0,
    borderStyle: 'none',
    backgroundColor: 'transparent',
    color: { default: 'inherit', ':hover': table.headActive },
    font: 'inherit',
    letterSpacing: 'inherit',
    cursor: 'pointer',
    outlineStyle: 'none',
    borderRadius: radius.mini,
    cornerShape: corner.shape,
    boxShadow: {
      default: 'none',
      ':focus-visible': `0 0 0 ${table.ringWidth} ${table.ring}`,
    },
    transitionProperty: 'color, box-shadow',
    transitionDuration: duration.fast,
    transitionTimingFunction: ease.standard,
  },
  /**
   * The box the arrow gets. Whatever holds a glyph here gives it one, because
   * this package's glyphs state 100% of their holder.
   */
  sortMark: {
    display: 'block',
    flexShrink: 0,
    width: table.sortMarkSize,
    height: table.sortMarkSize,
  },

  // ── The pager ────────────────────────────────────────────────────────────
  pager: {
    display: 'flex',
    alignItems: 'center',
    gap: table.pagerGap,
  },
  pagerList: {
    display: 'flex',
    alignItems: 'center',
    gap: table.pagerGap,
    listStyleType: 'none',
    margin: 0,
    padding: 0,
  },
  pagerItem: { display: 'flex' },
  /**
   * A numbered button is square while its number is one digit and grows with
   * the number, which is why it is not the icon-only Button a step takes: a
   * glyph box holds 16px and page 120 is wider than that. Only the minimum is
   * stated here — the padding stays the Button's own, because two classes
   * claiming one property from two `stylex.create` calls have no settled order.
   */
  pagerPageSmall: { minWidth: button.heightSmall },
  pagerPageMedium: { minWidth: button.heightMedium },
  /**
   * The pages that are not listed. It is a square the size of the buttons
   * beside it — it reads the button's own height for that, because "as tall as
   * what it stands between" is the fact, not a measurement of its own — and it
   * is hidden from a screen reader: it names no page a person can go to, and a
   * list that reads "3, 4, more pages, 98" says nothing "3, 4, 98" does not.
   */
  ellipsis: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    color: table.pagerHint,
  },
  ellipsisSmall: { width: button.heightSmall, height: button.heightSmall },
  ellipsisMedium: { width: button.heightMedium, height: button.heightMedium },
  ellipsisGlyph: {
    display: 'block',
    width: button.iconSize,
    height: button.iconSize,
  },
  /**
   * Where you are, when there are too many pages to list. The number you are on
   * is the value and takes the label colour; the count it is out of is about it
   * and takes the hint. The digits are tabular so the row does not twitch as
   * the pages tick over.
   */
  position: {
    display: 'flex',
    alignItems: 'center',
    gap: table.pagerPositionGap,
    marginInline: table.pagerGap,
    color: table.value,
    fontSize: table.text,
    lineHeight: table.leading,
    fontWeight: 500,
    letterSpacing: text.controlTracking,
    fontVariantNumeric: 'tabular-nums',
  },
  positionTotal: { color: table.pagerHint, fontWeight: 400 },
  jump: {
    width: table.pagerJumpWidth,
    textAlign: 'center',
    fontVariantNumeric: 'tabular-nums',
  },
  /**
   * Said to a screen reader and to nobody else. The pager's position is three
   * numbers and a slash on screen, which is read as "4 slash 120"; this is the
   * sentence that replaces it.
   */
  srOnly: {
    position: 'absolute',
    width: '1px',
    height: '1px',
    margin: '-1px',
    padding: 0,
    overflow: 'hidden',
    clipPath: 'inset(50%)',
    whiteSpace: 'nowrap',
    borderWidth: 0,
  },
});
