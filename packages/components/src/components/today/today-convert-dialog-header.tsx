import * as stylex from '@stylexjs/stylex';
import { ChevronRight } from 'lucide-react';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { control, space, text } from '@lody/ui/tokens/scales.stylex';
import { Dialog } from '@/ui/dialog';

/** The panel width of "Convert to task": a create form, wider than a question. */
export const TODAY_CONVERT_DIALOG_WIDTH = '48rem';

const styles = stylex.create({
  // One control tall, so the crumbs centre on the panel's close cross, which
  // sits at the panel's padding in the top corner; the end padding keeps a
  // long translation clear of it.
  crumbs: {
    display: 'flex',
    alignItems: 'center',
    gap: space[1],
    minHeight: control.small,
    minWidth: 0,
    paddingInlineEnd: control.medium,
    fontSize: text.subheadlineSize,
    lineHeight: text.subheadlineLeading,
    fontWeight: 500,
    userSelect: 'none',
  },
  parent: { color: colors.secondaryLabel, flexShrink: 0 },
  separator: { color: colors.tertiaryLabel, flexShrink: 0, width: 14, height: 14 },
  current: {
    color: colors.label,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
});

/**
 * Where the task is being made, not a heading: "Today › Convert to task", in
 * the small type of a breadcrumb. It is still the dialog's title, so the
 * panel's accessible name reads the same words.
 */
export function TodayConvertDialogHeader({ parent, title }: { parent: string; title: string }) {
  return (
    <Dialog.Title>
      <span {...stylex.props(styles.crumbs)}>
        <span {...stylex.props(styles.parent)}>{parent}</span>
        <ChevronRight aria-hidden="true" strokeWidth={1.75} {...stylex.props(styles.separator)} />
        <span {...stylex.props(styles.current)}>{title}</span>
      </span>
    </Dialog.Title>
  );
}
