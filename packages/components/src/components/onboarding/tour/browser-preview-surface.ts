import * as stylex from '@stylexjs/stylex';
import { themeColors } from '../../../style/theme-colors.stylex';
import { themeRadius, themeSpace } from '../../../style/theme-scale.stylex';

/**
 * The browser the tour shows in the Browser beat.
 *
 * The preview is a fixture, so it is drawn from the product's own colours: the
 * app's background, the app's muted ink, the app's border.
 */
export const browserPreviewSurface = stylex.create({
  /** The page the preview stands in. */
  page: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    backgroundColor: themeColors.background,
  },
  /** The address bar across the top. */
  bar: {
    display: 'flex',
    flexShrink: 0,
    alignItems: 'center',
    gap: themeSpace[2],
    height: themeSpace[8],
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: 'hsl(var(--border) / 0.5)',
    paddingInline: themeSpace[2.5],
  },
  /** The address bar's own traffic light. */
  barDot: {
    width: themeSpace[1.5],
    height: themeSpace[1.5],
    borderRadius: themeRadius.full,
    backgroundColor: themeColors.codeAdded,
  },
  /** The address bar's own text. */
  address: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    borderRadius: themeRadius.full,
    backgroundColor: 'hsl(var(--muted) / 0.6)',
    paddingInline: themeSpace[2],
    paddingBlock: '0.125rem',
    fontSize: '11px',
    color: themeColors.mutedForeground,
  },
  /** The scrolling page under the address bar. */
  body: {
    position: 'relative',
    minHeight: 0,
    flexGrow: 1,
    overflow: 'hidden',
    padding: themeSpace[4],
  },
  /** The rows of the fixture page. */
  rows: { display: 'flex', flexDirection: 'column', gap: themeSpace[3] },
  /** The heading line of the fixture page. */
  headingLine: {
    height: themeSpace[3],
    width: themeSpace[24],
    borderRadius: themeRadius.full,
    backgroundColor: 'hsl(var(--muted-foreground) / 0.25)',
  },
  /** The subheading line of the fixture page. */
  subheadingLine: {
    height: themeSpace[2],
    width: '10rem',
    borderRadius: themeRadius.full,
    backgroundColor: 'hsl(var(--muted-foreground) / 0.15)',
  },
  /** The card of placeholder copy. */
  card: {
    marginTop: themeSpace[5],
    display: 'flex',
    flexDirection: 'column',
    gap: themeSpace[2],
    borderRadius: themeRadius.lg,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: 'hsl(var(--border) / 0.6)',
    padding: themeSpace[3],
  },
  /** The card's first line. */
  cardLineHead: {
    height: themeSpace[2.5],
    width: themeSpace[20],
    borderRadius: themeRadius.full,
    backgroundColor: 'hsl(var(--muted-foreground) / 0.2)',
  },
  /** The card's full-width line. */
  cardLineFull: {
    height: themeSpace[2],
    width: '100%',
    borderRadius: themeRadius.full,
    backgroundColor: 'hsl(var(--muted-foreground) / 0.1)',
  },
  /** The card's two-thirds line. */
  cardLineTwoThirds: {
    height: themeSpace[2],
    width: 'calc(2 / 3 * 100%)',
    borderRadius: themeRadius.full,
    backgroundColor: 'hsl(var(--muted-foreground) / 0.1)',
  },
  /** The target the annotation lands on. */
  target: {
    position: 'relative',
    marginTop: themeSpace[4],
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    height: themeSpace[20],
    borderRadius: themeRadius.lg,
    borderWidth: '1px',
    borderStyle: 'dashed',
    transitionProperty: 'color, background-color, border-color',
    transitionDuration: '300ms',
  },
  /** The target once it has been clicked. */
  targetActive: {
    borderColor: 'hsl(var(--primary) / 0.7)',
    backgroundColor: 'hsl(var(--primary) / 0.1)',
  },
  /** The target before it has been clicked. */
  targetIdle: {
    borderColor: 'hsl(var(--border) / 0.7)',
    color: 'hsl(var(--muted-foreground) / 0.5)',
  },
  /** The target's own label. */
  targetLabel: { fontSize: '11px' },
  /** The draft composer the annotation is typed into. */
  composer: {
    position: 'absolute',
    bottom: '18px',
    left: themeSpace[5],
    zIndex: 30,
    width: 'calc(100% - 40px)',
    maxWidth: 'none',
  },
});
