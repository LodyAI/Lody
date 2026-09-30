import * as stylex from '@stylexjs/stylex';
import { colors, shadow } from '@lody/ui/tokens/colors.stylex';
import { corner, duration, ease, focus, radius, space, text } from '@lody/ui/tokens/scales.stylex';

/**
 * The materials every onboarding setup screen shares, in `@lody/ui`'s own
 * tokens. The stage is the page rung; what a screen puts on it is a card that
 * lifts, a tile a person picks (the card rung made pressable, selection an
 * accent ring), a list of records (one card, ruled rows), or a message (a tint
 * and a mark). Nothing here draws a border: an edge is a shadow or a ring.
 *
 * Onboarding sizes copy in the package's px steps rather than `em`: the flow
 * owns its own shell and does not follow the settings font-size tier.
 */

/** The accent ring a selected or keyboard-focused tile carries over its card shadow. */
const TILE_RING = `0 0 0 ${focus.ringWidth} ${colors.accent}, ${shadow.card}`;
const TILE_HOVER = `color-mix(in oklab, ${colors.elevatedBackground}, ${colors.label} 4%)`;
/** A block inside a card, or a quiet note on the stage: the region rung, a fill with no edge. */
const REGION_FILL = `color-mix(in oklab, transparent, ${colors.label} 3%)`;

