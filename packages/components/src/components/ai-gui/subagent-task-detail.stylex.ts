import * as stylex from '@stylexjs/stylex';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { corner, radius, space, text } from '@lody/ui/tokens/scales.stylex';
import { conversation } from './conversation.tokens.stylex';

const REGION = `color-mix(in oklab, transparent, ${colors.label} 5%)`;

export const dialogLayout = { width: '800px', maxHeight: 'min(760px, 85dvh)' };

export const styles = stylex.create({
  /** The task at full depth; everything under the heading scrolls as one column. */
  detail: {
    display: 'flex',
    flexDirection: 'column',
    gap: conversation.surfaceGap,
    minHeight: 0,
    overflowY: 'auto',
    overscrollBehavior: 'contain',
    // Focusable only so the dialog can land here; the panel's own shadow says
    // where focus is, as it does for the modal itself.
    outlineStyle: 'none',
  },
  bodyWrap: { position: 'relative', minWidth: 0 },
  commandBrief: { paddingInlineEnd: space[8] },
  danger: { color: colors.destructive },
  body: {
    margin: 0,
    paddingBlock: space[2],
    paddingInlineStart: space[3],
    // Room for the copy button in the corner.
    paddingInlineEnd: '36px',
    backgroundColor: REGION,
    borderRadius: radius.medium,
    cornerShape: corner.shape,
    fontSize: text.bodySize,
    lineHeight: conversation.readingLeading,
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
    color: colors.label,
  },
  copy: { position: 'absolute', insetBlockStart: '4px', insetInlineEnd: '4px' },
  section: { display: 'flex', flexDirection: 'column', gap: space[1], minWidth: 0 },
  sectionLabel: { margin: 0, fontSize: text.captionSize, color: colors.tertiaryLabel },
  sectionText: {
    margin: 0,
    fontSize: text.subheadlineSize,
    lineHeight: text.subheadlineLeading,
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
    color: colors.label,
  },
  note: {
    margin: 0,
    fontSize: text.subheadlineSize,
    lineHeight: text.subheadlineLeading,
    color: colors.secondaryLabel,
  },
  actionsError: { flexGrow: 1, alignSelf: 'center' },
  /** Covers the dialog's backdrop inside a drawer, so a drag there is not Vaul's. */
  backdropNoDrag: { position: 'absolute', inset: 0 },
});
