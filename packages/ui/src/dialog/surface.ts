import * as stylex from '@stylexjs/stylex';
import { control, corner, duration, ease, space, z } from '../tokens/scales.stylex';
import { dialog } from './dialog.tokens.stylex';

/**
 * The appearance every surface on the modal rung shares: the overlay under it,
 * the panel itself, and the header, body and footer a caller lays out on it. It
 * lives here rather than on one component so Dialog, AlertDialog and Drawer
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
   * A drawer's backdrop lifts as the panel is dragged away.
   *
   * Base UI publishes the gesture's progress and the host decides what it
   * means. Here it means the page comes back as the drawer leaves, so a
   * half-dismissed drawer shows a half-lit page and the gesture reads as
   * reversible rather than as a switch that has not flipped yet.
   */
  backdropSwipe: {
    opacity: 'calc(1 - var(--drawer-swipe-progress, 0))',
    transitionDuration: duration.slow,
  },
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
    // drawer resetting `top: auto` over a `inset-block: 0` produced two
    // declarations and the cascade, not the author, picked the winner. It picked
    // `top`, and the panel collapsed to the height of its own content at the
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
   * The drawer's viewport: a fixed box over the whole window whose alignment
   * decides which edge the panel sits on.
   *
   * A drawer is not a dialog pinned to an edge. Base UI lays the panel out
   * inside this container rather than positioning it, which is what lets the
   * panel be dragged: the popup's `transform` belongs to the gesture, so it
   * cannot also be carrying a `translate(-50%, -50%)` that puts it where it
   * lives. The viewport holds the position; the popup holds the movement.
   */
  drawerViewport: {
    position: 'fixed',
    inset: 0,
    display: 'flex',
    padding: 0,
    // The stacking belongs here, not on the panel. A `position: fixed` element
    // creates a stacking context, so a `z-index` on the panel inside it only
    // orders the panel against its own siblings — against the page it counts as
    // whatever the viewport counts as, which with no `z-index` is `auto`. The
    // backdrop, at `z.dialogBackdrop`, then paints over the drawer: the panel
    // renders greyed under its own overlay. The viewport is the element that
    // stacks against the product shell, so it is the one that says so.
    zIndex: z.dialog,
  },
  /**
   * An inset drawer floats off every edge instead of meeting one.
   *
   * It is the viewport's padding rather than a margin on the panel, for the
   * same reason the position is: a margin would be one more thing competing
   * with the swipe transform. The safe area is added here too, because a panel
   * that is already held off the edge should clear the notch by the same
   * mechanism rather than by padding its own text.
   */
  drawerViewportInset: {
    paddingBlockStart: `calc(${dialog.drawerInset} + env(safe-area-inset-top, 0px))`,
    paddingBlockEnd: `calc(${dialog.drawerInset} + env(safe-area-inset-bottom, 0px))`,
    paddingInlineStart: `calc(${dialog.drawerInset} + env(safe-area-inset-left, 0px))`,
    paddingInlineEnd: `calc(${dialog.drawerInset} + env(safe-area-inset-right, 0px))`,
  },
  /** Which edge the panel is laid out against. */
  viewportTop: { alignItems: 'flex-start', justifyContent: 'center' },
  viewportBottom: { alignItems: 'flex-end', justifyContent: 'center' },
  viewportStart: { alignItems: 'stretch', justifyContent: 'flex-start' },
  viewportEnd: { alignItems: 'stretch', justifyContent: 'flex-end' },
  /**
   * The panel itself: the modal rung again, laid out by its viewport and moved
   * by the gesture.
   *
   * Base UI publishes the drag as two custom properties and lets the host
   * compose them, so the panel follows the finger; on release it publishes a
   * strength scalar that scales the transition, so a hard throw closes faster
   * than a gentle one. A drawer crosses the window rather than rising 4px, so
   * it takes the slow step of the motion scale.
   */
  drawerPopup: {
    boxSizing: 'border-box',
    display: 'flex',
    flexDirection: 'column',
    gap: dialog.gap,
    padding: dialog.padding,
    backgroundColor: dialog.background,
    boxShadow: dialog.shadow,
    borderRadius: dialog.radius,
    cornerShape: corner.shape,
    color: dialog.title,
    // Same reasoning as the dialog panel: the shadow and the overlay separate a
    // modal from the page, and a ring around the whole panel would say it is a
    // control.
    outlineStyle: 'none',
    overflowY: 'auto',
    // A drawer that has been scrolled to its end must not hand the wheel to the
    // page it is covering.
    overscrollBehavior: 'contain',
    transform:
      'translate(var(--drawer-swipe-movement-x, 0px), var(--drawer-swipe-movement-y, 0px))',
    willChange: 'transform',
    transitionProperty: 'transform',
    transitionDuration: duration.slow,
    transitionTimingFunction: ease.standard,
    // No `z-index` here on purpose: the viewport above already carries the
    // rung's, and a second one on a panel inside that stacking context would
    // look like it did something.
  },
  /**
   * How big the panel is on the edge it came in on. Top and bottom take the
   * width of the window and cap their height; start and end take the height and
   * cap their width at `drawerSize`.
   */
  drawerTop: { width: '100%', maxHeight: `calc(100dvh - ${dialog.inset})` },
  drawerBottom: { width: '100%', maxHeight: `calc(100dvh - ${dialog.inset})` },
  drawerStart: {
    height: '100%',
    width: dialog.drawerSize,
    maxWidth: `calc(100vw - ${dialog.inset})`,
  },
  drawerEnd: {
    height: '100%',
    width: dialog.drawerSize,
    maxWidth: `calc(100vw - ${dialog.inset})`,
  },
  /**
   * A flush drawer meets the window, so the two corners that touch it are
   * square and the safe area is padding inside the panel rather than a gap
   * outside it — the panel reaches the physical edge and keeps its text off the
   * notch. An inset drawer states none of this: it keeps all four corners and
   * its viewport already holds it clear.
   */
  flushTop: {
    paddingBlockStart: `calc(${dialog.padding} + env(safe-area-inset-top, 0px))`,
    borderStartStartRadius: 0,
    borderStartEndRadius: 0,
  },
  flushBottom: {
    paddingBlockEnd: `calc(${dialog.padding} + env(safe-area-inset-bottom, 0px))`,
    borderEndStartRadius: 0,
    borderEndEndRadius: 0,
  },
  flushStart: {
    paddingInlineStart: `calc(${dialog.padding} + env(safe-area-inset-left, 0px))`,
    borderStartStartRadius: 0,
    borderEndStartRadius: 0,
  },
  flushEnd: {
    paddingInlineEnd: `calc(${dialog.padding} + env(safe-area-inset-right, 0px))`,
    borderStartEndRadius: 0,
    borderEndEndRadius: 0,
  },
  /**
   * Both ends of a drawer's travel: fully off the edge it belongs to.
   *
   * This replaces the whole transform rather than composing the swipe
   * variables, which is right — while the panel is arriving or leaving there is
   * no gesture to follow, and Base UI reports that state as the transition
   * status the way it does everywhere else in this package.
   */
  drawerHiddenTop: { transform: 'translateY(-100%)' },
  drawerHiddenBottom: { transform: 'translateY(100%)' },
  drawerHiddenStart: { transform: 'translateX(-100%)' },
  drawerHiddenEnd: { transform: 'translateX(100%)' },
  /**
   * The same, for a panel its viewport is holding off the edge: 100% of the
   * panel only reaches the gap, so the gap and the safe area go with it or the
   * drawer parks with a strip of itself still showing.
   */
  drawerInsetHiddenTop: {
    transform: `translateY(calc(-100% - ${dialog.drawerInset} - env(safe-area-inset-top, 0px)))`,
  },
  drawerInsetHiddenBottom: {
    transform: `translateY(calc(100% + ${dialog.drawerInset} + env(safe-area-inset-bottom, 0px)))`,
  },
  drawerInsetHiddenStart: {
    transform: `translateX(calc(-100% - ${dialog.drawerInset} - env(safe-area-inset-left, 0px)))`,
  },
  drawerInsetHiddenEnd: {
    transform: `translateX(calc(100% + ${dialog.drawerInset} + env(safe-area-inset-right, 0px)))`,
  },
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

