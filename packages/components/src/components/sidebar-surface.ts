import * as stylex from '@stylexjs/stylex';
import { control, corner, radius, space, text } from '@lody/ui/tokens/scales.stylex';
import { sidebar } from './sidebar.tokens.stylex';

/**
 * What every sidebar row shares: its box, its resting ink, its hover and
 * selected fills. A conversation row, a repo row and a navigation row are the
 * same object at different weights, so none of them states its own radius or
 * colour. Type sizes stay in `sidebar-row-shared.tsx`'s roles; a style here
 * never repeats a property a role sets, because two StyleX classes on one
 * element have no defined order.
 *
 * Unmigrated ancestor-state hooks stay with the callers: the named `group/row`
 * that reveals trailing actions, `data-[menu-open]` and the keyboard focus ring.
 */
export const sidebarSurface = stylex.create({
  row: {
    borderRadius: radius.small,
    cornerShape: corner.shape,
    paddingInline: space[2],
    color: sidebar.rowText,
  },
  /**
   * One title line. A row is border + padding around it, and the tree connector
   * measures that box (`session-row-leading-slot.tsx`), so every row type draws
   * its title, leading slot and end slot in a box this tall rather than a fixed
   * `h-5` that drifts from the type scale.
   */
  line: { height: text.subheadlineLeading },
  /**
   * A one-line row and a row carrying a second line. The one-line row pads 3px
   * (off the space scale on purpose, like `navInset`): 26px at the default size,
   * so the conversation list reads denser than the 28px it was.
   */
  snug: { paddingBlock: 3 },
  tall: { paddingBlock: space[1.5] },
  /** A desktop navigation row: its 20px icon slot plus 4px padding is 28px, the same as a Workspace conversation row. */
  navSnug: { paddingBlock: space[1] },
  /** Navigation rows have no transparent border, so they pad 1px wider to keep the icon column. */
  navInset: { paddingInline: 9 },
  navAction: { paddingInlineEnd: space[8] },
  /**
   * The footer's workspace row: as tall as the footer's icon buttons at any
   * interface font size (a navigation row grows with its text). The footer pads
   * 12px each side, so 6px here puts the avatar 18px from the edge, the same as
   * the Settings glyph on the right.
   */
  footerRow: { height: control.small, paddingBlock: 0, paddingInline: 6 },
  /**
   * An icon-only control in the header or footer. It rests as quiet as a
   * navigation row's icon and comes up to the row's ink with the hover fill, so
   * the window's top and bottom edges read as one family. Pair with `selected`
   * for the current page; its colour and fill replace these by property.
   */
  iconButton: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    width: control.small,
    height: control.small,
    padding: 0,
    borderWidth: 0,
    borderRadius: radius.small,
    cornerShape: corner.shape,
    backgroundColor: { default: 'transparent', ':hover': sidebar.hoverFill },
    color: { default: sidebar.mutedText, ':hover': sidebar.rowText },
  },
  hover: {
    backgroundColor: { default: 'transparent', ':hover': sidebar.hoverFill },
  },
  selected: {
    backgroundColor: sidebar.selectedFill,
    color: sidebar.selectedText,
  },
  /** A repo or project row: the heading over its conversations. */
  heading: { fontWeight: 500 },
  /** A conversation title: one clipped line, regular weight. */
  title: {
    minWidth: 0,
    flexGrow: 1,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontWeight: 400,
    color: sidebar.rowText,
  },
  titleSelected: { color: sidebar.selectedText },
  meta: { color: sidebar.mutedText },
  faint: { color: sidebar.faintText },
});

export const SIDEBAR_ROW_LINE_CLASS = stylex.props(sidebarSurface.line).className;
