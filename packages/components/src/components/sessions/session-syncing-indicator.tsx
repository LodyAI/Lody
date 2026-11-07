import { Spinner } from '@lody/ui/spinner';
import * as stylex from '@stylexjs/stylex';
import { useTranslation } from 'react-i18next';
import { themeColors } from '../../style/theme-colors.stylex';
import { themeFontSize, themeLineHeight, themeSpace } from '../../style/theme-scale.stylex';

const styles = stylex.create({
  root: {
    display: 'inline-flex',
    flexShrink: 0,
    alignItems: 'center',
    gap: themeSpace[1],
    fontSize: themeFontSize.xs,
    lineHeight: themeLineHeight.xs,
    color: themeColors.mutedForeground,
  },
});

/**
 * - `syncing`: generic document catch-up (headers).
 * - `updating`: a cached conversation is shown while newer messages are fetched.
 */
export type SessionSyncIndicatorVariant = 'syncing' | 'updating';

export function SessionSyncingIndicator({
  labelClassName,
  variant = 'syncing',
}: {
  labelClassName?: string;
  variant?: SessionSyncIndicatorVariant;
}) {
  const { t } = useTranslation();

  return (
    <span {...stylex.props(styles.root)} role="status" data-sync-indicator={variant}>
      <Spinner diameter="calc(var(--spacing) * 3)" aria-hidden="true" />
      <span className={labelClassName}>
        {variant === 'updating'
          ? t('sessions.contentSync.updating', 'Updating')
          : t('common.syncing', 'Syncing')}
      </span>
    </span>
  );
}