/** Which edge a Drawer comes in on, in writing-direction terms. */
export type DrawerSide = 'top' | 'bottom' | 'start' | 'end';

/**
 * The swipe that dismisses a drawer, for the edge it came in on.
 *
 * Base UI names the gesture in physical directions because a finger moves in
 * physical space: a drawer on the inline-start edge is swiped `left` away in a
 * left-to-right document and `right` away in a right-to-left one. The mapping
 * is resolved here rather than by a caller, and the right-to-left case is
 * resolved at render time from the document's direction.
 */
export type DrawerSwipe = 'up' | 'down' | 'left' | 'right';

const VIEWPORTS = {
  top: modal.viewportTop,
  bottom: modal.viewportBottom,
  start: modal.viewportStart,
  end: modal.viewportEnd,
} as const;

const SIZES = {
  top: modal.drawerTop,
  bottom: modal.drawerBottom,
  start: modal.drawerStart,
  end: modal.drawerEnd,
} as const;

const FLUSH = {
  top: modal.flushTop,
  bottom: modal.flushBottom,
  start: modal.flushStart,
  end: modal.flushEnd,
} as const;

const HIDDEN = {
  top: modal.drawerHiddenTop,
  bottom: modal.drawerHiddenBottom,
  start: modal.drawerHiddenStart,
  end: modal.drawerHiddenEnd,
} as const;

const INSET_HIDDEN = {
  top: modal.drawerInsetHiddenTop,
  bottom: modal.drawerInsetHiddenBottom,
  start: modal.drawerInsetHiddenStart,
  end: modal.drawerInsetHiddenEnd,
} as const;

/** How the viewport lays the panel out for the edge it belongs to. */
export function drawerViewportStyle(side: DrawerSide) {
  return VIEWPORTS[side];
}

/** How big the panel is on that edge. */
export function drawerSizeStyle(side: DrawerSide) {
  return SIZES[side];
}

/** The two square corners and the safe-area padding a flush drawer takes. */
export function drawerFlushStyle(side: DrawerSide) {
  return FLUSH[side];
}

/** Where the panel starts and ends: off that edge, plus the gap if it is inset. */
export function drawerHiddenStyle(side: DrawerSide, inset: boolean) {
  return inset ? INSET_HIDDEN[side] : HIDDEN[side];
}

/**
 * The physical swipe that takes a drawer away from its edge.
 *
 * `rtl` flips only the inline pair, because the block axis does not reverse
 * with writing direction in any script this ships to.
 */
export function drawerSwipeDirection(side: DrawerSide, rtl: boolean): DrawerSwipe {
  if (side === 'top') return 'up';
  if (side === 'bottom') return 'down';
  if (side === 'start') return rtl ? 'right' : 'left';
  return rtl ? 'left' : 'right';
}