export const onboardingSurface = stylex.create({
  /** A screen's content column: blocks set apart by space. */
  stack: { display: 'flex', flexDirection: 'column', gap: space[3], minWidth: 0 },
  stackLoose: { display: 'flex', flexDirection: 'column', gap: space[4], minWidth: 0 },
  stackTight: { display: 'flex', flexDirection: 'column', gap: space[1.5], minWidth: 0 },
  /** The shell's primary slot holding more than one answer: Skip beside Next. */
  actions: { display: 'flex', alignItems: 'center', gap: space[2] },

  /** The card rung: a block of the stage that lifts, with no border. */
  card: {
    boxSizing: 'border-box',
    minWidth: 0,
    overflow: 'hidden',
    backgroundColor: colors.elevatedBackground,
    boxShadow: shadow.card,
    borderRadius: radius.large,
    cornerShape: corner.shape,
  },
  /** A card holding one line of content rather than rows. */
  cardPadded: {
    display: 'flex',
    alignItems: 'center',
    gap: space[3],
    paddingInline: space[4],
    paddingBlock: space[3],
  },

  /**
   * A list of records inside a card. It scrolls once it passes its cap, and
   * `overscroll-behavior` keeps the wheel from chaining to the stage.
   */
  list: {
    margin: 0,
    padding: 0,
    listStyle: 'none',
    maxHeight: '260px',
    overflowY: 'auto',
    overscrollBehavior: 'contain',
  },
  /** Every row of a list but the first is ruled from the one above. */
  ruled: { boxShadow: `inset 0 1px 0 ${colors.separator}` },
  /** A record's own line: a glyph, its two lines of text, what trails. */
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: space[3],
    minWidth: 0,
    paddingInline: space[3],
    paddingBlock: '10px',
  },

  /**
   * A choice a person picks — a language, a look, a workspace, a project: a
   * pressable on the card rung. Spread on a `<button>`; it resets what a button
   * brings. The pointer's answer is the fill alone; the rung does not lift.
   */
  tile: {
    boxSizing: 'border-box',
    display: 'flex',
    alignItems: 'center',
    gap: space[3],
    width: '100%',
    minWidth: 0,
    margin: 0,
    paddingInline: space[3],
    paddingBlock: space[3],
    borderWidth: 0,
    borderStyle: 'none',
    outlineStyle: 'none',
    backgroundColor: colors.elevatedBackground,
    boxShadow: { default: shadow.card, ':focus-visible': TILE_RING },
    borderRadius: radius.large,
    // A ring cannot be offset in parallel with a superellipse, so a ringed tile
    // takes the round corner.
    cornerShape: { default: corner.shape, ':focus-visible': corner.round },
    color: colors.label,
    fontFamily: 'inherit',
    textAlign: 'start',
    cursor: 'pointer',
    transitionProperty: 'background-color, box-shadow',
    transitionDuration: duration.fast,
    transitionTimingFunction: ease.standard,
  },
  /** The pointer's answer, applied only while the tile can be pressed. */
  tileHover: {
    backgroundColor: { default: colors.elevatedBackground, ':hover': TILE_HOVER },
  },
  tileSelected: {
    boxShadow: { default: TILE_RING, ':focus-visible': TILE_RING },
    cornerShape: corner.round,
  },
  /** Disabled is 45% on the whole control, not a colour. */
  tileDisabled: { opacity: 0.45, cursor: 'not-allowed' },
  /** A tile laid out as a column, centred: the language and look choices. */
  tileColumn: { flexDirection: 'column', justifyContent: 'center', textAlign: 'center' },

  /** A glyph standing for a record, on the region rung inside its card or tile. */
  glyphBox: {
    display: 'flex',
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
    width: '40px',
    height: '40px',
    backgroundColor: REGION_FILL,
    borderRadius: radius.medium,
    cornerShape: corner.shape,
    color: colors.secondaryLabel,
  },
  glyphBoxSmall: { width: '32px', height: '32px', borderRadius: radius.small },

  /** The tick a selected tile carries: selection is the accent. */
  selectedMark: {
    display: 'flex',
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
    width: '20px',
    height: '20px',
    borderRadius: radius.full,
    cornerShape: corner.round,
    backgroundColor: colors.accent,
    color: colors.onAccent,
  },

  /** A record's two lines. */
  textColumn: { display: 'flex', flexDirection: 'column', flexGrow: 1, flexBasis: 0, minWidth: 0 },
  title: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    minWidth: 0,
    fontSize: text.bodySize,
    lineHeight: text.bodyLeading,
    fontWeight: 500,
    color: colors.label,
  },
  detail: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    minWidth: 0,
    fontSize: text.footnoteSize,
    lineHeight: text.footnoteLeading,
    color: colors.secondaryLabel,
  },

  /** The small heading over a group: "Mode", "Connected". */
  groupLabel: {
    margin: 0,
    fontSize: text.footnoteSize,
    lineHeight: text.footnoteLeading,
    fontWeight: 500,
    color: colors.secondaryLabel,
  },
  /** A line of guidance under the controls: a hint, never a label. */
  hint: {
    margin: 0,
    fontSize: text.footnoteSize,
    lineHeight: text.footnoteLeading,
    color: colors.secondaryLabel,
  },
  hintCentered: { textAlign: 'center' },

  /**
   * A message is a tint and a mark, never a bordered box. The neutral tone is
   * the region fill: a note about waiting, not an outcome.
   */
  message: {
    boxSizing: 'border-box',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    gap: space[2],
    minWidth: 0,
    paddingInline: space[3],
    paddingBlock: '10px',
    borderRadius: radius.medium,
    cornerShape: corner.shape,
    fontSize: text.footnoteSize,
    lineHeight: text.footnoteLeading,
  },
  messageInline: { flexDirection: 'row', alignItems: 'center' },
  messageNeutral: { backgroundColor: REGION_FILL, color: colors.secondaryLabel },
  messageDanger: {
    backgroundColor: `color-mix(in oklab, transparent, ${colors.destructive} 10%)`,
    color: colors.destructive,
  },
  messageBody: { display: 'flex', flexDirection: 'column', gap: space[1], minWidth: 0 },
  messageText: { margin: 0, overflowWrap: 'anywhere' },
  /** The underlying detail an error keeps inspectable. */
  messageDetail: {
    margin: 0,
    overflowWrap: 'anywhere',
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    opacity: 0.9,
  },

  /**
   * Glyph boxes. Lucide states its own 24px size, so whatever holds an icon
   * gives it one; a Button's glyph is 16px, or 14px beside small copy.
   */
  icon12: { flexShrink: 0, width: '12px', height: '12px' },
  icon14: { flexShrink: 0, width: '14px', height: '14px' },
  icon16: { flexShrink: 0, width: '16px', height: '16px' },
  icon20: { flexShrink: 0, width: '20px', height: '20px' },
  /** A glyph in a box someone else draws — a Badge's — fills it. */
  iconFill: { width: '100%', height: '100%' },
  iconMuted: { color: colors.tertiaryLabel },
  iconAccent: { color: colors.accent },
  iconDestructive: { color: colors.destructive },
});
