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
 * The visual vocabulary the mobile bottom sheets share.
 *
 * The sheets in this folder are one family — the filter drawer, the session
 * menu, the tabs sheet, the ACP history sheet, the workspace sheets — and they
 * spell their chrome the same way: a header row with a centred title and a
 * close chip on the right, a body that scrolls, a footer that sits on a rule,
 * and rows inside one recessed card.
 *
 * That shared look lives here, beside the sheets that use it, the way
 * `components/settings/surface.ts` holds the desktop settings family's shared
 * look. A sheet's own vocabulary (its rows, its fields) stays in the sheet.
 *
 * Sizes come from the theme's own scale (`themeSpace`), so a migrated sheet
 * keeps the rem geometry it had.
 */

/** Tailwind's `transition-colors`: colour properties only, 150ms, standard ease. */
const TRANSITION_COLORS = {
  transitionProperty: 'color, background-color, border-color, text-decoration-color, fill, stroke',
  transitionDuration: '150ms',
  transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
} as const;

export const sheetSurface = stylex.create({
  /** The sheet's column: header, scrolling body, footer. */
  column: {
    display: 'flex',
    height: '100%',
    minHeight: 0,
    flexDirection: 'column',
  },
  /** The sheet's column, sized by its own content instead of the drawer. */
  columnAuto: {
    display: 'flex',
    maxHeight: '100%',
    minHeight: 0,
    flexDirection: 'column',
  },

  /** The header row: the title, and the chips that sit on its edges. */
  header: {
    position: 'relative',
    display: 'flex',
    alignItems: 'center',
    paddingInline: themeSpace[4],
    paddingTop: themeSpace[2],
    paddingBottom: themeSpace[2],
  },
  /** A header that must not be squeezed by the body below it. */
  headerShrink: { flexShrink: 0 },
  /** A header whose title needs the full width, so the edges move outward. */
  headerWide: { paddingInline: themeSpace[12] },

  /** The sheet's title. */
  title: {
    fontSize: '0.95rem',
    fontWeight: themeFontWeight.semibold,
    letterSpacing: '-0.025em',
  },
  /** A title centred in the header. */
  titleCentered: { marginInline: 'auto' },
  /** A title that takes the header's whole width and centres its own text. */
  titleFull: { width: '100%', textAlign: 'center' },

  /**
   * The round chip in a header's corner — the close button, the back button.
   * It answers the pointer with a wash of the muted fill and steps its ink up
   * to the foreground.
   */
  iconButton: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: themeSpace[9],
    height: themeSpace[9],
    borderRadius: themeRadius.full,
    color: { default: themeColors.mutedForeground, ':hover': themeColors.foreground },
    backgroundColor: { default: 'transparent', ':hover': 'hsl(var(--muted) / 0.6)' },
    ...TRANSITION_COLORS,
  },
  /** A chip parked in the header's trailing corner. */
  iconButtonRight: { position: 'absolute', top: themeSpace[1.5], right: themeSpace[3] },
  /** A chip parked in the header's leading corner. */
  iconButtonLeft: { position: 'absolute', top: themeSpace[1.5], left: themeSpace[3] },
  /** A chip parked closer to the header's leading edge. */
  iconButtonLeftTight: { position: 'absolute', top: themeSpace[1.5], left: themeSpace[2] },
  /** A chip that steps back while its sheet is busy. */
  iconButtonDisabled: {
    opacity: { default: 1, ':disabled': 0.5 },
    pointerEvents: { default: null, ':disabled': 'none' },
  },

  /** The sheet's scrolling body, clear of the home indicator. */
  body: {
    minHeight: 0,
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
    overflowY: 'auto',
    paddingInline: themeSpace[3],
    paddingTop: themeSpace[3],
    paddingBottom: 'calc(16px + var(--safe-area-bottom, 0px))',
  },

  /** The footer's answers, on a rule that separates them from the body. */
  footer: {
    display: 'flex',
    flexShrink: 0,
    alignItems: 'center',
    gap: themeSpace[2],
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: 'hsl(var(--border) / 0.4)',
    paddingInline: themeSpace[4],
    paddingTop: themeSpace[3],
  },
  /** A footer that keeps clear of the home indicator. */
  footerPadSafe: { paddingBottom: 'calc(12px + max(0px, var(--safe-area-bottom, 0px)))' },
  /** A footer that gives the safe-area inset back while the keyboard is up. */
  footerPadKeyboard: {
    paddingBottom:
      'calc(12px + max(0px, var(--safe-area-bottom, 0px) - var(--native-keyboard-height, 0px)))',
  },

  /**
   * The recessed card the sheet's records live in: the card fill, a hairline
   * ring, and rounded corners.
   */
  card: {
    display: 'flex',
    flexDirection: 'column',
    borderRadius: themeRadius.xl,
    backgroundColor: themeColors.card,
    boxShadow: '0 0 0 1px hsl(var(--border) / 0.6)',
  },
  /**
   * One record of a card. Every record but the last carries a hairline
   * beneath it — the card's `divide-y` — and the first and the last round
   * with the card's own corners.
   */
  cardChild: {
    borderBottomWidth: { default: '0px', ':not(:last-child)': '1px' },
    borderBottomStyle: { default: 'none', ':not(:last-child)': 'solid' },
    borderBottomColor: 'hsl(var(--border) / 0.4)',
  },
  cardRow: {
    display: 'flex',
    width: '100%',
    alignItems: 'center',
    userSelect: 'none',
    gap: themeSpace[3],
    paddingInline: themeSpace[3.5],
    paddingTop: themeSpace[2.5],
    paddingBottom: themeSpace[2.5],
    textAlign: 'left',
    borderBottomWidth: { default: '0px', ':not(:last-child)': '1px' },
    borderBottomStyle: { default: 'none', ':not(:last-child)': 'solid' },
    borderBottomColor: 'hsl(var(--border) / 0.4)',
    borderTopLeftRadius: { default: '0px', ':first-child': themeRadius.xl },
    borderTopRightRadius: { default: '0px', ':first-child': themeRadius.xl },
    borderBottomLeftRadius: { default: '0px', ':last-child': themeRadius.xl },
    borderBottomRightRadius: { default: '0px', ':last-child': themeRadius.xl },
  },
  /** A card record set in the sheet's own body size. */
  cardRowText: {
    fontSize: themeFontSize.sm,
    lineHeight: themeLineHeight.sm,
  },

  /** An icon that must not be squeezed by the row around it. */
  shrink0: { flexShrink: 0 },

  /** Said to a screen reader and to nobody else. */
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

  /** The glyph sizes the sheets draw their icons at. */
  glyph12: { width: themeSpace[3], height: themeSpace[3] },
  glyph14: { width: themeSpace[3.5], height: themeSpace[3.5] },
  glyph16: { width: themeSpace[4], height: themeSpace[4] },
  glyph20: { width: themeSpace[5], height: themeSpace[5] },
  glyph24: { width: themeSpace[6], height: themeSpace[6] },
});
