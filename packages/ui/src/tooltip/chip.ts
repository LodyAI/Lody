import * as stylex from '@stylexjs/stylex';
import { corner, duration, ease, text, z } from '../tokens/scales.stylex';
import { tooltip } from './tooltip.tokens.stylex';

/**
 * The tooltip's appearance, in a file of its own for the reason
 * `popup/surface.ts` is: the board composes the very rules the component
 * applies rather than copying them, so a stand-in cannot report a chip this
 * package no longer draws.
 */
export const chip = stylex.create({
  /**
   * The positioner carries no appearance, but it owns the stacking for the
   * same reason a popup's does (`popup/surface.ts`): a `position: fixed`
   * element is a stacking context, so the rung must be stated here, where it
   * competes with the page — above every popup, since a tooltip can name a
   * control that is itself inside one.
   */
  positioner: { outlineStyle: 'none', zIndex: z.tooltip },
  /**
   * The chip. It rises off the page on the floating rung like a menu does —
   * the raised background under the popover shadow, with the page's own ink —
   * so it follows the palette rather than standing against it: a light chip in
   * a light palette, a dark one in a dark palette. Only its geometry is
   * smaller, because it names a control rather than holding any.
   */
  popup: {
    boxSizing: 'border-box',
    maxWidth: tooltip.maxWidth,
    paddingBlock: tooltip.paddingY,
    paddingInline: tooltip.paddingX,
    backgroundColor: tooltip.background,
    color: tooltip.label,
    boxShadow: tooltip.shadow,
    borderRadius: tooltip.radius,
    cornerShape: corner.shape,
    fontFamily: 'inherit',
    fontSize: tooltip.text,
    lineHeight: tooltip.leading,
    fontWeight: 500,
    letterSpacing: text.controlTracking,
    // A tooltip names what is under the pointer; it is never itself the target.
    // Without this, one that lands under the cursor takes the pointer off its
    // own trigger and flickers itself closed and open again.
    pointerEvents: 'none',
    // A long label wraps at `maxWidth` rather than being cut off at an ellipsis
    // a person has no way to open: a tooltip is already the expansion.
    overflowWrap: 'break-word',
    opacity: 1,
    transform: 'translateY(0)',
    transitionProperty: 'opacity, transform',
    transitionDuration: duration.fast,
    transitionTimingFunction: ease.standard,
  },
  /**
   * Both ends of the rise, measured against the anchor rather than the page,
   * for the reason a menu's are: a tooltip flips to stay on screen, so it
   * starts one step further from what it names on whichever side it landed.
   */
  hiddenBelow: { opacity: 0, transform: `translateY(${tooltip.rise})` },
  hiddenAbove: { opacity: 0, transform: `translateY(calc(-1 * ${tooltip.rise}))` },
  hiddenAfter: { opacity: 0, transform: `translateX(${tooltip.rise})` },
  hiddenBefore: { opacity: 0, transform: `translateX(calc(-1 * ${tooltip.rise}))` },
});

/** The hidden end of the rise for the side a tooltip actually landed on. */
export function hiddenChipForSide(side: string | undefined) {
  if (side === 'top') return chip.hiddenAbove;
  if (side === 'right' || side === 'inline-end') return chip.hiddenAfter;
  if (side === 'left' || side === 'inline-start') return chip.hiddenBefore;
  return chip.hiddenBelow;
}
