import * as stylex from '@stylexjs/stylex';
import { corner, duration, ease, text } from '../tokens/scales.stylex';
import { field } from './field.tokens.stylex';

/**
 * The resting and ringed appearance every control in the field family shares.
 * It lives here rather than on one control so Input, Textarea and the controls
 * that migrate next cannot each grow their own focus, invalid and disabled
 * treatment.
 */
export const well = stylex.create({
  base: {
    boxSizing: 'border-box',
    width: '100%',
    minWidth: 0,
    margin: 0,
    borderWidth: 0,
    borderStyle: 'none',
    backgroundColor: field.background,
    // The ring rides in the same box-shadow as the well: 2px, tight to the
    // control, no offset, no glow. It is not an `outline` because the app shell
    // resets every outline with `!important`, which no layer order can beat. A
    // text control is always focus-visible, so this covers pointer focus too.
    boxShadow: {
      default: field.well,
      ':focus-visible': `${field.well}, 0 0 0 ${field.ringWidth} ${field.ring}`,
    },
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
      default: `${field.well}, 0 0 0 ${field.ringWidth} ${field.invalidRing}`,
      ':focus-visible': `${field.well}, 0 0 0 ${field.ringWidth} ${field.invalidRing}`,
    },
  },
});
