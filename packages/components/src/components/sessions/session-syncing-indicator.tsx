import * as stylex from '@stylexjs/stylex';
import { Progress } from '@lody/ui/progress';
import { Spinner } from '@lody/ui/spinner';
import { useTranslation } from 'react-i18next';
import type { HistorySyncProgress } from '@/lib/conversation-view/create-conversation-session';
import { toIntlLocaleOrEn } from '@/lib/intl-locale';

const styles = stylex.create({
  historyLabel: {
    fontSize: '0.75rem',
    fontVariantNumeric: 'tabular-nums',
    whiteSpace: 'nowrap',
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
  historyProgress,
}: {
  labelClassName?: string;
  variant?: SessionSyncIndicatorVariant;
  historyProgress?: HistorySyncProgress | null;
}) {
  const { t, i18n } = useTranslation();

  if (historyProgress) {
    const { received, total } = historyProgress;
    const format = new Intl.NumberFormat(toIntlLocaleOrEn(i18n.resolvedLanguage ?? i18n.language));
    const counts = { received: format.format(received), total: format.format(total) };
    const label =
      received === total
        ? t(
            'sessions.contentSync.historyApplyingProgress',
            'Applying {{received}} / {{total}}',
            counts
          )
        : t(
            'sessions.contentSync.historyReadingProgress',
            'History {{received}} / {{total}}',
            counts
          );
    return (
      <Progress
        label={<span {...stylex.props(styles.historyLabel)}>{label}</span>}
        value={received}
        max={total}
        getAriaValueText={() => label}
      />
    );
  }

  return (
    <span
      className="inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground"
      role="status"
      data-sync-indicator={variant}
    >
      <Spinner className="h-3 w-3" aria-hidden="true" />
      <span className={labelClassName}>
        {variant === 'updating'
          ? t('sessions.contentSync.updating', 'Syncing')
          : t('common.syncing', 'Syncing')}
      </span>
    </span>
  );
}
