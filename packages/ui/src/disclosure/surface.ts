import * as stylex from '@stylexjs/stylex';
import { control, corner, duration, ease, radius, text } from '../tokens/scales.stylex';
import { disclosure } from './disclosure.tokens.stylex';

/**
 * The ring this family draws, in the shape the field family's takes: 2px, tight
 * to the control, no offset, no glow, and a `box-shadow` rather than an
 * `outline` because the product shell resets every outline with `!important`.
 * Nothing here has an edge of its own to compose it with, so it stands alone.
 */
const RING = `0 0 0 ${disclosure.ringWidth} ${disclosure.ring}`;

/**
 * What the three disclosures are made of: the tab strip, the accordion's rows
 * and the panel both it and the Collapsible reveal. It lives here rather than
 * beside each component for the reason `popup/surface.ts` holds the floating
 * rung's appearance — three parts of one family cannot each grow their own
 * label colour, their own ring and their own idea of how a panel opens.
 *
 * The reveal is the part with a rule behind it. A panel's height is animated
 * from a variable Base UI measures with `scrollHeight` and publishes on the
 * panel itself, and a height that is being animated cannot also carry padding:
 * `scrollHeight` counts the padding, so a padded panel is cropped by exactly
 * its own padding under `border-box` and overshoots by it under `content-box`.
 * The padding therefore belongs to a child — `body` below — and the panel keeps
 * nothing but the motion and the overflow that hides what is on its way in.
 */
