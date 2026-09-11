import * as stylex from '@stylexjs/stylex';
import { colors, shadow } from '../tokens/colors.stylex';
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
const RING = `0 0 0 ${field.ringWidth} ${colors.accent}`;
const INVALID_RING = `0 0 0 ${field.ringWidth} ${colors.destructive}`;

export const well = stylex.create({
  base: {
    boxSizing: 'border-box',
    width: '100%',
    minWidth: 0,
    margin: 0,
    borderWidth: 0,
    borderStyle: 'none',
    backgroundColor: colors.wellBackground,
    // A text control is always focus-visible, so this covers pointer focus too.
    boxShadow: { default: shadow.inset, ':focus-visible': `${shadow.inset}, ${RING}` },
    color: colors.label,
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
    '::placeholder': { color: colors.hintLabel, opacity: 1 },
  },
  // StyleX keys a conditional value per condition, so the focused case is
  // restated here; otherwise an invalid control would flip back to the accent
  // ring the moment it takes focus.
  invalid: {
    boxShadow: {
      default: `${shadow.inset}, ${INVALID_RING}`,
      ':focus-visible': `${shadow.inset}, ${INVALID_RING}`,
    },
  },
  /**
   * A well that wraps its own control rather than being one: the Combobox shell
   * holding an input beside a chevron. The ring follows `:focus-within`, since
   * the element that takes focus is the input inside it, not the shell; a text
   * control is always focus-visible, so this covers pointer focus too. Disabled
   * cannot be `:disabled` on a `<div>`, so it is read from Base UI's state and
   * `dimmed` is applied instead.
   */
  shell: {
    display: 'flex',
    alignItems: 'center',
    boxSizing: 'border-box',
    width: '100%',
    minWidth: 0,
    margin: 0,
    borderWidth: 0,
    borderStyle: 'none',
    backgroundColor: colors.wellBackground,
    boxShadow: { default: shadow.inset, ':focus-within': `${shadow.inset}, ${RING}` },
    color: colors.label,
    cornerShape: corner.shape,
    outlineStyle: 'none',
    cursor: 'text',
    transitionProperty: 'box-shadow, opacity',
    transitionDuration: duration.fast,
    transitionTimingFunction: ease.standard,
  },
  shellInvalid: {
    boxShadow: {
      default: `${shadow.inset}, ${INVALID_RING}`,
      ':focus-within': `${shadow.inset}, ${INVALID_RING}`,
    },
  },
  /** The control inside a shell: the shell already is the well. */
  bare: {
    flexGrow: 1,
    flexShrink: 1,
    minWidth: 0,
    margin: 0,
    padding: 0,
    borderWidth: 0,
    borderStyle: 'none',
    backgroundColor: 'transparent',
    boxShadow: 'none',
    color: 'inherit',
    fontFamily: 'inherit',
    fontSize: 'inherit',
    fontWeight: 500,
    letterSpacing: text.controlTracking,
    outlineStyle: 'none',
    cursor: { default: 'auto', ':disabled': 'default' },
    '::placeholder': { color: colors.hintLabel, opacity: 1 },
  },
  /** The family's one disabled value, for a part `:disabled` cannot reach. */
  dimmed: { opacity: field.disabledOpacity },
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
    backgroundColor: colors.wellBackground,
    boxShadow: { default: shadow.inset, ':focus-visible': `${shadow.inset}, ${RING}` },
    color: colors.background,
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
    backgroundColor: colors.label,
    boxShadow: { default: shadow.inkEdge, ':focus-visible': `${shadow.inkEdge}, ${RING}` },
  },
  /** The invalid ring on that ink edge, at rest and while focused. */
  checkedInvalid: {
    boxShadow: {
      default: `${shadow.inkEdge}, ${INVALID_RING}`,
      ':focus-visible': `${shadow.inkEdge}, ${INVALID_RING}`,
    },
  },
});
