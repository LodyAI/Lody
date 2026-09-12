import * as stylex from '@stylexjs/stylex';
import { control, corner, duration, ease, space, z } from '../tokens/scales.stylex';
import { dialog } from './dialog.tokens.stylex';

/**
 * The appearance every surface on the modal rung shares: the overlay under it,
 * the panel itself, and the header, body and footer a caller lays out on it. It
 * lives here rather than on one component so Dialog, AlertDialog and Sheet
 * cannot each grow their own padding, radius and title step, the way
 * `popup/surface.ts` keeps the floating surfaces together and `field/well.ts`
 * keeps the controls on the well rung together.
 *
 * The modal rung is the one rung that states three things at once: the elevated
 * background, the large shadow, and an overlay over the page. A dialog covers
 * what a person was doing and still shows it, so the page has to recede rather
 * than merely sit behind something.
 */
export const modal = stylex.create({
  /**
   * The overlay. It is `position: fixed` with `min-height: 100dvh` because on
   * iOS the visual viewport and the layout viewport disagree while the URL bar
   * is retracting, and a backdrop sized to the layout viewport leaves a band of
   * page showing under it.
   */
  backdrop: {
    position: 'fixed',
    inset: 0,
    minHeight: '100dvh',
    backgroundColor: dialog.overlay,
    opacity: 1,
    transitionProperty: 'opacity',
    transitionDuration: duration.regular,
    transitionTimingFunction: ease.standard,
    zIndex: z.dialogBackdrop,
  },
  /** Both ends of the backdrop's fade. */
  backdropHidden: { opacity: 0 },
  /**
   * The panel: centred, capped, and inset from the window by `dialog.inset` on
   * every side so it never reaches an edge. The safe-area insets are added to
   * the vertical cap and shift the centre, so on a device with a notch and a
   * home indicator the panel sits between them rather than under either; on a
   * desktop browser every `env()` here resolves to 0 and the panel is centred.
   */
  popup: {
    boxSizing: 'border-box',
    position: 'fixed',
    // Every inset in this file is a logical longhand, and deliberately so.
    // StyleX keeps one class per property *key*, and it has no idea that `top`,
    // `inset-block-start` and `inset-block` are three names for one thing — so a
    // sheet resetting `top: auto` over a `inset-block: 0` produced two
    // declarations and the cascade, not the author, picked the winner. It picked
    // `top`, and the sheet collapsed to the height of its own content at the
    // bottom of the window. One vocabulary, longhands only, is what makes "the
    // last style wins" true here.
    insetInlineStart: '50%',
    insetInlineEnd: 'auto',
    insetBlockStart: `calc(50% + (env(safe-area-inset-top, 0px) - env(safe-area-inset-bottom, 0px)) / 2)`,
    insetBlockEnd: 'auto',
    display: 'flex',
    flexDirection: 'column',
    gap: dialog.gap,
    width: dialog.width,
    maxWidth: `calc(100vw - ${dialog.inset})`,
    maxHeight: `calc(100dvh - ${dialog.inset} - env(safe-area-inset-top, 0px) - env(safe-area-inset-bottom, 0px))`,
    padding: dialog.padding,
    backgroundColor: dialog.background,
    boxShadow: dialog.shadow,
    borderRadius: dialog.radius,
    cornerShape: corner.shape,
    color: dialog.title,
    // A panel that owns the window declares its own edge, which is no edge: the
    // product shell rings any focused element through a zero-specificity
    // `:where()` rule, and Base UI moves focus into the popup when it opens.
    // The shadow and the overlay are how this system separates a modal from the
    // page; a ring around the whole panel would say the panel is a control.
    outlineStyle: 'none',
    transform: 'translate(-50%, -50%)',
    opacity: 1,
    transitionProperty: 'opacity, transform',
    transitionDuration: duration.regular,
    transitionTimingFunction: ease.standard,
    zIndex: z.dialog,
  },
  /**
   * Where the rise starts and ends.
   *
   * The motion rule puts a popup 4px below its resting position at opacity 0.
   * A dialog is centred rather than anchored, so the same 4px is composed into
   * the centring transform: CSS has one `transform` property, and a second
   * class setting only `translateY` would replace the centring rather than add
   * to it — the panel would leap to the window's bottom-right as it faded.
   */
  popupHidden: {
    opacity: 0,
    transform: `translate(-50%, calc(-50% + ${dialog.rise}))`,
  },
  /**
   * A sheet is the same panel arriving from an edge instead of the middle, so
   * it drops the centring entirely: it is pinned to two or three sides and
   * slides along the axis it came in on.
   */
  sheet: {
    transform: 'none',
    maxWidth: 'none',
    maxHeight: 'none',
    width: 'auto',
  },
  /**
   * Each edge states all four insets, rather than setting the two it cares
   * about and leaving the others to a reset. A style that only sets what it
   * needs depends on the one before it having cleared the rest, which is the
   * shape that produced the collapsed sheet; stating four is four lines and no
   * dependency.
   */
  sheetTop: {
    insetBlockStart: 0,
    insetBlockEnd: 'auto',
    insetInlineStart: 0,
    insetInlineEnd: 0,
    maxHeight: `calc(100dvh - ${dialog.inset})`,
    paddingBlockStart: `calc(${dialog.padding} + env(safe-area-inset-top, 0px))`,
    borderStartStartRadius: 0,
    borderStartEndRadius: 0,
  },
  sheetBottom: {
    insetBlockStart: 'auto',
    insetBlockEnd: 0,
    insetInlineStart: 0,
    insetInlineEnd: 0,
    maxHeight: `calc(100dvh - ${dialog.inset})`,
    paddingBlockEnd: `calc(${dialog.padding} + env(safe-area-inset-bottom, 0px))`,
    borderEndStartRadius: 0,
    borderEndEndRadius: 0,
  },
  sheetStart: {
    insetBlockStart: 0,
    insetBlockEnd: 0,
    insetInlineStart: 0,
    insetInlineEnd: 'auto',
    width: dialog.sheetSize,
    maxWidth: `calc(100vw - ${dialog.inset})`,
    paddingInlineStart: `calc(${dialog.padding} + env(safe-area-inset-left, 0px))`,
    borderStartStartRadius: 0,
    borderEndStartRadius: 0,
  },
  sheetEnd: {
    insetBlockStart: 0,
    insetBlockEnd: 0,
    insetInlineStart: 'auto',
    insetInlineEnd: 0,
    width: dialog.sheetSize,
    maxWidth: `calc(100vw - ${dialog.inset})`,
    paddingInlineEnd: `calc(${dialog.padding} + env(safe-area-inset-right, 0px))`,
    borderStartEndRadius: 0,
    borderEndEndRadius: 0,
  },
  /**
   * A sheet's hidden end: fully off the edge it came in on, rather than 4px
   * below. The rise says a popup arrives from where it belongs; for a sheet
   * that is outside the window, which is also the only motion that reads as
   * "this came in from there" rather than "this faded in near the edge".
   */
  sheetHiddenTop: { opacity: 0, transform: 'translateY(-100%)' },
  sheetHiddenBottom: { opacity: 0, transform: 'translateY(100%)' },
  sheetHiddenStart: { opacity: 0, transform: 'translateX(-100%)' },
  sheetHiddenEnd: { opacity: 0, transform: 'translateX(100%)' },
  /** The title and the sentence under it: one block, so one gap. */
  header: { display: 'flex', flexDirection: 'column', gap: dialog.headerGap },
  title: {
    margin: 0,
    // The cross sits in the panel's corner, out of the header's flow, and the
    // title is the one line at its height — so the title is what keeps the room
    // for it. A description is already below the button's 28px and clears it.
    // The room is kept whether or not a panel shows a cross: a title is a short
    // line that rarely reaches the end of a 512px panel, and the alternative is
    // a layout fact travelling from `Content` down to a part it does not
    // render, for a gap nobody can see.
    paddingInlineEnd: `calc(${control.small} + ${space[2]})`,
    fontSize: dialog.titleSize,
    lineHeight: dialog.titleLeading,
    fontWeight: 600,
    letterSpacing: 'normal',
    color: dialog.title,
  },
  description: {
    margin: 0,
    fontSize: dialog.descriptionSize,
    lineHeight: dialog.descriptionLeading,
    fontWeight: 400,
    color: dialog.description,
  },
  /**
   * The answers, at the end of the panel.
   *
   * They run in a row from the end on a wide window and stack in reverse on a
   * narrow one, so the affirmative answer is the one nearest the thumb in both
   * — the same order, read the way each shape is read.
   */
  footer: {
    display: 'flex',
    flexDirection: { default: 'row', '@media (max-width: 480px)': 'column-reverse' },
    justifyContent: 'flex-end',
    gap: dialog.footerGap,
  },
  /**
   * The close affordance, pinned to the panel's own padding box so it sits in
   * the corner rather than in the header's flow — a header with no description
   * would otherwise put it on the title's baseline and a wrapped title would
   * move it.
   */
  close: {
    position: 'absolute',
    insetBlockStart: dialog.padding,
    insetInlineEnd: dialog.padding,
  },
});

/** Both ends of a fade or a rise, as Base UI reports the transition. */
export function isHidden(status: string | undefined): boolean {
  return status === 'starting' || status === 'ending';
}

/** Which edge a Sheet comes in on. */
export type SheetSide = 'top' | 'bottom' | 'start' | 'end';

const SHEET_SIDES = {
  top: modal.sheetTop,
  bottom: modal.sheetBottom,
  start: modal.sheetStart,
  end: modal.sheetEnd,
} as const;

const SHEET_HIDDEN = {
  top: modal.sheetHiddenTop,
  bottom: modal.sheetHiddenBottom,
  start: modal.sheetHiddenStart,
  end: modal.sheetHiddenEnd,
} as const;

/** Where a sheet rests, for the edge it came in on. */
export function sheetSideStyle(side: SheetSide) {
  return SHEET_SIDES[side];
}

/** Where that sheet starts and ends: off the same edge. */
export function sheetHiddenStyle(side: SheetSide) {
  return SHEET_HIDDEN[side];
}
