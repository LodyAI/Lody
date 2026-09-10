import * as stylex from '@stylexjs/stylex';
import { corner, duration, ease, text, z } from '../tokens/scales.stylex';
import { popup } from './popup.tokens.stylex';

/**
 * The appearance every floating list in this package shares: the popup itself,
 * the rows in it, the group labels, the separators and the scroll arrows. It
 * lives here rather than on one component so Select, Combobox and the menus
 * that follow cannot each grow their own surface, highlight and selected
 * treatment, the way `field/well.ts` keeps the controls on the well rung
 * together.
 *
 * A row states two different facts at once. `highlighted` is where the keyboard
 * or the pointer is right now and takes `popup.highlight`; `selected` is the row
 * that holds the value and takes `popup.selected`. When the highlight lands on
 * the selected row the highlight wins the fill, because that is the one that
 * moves — the tick keeps saying which row is current.
 */
export const surface = stylex.create({
  /** The floating rung: raised background and the popover shadow, together. */
  popup: {
    boxSizing: 'border-box',
    display: 'flex',
    flexDirection: 'column',
    minWidth: 'var(--anchor-width)',
    maxHeight: 'var(--available-height)',
    maxWidth: 'var(--available-width)',
    padding: popup.inset,
    backgroundColor: popup.background,
    boxShadow: popup.shadow,
    borderRadius: popup.radius,
    cornerShape: corner.shape,
    color: popup.label,
    fontFamily: 'inherit',
    fontSize: popup.text,
    fontWeight: 500,
    letterSpacing: text.controlTracking,
    outlineStyle: 'none',
    // The rules put a popup at 4px below at opacity 0, rising over
    // duration.regular. StyleX cannot express `[data-starting-style]`, so the
    // transition status is read from Base UI's state in JS and the hidden end
    // of the transition is a class of its own.
    opacity: 1,
    transform: 'translateY(0)',
    transitionProperty: 'opacity, transform',
    transitionDuration: duration.regular,
    transitionTimingFunction: ease.standard,
    // The product shell stacks its own surfaces; a popup belongs above them.
    zIndex: z.popover,
  },
  /** Where the rise starts and ends: 4px below the resting position. */
  popupHidden: { opacity: 0, transform: `translateY(${popup.rise})` },
  /**
   * A Select popup that overlaps its trigger so the selected row's text sits
   * on the trigger's value reports `side="none"`. Moving it would slide that
   * alignment out from under the pointer, so this end of the transition only
   * fades.
   */
  popupHiddenInPlace: { opacity: 0, transform: 'translateY(0)' },
  /** The scrolling region inside the popup. */
  list: {
    display: 'flex',
    flexDirection: 'column',
    minHeight: 0,
    overflowY: 'auto',
    overflowX: 'hidden',
    // A row scrolled to the edge stays clear of the scroll arrows above it.
    scrollPaddingBlock: popup.scrollArrowHeight,
    outlineStyle: 'none',
  },
  /** A row: a 28px control that happens to live in a list. */
  item: {
    boxSizing: 'border-box',
    display: 'flex',
    alignItems: 'center',
    gap: popup.itemGap,
    minHeight: popup.itemHeight,
    paddingBlock: 0,
    paddingInline: popup.itemPaddingX,
    borderRadius: popup.itemRadius,
    cornerShape: corner.shape,
    backgroundColor: 'transparent',
    color: popup.label,
    // A list row is not a button: the pointer picks it, it does not press it.
    cursor: 'default',
    userSelect: 'none',
    outlineStyle: 'none',
    scrollMarginBlock: popup.inset,
    transitionProperty: 'background-color, opacity',
    transitionDuration: duration.fast,
    transitionTimingFunction: ease.standard,
  },
  /** The row that holds the value. */
  itemSelected: { backgroundColor: popup.selected },
  /** Where the keyboard or the pointer is; it wins over the selected fill. */
  itemHighlighted: { backgroundColor: popup.highlight },
  /** The same 45% the whole library uses, and no pointer. */
  itemDisabled: { opacity: 0.45, pointerEvents: 'none' },
  /**
   * The label of a row. It takes the remaining width so a long one truncates
   * instead of pushing the tick out of the popup.
   */
  itemText: {
    flexGrow: 1,
    flexShrink: 1,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  /**
   * The tick. Its box is reserved on every row, selected or not, so a list does
   * not reflow as the selection moves down it.
   */
  indicator: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    width: popup.indicatorSize,
    height: popup.indicatorSize,
    color: popup.indicator,
  },
  indicatorGlyph: { display: 'block', width: popup.indicatorSize, height: popup.indicatorSize },
  /** A group heading: about the rows under it, so the secondary label colour. */
  groupLabel: {
    boxSizing: 'border-box',
    display: 'flex',
    alignItems: 'center',
    minHeight: popup.itemHeight,
    paddingInline: popup.itemPaddingX,
    color: popup.groupLabel,
    fontSize: popup.groupLabelSize,
    lineHeight: popup.groupLabelLeading,
    fontWeight: 500,
    letterSpacing: '0.06em',
    textTransform: 'uppercase',
    userSelect: 'none',
  },
  /** The one place a line is allowed: between rows. */
  separator: {
    height: '1px',
    flexShrink: 0,
    marginBlock: popup.inset,
    marginInline: `calc(-1 * ${popup.inset})`,
    backgroundColor: popup.separator,
  },
  /** "No matches": a hint rather than a row, because it cannot be picked. */
  empty: {
    boxSizing: 'border-box',
    display: 'flex',
    alignItems: 'center',
    minHeight: popup.itemHeight,
    paddingInline: popup.itemPaddingX,
    color: popup.hint,
    fontWeight: 400,
    userSelect: 'none',
  },
  /** The strips that appear when a list is taller than the space it has. */
  scrollArrow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    height: popup.scrollArrowHeight,
    backgroundColor: popup.background,
    color: popup.hint,
    cursor: 'default',
    userSelect: 'none',
  },
});
