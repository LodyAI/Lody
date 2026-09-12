import * as stylex from '@stylexjs/stylex';
import { corner, duration, ease, radius, space, text, z } from '../tokens/scales.stylex';
import { feedback } from './feedback.tokens.stylex';

/**
 * What a message is made of, and what a wait looks like.
 *
 * An Alert and a Toast are the same block — a mark, a title, a sentence under
 * it, and whatever answers it — on two rungs of the ladder. The block lives
 * here so the two cannot drift into two messages, the way `popup/surface.ts`
 * keeps every floating surface one surface.
 *
 * A tone is a tint and a mark, never a fill. The tint is mixed here rather than
 * frozen into a token, because it is a mix *of a surface* and the two surfaces
 * are on different rungs: an Alert sits on the card rung and a Toast on the
 * floating one, so the same 8% of the same tone has to be taken from two
 * different backgrounds or one of them stops looking like its own rung.
 */
const TINT = '8%';

/** Content that has not arrived yet, breathing so it reads as pending. */
const pulse = stylex.keyframes({
  '0%, 100%': { opacity: 1 },
  '50%': { opacity: 0.55 },
});

/**
 * A bar with no end in sight: a band that crosses the track and returns. The
 * far end is 250% of the band's own width, which is where a 40% band's leading
 * edge reaches the end of the track — past that it is off the track and the
 * bar reads as stopped for the rest of the cycle.
 */
const sweep = stylex.keyframes({
  from: { transform: 'translateX(-100%)' },
  to: { transform: 'translateX(250%)' },
});

const spin = stylex.keyframes({
  from: { transform: 'rotate(0deg)' },
  to: { transform: 'rotate(360deg)' },
});

