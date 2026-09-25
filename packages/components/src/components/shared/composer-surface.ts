import * as stylex from '@stylexjs/stylex';
import { colors, shadow, sheen } from '@lody/ui/tokens/colors.stylex';
import {
  control,
  corner,
  duration,
  ease,
  radius,
  space,
  text,
} from '@lody/ui/tokens/scales.stylex';

/**
 * The materials the composer and its selectors share, in `@lody/ui`'s own
 * tokens, so the run-config button, the permission button, the option
 * selectors and the lists they open cannot each grow their own chip and row.
 *
 * - A trigger in the composer toolbar is **ghost**: no fill and no edge at
 *   rest, `hoverFill` under the pointer and while its popup is up. It is what a
 *   ghost `Button` is, restated here because a composer trigger follows the
 *   font-size tier (`0.9em` of `--ui-font-size`) and folds to a square when the
 *   face slot is narrow, neither of which a `Button` prop can say.
 * - A trigger used as a form value is the **field**: the one recessed well.
 * - What they open is the floating rung, and its rows mirror `@lody/ui`'s popup
 *   rows (`popup` tokens are internal to the package, so they are restated from
 *   the semantic tokens they resolve to): 28px, 8px in, 10px corners, the
 *   highlight mixed 6% from the surface toward the ink, the tick at the end.
 * - A search field on that surface is typed into, so it is still the well.
 *
 * StyleX has no attribute or descendant selector: open, highlighted and
 * compact are read from state or a container query and applied as classes.
 */

/** The composer face's own container (`@container/composer-face`) is narrow. */
const COMPACT_FACE = '@container composer-face (max-width: 280px)';

/** The focus ring every control here composes into its own shadow. */
const RING = `0 0 0 2px ${colors.accent}`;

/** The popup rows' highlight: the floating rung mixed toward the ink. */
const POPUP_HIGHLIGHT = `color-mix(in oklab, ${colors.raisedBackground}, ${colors.label} 6%)`;

