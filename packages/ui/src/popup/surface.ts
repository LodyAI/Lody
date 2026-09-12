import * as stylex from '@stylexjs/stylex';
import { corner, duration, ease, space, text, z } from '../tokens/scales.stylex';
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
  /**
   * A menu surface is not the width of what opened it.
   *
   * A list belongs to a control that shows the value it holds, so it takes
   * `--anchor-width` and the two read as one control. A menu is opened by
   * whatever happens to be there — often a 28px icon button — so it states its
   * own width and grows past it for the longest row.
   */
  popupMenu: {
    minWidth: popup.menuWidth,
    // A list keeps its scroll in `list`, between the two scroll arrows. A menu
    // has no such part — its rows are the popup's own children — so the popup
    // is the scrolling box, bounded by the `--available-height` it already has.
    overflowY: 'auto',
    overflowX: 'hidden',
  },
  /**
   * A popover surface: the same rung with content on it instead of rows.
   *
   * It replaces five declarations, the way `popupMenu` replaces one, and
   * `test/popover.test.tsx` pins that as a count so a sixth cannot appear
   * quietly. Two are layout: a list is the width of the control it belongs to
   * and insets by 4px so a row can reach its edge, while a popover is opened by
   * whatever the surface already had there and holds prose, which needs room
   * rather than a row's bleed. The other three are the type — size, weight and
   * tracking — stepping from the control rule to the prose rule, 14 at weight
   * 400, because what is in a popover is sentences rather than the labels of
   * commands. A control placed inside one brings its own step with it.
   */
  popupPanel: {
    minWidth: 'auto',
    gap: popup.panelGap,
    padding: popup.panelPadding,
    overflowY: 'auto',
    overflowX: 'hidden',
    fontSize: text.bodySize,
    lineHeight: text.bodyLeading,
    fontWeight: 400,
    letterSpacing: 'normal',
  },
  /** A popover's title and the sentence under it: one block, not two. */
  panelHeader: { display: 'flex', flexDirection: 'column', gap: space[1] },
  /**
   * The popover's heading. It is not a dialog title — the rules reserve
   * `headline` for a panel that owns the window — so it takes the control step
   * the surface around it already speaks in, at the weight that makes it a
   * heading.
   */
  panelTitle: {
    margin: 0,
    fontSize: popup.text,
    lineHeight: text.subheadlineLeading,
    fontWeight: 600,
    letterSpacing: text.controlTracking,
    color: popup.label,
  },
  /** What the heading is about, so the secondary label at the footnote step. */
  panelDescription: {
    margin: 0,
    fontSize: text.footnoteSize,
    lineHeight: text.footnoteLeading,
    fontWeight: 400,
    color: popup.description,
  },
  /** Where the rise starts and ends: 4px below the resting position. */
  popupHidden: { opacity: 0, transform: `translateY(${popup.rise})` },
  /**
   * The same 4px, on the other three sides.
   *
   * A Select list always opens below its trigger, so the rules could name one
   * direction. A menu flips to stay on screen and a submenu opens beside its
   * row, so the distance is stated against the anchor instead of against the
   * page: the popup starts one step further from what opened it and closes that
   * step as it arrives, whichever side it landed on.
   */
  popupHiddenAbove: { opacity: 0, transform: `translateY(calc(-1 * ${popup.rise}))` },
  popupHiddenAfter: { opacity: 0, transform: `translateX(${popup.rise})` },
  popupHiddenBefore: { opacity: 0, transform: `translateX(calc(-1 * ${popup.rise}))` },
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
    // A row owns its edge, which is no edge. Base UI moves DOM focus onto the
    // highlighted row, and the product shell puts an inset accent ring on any
    // focused `[tabindex]` through a zero-specificity `:where()` rule — it
    // already exempts `[role="menuitem"]` for this exact reason, and an option
    // is the same case. Stating `none` here means the row cannot pick up a ring
    // from any host: the fill is how this system says where the keyboard is.
    boxShadow: 'none',
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
   * The row that owns an open surface: a submenu trigger while its submenu is
   * up. It keeps the highlight it was given when the pointer moved onto it, so
   * the row the submenu belongs to does not go dark the moment the pointer
   * crosses into the submenu it opened.
   */
  itemOpen: { backgroundColor: popup.highlight },
  /**
   * A command that destroys something. It is the only row whose label is not
   * `popup.label`, and its highlight is mixed toward `destructive` so what the
   * keyboard is on stays the thing the row is about.
   */
  itemDestructive: { color: popup.destructive },
  itemDestructiveHighlighted: { backgroundColor: popup.destructiveHighlight },
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
  /**
   * The same box at the start of a menu row, holding whatever the caller gave
   * rather than a tick. It is the hint colour, because the rules put an icon at
   * rest with the chevron and the placeholder; the glyph inside it is sized by
   * this box, never by whatever an icon package decided its default was.
   */
  itemIcon: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    width: popup.indicatorSize,
    height: popup.indicatorSize,
    color: popup.hint,
    pointerEvents: 'none',
  },
  /** On a destructive row the icon is part of what the row says, not a hint. */
  itemIconInherit: { color: 'inherit' },
  /**
   * Trailing metadata: a keyboard shortcut, a count, a hint. It sits after the
   * label, which already takes the width, and never grows or shrinks with it.
   */
  itemShortcut: {
    flexShrink: 0,
    paddingInlineStart: space[3],
    color: popup.hint,
    fontSize: text.captionSize,
    lineHeight: text.captionLeading,
    fontWeight: 500,
    // A shortcut is a set of keys rather than a word: the glyphs line up in a
    // column when several rows carry one.
    fontVariantNumeric: 'tabular-nums',
    whiteSpace: 'nowrap',
  },
  /** The chevron that says a row opens a submenu. */
  itemSubmenuGlyph: { marginInlineEnd: `calc(-1 * ${popup.itemGap} / 2)` },
  /**
   * A menubar trigger: a menu row laid out along a bar instead of down a list.
   * It reads the same tokens as a row, so a bar and the menus it opens cannot
   * drift into two vocabularies.
   */
  barItem: {
    boxSizing: 'border-box',
    display: 'inline-flex',
    alignItems: 'center',
    gap: popup.itemGap,
    height: popup.itemHeight,
    paddingInline: popup.itemPaddingX,
    margin: 0,
    borderWidth: 0,
    borderStyle: 'none',
    borderRadius: popup.itemRadius,
    cornerShape: corner.shape,
    backgroundColor: 'transparent',
    color: popup.label,
    fontFamily: 'inherit',
    fontSize: popup.text,
    fontWeight: 500,
    letterSpacing: text.controlTracking,
    lineHeight: 1,
    cursor: 'default',
    userSelect: 'none',
    whiteSpace: 'nowrap',
    outlineStyle: 'none',
    boxShadow: 'none',
    opacity: { default: 1, ':disabled': 0.45 },
    transitionProperty: 'background-color, opacity',
    transitionDuration: duration.fast,
    transitionTimingFunction: ease.standard,
  },
  /** Hovered, or holding the menu that is currently up: the same one fill. */
  barItemOpen: { backgroundColor: popup.highlight },
  /** The bar itself: a row of triggers, on whatever rung the surface is. */
  bar: { display: 'flex', alignItems: 'center', gap: space[1] },
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
  /**
   * "No matches": a hint rather than a row, because it cannot be picked.
   *
   * Base UI keeps this element mounted whether or not the list is empty, so a
   * screen reader has a live region to announce the change into, and swaps its
   * children instead. It therefore has to take no room while it holds nothing,
   * or every popup opens with a blank row above its first item. `:empty` is the
   * right lever: the element stays rendered and in the accessibility tree, it
   * just has no height. Hiding it with `display: none`, `hidden` or
   * `aria-hidden` would take the live region out of the tree, which is what
   * Base UI warns against.
   */
  empty: {
    boxSizing: 'border-box',
    display: 'flex',
    alignItems: 'center',
    minHeight: { default: popup.itemHeight, ':empty': 0 },
    paddingInline: { default: popup.itemPaddingX, ':empty': 0 },
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

/** Which side of its anchor a popup landed on, as Base UI reports it. */
export type PopupSide = 'top' | 'bottom' | 'left' | 'right' | 'inline-start' | 'inline-end';

/**
 * The hidden end of the rise for the side a popup actually landed on.
 *
 * StyleX cannot express `[data-starting-style]`, so both ends of the transition
 * are read off Base UI's transition status in JS and the hidden one is a class
 * of its own. A list only ever opens below its trigger, so `popupHidden` alone
 * covers it; a menu flips to stay on screen and a submenu opens beside its row,
 * so the direction is chosen from the side rather than assumed.
 */
export function hiddenSurfaceForSide(side: PopupSide | 'none' | undefined) {
  if (side === 'top') return surface.popupHiddenAbove;
  if (side === 'right' || side === 'inline-end') return surface.popupHiddenAfter;
  if (side === 'left' || side === 'inline-start') return surface.popupHiddenBefore;
  return surface.popupHidden;
}
