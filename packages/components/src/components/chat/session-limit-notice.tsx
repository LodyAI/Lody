import * as stylex from '@stylexjs/stylex';
import { colors } from '@lody/ui/tokens/colors.stylex';
import {
  themeFontSize,
  themeFontWeight,
  themeLineHeight,
  themeRadius,
  themeShadow,
  themeSpace,
} from '../../style/theme-scale.stylex';

const DARK_SCOPE =
  ':where(.dark, .dark *, .dark-scope, .dark-scope *):not(:where(.light-scope, .light-scope *))';

const styles = stylex.create({
  notice: {
    marginBottom: themeSpace[2],
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    columnGap: themeSpace[1.5],
    rowGap: themeSpace[1],
    borderRadius: themeRadius.lg,
    borderWidth: '1px',
    borderStyle: 'solid',
    paddingInline: themeSpace[3],
    paddingBlock: themeSpace[2],
    fontSize: themeFontSize.xs,
    lineHeight: themeLineHeight.xs,
    fontWeight: themeFontWeight.medium,
    boxShadow: themeShadow.xs,
    borderColor: `color-mix(in oklab, ${colors.warning} 30%, transparent)`,
    backgroundColor: `color-mix(in oklab, ${colors.warning} 10%, transparent)`,
    color: {
      default: 'var(--color-amber-950)',
      [DARK_SCOPE]: 'var(--color-amber-100)',
    },
  },
  action: {
    fontWeight: themeFontWeight.semibold,
    textDecorationLine: 'underline',
    textUnderlineOffset: '2px',
    color: {
      default: 'var(--color-amber-700)',
      '@media (hover: hover)': { ':hover': 'var(--color-amber-800)' },
      [DARK_SCOPE]: {
        default: 'var(--color-amber-200)',
        '@media (hover: hover)': { ':hover': 'var(--color-amber-100)' },
      },
    },
  },
});

export function SessionLimitNotice({
  message,
  actionLabel,
  onUpgrade,
}: {
  message: string;
  actionLabel?: string;
  onUpgrade: () => void;
}) {
  return (
    <div {...stylex.props(styles.notice)}>
      <span>{message}</span>
      {actionLabel !== undefined ? (
        <button type="button" {...stylex.props(styles.action)} onClick={onUpgrade}>
          {actionLabel}
        </button>
      ) : null}
    </div>
  );
}
