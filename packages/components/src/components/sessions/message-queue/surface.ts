import * as stylex from '@stylexjs/stylex';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { duration, radius, space, text } from '@lody/ui/tokens/scales.stylex';

const TOUCH = '@media (pointer: coarse), (max-width: 600px)';
const NO_HOVER = '@media (hover: none)';
/** Touch row height and its More box: non-overlapping, see the touch-actions Spec. */
const TOUCH_ROW = 36;
const TOUCH_MORE_WIDTH = 40;

/** One line of queue text; the gutter, index and actions center on this box. */
export const QUEUE_LINE = text.subheadlineLeading;
/** The leading gutter (index, drag handle, section label) every row shares. */
export const QUEUE_GUTTER = 16;

// Rows are inset tiles on the sheet rather than hairline-divided strips: the
// gutter, text and actions columns line up across queued, local-pending and
// scheduled rows, so the sections read as one list. Desktop actions surface on
// hover or focus; touch layouts keep them visible with real 44 px boxes on the
// message's line.
export const queueSurface = stylex.create({
  list: { display: 'flex', flexDirection: 'column', padding: space[1], paddingTop: 0 },
  row: {
    position: 'relative',
    display: 'flex',
    alignItems: 'flex-start',
    gap: space[2],
    paddingBlock: space[1.5],
    paddingInline: space[1.5],
    borderRadius: radius.mini,
    backgroundColor: {
      default: 'transparent',
      ':hover': { default: colors.hoverFill, [NO_HOVER]: 'transparent' },
    },
    transitionProperty: 'background-color',
    transitionDuration: duration.fast,
  },
  // Touch rows are dense: 36 px tall, matching the 40 × 36 More box, so a short
  // sheet shows every row without scrolling.
  roomyRow: {
    minHeight: { default: 40, [TOUCH]: TOUCH_ROW },
    alignItems: 'center',
    paddingInlineStart: space[1.5],
    paddingInlineEnd: { default: space[1.5], [TOUCH]: 0 },
    paddingBlock: { default: space[1], [TOUCH]: 0 },
    columnGap: { default: space[2], [TOUCH]: space[1] },
    backgroundColor: {
      default: 'transparent',
      ':hover': { default: colors.hoverFill, [NO_HOVER]: 'transparent' },
    },
    flexWrap: 'wrap',
    display: { default: 'flex', [TOUCH]: 'grid' },
    gridTemplateColumns: { default: null, [TOUCH]: `minmax(0, 1fr) ${TOUCH_MORE_WIDTH}px` },
  },
  airyRow: { minHeight: 48, paddingInline: space[3], paddingBlock: space[1.5] },
  editingRow: { backgroundColor: { default: colors.hoverFill, ':hover': colors.hoverFill } },
  roomyBody: {
    minWidth: { default: 120, [TOUCH]: 0 },
    gridColumn: { default: null, [TOUCH]: 1 },
    gridRow: { default: null, [TOUCH]: 1 },
  },
  inlineMeta: { gridColumn: { default: null, [TOUCH]: 1 }, gridRow: { default: null, [TOUCH]: 1 } },
  // Touch rows drop the index/gutter: the message starts the line.
  leading: { display: { default: 'contents', [TOUCH]: 'none' } },
  editor: { gridColumn: '1 / -1', width: '100%' },
  text: {
    overflowWrap: 'anywhere',
    fontSize: text.subheadlineSize,
    lineHeight: QUEUE_LINE,
    color: colors.label,
    opacity: 0.86,
  },
  preparingText: { opacity: 0.55 },
  roomyText: {
    fontSize: { default: text.bodySize, [TOUCH]: text.subheadlineSize },
    lineHeight: { default: text.bodyLeading, [TOUCH]: QUEUE_LINE },
  },
  editorText: { fontSize: text.subheadlineSize, lineHeight: QUEUE_LINE },
  actions: {
    display: 'flex',
    flexShrink: 0,
    alignItems: 'center',
    height: { default: QUEUE_LINE, [TOUCH]: 'auto' },
    gap: { default: 2, [TOUCH]: 0 },
  },
  roomyActions: {
    display: 'flex',
    justifyContent: 'flex-end',
    height: 'auto',
    gap: { default: space[1], [TOUCH]: 0 },
    marginInlineStart: 'auto',
    gridColumn: { default: null, [TOUCH]: 2 },
    gridRow: { default: null, [TOUCH]: 1 },
  },
  roomyAction: {
    minHeight: { default: 32, [TOUCH]: TOUCH_ROW },
    minWidth: { default: 32, [TOUCH]: TOUCH_MORE_WIDTH },
  },
  action: {
    minHeight: { default: null, [TOUCH]: TOUCH_ROW },
    minWidth: { default: null, [TOUCH]: TOUCH_MORE_WIDTH },
  },
  more: {
    display: 'flex',
    appearance: 'none',
    alignItems: 'center',
    justifyContent: 'center',
    width: TOUCH_MORE_WIDTH,
    height: TOUCH_ROW,
    flexShrink: 0,
    padding: 0,
    borderWidth: 0,
    borderRadius: radius.small,
    backgroundColor: { default: 'transparent', ':hover': colors.selectedFill },
    color: colors.secondaryLabel,
    cursor: 'pointer',
    boxShadow: { default: 'none', ':focus-visible': `inset 0 0 0 2px ${colors.accent}` },
    outline: 'none',
  },
  steer: {
    display: 'inline-flex',
    alignItems: 'center',
    flexShrink: 0,
    height: 20,
    paddingInline: space[2],
    borderRadius: radius.full,
    borderWidth: 0,
    backgroundColor: { default: colors.trayBackground, ':hover': colors.selectedFill },
    color: colors.secondaryLabel,
    fontSize: text.captionSize,
    fontWeight: 500,
    letterSpacing: text.controlTracking,
    cursor: 'pointer',
    transitionProperty: 'background-color, color',
    transitionDuration: duration.fast,
    boxShadow: { default: 'none', ':focus-visible': `0 0 0 2px ${colors.accent}` },
    outline: 'none',
  },

  sectionLabel: {
    display: 'flex',
    alignItems: 'center',
    gap: space[2],
    paddingInline: space[1.5],
    paddingTop: { default: space[2], [TOUCH]: space[1.5] },
    paddingBottom: { default: 2, [TOUCH]: 0 },
    fontSize: text.captionSize,
    lineHeight: text.captionLeading,
    fontWeight: 500,
    color: colors.secondaryLabel,
  },

  gutter: { display: 'block', flexShrink: 0, width: QUEUE_GUTTER },
  // A reservation's send time leads its text inline, like a queued row's inline
  // footer; it is the row's direct control and opens the time editor.
  time: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 3,
    marginInlineStart: -4,
    paddingInline: 4,
    borderWidth: 0,
    borderRadius: radius.mini,
    verticalAlign: 'top',
    backgroundColor: { default: 'transparent', ':hover': colors.selectedFill },
    color: colors.secondaryLabel,
    fontFamily: 'inherit',
    fontSize: 'inherit',
    lineHeight: 'inherit',
    fontVariantNumeric: 'tabular-nums',
    whiteSpace: 'nowrap',
    cursor: 'pointer',
    transitionProperty: 'background-color',
    transitionDuration: duration.fast,
    boxShadow: { default: 'none', ':focus-visible': `inset 0 0 0 2px ${colors.accent}` },
    outline: 'none',
  },
  failed: { color: colors.destructive },
  // The fine-pointer More trigger used when the sheet is too narrow for inline actions.
  compactMore: { width: 22, height: QUEUE_LINE, borderRadius: radius.mini },
});
