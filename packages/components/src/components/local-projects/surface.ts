import * as stylex from '@stylexjs/stylex';
import { themeColors } from '../../style/theme-colors.stylex';
import {
  themeFontSize,
  themeFontWeight,
  themeLineHeight,
  themeRadius,
  themeSpace,
} from '../../style/theme-scale.stylex';

/**
 * The vocabulary the "add a local project" surfaces share.
 *
 * The desktop dialog and the mobile flow are the same surface at two sizes:
 * pick a machine, browse a folder, confirm it. They spell that the same way —
 * a row per machine, a quiet path bar, a hairline between records — so the
 * shared look lives here, beside the surfaces that use it, the way
 * `components/settings/surface.ts` holds the desktop settings family's shared
 * look.
 *
 * Sizes come from the theme's own scale (`themeSpace`), so a migrated row
 * keeps the rem geometry it had.
 */

/** Tailwind's `transition-colors`: colour properties only, 150ms, standard ease. */
const TRANSITION_COLORS = {
  transitionProperty: 'color, background-color, border-color, text-decoration-color, fill, stroke',
  transitionDuration: '150ms',
  transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
} as const;

export const localProjectsSurface = stylex.create({
  /**
   * The sheet's column: the title row, the scrolling body, the footer.
   */
  column: {
    display: 'flex',
    height: '100%',
    minHeight: 0,
    flexDirection: 'column',
  },

  /**
   * The title row: the back control, the centred title, the close control.
   */
  titleRow: {
    display: 'flex',
    alignItems: 'center',
    gap: themeSpace[1],
    paddingInline: themeSpace[2],
    paddingBottom: themeSpace[1.5],
    paddingTop: themeSpace[1],
  },
  /** The title itself: centred, and it truncates rather than pushing the row. */
  title: {
    minWidth: 0,
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    textAlign: 'center',
    fontSize: '0.95rem',
    fontWeight: themeFontWeight.semibold,
    lineHeight: themeSpace[6],
    color: themeColors.foreground,
  },
  /** The row's title in the body: the same face, one step down. */
  rowTitle: {
    display: 'block',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: '0.95rem',
    fontWeight: themeFontWeight.semibold,
    lineHeight: themeSpace[6],
    color: themeColors.foreground,
  },

  /**
   * A round control in the title row: the back arrow and the close cross.
   * It answers the pointer with a wash of the muted fill.
   */
  iconButton: {
    display: 'flex',
    width: themeSpace[11],
    height: themeSpace[11],
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: themeRadius.full,
    backgroundColor: { default: null, ':active': 'hsl(var(--muted) / 0.6)' },
  },
  /** The back arrow's ink: the foreground itself. */
  iconButtonForeground: { color: themeColors.foreground },
  /** The close cross's ink: the quieter one. */
  iconButtonMuted: { color: themeColors.mutedForeground },
  /** The gap the title row keeps where the back arrow would be. */
  iconButtonSpacer: {
    width: themeSpace[11],
    height: themeSpace[11],
    flexShrink: 0,
  },
  /** The glyph inside a round control. */
  iconGlyph: {
    width: themeSpace[5],
    height: themeSpace[5],
  },

  /**
   * The scrolling body: the machine list or the folder listing.
   */
  scroller: {
    minHeight: 0,
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
    overflowY: 'auto',
  },
  /** The scroller that also keeps clear of the home indicator. */
  scrollerSafeArea: {
    paddingBottom: 'var(--safe-area-bottom,0px)',
  },
  /** The scroller that holds its own overscroll. */
  scrollerOverscroll: { overscrollBehavior: 'contain' },

  /** The quiet line that says what to do next. */
  hint: {
    paddingInline: themeSpace[4],
    paddingBlock: themeSpace[2],
    fontSize: '0.8125rem',
    color: themeColors.mutedForeground,
  },
  /**
   * A notice the picker shows instead of a list: a machine that belongs to
   * somebody else, say. It is a wash of the muted fill with a quiet edge.
   */
  notice: {
    marginInline: themeSpace[4],
    marginBottom: themeSpace[2],
    display: 'flex',
    gap: themeSpace[2],
    borderRadius: themeRadius.lg,
    backgroundColor: 'hsl(var(--muted) / 0.6)',
    paddingInline: themeSpace[3],
    paddingBlock: themeSpace[2.5],
    fontSize: '0.8125rem',
    lineHeight: 1.375,
    color: themeColors.mutedForeground,
  },
  /** The notice's glyph: the lock that says why. */
  noticeGlyph: {
    marginTop: themeSpace[0.5],
    width: themeSpace[4],
    height: themeSpace[4],
    flexShrink: 0,
  },

  /**
   * The hairline between two records in a list.
   */
  separator: {
    marginInlineStart: '3.25rem',
    height: '1px',
    backgroundColor: 'hsl(var(--border) / 0.4)',
  },

  /**
   * A row in the machine list or the folder listing: the glyph, the name,
   * and what trails it.
   */
  row: {
    display: 'flex',
    width: '100%',
    alignItems: 'center',
    gap: themeSpace[3],
    paddingInline: themeSpace[4],
    paddingBlock: themeSpace[3.5],
    textAlign: 'left',
    ...TRANSITION_COLORS,
  },
  /** A row that answers the pointer. */
  rowActive: {
    backgroundColor: { default: null, ':active': 'hsl(var(--muted) / 0.5)' },
  },
  /** A row that cannot be picked. */
  rowDisabled: {
    cursor: 'not-allowed',
    opacity: 0.5,
  },
  /** The row's glyph: the machine, the folder, the file. */
  rowGlyph: {
    width: themeSpace[6],
    height: themeSpace[6],
    flexShrink: 0,
    color: themeColors.mutedForeground,
  },
  /** The row's name column: it takes the room and truncates. */
  rowText: {
    minWidth: 0,
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
  },
  /** The row's quiet second line. */
  rowName: {
    display: 'block',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: '0.8125rem',
    color: themeColors.mutedForeground,
  },
  /** The row's name, in the body size. */
  rowNameLarge: {
    display: 'block',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: '1.0625rem',
    color: themeColors.foreground,
  },
  /** A hidden entry's name steps back to the quiet ink. */
  rowNameHidden: { color: themeColors.mutedForeground },
  /** The row's trailing column: the online state and the owner note. */
  rowTrailing: {
    display: 'flex',
    flexShrink: 0,
    flexDirection: 'column',
    alignItems: 'flex-end',
    gap: themeSpace[1],
  },
  /** The row's trailing text. */
  rowTrailingText: {
    fontSize: '0.8125rem',
    color: themeColors.mutedForeground,
  },
  /** The trailing text that says the machine is reachable. */
  rowTrailingOnline: { color: 'var(--color-emerald-500)' },
  /** The note under the trailing text. */
  rowTrailingNote: {
    fontSize: themeFontSize.xs,
    lineHeight: themeLineHeight.xs,
    color: themeColors.mutedForeground,
  },
  /** The row's chevron, in the muted ink. */
  rowChevron: {
    width: themeSpace[5],
    height: themeSpace[5],
    flexShrink: 0,
    color: 'hsl(var(--muted-foreground) / 0.4)',
  },
  /** The row's chevron when there is nothing behind it. */
  rowChevronHidden: { visibility: 'hidden' },
  /** The row's lock, in the quieter ink. */
  rowLock: {
    width: themeSpace[5],
    height: themeSpace[5],
    flexShrink: 0,
    color: 'hsl(var(--muted-foreground) / 0.5)',
  },

  /**
   * The path bar: where the picker is, and the control that edits it.
   */
  pathBar: {
    display: 'flex',
    minHeight: '3.25rem',
    alignItems: 'center',
    gap: themeSpace[1],
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: 'hsl(var(--border) / 0.4)',
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: 'hsl(var(--border) / 0.4)',
    backgroundColor: 'hsl(var(--muted) / 0.2)',
    paddingInline: themeSpace[2],
    paddingBlock: themeSpace[1.5],
  },
  /** The path itself: it scrolls sideways rather than wrapping. */
  pathCrumbs: {
    display: 'flex',
    minHeight: themeSpace[10],
    minWidth: 0,
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
    alignItems: 'center',
    gap: themeSpace[0.5],
    overflow: 'hidden',
    whiteSpace: 'nowrap',
    fontSize: '0.9rem',
    color: themeColors.mutedForeground,
  },
  /** One crumb's slot in the path. */
  pathCrumbGroup: {
    display: 'flex',
    minWidth: 0,
    alignItems: 'center',
  },
  /** One crumb in the path. */
  pathCrumb: {
    display: 'flex',
    minWidth: 0,
    maxWidth: '8rem',
    alignItems: 'center',
    borderRadius: '0.25rem',
    paddingInline: themeSpace[1.5],
    paddingBlock: themeSpace[1],
    backgroundColor: { default: null, ':active': 'hsl(var(--muted) / 0.6)' },
    ...TRANSITION_COLORS,
  },
  /** The crumb the picker is in: it keeps the room it needs. */
  pathCrumbCurrent: {
    maxWidth: '10rem',
    fontWeight: themeFontWeight.medium,
    color: themeColors.foreground,
  },
  /** The crumb's glyph: the root's house. */
  pathCrumbGlyph: {
    width: themeSpace[4],
    height: themeSpace[4],
    flexShrink: 0,
  },
  /** The separator between two crumbs. */
  pathCrumbSeparator: {
    flexShrink: 0,
    paddingInline: themeSpace[0.5],
    color: 'hsl(var(--muted-foreground) / 0.4)',
  },
  /** The ellipsis that stands for the crumbs that did not fit. */
  pathCrumbEllipsis: {
    flexShrink: 0,
    paddingInline: themeSpace[1.5],
    paddingBlock: themeSpace[1],
    color: 'hsl(var(--muted-foreground) / 0.6)',
  },
  /** The crumb's label: it truncates rather than pushing the path. */
  truncate: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  /** The control that edits the path. */
  pathEditButton: {
    display: 'flex',
    width: themeSpace[9],
    height: themeSpace[9],
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: themeRadius.full,
    color: themeColors.mutedForeground,
    backgroundColor: { default: null, ':active': 'hsl(var(--muted) / 0.6)' },
    opacity: { default: null, ':disabled': 0.4 },
  },
  /** The glyph inside the edit control. */
  pathEditGlyph: {
    width: themeSpace[4],
    height: themeSpace[4],
  },
  /** A 16px glyph: a refresh arrow, a spinner in a control. */
  glyphSm: {
    width: themeSpace[4],
    height: themeSpace[4],
  },
  /** A 20px glyph: a spinner in the primary action. */
  glyphMd: {
    width: themeSpace[5],
    height: themeSpace[5],
  },
  /** The spinner's box beside the path. */
  pathSpinnerBox: {
    display: 'flex',
    width: themeSpace[9],
    height: themeSpace[9],
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  /** The spinner itself. */
  pathSpinner: {
    width: themeSpace[4],
    height: themeSpace[4],
    color: themeColors.mutedForeground,
  },

  /**
   * The control that accepts a typed path.
   */
  pathGoButton: {
    display: 'flex',
    width: themeSpace[10],
    height: themeSpace[10],
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: themeRadius.full,
    color: themeColors.primary,
    backgroundColor: { default: null, ':active': 'hsl(var(--muted) / 0.6)' },
  },
  /** The glyph inside the accept control. */
  pathGoGlyph: {
    width: themeSpace[5],
    height: themeSpace[5],
  },

  /**
   * The drives a Windows machine offers, one pill each.
   */
  drives: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: themeSpace[1.5],
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: 'hsl(var(--border) / 0.4)',
    paddingInline: themeSpace[3],
    paddingBlock: themeSpace[2],
  },
  /** One drive pill. */
  drive: {
    display: 'flex',
    alignItems: 'center',
    gap: themeSpace[1.5],
    borderRadius: themeRadius.full,
    backgroundColor: { default: 'hsl(var(--muted) / 0.5)', ':active': 'hsl(var(--muted) / 0.7)' },
    paddingInline: themeSpace[3],
    paddingBlock: themeSpace[1.5],
    fontSize: '0.8125rem',
  },
  /** The drive's glyph. */
  driveGlyph: {
    width: themeSpace[3.5],
    height: themeSpace[3.5],
  },

  /**
   * The listing that is being navigated: it dims while a new folder loads.
   */
  listing: {
    transitionProperty: 'opacity',
    transitionDuration: '150ms',
    transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
  },
  /** The listing while it is dimmed. */
  listingNavigating: {
    pointerEvents: 'none',
    opacity: 0.5,
  },
  /** The row that goes up one folder. */
  parentRow: {
    display: 'flex',
    width: '100%',
    alignItems: 'center',
    gap: themeSpace[3],
    paddingInline: themeSpace[4],
    paddingBlock: themeSpace[3.5],
    textAlign: 'left',
    color: themeColors.mutedForeground,
    backgroundColor: { default: null, ':active': 'hsl(var(--muted) / 0.5)' },
    ...TRANSITION_COLORS,
  },
  /** The parent row's glyph. */
  parentGlyph: {
    width: themeSpace[6],
    height: themeSpace[6],
    flexShrink: 0,
  },
  /** The parent row's label. */
  parentLabel: { fontSize: '1.0625rem' },
  /** The row that loads more of a truncated listing. */
  loadMoreRow: {
    display: 'flex',
    width: '100%',
    alignItems: 'center',
    justifyContent: 'center',
    gap: themeSpace[2],
    paddingInline: themeSpace[4],
    paddingBlock: themeSpace[3.5],
    fontSize: '0.95rem',
    color: themeColors.mutedForeground,
    backgroundColor: { default: null, ':active': 'hsl(var(--muted) / 0.5)' },
  },
  /** The empty listing's line. */
  emptyListing: {
    paddingInline: themeSpace[4],
    paddingBlock: themeSpace[12],
    textAlign: 'center',
    fontSize: '0.95rem',
    color: themeColors.mutedForeground,
  },

  /**
   * The footer's rule and its content: the create form and the Add button.
   */
  footer: {
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: 'hsl(var(--border) / 0.6)',
    paddingInline: themeSpace[4],
    paddingBottom: 'max(0.75rem,var(--safe-area-bottom,0px))',
    paddingTop: themeSpace[3],
  },
  /** The footer's error line. */
  footerError: {
    marginBottom: themeSpace[2],
    textAlign: 'left',
    fontSize: '0.8rem',
    color: themeColors.destructive,
  },

  /**
   * The loading rows: the skeleton of a list that has not arrived yet.
   */
  skeletonBody: {
    paddingBlock: themeSpace[1],
  },
  /** One skeleton row. */
  skeletonRow: {
    display: 'flex',
    alignItems: 'center',
    gap: themeSpace[3],
    paddingInline: themeSpace[4],
    paddingBlock: themeSpace[3.5],
  },

  /**
   * The status panel: the centred icon, the title, the description.
   */
  statusPanel: {
    display: 'flex',
    minHeight: 0,
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: themeSpace[3],
    padding: themeSpace[10],
    textAlign: 'center',
  },
  /** The status panel's glyph. */
  statusGlyph: {
    width: themeSpace[9],
    height: themeSpace[9],
    color: themeColors.mutedForeground,
  },
  /** The status panel's title. */
  statusTitle: {
    fontSize: '1.0625rem',
    fontWeight: themeFontWeight.medium,
    color: themeColors.foreground,
  },
  /** The status panel's description. */
  statusDescription: {
    maxWidth: '20rem',
    fontSize: '0.9rem',
    color: themeColors.mutedForeground,
  },
  /** The status panel's action. */
  statusAction: { marginTop: themeSpace[1] },
});
