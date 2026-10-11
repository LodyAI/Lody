import * as stylex from '@stylexjs/stylex';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { corner, focus, radius, space } from '@lody/ui/tokens/scales.stylex';

const MARK = '14px';
const MARK_GAP = space[1.5];

export const styles = stylex.create({
  /**
   * The group is a card of its own: tasks run beside the turn rather than as
   * one of its steps, and a reader waiting on them needs one place to look.
   */
  panel: {
    display: 'flex',
    flexDirection: 'column',
    minWidth: 0,
    paddingInline: space[1.5],
    paddingBlock: space[1],
    backgroundColor: `color-mix(in oklab, ${colors.elevatedBackground} 55%, transparent)`,
    boxShadow: `inset 0 0 0 1px ${colors.separator}`,
    borderRadius: radius.large,
    cornerShape: corner.shape,
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: MARK_GAP,
    width: '100%',
    margin: 0,
    paddingInline: '4px',
    paddingBlock: '3px',
    borderWidth: 0,
    backgroundColor: 'transparent',
    fontFamily: 'inherit',
    fontSize: '0.9em',
    lineHeight: 1.5,
    textAlign: 'start',
    userSelect: 'none',
    color: { default: colors.secondaryLabel, ':hover': colors.label },
    cursor: 'default',
    outlineStyle: 'none',
  },
  headerToggle: { cursor: 'pointer' },
  chevron: {
    width: '14px',
    height: '14px',
    flexShrink: 0,
    transitionProperty: 'transform',
    transitionDuration: '150ms',
  },
  chevronOpen: { transform: 'rotate(90deg)' },
  glyph: { width: '14px', height: '14px', flexShrink: 0 },
  /**
   * Every line starts with a mark in one column, so a finished task does not
   * sit a spinner's width to the left of a running one, and the header's mark
   * says whether the group is still live.
   */
  mark: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    width: MARK,
    height: MARK,
  },
  markDone: { color: colors.success },
  markFailed: { color: colors.destructive },
  markPending: { color: colors.tertiaryLabel },
  /** The tasks, ruled apart; a long run scrolls inside the card. */
  rows: {
    display: 'flex',
    flexDirection: 'column',
    maxHeight: '22rem',
    overflowY: 'auto',
    marginTop: '2px',
  },
  rowRuled: { borderTopWidth: '1px', borderTopStyle: 'solid', borderTopColor: colors.separator },

  /**
   * One task, the width of the card. Its first line is its identity and its
   * time; a running task adds a second line under the name for what it is doing
   * now, so the step can change every few seconds without the name, the time or
   * the rows below it moving sideways.
   */
  row: {
    display: 'flex',
    flexDirection: 'column',
    width: '100%',
    minWidth: 0,
    margin: 0,
    paddingInlineStart: '4px',
    paddingInlineEnd: '4px',
    paddingBlock: '4px',
    borderWidth: 0,
    borderRadius: radius.small,
    cornerShape: corner.shape,
    backgroundColor: { default: 'transparent', ':hover': colors.hoverFill },
    fontFamily: 'inherit',
    fontSize: '0.9em',
    lineHeight: 1.5,
    textAlign: 'start',
    userSelect: 'none',
    color: colors.secondaryLabel,
    cursor: 'pointer',
    outlineStyle: 'none',
    boxShadow: {
      default: 'none',
      ':focus-visible': `inset 0 0 0 ${focus.ringWidth} ${colors.accent}`,
    },
    transitionProperty: 'background-color',
    transitionDuration: '120ms',
  },
  line: {
    display: 'flex',
    alignItems: 'center',
    gap: MARK_GAP,
    width: '100%',
    minWidth: 0,
  },
  actor: {
    flexShrink: 0,
    color: { default: colors.label, ':hover': colors.label },
  },
  description: {
    flexGrow: 1,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  dot: { flexShrink: 0, color: colors.tertiaryLabel },
  meta: {
    flexShrink: 0,
    marginInlineStart: 'auto',
    color: colors.tertiaryLabel,
    fontVariantNumeric: 'tabular-nums',
    whiteSpace: 'nowrap',
  },
  /** The step in flight, hung under the name rather than under the mark. */
  latest: {
    minWidth: 0,
    paddingInlineStart: `calc(${MARK} + ${MARK_GAP})`,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: '0.95em',
    color: colors.tertiaryLabel,
  },
  /** A run another run started hangs under its parent's name. */
  depth1: { paddingInlineStart: `calc(4px + ${MARK} + ${MARK_GAP})` },
  depth2: { paddingInlineStart: `calc(4px + 2 * (${MARK} + ${MARK_GAP}))` },
  danger: { color: colors.destructive },
});