export const feedbackSurface = stylex.create({
  // ── The message ──────────────────────────────────────────────────────────
  /** The block: the mark, and the words beside it. */
  message: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: feedback.gap,
    boxSizing: 'border-box',
    padding: feedback.padding,
    borderRadius: feedback.noticeRadius,
    cornerShape: corner.shape,
  },
  /** An Alert: kept on the page it is about, on the card rung. */
  notice: {
    width: '100%',
    backgroundColor: feedback.noticeBackground,
    boxShadow: feedback.noticeShadow,
  },
  /**
   * A message with nothing to report in colour still has to read as a block of
   * its own, and an Alert is the one part of this family that shares its rung
   * with what it sits on: a card inside a card is the same fill twice, and in
   * the light palette the card rung and the page are the same white. So the
   * neutral tone takes a tint too, toward `label` — the derivation a popup's
   * highlight already uses when a named fill collapses into its surface. A
   * Toast needs none: nothing else is ever on the floating rung beside it.
   */
  noticeNeutral: {
    backgroundColor: `color-mix(in oklab, ${feedback.noticeBackground}, ${feedback.title} 4%)`,
  },
  noticeSuccess: {
    backgroundColor: `color-mix(in oklab, ${feedback.noticeBackground}, ${feedback.success} ${TINT})`,
  },
  noticeWarning: {
    backgroundColor: `color-mix(in oklab, ${feedback.noticeBackground}, ${feedback.warning} ${TINT})`,
  },
  noticeDanger: {
    backgroundColor: `color-mix(in oklab, ${feedback.noticeBackground}, ${feedback.danger} ${TINT})`,
  },
  /** A Toast: the same message arriving over the page, on the floating rung. */
  toast: {
    width: feedback.toastWidth,
    maxWidth: '100%',
    backgroundColor: feedback.toastBackground,
    boxShadow: feedback.toastShadow,
    // The list is laid out by the viewport; a toast that is being dragged
    // carries the distance Base UI measured.
    translate: 'var(--toast-swipe-movement-x, 0) var(--toast-swipe-movement-y, 0)',
    opacity: 1,
    pointerEvents: 'auto',
    transitionProperty: 'opacity, translate',
    transitionDuration: duration.regular,
    transitionTimingFunction: ease.standard,
  },
  toastSuccess: {
    backgroundColor: `color-mix(in oklab, ${feedback.toastBackground}, ${feedback.success} ${TINT})`,
  },
  toastWarning: {
    backgroundColor: `color-mix(in oklab, ${feedback.toastBackground}, ${feedback.warning} ${TINT})`,
  },
  toastDanger: {
    backgroundColor: `color-mix(in oklab, ${feedback.toastBackground}, ${feedback.danger} ${TINT})`,
  },
  /**
   * The two ends of a toast's arrival, which is the rise rule applied from the
   * edge the toast appears at: 4px above, at opacity 0. It arrives from above
   * rather than from below because a thing sliding up out of the window's top
   * edge reads as leaving. StyleX cannot express `[data-starting-style]`, so
   * which end a toast is at is read off Base UI's transition status in JS, the
   * way a popover's rise and an accordion's reveal already are.
   */
  toastHidden: { opacity: 0, translate: '0 -4px' },
  /**
   * A toast dismissed by a finger leaves along the finger, so only the opacity
   * is taken here — replacing the translate would snap it back to the top edge
   * halfway through the gesture that is removing it.
   */
  toastFading: { opacity: 0 },
  /** While a finger is on it, the toast is where the finger is, with no lag. */
  toastSwiping: { transitionProperty: 'none' },
  /**
   * The mark. It is the tone's, not the caller's: the point of a tone is that a
   * person knows what kind of message this is before reading it, and a glyph a
   * caller chose can put a tick on a failure.
   */
  mark: {
    display: 'block',
    flexShrink: 0,
    width: feedback.markSize,
    height: feedback.markSize,
    // The title sits on an 18px line and the mark is 16, so it rides one pixel
    // down to sit on the same optical line rather than on the box's top.
    marginBlockStart: '1px',
    color: feedback.mark,
  },
  markSuccess: { color: feedback.success },
  markWarning: { color: feedback.warning },
  markDanger: { color: feedback.danger },
  /** The words: a title, the sentence under it, and what answers them. */
  body: {
    display: 'flex',
    flexDirection: 'column',
    gap: space[1],
    minWidth: 0,
    flexGrow: 1,
  },
  title: {
    margin: 0,
    color: feedback.title,
    fontSize: feedback.titleSize,
    lineHeight: feedback.titleLeading,
    fontWeight: 600,
    letterSpacing: text.controlTracking,
  },
  description: {
    margin: 0,
    color: feedback.description,
    fontSize: feedback.descriptionSize,
    lineHeight: feedback.descriptionLeading,
    fontWeight: 400,
  },
  actions: {
    display: 'flex',
    alignItems: 'center',
    gap: space[2],
    marginBlockStart: space[1],
  },
  /**
   * The viewport a toast list is laid out in. It takes no pointer, so the page
   * under it stays usable while a message is showing; each toast takes its own
   * back. The safe area is read with `env()` for the reason the dialog's is:
   * a shared package cannot depend on a host publishing a variable.
   */
  viewport: {
    position: 'fixed',
    insetBlockStart: `calc(${feedback.viewportInset} + env(safe-area-inset-top, 0px))`,
    insetInlineStart: '50%',
    translate: '-50% 0',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: feedback.toastGap,
    width: feedback.toastWidth,
    maxWidth: `calc(100vw - 2 * ${feedback.viewportInset})`,
    zIndex: z.toast,
    pointerEvents: 'none',
    outlineStyle: 'none',
  },

  // ── The wait ─────────────────────────────────────────────────────────────
  progress: {
    display: 'flex',
    flexDirection: 'column',
    gap: space[1],
    minWidth: 0,
  },
  progressHeader: {
    display: 'flex',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: space[2],
    fontSize: feedback.descriptionSize,
    lineHeight: feedback.descriptionLeading,
  },
  progressLabel: { color: feedback.title, fontWeight: 500 },
  progressValue: { color: feedback.description, fontVariantNumeric: 'tabular-nums' },
  /** The track is the well rung, and the bar in it is the one live thing. */
  track: {
    position: 'relative',
    overflow: 'hidden',
    width: '100%',
    height: feedback.trackHeight,
    backgroundColor: feedback.trackBackground,
    boxShadow: feedback.trackWell,
    borderRadius: radius.full,
    // A pill takes the round corner: a squircle at this radius is a
    // superellipse rather than a stadium.
    cornerShape: corner.round,
  },
  indicator: {
    position: 'absolute',
    insetBlockStart: 0,
    insetBlockEnd: 0,
    backgroundColor: feedback.indicator,
    borderRadius: radius.full,
    cornerShape: corner.round,
    transitionProperty: 'width',
    transitionDuration: duration.regular,
    transitionTimingFunction: ease.standard,
  },
  /**
   * A bar that is not reporting live progress but an outcome, or a measure. The
   * colour is the family's tone rather than a second palette: a quota nearly
   * spent is the same warning an Alert would carry, and a bar of a thing that
   * is merely counted — storage used, sessions left — is not live at all, so it
   * gives `accent` back.
   */
  indicatorNeutral: { backgroundColor: feedback.mark },
  indicatorSuccess: { backgroundColor: feedback.success },
  indicatorWarning: { backgroundColor: feedback.warning },
  indicatorDanger: { backgroundColor: feedback.danger },
  /**
   * No value to show, so the bar says "still working" instead of "this far".
   * Base UI leaves the inline width unset when the value is null, which is what
   * leaves this style free to set one.
   */
  indicatorIndeterminate: {
    width: '40%',
    transitionProperty: 'none',
    animationName: sweep,
    animationDuration: '1400ms',
    animationTimingFunction: ease.standard,
    animationIterationCount: 'infinite',
  },

  /**
   * Content that has not arrived. It breathes rather than sweeping, because a
   * page of sweeping blocks is a page of movement; and it stops breathing where
   * a person asked for less of it, since nothing here is being reported that
   * the shape itself does not already say.
   */
  skeleton: {
    display: 'block',
    flexShrink: 0,
    backgroundColor: feedback.skeleton,
    animationName: {
      default: pulse,
      '@media (prefers-reduced-motion: reduce)': 'none',
    },
    animationDuration: '1600ms',
    animationTimingFunction: ease.standard,
    animationIterationCount: 'infinite',
  },
  skeletonLine: {
    // A line of text that has not arrived is as tall as the line it will be.
    height: text.bodyLeading,
    borderRadius: radius.mini,
    cornerShape: corner.shape,
  },
  skeletonBlock: { borderRadius: radius.medium, cornerShape: corner.shape },
  skeletonCircle: { borderRadius: radius.full, cornerShape: corner.round },

  /**
   * The spinner, in `currentColor`: it takes the ink of whatever holds it, so a
   * ghost button's label and a page's secondary text each get a mark that
   * belongs to them. The ring behind the arc is the same colour at a quarter,
   * which is one declaration rather than a token per context.
   */
  spinner: {
    display: 'block',
    flexShrink: 0,
    color: 'inherit',
    // A presentation attribute cannot hold a `var()`, so the one measurement
    // both the ring and the arc take is declared here instead.
    strokeWidth: feedback.spinnerWidth,
    animationName: spin,
    animationDuration: '900ms',
    animationTimingFunction: 'linear',
    animationIterationCount: 'infinite',
  },
  spinnerSmall: { width: feedback.spinnerSmall, height: feedback.spinnerSmall },
  spinnerMedium: { width: feedback.spinnerMedium, height: feedback.spinnerMedium },
  spinnerLarge: { width: feedback.spinnerLarge, height: feedback.spinnerLarge },
});

/**
 * Whether a toast is at one of the two ends of its arrival. Base UI reports the
 * ends as `data-starting-style` and `data-ending-style`, which StyleX has no way
 * to select, so the status is read here instead — the same reading the
 * disclosure family's panel makes.
 */
export function isHidden(transitionStatus: string | undefined): boolean {
  return transitionStatus === 'starting' || transitionStatus === 'ending';
}
