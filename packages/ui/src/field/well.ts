import * as stylex from '@stylexjs/stylex';
import { corner, duration, ease, text } from '../tokens/scales.stylex';
import { field } from './field.tokens.stylex';

/**
 * The resting and ringed appearance every control in the field family shares.
 * It lives here rather than on one control so Input, Textarea, Checkbox, Radio,
 * Switch and the controls that migrate next cannot each grow their own focus,
 * invalid and disabled treatment.
 *
 * The ring rides in the same box-shadow as the control's own edge: 2px, tight
 * to the control, no offset, no glow. It is not an `outline` because the app
 * shell resets every outline with `!important`, which no layer order can beat.
 * CSS cannot append to a box-shadow list, so a control that changes its edge —
 * a checked box swaps the well for the ink highlight — restates the ring with
 * it, the way each Button variant does.
 */
const RING = `0 0 0 ${field.ringWidth} ${field.ring}`;
const INVALID_RING = `0 0 0 ${field.ringWidth} ${field.invalidRing}`;

export const well = stylex.create({
  base: {
    boxSizing: 'border-box',
    width: '100%',
    minWidth: 0,
    margin: 0,
    borderWidth: 0,
    borderStyle: 'none',
    backgroundColor: field.background,
    // A text control is always focus-visible, so this covers pointer focus too.
    boxShadow: { default: field.well, ':focus-visible': `${field.well}, ${RING}` },
    color: field.value,
    fontFamily: 'inherit',
    // Controls are 13 at weight 500 with controlTracking; the size step sets
    // the size, this sets the weight and tracking for every control here.
    fontWeight: 500,
    letterSpacing: text.controlTracking,
    cornerShape: corner.shape,
    outlineStyle: 'none',
    opacity: { default: 1, ':disabled': field.disabledOpacity },
    cursor: { default: 'auto', ':disabled': 'default' },
    transitionProperty: 'box-shadow, opacity',
    transitionDuration: duration.fast,
    transitionTimingFunction: ease.standard,
    '::placeholder': { color: field.placeholder, opacity: 1 },
  },
  // StyleX keys a conditional value per condition, so the focused case is
  // restated here; otherwise an invalid control would flip back to the accent
  // ring the moment it takes focus.
  invalid: {
    boxShadow: {
      default: `${field.well}, ${INVALID_RING}`,
      ':focus-visible': `${field.well}, ${INVALID_RING}`,
    },
  },
  /**
   * The same well as a box rather than a line of text: the tick box of a
   * Checkbox and a Radio, and the track of a Switch. It takes no width, no font
   * and no placeholder, and it carries the mark colour so an indicator inside
   * it needs no colour of its own. These controls render a real `<button>`, so
   * `:disabled` and `:focus-visible` reach them the way they reach an `<input>`.
   */
  box: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    boxSizing: 'border-box',
    margin: 0,
    padding: 0,
    borderWidth: 0,
    borderStyle: 'none',
    backgroundColor: field.background,
    boxShadow: { default: field.well, ':focus-visible': `${field.well}, ${RING}` },
    color: field.checkedMark,
    cornerShape: corner.shape,
    outlineStyle: 'none',
    opacity: { default: 1, ':disabled': field.disabledOpacity },
    cursor: { default: 'pointer', ':disabled': 'default' },
    transitionProperty: 'background-color, box-shadow, opacity',
    transitionDuration: duration.fast,
    transitionTimingFunction: ease.standard,
  },
  /** Stored state: the ink fill and its top highlight in place of the well. */
  checked: {
    backgroundColor: field.checkedFill,
    boxShadow: { default: field.checkedEdge, ':focus-visible': `${field.checkedEdge}, ${RING}` },
  },
  /** The invalid ring on that ink edge, at rest and while focused. */
  checkedInvalid: {
    boxShadow: {
      default: `${field.checkedEdge}, ${INVALID_RING}`,
      ':focus-visible': `${field.checkedEdge}, ${INVALID_RING}`,
    },
  },
});
