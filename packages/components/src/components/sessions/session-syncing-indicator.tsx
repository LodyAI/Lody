import { Progress } from '@lody/ui/progress';
import { Spinner } from '@lody/ui/spinner';
import * as stylex from '@stylexjs/stylex';
import { useMemo, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import type { SessionSyncProgress, SessionSyncProgressView } from '@lody/shared';
import { toIntlLocaleOrEn } from '@/lib/intl-locale';
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
  progressLabel: {
    fontSize: themeFontSize.xs,
    fontVariantNumeric: 'tabular-nums',
  },
});

/**
 * - `syncing`: generic document catch-up (headers).
 * - `updating`: a cached conversation is shown while newer messages are fetched.
 */
export type SessionSyncIndicatorVariant = 'syncing' | 'updating';

const noProgress = (): SessionSyncProgress | null => null;
const noProgressSubscription = () => () => {};

/** Subscribes the indicator alone, so each published step re-renders only it. */
function useSessionSyncProgress(view: SessionSyncProgressView | undefined) {
  return useSyncExternalStore(
    view?.subscribe ?? noProgressSubscription,
    view?.getSnapshot ?? noProgress,
    noProgress
  );
}

export function SessionSyncingIndicator({
  labelClassName,
  variant = 'syncing',
  syncProgress,
}: {
  labelClassName?: string;
  variant?: SessionSyncIndicatorVariant;
  syncProgress?: SessionSyncProgressView;
}) {
  const { t } = useTranslation();
  const progress = useSessionSyncProgress(syncProgress);

  if (progress) return <SessionSyncProgressBar progress={progress} />;

  return (
    <span {...stylex.props(styles.root)} role="status" data-sync-indicator={variant}>
      <Spinner diameter="calc(var(--spacing) * 3)" aria-hidden="true" />
      <span className={labelClassName}>
        {variant === 'updating'
          ? t('sessions.contentSync.updating', 'Syncing')
          : t('common.syncing', 'Syncing')}
      </span>
    </span>
  );
}

function SessionSyncProgressBar({ progress }: { progress: SessionSyncProgress }) {
  const { t, i18n } = useTranslation();
  const locale = toIntlLocaleOrEn(i18n.resolvedLanguage ?? i18n.language);
  const format = useMemo(() => new Intl.NumberFormat(locale), [locale]);
  const { kind, received, total } = progress;
  const counts = {
    received: format.format(received),
    total: total === undefined ? '' : format.format(total),
  };
  const applying = received === total;
  let label: string;
  if (kind === 'history') {
    label = applying
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
  } else if (kind === 'chunks') {
    label = applying
      ? t(
          'sessions.contentSync.chunksApplyingProgress',
          'Applying {{received}} / {{total}} chunks',
          counts
        )
      : t(
          'sessions.contentSync.chunksReadingProgress',
          'Syncing {{received}} / {{total}} chunks',
          counts
        );
  } else if (total !== undefined) {
    label = applying
      ? t(
          'sessions.contentSync.bytesApplyingProgress',
          'Applying {{received}} / {{total}} B',
          counts
        )
      : t(
          'sessions.contentSync.bytesReadingProgress',
          'Syncing {{received}} / {{total}} B',
          counts
        );
  } else if (received > 0) {
    label = t('sessions.contentSync.bytesReceived', 'Syncing {{received}} B', counts);
  } else {
    label =
      kind === 'bootstrap'
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