export const disclosureSurface = stylex.create({
  /**
   * A part a person cannot use. It is applied from Base UI's state rather than
   * through `:disabled`, because neither a tab nor an accordion row carries the
   * native attribute: both stay focusable so a keyboard reaches them and hears
   * why, and say so with `aria-disabled`. `:disabled` therefore never matches
   * here — the control the field family dims is a different kind of control.
   */
  disabled: { opacity: disclosure.disabledOpacity, cursor: 'default' },
  /**
   * Where the keyboard is, on a part whose edge is otherwise nothing. It is a
   * style rather than a constant because the StyleX compiler evaluates a
   * `create` call's arguments at build time and cannot follow a value imported
   * from a file that is not a `.stylex` one — so the family's one ring is
   * composed onto a part rather than interpolated into it.
   */
  ring: {
    boxShadow: { default: 'none', ':focus-visible': RING },
    outlineStyle: 'none',
  },

  // ── The strip ────────────────────────────────────────────────────────────
  /** The strip and the panel under it: two blocks, one gap. */
  tabs: {
    display: 'flex',
    flexDirection: 'column',
    gap: disclosure.panelGap,
    minWidth: 0,
  },
  /** The track: the well rung, holding the one thing raised out of it. */
  track: {
    position: 'relative',
    display: 'inline-flex',
    alignItems: 'stretch',
    boxSizing: 'border-box',
    padding: disclosure.trackInset,
    backgroundColor: disclosure.trackBackground,
    boxShadow: disclosure.trackWell,
    cornerShape: corner.shape,
  },
  /**
   * A strip that takes the width it is given, with the choices sharing it
   * equally. It is a named product choice rather than a caller's `w-full`
   * because it is two facts that have to agree — the track stretching and the
   * tabs inside it splitting the room — and a surface that stated only the
   * first would get a full-width track with three tabs huddled at its start.
   */
  trackStretch: { display: 'flex', width: '100%' },
  trackSmall: { height: control.small, borderRadius: disclosure.trackRadiusSmall },
  trackMedium: { height: control.medium, borderRadius: disclosure.trackRadiusMedium },
  trackLarge: { height: control.large, borderRadius: disclosure.trackRadiusMedium },
  /**
   * The pill under the selected tab. Base UI measures that tab and publishes
   * its box on this element as physical pixels from the list's own top-left
   * corner, so the pill is anchored physically and moved with `translate`:
   * reading those offsets from the inline edge would put it on the wrong tab in
   * a right-to-left document. That it moves rather than lighting up is also why
   * it is one element and not a fill on each tab — the strip is one control,
   * and the pill sliding across it says so.
   */
  indicator: {
    position: 'absolute',
    left: 0,
    top: 0,
    width: 'var(--active-tab-width)',
    height: 'var(--active-tab-height)',
    translate: 'var(--active-tab-left) var(--active-tab-top)',
    backgroundColor: disclosure.indicator,
    boxShadow: disclosure.indicatorShadow,
    cornerShape: corner.shape,
    transitionProperty: 'translate, width',
    transitionDuration: duration.regular,
    transitionTimingFunction: ease.standard,
  },
  // Nested radius is outer minus inset, so a 28px track at 8 holds a 4 and a 32
  // or 36px one at 10 holds a 6. Neither is a token of its own.
  indicatorSmall: {
    borderRadius: `calc(${disclosure.trackRadiusSmall} - ${disclosure.trackInset})`,
  },
  indicatorMedium: {
    borderRadius: `calc(${disclosure.trackRadiusMedium} - ${disclosure.trackInset})`,
  },
  /** One choice on the strip. The fill is the indicator's; this takes none. */
  tab: {
    // A tab is in flow and the indicator is not, so this is what keeps the
    // label over the pill rather than under it.
    position: 'relative',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: disclosure.tabGap,
    boxSizing: 'border-box',
    margin: 0,
    paddingBlock: 0,
    paddingInline: disclosure.tabPaddingX,
    borderWidth: 0,
    borderStyle: 'none',
    backgroundColor: 'transparent',
    cornerShape: corner.shape,
    color: {
      default: disclosure.tabLabel,
      ':hover': disclosure.tabActiveLabel,
      ':disabled': disclosure.tabLabel,
    },
    fontFamily: 'inherit',
    fontSize: disclosure.tabText,
    fontWeight: 500,
    letterSpacing: text.controlTracking,
    whiteSpace: 'nowrap',
    cursor: 'pointer',
    transitionProperty: 'color, box-shadow, opacity',
    transitionDuration: duration.fast,
    transitionTimingFunction: ease.standard,
  },
  tabStretch: { flexGrow: 1, flexShrink: 1, flexBasis: 0, minWidth: 0 },
  tabSmall: { borderRadius: `calc(${disclosure.trackRadiusSmall} - ${disclosure.trackInset})` },
  tabMedium: { borderRadius: `calc(${disclosure.trackRadiusMedium} - ${disclosure.trackInset})` },
  /**
   * The tab you are on. It replaces the resting colour and nothing else: the
   * pill under it is what says "here", so a second mark on the label would be
   * the same fact stated twice.
   */
  tabActive: { color: disclosure.tabActiveLabel },
  /** A tab that cannot be taken does not light up under the pointer either. */
  tabDisabled: { color: { default: disclosure.tabLabel, ':hover': disclosure.tabLabel } },
  /** What the strip swaps. Base UI makes it focusable, so it takes the ring. */
  tabPanel: {
    minWidth: 0,
    borderRadius: radius.medium,
    cornerShape: corner.shape,
  },

  // ── The stack ────────────────────────────────────────────────────────────
  /** The accordion: rows, and nothing around them. */
  stack: { display: 'flex', flexDirection: 'column', minWidth: 0 },
  /**
   * One item in that stack. The line is the row divider the rules give a list,
   * drawn as an inset shadow rather than as an element between rows: an
   * accordion's rows are its own children, so there is nowhere for a caller to
   * put a separator part and nothing to stop them forgetting it. The last row
   * has no next row, so it draws no line.
   */
  item: {
    boxShadow: {
      default: `inset 0 -1px 0 ${disclosure.separator}`,
      ':last-child': 'none',
    },
  },
  /** The heading Base UI wraps the trigger in; it carries no appearance. */
  header: { display: 'flex', margin: 0 },
  /**
   * The row itself: the label takes the width and the chevron trails it, the
   * way a menu row's shortcut does. It has no fill in any state — a row here is
   * a line of a list rather than a control on a surface — so what moves when it
   * opens is the chevron.
   */
  row: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: disclosure.rowGap,
    boxSizing: 'border-box',
    width: '100%',
    margin: 0,
    paddingInline: 0,
    paddingBlock: disclosure.rowPaddingY,
    borderWidth: 0,
    borderStyle: 'none',
    backgroundColor: 'transparent',
    borderRadius: radius.small,
    cornerShape: corner.shape,
    color: disclosure.label,
    fontFamily: 'inherit',
    fontSize: disclosure.rowText,
    fontWeight: 500,
    letterSpacing: text.controlTracking,
    textAlign: 'start',
    cursor: 'pointer',
    transitionProperty: 'box-shadow, opacity',
    transitionDuration: duration.fast,
    transitionTimingFunction: ease.standard,
  },
  /** The row's text, which takes the width so a long label truncates. */
  rowLabel: {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  /**
   * The chevron the part draws rather than the caller: it is how a closed row
   * says there is something under it, so a caller cannot forget it. It points
   * down while closed and has turned over once the panel is open.
   */
  chevron: {
    display: 'block',
    flexShrink: 0,
    width: disclosure.chevronSize,
    height: disclosure.chevronSize,
    color: disclosure.chevron,
    transform: 'rotate(0deg)',
    transitionProperty: 'transform',
    transitionDuration: duration.fast,
    transitionTimingFunction: ease.standard,
  },
  chevronOpen: { transform: 'rotate(180deg)' },

  // ── The reveal ───────────────────────────────────────────────────────────
  /**
   * The panel, mid-reveal. Base UI names the height it measured per component,
   * so the two read different variables: one style shared between them would
   * leave whichever it was not written for with nothing to move between.
   * Which end of the transition a panel is at is read off Base UI's transition
   * status in JS, because StyleX cannot express `[data-starting-style]`.
   */
  collapsiblePanel: {
    overflow: 'hidden',
    height: 'var(--collapsible-panel-height)',
    transitionProperty: 'height',
    transitionDuration: duration.regular,
    transitionTimingFunction: ease.standard,
  },
  accordionPanel: {
    overflow: 'hidden',
    height: 'var(--accordion-panel-height)',
    transitionProperty: 'height',
    transitionDuration: duration.regular,
    transitionTimingFunction: ease.standard,
  },
  collapsed: { height: 0 },
  /** What the panel holds: prose, and the room a row's padding does not give. */
  body: {
    paddingBlockEnd: disclosure.panelPaddingBottom,
    fontSize: disclosure.panelText,
    lineHeight: disclosure.panelLeading,
    fontWeight: 400,
    letterSpacing: 'normal',
  },
});

/**
 * Whether a panel is at one of the two ends of its reveal. Base UI reports the
 * ends as `data-starting-style` and `data-ending-style`, which StyleX has no way
 * to select, so both the Accordion's panel and the Collapsible's read the same
 * status here rather than each deciding what "closed" means.
 */
export function isCollapsed(transitionStatus: string | undefined): boolean {
  return transitionStatus === 'starting' || transitionStatus === 'ending';
}
