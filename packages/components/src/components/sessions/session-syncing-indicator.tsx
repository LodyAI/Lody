import * as stylex from '@stylexjs/stylex';
import { Progress } from '@lody/ui/progress';
import { Spinner } from '@lody/ui/spinner';
import { useTranslation } from 'react-i18next';
import type { SessionSyncProgress } from '@lody/shared';
import { toIntlLocaleOrEn } from '@/lib/intl-locale';

const styles = stylex.create({
  progressLabel: {
    fontSize: '0.75rem',
    fontVariantNumeric: 'tabular-nums',
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
  syncProgress,
}: {
  labelClassName?: string;
  variant?: SessionSyncIndicatorVariant;
  syncProgress?: SessionSyncProgress | null;
}) {
  const { t, i18n } = useTranslation();

  if (syncProgress) {
    const { kind, received, total } = syncProgress;
    const format = new Intl.NumberFormat(toIntlLocaleOrEn(i18n.resolvedLanguage ?? i18n.language));
    const counts = { received: format.format(received), total: total === undefined ? '' : format.format(total) };
    const applying = received === total;
    let label: string;
    if (kind === 'history') {
      label = applying
        ? t('sessions.contentSync.historyApplyingProgress', 'Applying {{received}} / {{total}}', counts)
        : t('sessions.contentSync.historyReadingProgress', 'History {{received}} / {{total}}', counts);
    } else if (kind === 'chunks') {
      label = applying
        ? t('sessions.contentSync.chunksApplyingProgress', 'Applying {{received}} / {{total}} chunks', counts)
        : t('sessions.contentSync.chunksReadingProgress', 'Syncing {{received}} / {{total}} chunks', counts);
    } else if (total !== undefined) {
      label = applying
        ? t('sessions.contentSync.bytesApplyingProgress', 'Applying {{received}} / {{total}} B', counts)
        : t('sessions.contentSync.bytesReadingProgress', 'Syncing {{received}} / {{total}} B', counts);
    } else if (received > 0) {
      label = t('sessions.contentSync.bytesReceived', 'Syncing {{received}} B', counts);
    } else {
      label = kind === 'bootstrap'
        ? t('sessions.contentSync.readingSessionData', 'Reading session data')
        : t('sessions.contentSync.readingUpdates', 'Syncing session updates');
    }
    return (
      <Progress
        label={<span {...stylex.props(styles.progressLabel)}>{label}</span>}
        value={total === undefined ? null : received}
        max={total ?? 1}
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
