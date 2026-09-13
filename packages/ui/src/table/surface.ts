import * as stylex from '@stylexjs/stylex';
import { button } from '../button/button.tokens.stylex';
import { corner, duration, ease, radius, space, text, z } from '../tokens/scales.stylex';
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
 * That line is the `inset 0 -1px 0` every other row in this package draws, and
 * the table is laid out with `border-collapse: separate` so it can be. Under
 * `collapse` a row's own box-shadow is not painted, a sticky head's border does
 * not travel with it, and a row could not carry a focus ring; under `separate`
 * all three work, and the row keeps one `box-shadow` in which its line and its
 * ring compose — which is the rule the rest of the package already follows.
 */
const RING = `0 0 0 ${table.ringWidth} ${table.ring}`;
const LINE = `inset 0 -1px 0 ${table.line}`;

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
    /**
     * The table asks about *its own* width, not the window's. A settings table
     * in a 360px side panel on a 27" screen is narrow, and a media query calls
     * it wide; the panel is the thing that got small, so the panel's width is
     * what the question is about. This is what makes the stacked layout below
     * a container query rather than a breakpoint.
     */
    containerType: 'inline-size',
  },
  /**
   * A table told how tall it may be owns a scroll box, which is the only thing
   * a sticky head can stick to. The two are one decision rather than two props:
   * a head that scrolls out of its own box is not a choice a surface would make.
   */
  scrollerBounded: { overflowY: 'auto' },
  root: {
    width: '100%',
    borderCollapse: 'separate',
    borderSpacing: 0,
    margin: 0,
    color: table.value,
    fontSize: table.text,
    lineHeight: table.leading,
    fontWeight: 400,
    textAlign: 'start',
  },
  /** Columns share the width they are given instead of following their contents. */
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
  /**
   * The head stops being a row when it stays: it becomes a band over the rows
   * moving under it, so it takes the rung the ladder gives a band. Without a
   * fill the rows are painted through it — that is not a subtlety, it is
   * legible in a screenshot.
   */
  headSticky: {
    position: 'sticky',
    insetBlockStart: 0,
    zIndex: 1,
  },
  headStickyRow: { backgroundColor: table.headStickyBackground },
  row: {
    backgroundColor: 'transparent',
    transitionProperty: 'background-color, box-shadow',
    transitionDuration: duration.fast,
    transitionTimingFunction: ease.standard,
  },
  headRow: { boxShadow: LINE },
  /**
   * The last record is the end of the table, so it draws no line to a next row
   * there is none of — the same reading a disclosure row makes of its own
   * position. `:last-child` is how a row assembled by a caller reads it; a table
   * that renders its own rows knows which one is last and says so, because a
   * pseudo-class cannot be composed with the focus ring below.
   */
  bodyRow: { boxShadow: { default: LINE, ':last-child': 'none' } },
  bodyRowLined: { boxShadow: LINE },
  bodyRowLast: { boxShadow: { default: 'none', ':focus-visible': RING } },
  /**
   * A totals row is under the records rather than among them, so the line it
   * carries is the one above it.
   */
  footRow: { boxShadow: `inset 0 1px 0 ${table.line}`, fontWeight: 500 },
  /**
   * The pointer is answered only where pressing a row does something. The
   * package's first table lit every row on hover and its one caller had to turn
   * that off again with a class, which is the shape of a default that was
   * wrong: a table of facts is read, not operated.
   */
  hoverRow: { backgroundColor: { default: 'transparent', ':hover': table.hover } },
  /**
   * A row that can be pressed is reachable by the keyboard and says where the
   * keyboard is, in the ring the whole package uses — restated with the line,
   * because CSS cannot add to a box-shadow list. It is not an `outline`: the
   * product shell resets every outline with `!important`.
   */
  pressableRow: {
    cursor: 'pointer',
    outlineStyle: 'none',
    boxShadow: { default: LINE, ':focus-visible': `${LINE}, ${RING}` },
  },
  pressableRowLast: {
    boxShadow: { default: 'none', ':focus-visible': RING },
  },
  /**
   * The rows a bulk action would act on. The tick in the first column is what
   * says so — a fill alone reaches only the people who can see it — and this is
   * the quiet fill that lets a person find them again down the page.
   */
  selectedRow: { backgroundColor: { default: table.selected, ':hover': table.selected } },
  cell: {
    paddingBlock: table.cellPaddingY,
    textAlign: 'start',
    verticalAlign: 'middle',
    fontWeight: 'inherit',
    /**
     * A value is one line. A table is read down its columns, and a cell that
     * wraps to three lines takes the row with it and stops the column being
     * scannable; a column of sentences says `wrap` and takes the other rule.
     * Where the layout is `fixed` this ellipsizes, and where it is `auto` the
     * column grows and the scroller carries it.
     */
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  cellWrap: { whiteSpace: 'normal', overflow: 'visible', textOverflow: 'clip' },
  cellSmall: { height: table.rowHeightSmall, paddingInline: table.cellPaddingXSmall },
  cellMedium: { height: table.rowHeightMedium, paddingInline: table.cellPaddingXMedium },
  cellLarge: { height: table.rowHeightLarge, paddingInline: table.cellPaddingXLarge },
  /**
   * A column's name is about the column rather than in it, so it takes the
   * footnote step and the secondary colour the rules give a label.
   */
  headCell: {
    color: table.head,
    fontSize: table.headText,
    lineHeight: table.headLeading,
    fontWeight: 500,
    letterSpacing: text.controlTracking,
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
   * control a table's head holds. The button pads itself by the ring's own width
   * and takes that width back as a margin, so the ring has room without the name
   * moving away from the column under it.
   */
  sortButton: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: table.sortGap,
    maxWidth: '100%',
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
    boxShadow: { default: 'none', ':focus-visible': RING },
    transitionProperty: 'color, box-shadow',
    transitionDuration: duration.fast,
    transitionTimingFunction: ease.standard,
  },
  /** A column aligned to its end puts the arrow before the name, not after it. */
  sortButtonEnd: { flexDirection: 'row-reverse' },
  sortLabel: { overflow: 'hidden', textOverflow: 'ellipsis' },
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
  /** The column that holds nothing but the box that picks a row. */
  selectCell: {
    width: table.selectWidth,
    paddingInline: 0,
    textAlign: 'center',
    verticalAlign: 'middle',
    whiteSpace: 'nowrap',
  },
  selectBox: { display: 'inline-flex', verticalAlign: 'middle' },
  /**
   * Nothing to show. It is a row of the table rather than a panel over it, so
   * the head stays where it is and a person can still read what the columns
   * were going to be.
   */
  empty: {
    height: table.emptyHeight,
    textAlign: 'center',
    color: table.empty,
    fontSize: table.text,
    lineHeight: table.leading,
  },

  /**
   * A table narrower than its columns need is not a table with a scrollbar: it
   * is a list of records, each one a stack of label-and-value lines. Every
   * surface in this repository that draws a table already does this by hand —
   * one of them by rendering every cell a second time — and it is only possible
   * here because the columns are stated: a cell can carry its own column's name
   * when the head is no longer over it.
   *
   * The width is the design system's rather than a caller's, because a caller
   * choosing it is a caller deciding how wide a record is allowed to be, and
   * StyleX wants a static key besides.
   */
  stackedRow: {
    '@container (max-width: 480px)': {
      display: 'block',
      paddingBlock: table.cellPaddingY,
    },
  },
  stackedCell: {
    '@container (max-width: 480px)': {
      display: 'flex',
      alignItems: 'baseline',
      justifyContent: 'space-between',
      gap: space[3],
      height: 'auto',
      whiteSpace: 'normal',
      overflow: 'visible',
      textAlign: 'start',
    },
  },
  /**
   * The column's name, beside the value it belongs to. It is the head's own
   * words rather than a second copy, and it is only shown where the head is
   * not: a screen reader is given the pair rather than losing the name with
   * the row of them.
   */
  stackedHead: { '@container (max-width: 480px)': { display: 'none' } },
  cellLabel: {
    display: 'none',
    '@container (max-width: 480px)': {
      display: 'block',
      flexShrink: 0,
      color: table.head,
      fontSize: table.headText,
      lineHeight: table.headLeading,
      fontWeight: 500,
      letterSpacing: text.controlTracking,
    },
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
    zIndex: z.dialogBackdrop,
  },
});

/** How much room a column takes, stated on a `<col>` so both its cells follow. */
export const columnWidth = stylex.create({
  width: (value: string | number | undefined) => ({ width: value }),
});

/** A table told how tall it may be, which is what its head sticks to. */
export const scrollerHeight = stylex.create({
  maxHeight: (value: string | number | undefined) => ({ maxHeight: value }),
});
