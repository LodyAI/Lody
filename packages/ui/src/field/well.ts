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
 * The ring comes FIRST in that list: earlier shadows paint on top, and the
 * well's lit lower lip (a 1px light line under the field) otherwise covered the
 * ring's bottom edge, so the ring read 2px at the sides and 1px below.
 * CSS cannot append to a box-shadow list, so a control that changes its edge —
 * a checked box swaps the well for the ink highlight — restates the ring with
 * it, the way each Button variant does.
 */
const RING = `0 0 0 ${field.ringWidth} ${field.ring}`;
const INVALID_RING = `0 0 0 ${field.ringWidth} ${field.invalidRing}`;

/**
 * A corner that carries the ring is `corner.round`, not the squircle: Chromium
 * draws a spread box-shadow on a superellipse as `radius + spread`, which is
 * not a parallel offset of the original curve, so a squircle ring bulges off
 * the corner tangents by several px. A circular corner offsets in true
 * parallel and the ring stays tight. Parts below that never take the ring
 * keep `corner.shape`.
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
    // A text control is always focus-visible, so this covers pointer focus too.
    boxShadow: { default: field.well, ':focus-visible': `${RING}, ${field.well}` },
    color: field.value,
    fontFamily: 'inherit',
    // Controls are 13 at weight 500 with controlTracking; the size step sets
    // the size, this sets the weight and tracking for every control here.
    fontWeight: 500,
    letterSpacing: text.controlTracking,
    cornerShape: corner.round,
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
      default: `${INVALID_RING}, ${field.well}`,
      ':focus-visible': `${INVALID_RING}, ${field.well}`,
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
    backgroundColor: field.background,
    boxShadow: { default: field.well, ':focus-within': `${RING}, ${field.well}` },
    color: field.value,
    cornerShape: corner.round,
    outlineStyle: 'none',
    cursor: 'text',
    transitionProperty: 'box-shadow, opacity',
    transitionDuration: duration.fast,
    transitionTimingFunction: ease.standard,
  },
  shellInvalid: {
    boxShadow: {
      default: `${INVALID_RING}, ${field.well}`,
      ':focus-within': `${INVALID_RING}, ${field.well}`,
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
    '::placeholder': { color: field.placeholder, opacity: 1 },
  },
  /**
   * A glyph sharing a well with the value: a Combobox chevron or cross, a
   * number field's steppers, a password field's reveal. It is a box holding a
   * glyph rather than a button with a fill of its own — the well is the one
   * control, and a filled button inside it would read as a second one. It
   * carries no disabled opacity: the shell already dims, and a dimmed glyph
   * inside a dimmed shell is dimmed twice.
   *
   * It states no edge of its own. The app shell rings any focused `[tabindex]`
   * with an inset box-shadow, and the shell around this one already rings on
   * `:focus-within` — so without this, focusing a chevron or an eye draws a
   * second ring inside the field's own.
   */
  adornment: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    boxSizing: 'border-box',
    width: field.iconSize,
    height: field.iconSize,
    margin: 0,
    padding: 0,
    borderWidth: 0,
    borderStyle: 'none',
    backgroundColor: 'transparent',
    boxShadow: 'none',
    color: { default: field.icon, ':hover': field.value },
    cursor: { default: 'default', ':disabled': 'default' },
    outlineStyle: 'none',
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
    backgroundColor: field.background,
    boxShadow: { default: field.well, ':focus-visible': `${RING}, ${field.well}` },
    color: field.checkedMark,
    cornerShape: corner.round,
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
    backgroundImage: field.checkedSheen,
    boxShadow: { default: field.checkedEdge, ':focus-visible': `${RING}, ${field.checkedEdge}` },
  },
  /** The invalid ring on that ink edge, at rest and while focused. */
  checkedInvalid: {
    boxShadow: {
      default: `${INVALID_RING}, ${field.checkedEdge}`,
      ':focus-visible': `${INVALID_RING}, ${field.checkedEdge}`,
    },
  },
});
