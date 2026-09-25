import * as stylex from '@stylexjs/stylex';
import { corner, duration, ease, radius, text } from '../tokens/scales.stylex';
import { toggle } from './toggle.tokens.stylex';

/**
 * The ring this family draws, in the shape every other ring here takes: 2px,
 * tight to the control, no offset, no glow, and a `box-shadow` rather than an
 * `outline` because the product shell resets every outline with `!important`.
 * A pressed toggle has an edge of its own, so it composes the ring onto it —
 * CSS cannot append to a box-shadow list, so the pressed style restates both.
 */
const RING = `0 0 0 ${toggle.ringWidth} ${toggle.ring}`;

/**
 * What a toggle, a set of them and the bar holding them are made of.
 *
 * It lives here rather than beside each part for the reason
 * `disclosure/surface.ts` holds the three disclosures' appearance: three parts
 * of one family cannot each grow their own idea of how far apart two controls
 * stand or what "pressed" looks like.
 */
export const toggleSurface = stylex.create({
  /**
   * The control itself, at rest. This is a ghost Button's reset, and
   * deliberately so: a toggle that is off is a ghost Button that happens to
   * remember, so the two cannot look different while they sit in one bar.
   */
  base: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: toggle.gap,
    flexShrink: 0,
    whiteSpace: 'nowrap',
    boxSizing: 'border-box',
    margin: 0,
    borderWidth: 0,
    borderStyle: 'none',
    fontFamily: 'inherit',
    fontWeight: 500,
    letterSpacing: text.controlTracking,
    lineHeight: 1,
    // Round rather than the squircle: a spread box-shadow ring does not track
    // a superellipse corner (see the note in `field/well.ts`).
    cornerShape: corner.round,
    // Not an `outline`; see RING above.
    outlineStyle: 'none',
    cursor: { default: 'pointer', ':disabled': 'default' },
    userSelect: 'none',
    opacity: { default: 1, ':disabled': toggle.disabledOpacity },
    pointerEvents: { default: 'auto', ':disabled': 'none' },
    /**
     * A toggle does not bob. The motion rules give a press
     * `translateY(1px)` and a dropped highlight, and that is the report of a
     * raised thing going down and coming back; this one goes down and stays, so
     * what moves is the surface under it rather than the control itself.
     */
    transitionProperty: 'background-color, color, box-shadow, opacity',
    transitionDuration: duration.fast,
    transitionTimingFunction: ease.standard,
  },
  mini: {
    height: toggle.heightMini,
    paddingInline: toggle.paddingXMini,
    borderRadius: toggle.radiusMini,
    fontSize: toggle.textMini,
  },
  small: {
    height: toggle.heightSmall,
    paddingInline: toggle.paddingXSmall,
    borderRadius: toggle.radiusSmall,
    fontSize: toggle.text,
  },
  medium: {
    height: toggle.heightMedium,
    paddingInline: toggle.paddingXMedium,
    borderRadius: toggle.radiusMedium,
    fontSize: toggle.text,
  },
  large: {
    height: toggle.heightLarge,
    paddingInline: toggle.paddingXLarge,
    borderRadius: toggle.radiusMedium,
    fontSize: toggle.text,
  },
  iconMini: { width: toggle.heightMini, paddingInline: 0 },
  iconSmall: { width: toggle.heightSmall, paddingInline: 0 },
  iconMedium: { width: toggle.heightMedium, paddingInline: 0 },
  iconLarge: { width: toggle.heightLarge, paddingInline: 0 },
  /**
   * The box an icon-only toggle gives what is in it, for the reason an
   * icon-only Button draws one: this package's glyphs and icons state their
   * size as 100% of whatever holds them, and StyleX has no descendant selector
   * with which the control could reach one.
   */
  glyph: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    width: toggle.iconSize,
    height: toggle.iconSize,
  },
  // A pill drops the base squircle: at `radius.full` a squircle is a
  // superellipse rather than the stadium shape the name promises.
  pill: { borderRadius: radius.full, cornerShape: corner.round },
  /** Off: no fill of its own, and about the thing rather than the thing. */
  rest: {
    backgroundColor: { default: 'transparent', ':hover': toggle.hover },
    color: { default: toggle.label, ':hover': toggle.activeLabel },
    boxShadow: { default: 'none', ':focus-visible': RING },
  },
  /**
   * On: the well rung, and the label colour of something that is the thing
   * rather than about it. The hover steps away from the surface by the mix a
   * secondary Button's hover and a popup's highlight already use, because the
   * ladder's own named fills were tuned against a row on the page rather than
   * against a control that has sunk into it.
   */
  pressed: {
    backgroundColor: {
      default: toggle.pressedBackground,
      ':hover': `color-mix(in oklab, ${toggle.pressedBackground}, ${toggle.activeLabel} 4%)`,
    },
    color: toggle.activeLabel,
    boxShadow: {
      default: toggle.pressedWell,
      ':focus-visible': `${RING}, ${toggle.pressedWell}`,
    },
  },

  // ── The set ──────────────────────────────────────────────────────────────
  /**
   * A set of toggles answering to one value.
   *
   * It is a row with a gap and nothing else — no track, no indicator — and that
   * is the whole difference between it and a `Tabs` strip. A strip picks what
   * you *see*, so it can be one control with one pill sliding between the
   * choices; a set stores what is *on*, and two of these can be on at once,
   * which a sliding pill cannot say. Each member sinks on its own.
   */
  group: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: toggle.groupGap,
    minWidth: 0,
  },
  groupVertical: { flexDirection: 'column', alignItems: 'stretch' },
  /**
   * A set too wide for its row runs onto a second one rather than overflowing.
   * The members keep their width there — a toggle neither grows nor shrinks,
   * the way a badge does not — and the row gap is already the one `gap` states,
   * so wrapping costs a single declaration.
   */
  groupWrap: { flexWrap: 'wrap' },

  // ── The bar ──────────────────────────────────────────────────────────────
  /**
   * The bar itself, which draws nothing at all: no fill, no shadow, no radius,
   * and not even the line a table draws. It is a row of controls on whatever
   * surface the product already had there, so a bar inside a popover is not a
   * second surface inside one.
   *
   * What it is for is the keyboard. A row of eight icon buttons is eight tab
   * stops unless something says otherwise, and a person tabbing through a page
   * should pass a bar rather than walk it; Base UI makes the bar one stop and
   * gives the arrow keys the walking.
   */
  bar: {
    display: 'flex',
    alignItems: 'center',
    gap: toggle.barGap,
    minWidth: 0,
  },
  barVertical: { flexDirection: 'column', alignItems: 'stretch' },
  /** A cluster inside a bar: related controls, at the set's tighter gap. */
  barGroup: {
    display: 'flex',
    alignItems: 'center',
    gap: toggle.groupGap,
    minWidth: 0,
  },
  barGroupVertical: { flexDirection: 'column', alignItems: 'stretch' },
});