export const composerSurface = stylex.create({
  /* ── Toolbar trigger (ghost) ─────────────────────────────────────────── */

  /** A trigger resting in the composer toolbar: a ghost control in `em`. */
  trigger: {
    boxSizing: 'border-box',
    display: 'inline-flex',
    alignItems: 'center',
    gap: space[1.5],
    minWidth: 0,
    height: control.small,
    margin: 0,
    paddingInline: space[2],
    borderWidth: 0,
    borderStyle: 'none',
    borderRadius: radius.small,
    cornerShape: corner.round,
    backgroundColor: { default: 'transparent', ':hover': colors.hoverFill },
    color: { default: colors.secondaryLabel, ':hover': colors.label },
    boxShadow: { default: 'none', ':focus-visible': RING },
    outlineStyle: 'none',
    fontFamily: 'inherit',
    fontSize: '0.9em',
    fontWeight: 500,
    letterSpacing: text.controlTracking,
    lineHeight: 1.25,
    whiteSpace: 'nowrap',
    textAlign: 'start',
    userSelect: 'none',
    cursor: 'default',
    opacity: { default: 1, ':disabled': 0.45 },
    transitionProperty: 'background-color, color, box-shadow, opacity',
    transitionDuration: duration.fast,
    transitionTimingFunction: ease.standard,
  },
  /** The small step, for a trigger inside a 24px context pill. */
  triggerSmall: { height: '24px', paddingInline: space[1.5], borderRadius: '6px' },
  /** The popup it opened is up: the pointer's fill stays. */
  triggerOpen: { backgroundColor: colors.hoverFill, color: colors.label },
  /**
   * A trigger that explains why it cannot be used rather than being disabled:
   * it stays focusable for its tooltip, and drops the pointer's fill.
   */
  triggerInert: {
    opacity: 0.45,
    backgroundColor: 'transparent',
    color: colors.secondaryLabel,
  },
  /**
   * The narrow face: a square at the control height, so the plus, the model and
   * the mode buttons share one hit box. Every property restates its default,
   * because this style replaces the ones `trigger` set.
   */
  triggerCompact: {
    flexShrink: { default: 1, [COMPACT_FACE]: 0 },
    width: { default: 'auto', [COMPACT_FACE]: control.small },
    gap: { default: space[1.5], [COMPACT_FACE]: 0 },
    paddingInline: { default: space[2], [COMPACT_FACE]: 0 },
    justifyContent: { default: 'flex-start', [COMPACT_FACE]: 'center' },
  },

  /* ── Context pill (above the composer) ───────────────────────────────── */

  /**
   * A pill holding two pressables side by side (the branch and the worktree
   * toggle): the raised material a secondary `Button` stands up in, at the
   * mini step, so it sits in one row with the machine button beside it.
   */
  contextPill: {
    boxSizing: 'border-box',
    display: 'flex',
    alignItems: 'center',
    minWidth: 0,
    maxWidth: '100%',
    height: '24px',
    overflow: 'hidden',
    borderRadius: '6px',
    cornerShape: corner.round,
    backgroundColor: colors.raisedBackground,
    backgroundImage: sheen.raised,
    boxShadow: shadow.raised,
  },
  /** The line between the pill's two halves. */
  contextPillDivider: {
    flexShrink: 0,
    width: '1px',
    height: '16px',
    backgroundColor: colors.separator,
  },

  /* ── What a toolbar trigger says ─────────────────────────────────────── */

  /** A run of words on a trigger face; hidden when the face is compact. */
  faceText: {
    display: { default: 'block', [COMPACT_FACE]: 'none' },
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    textAlign: 'start',
  },
  /** Words that keep their width, like a reasoning level. */
  faceFixed: {
    display: { default: 'block', [COMPACT_FACE]: 'none' },
    flexShrink: 0,
  },
  /** A group of a mark and its words that keep their width. */
  faceGroup: {
    display: { default: 'flex', [COMPACT_FACE]: 'none' },
    flexShrink: 0,
    alignItems: 'center',
    gap: space[1],
  },
  /** The dot between two facts on a face. */
  faceDot: {
    display: { default: 'block', [COMPACT_FACE]: 'none' },
    flexShrink: 0,
    userSelect: 'none',
    color: colors.tertiaryLabel,
  },
  /** A face's live state (Plan, Fast on): the accent, which is for live state. */
  faceLive: {
    display: { default: 'block', [COMPACT_FACE]: 'none' },
    flexShrink: 0,
    width: '14px',
    height: '14px',
    color: colors.accent,
  },
  /** A face's warning-tone fact, like full access. */
  faceWarning: { color: colors.warning },
  /**
   * The values a Role pins, stated beside its button and inert: a caption in the
   * hint colour, gone with the rest of the face when it is compact.
   */
  faceInert: {
    display: { default: 'flex', [COMPACT_FACE]: 'none' },
    alignItems: 'center',
    gap: space[1],
    minWidth: 0,
    pointerEvents: 'none',
    userSelect: 'none',
    color: colors.tertiaryLabel,
    fontSize: text.captionSize,
    lineHeight: text.captionLeading,
  },

  /* ── Glyph boxes ─────────────────────────────────────────────────────── */

  /** The leading mark of a trigger or row: a 16px box sizing what it holds. */
  glyph: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    width: '16px',
    height: '16px',
  },
  /** A lucide glyph in a 16px box. */
  glyph16: { display: 'block', flexShrink: 0, width: '16px', height: '16px' },
  /** A lucide glyph at the 14px step: a trailing mark beside words. */
  glyph14: { display: 'block', flexShrink: 0, width: '14px', height: '14px' },
  /** A lucide glyph at the 12px step. */
  glyph12: { display: 'block', flexShrink: 0, width: '12px', height: '12px' },
  /** An emoji standing for a Role: text, sized like a glyph. */
  emoji: { flexShrink: 0, fontSize: text.subheadlineSize, lineHeight: 1 },
  /** A mark that is a hint rather than content: the icon at rest. */
  hint: { color: colors.tertiaryLabel },
  /** The chevron of a trigger. */
  chevron: {
    display: 'block',
    flexShrink: 0,
    width: '14px',
    height: '14px',
    color: colors.tertiaryLabel,
  },

  /* ── Field trigger (the well) ────────────────────────────────────────── */

  /** A trigger holding a form value: the recessed well, with its ring. */
  field: {
    boxSizing: 'border-box',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space[2],
    width: '100%',
    minWidth: 0,
    margin: 0,
    borderWidth: 0,
    borderStyle: 'none',
    cornerShape: corner.round,
    backgroundColor: colors.wellBackground,
    boxShadow: { default: shadow.inset, ':focus-visible': `${RING}, ${shadow.inset}` },
    outlineStyle: 'none',
    color: colors.label,
    fontFamily: 'inherit',
    fontSize: text.subheadlineSize,
    fontWeight: 500,
    letterSpacing: text.controlTracking,
    lineHeight: 1.25,
    whiteSpace: 'nowrap',
    textAlign: 'start',
    userSelect: 'none',
    cursor: 'default',
    opacity: { default: 1, ':disabled': 0.45 },
    transitionProperty: 'box-shadow, opacity',
    transitionDuration: duration.fast,
    transitionTimingFunction: ease.standard,
  },
  fieldSmall: { height: control.small, paddingInline: space[2], borderRadius: radius.small },
  fieldMedium: { height: control.medium, paddingInline: '10px', borderRadius: radius.medium },
  fieldLarge: { height: control.large, paddingInline: space[3], borderRadius: radius.medium },
  /** An empty field reads as a prompt, in the placeholder's hint colour. */
  fieldPlaceholder: { color: colors.tertiaryLabel },

  /** The value inside a trigger: takes the width the chevron leaves. */
  value: {
    display: 'flex',
    alignItems: 'center',
    gap: space[1.5],
    flexGrow: 1,
    flexShrink: 1,
    minWidth: 0,
    overflow: 'hidden',
  },
  /** Words that give way to an ellipsis. */
  truncate: {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },

  /* ── The floating rung's contents ────────────────────────────────────── */

  /**
   * The list's own box inside a `Popover.Content`. The popover pads prose by
   * 12px and sets prose type; a list of rows takes the popup's 4px inset and
   * the control type instead, so this box reaches back out to that inset.
   */
  popupList: {
    display: 'flex',
    flexDirection: 'column',
    minWidth: 0,
    margin: `calc(${space[1]} - ${space[3]})`,
    color: colors.label,
    fontSize: text.subheadlineSize,
    lineHeight: text.subheadlineLeading,
    fontWeight: 500,
    letterSpacing: text.controlTracking,
  },
  /** The scrolling region under the search field. */
  popupScroll: {
    minHeight: 0,
    overflowX: 'hidden',
    overflowY: 'auto',
    overscrollBehavior: 'contain',
    outlineStyle: 'none',
    touchAction: 'pan-y',
  },
  /** A row: a 28px control that happens to live in a list. */
  row: {
    boxSizing: 'border-box',
    display: 'flex',
    alignItems: 'center',
    gap: space[2],
    minHeight: control.small,
    paddingBlock: 0,
    paddingInline: space[2],
    borderRadius: radius.medium,
    cornerShape: corner.shape,
    backgroundColor: 'transparent',
    color: colors.label,
    cursor: 'default',
    userSelect: 'none',
    outlineStyle: 'none',
    boxShadow: 'none',
    scrollMarginBlock: space[1],
    // No transition, like `@lody/ui`'s popup rows: the highlight follows the
    // pointer and the arrow keys without lagging behind them.
  },
  /** Where the keyboard or the pointer is. */
  rowHighlighted: { backgroundColor: POPUP_HIGHLIGHT },
  /** The same 45% the whole library uses, and no pointer. */
  rowDisabled: { opacity: 0.45, pointerEvents: 'none' },
  /** A row's words: the name, and what it is about under it. */
  rowText: {
    display: 'flex',
    flexDirection: 'column',
    flexGrow: 1,
    flexShrink: 1,
    minWidth: 0,
  },
  /** A row carrying a second line keeps its words clear of the row's edge. */
  rowTextStacked: { paddingBlock: space[1] },
  rowLabel: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  /** A name that may be long, like a branch: it wraps instead. */
  rowLabelWrap: { whiteSpace: 'normal', overflowWrap: 'anywhere' },
  rowDescription: {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    color: colors.secondaryLabel,
    fontSize: text.footnoteSize,
    lineHeight: text.footnoteLeading,
    fontWeight: 400,
  },
  /** The row's leading mark, at rest in the hint colour. */
  rowIcon: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    width: '16px',
    height: '16px',
    color: colors.tertiaryLabel,
  },
  /** The tick's box, reserved on every row so the list does not reflow. */
  rowTick: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    marginInlineStart: 'auto',
    width: '16px',
    height: '16px',
    color: colors.label,
  },
  /** "No matches": a hint rather than a row, because it cannot be picked. */
  empty: {
    boxSizing: 'border-box',
    display: 'flex',
    alignItems: 'center',
    minHeight: control.small,
    paddingInline: space[2],
    color: colors.tertiaryLabel,
    fontWeight: 400,
    userSelect: 'none',
  },

  /* ── Search on the floating rung ─────────────────────────────────────── */

  /** A search field on a popup: typed into, so the well, one row tall. */
  search: {
    boxSizing: 'border-box',
    display: 'block',
    flexShrink: 0,
    width: '100%',
    height: control.small,
    margin: 0,
    marginBottom: space[1],
    paddingInline: space[2],
    borderWidth: 0,
    borderStyle: 'none',
    borderRadius: radius.medium,
    cornerShape: corner.round,
    backgroundColor: colors.wellBackground,
    boxShadow: { default: shadow.inset, ':focus-visible': `${RING}, ${shadow.inset}` },
    outlineStyle: 'none',
    color: colors.label,
    fontFamily: 'inherit',
    fontSize: text.subheadlineSize,
    fontWeight: 500,
    letterSpacing: text.controlTracking,
    '::placeholder': { color: colors.tertiaryLabel, opacity: 1 },
  },
});
