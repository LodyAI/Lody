import * as stylex from '@stylexjs/stylex';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { space, text } from '@lody/ui/tokens/scales.stylex';

const TOUCH = '@media (pointer: coarse), (max-width: 600px)';

// Real layout boxes, not overlapping pseudo-element hit areas. Touch actions
// stay on the message's line; the row centers on their 44 px boxes so the
// index, text and actions read as one line instead of a detached button strip.
export const queueSurface = stylex.create({
  roomyRow: {
    minHeight: 40,
    alignItems: 'center',
    paddingInlineStart: { default: space[3], [TOUCH]: space[3] },
    paddingInlineEnd: { default: space[3], [TOUCH]: space[2] },
    paddingBlock: { default: space[1], [TOUCH]: 0 },
    columnGap: { default: space[2], [TOUCH]: space[1] },
    flexWrap: 'wrap',
    display: { default: 'flex', [TOUCH]: 'grid' },
    gridTemplateColumns: { default: null, [TOUCH]: 'minmax(0, 1fr) 44px' },
  },
  airyRow: { minHeight: 48, paddingInline: space[3], paddingBlock: space[1.5] },
  roomyBody: {
    minWidth: { default: 120, [TOUCH]: 0 },
    gridColumn: { default: null, [TOUCH]: 1 },
    gridRow: { default: null, [TOUCH]: 1 },
  },
  inlineMeta: { gridColumn: { default: null, [TOUCH]: 1 }, gridRow: { default: null, [TOUCH]: 1 } },
  editor: { gridColumn: '1 / -1', width: '100%' },
  leading: { display: { default: 'contents', [TOUCH]: 'none' } },
  editGlyph: { transform: { default: null, [TOUCH]: 'translateX(4px)' } },
  removeGlyph: { transform: { default: null, [TOUCH]: 'translateX(-4px)' } },
  roomyText: { fontSize: text.bodySize, lineHeight: 1.5 },
  roomyActions: {
    height: 'auto',
    gap: { default: space[1], [TOUCH]: 0 },
    marginInlineStart: 'auto',
    gridColumn: { default: null, [TOUCH]: 2 },
    gridRow: { default: null, [TOUCH]: 1 },
  },
  roomyAction: { minHeight: { default: 32, [TOUCH]: 44 }, minWidth: { default: 32, [TOUCH]: 44 } },
  row: {
    display: 'flex',
    alignItems: { default: 'flex-start', [TOUCH]: 'center' },
  },
  actions: {
    height: { default: 'calc(0.75rem * 1.375)', [TOUCH]: 'auto' },
    gap: { default: 2, [TOUCH]: 0 },
  },
  pendingActions: { gap: { default: space[1], [TOUCH]: 0 } },
  scheduledSection: {
    display: 'flex',
    alignItems: 'center',
    gap: space[1.5],
    paddingInline: space[2],
    paddingTop: space[2],
    paddingBottom: space[1],
    borderTopWidth: 1,
    borderTopStyle: 'solid',
    borderTopColor: colors.separator,
    fontSize: text.captionSize,
    color: colors.secondaryLabel,
  },
  scheduledRow: {
    display: 'flex',
    alignItems: 'center',
    gap: space[2],
    width: '100%',
    minHeight: { default: 32, [TOUCH]: 44 },
    paddingInline: space[2],
    paddingBlock: { default: space[1], [TOUCH]: 0 },
    borderTopWidth: 1,
    borderTopStyle: 'solid',
    borderTopColor: colors.separator,
    backgroundColor: { default: 'transparent', ':hover': colors.hoverFill },
    textAlign: 'start',
    boxShadow: { default: 'none', ':focus-visible': `inset 0 0 0 2px ${colors.accent}` },
    cursor: 'pointer',
  },
  scheduledIcon: { flexShrink: 0, color: colors.secondaryLabel },
  scheduledTime: {
    flexShrink: 0,
    fontSize: text.captionSize,
    color: colors.secondaryLabel,
    fontVariantNumeric: 'tabular-nums',
  },
  scheduledTitle: {
    minWidth: 0,
    flex: 1,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: text.bodySize,
  },
  scheduledState: { flexShrink: 0, fontSize: text.captionSize, color: colors.secondaryLabel },
  scheduledFailed: { color: colors.destructive },

  action: {
    minHeight: { default: null, [TOUCH]: 44 },
    minWidth: { default: null, [TOUCH]: 44 },
  },
  text: { overflowWrap: 'anywhere' },
});
