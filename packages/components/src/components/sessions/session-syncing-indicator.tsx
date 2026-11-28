import { Spinner } from '@lody/ui/spinner';
import * as stylex from '@stylexjs/stylex';
import { useTranslation } from 'react-i18next';
import type { RoostHistorySyncState } from '@lody/shared';
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
  history: {
    display: 'flex',
    flexWrap: 'wrap',
    justifyContent: 'flex-end',
    paddingBlock: themeSpace[1],
    paddingInline: themeSpace[2],
    columnGap: themeSpace[2],
  },
});

/** Healthy history (idle/ready, current version) has nothing to report. */
export function hasRoostHistorySyncNotice(state: RoostHistorySyncState | undefined) {
  if (!state) return false;
  return (
    (state.phase !== 'idle' && state.phase !== 'ready') ||
    (state.source === 'streams' && !!state.newerVersionPending)
  );
}

export function RoostHistorySyncIndicator({ state }: { state: RoostHistorySyncState }) {
  const { t } = useTranslation();
  let detail;
  switch (state.phase) {
    case 'checking':
      detail = t('sessions.historySync.checking', 'Checking cloud history');
      break;
    case 'pending':
      detail = t('sessions.historySync.pending', 'Waiting for cloud publication');
      break;
    case 'owner-required':
      detail = t(
        'sessions.historySync.ownerRequired',
        'The target machine must confirm access to this history'
      );
      break;
    case 'syncing':
      detail = t('sessions.historySync.syncing', 'Syncing cloud history');
      break;
    case 'retrying':
      detail =
        state.httpStatus === 403
          ? t('sessions.historySync.unconfirmed', 'Cloud history unconfirmed, retrying')
          : state.httpStatus
            ? t('sessions.historySync.retryingHttp', 'Retrying history read (HTTP {{status}})', {
                status: state.httpStatus,
              })
            : t('sessions.historySync.retrying', 'History read failed, retrying');
      break;
    case 'refused':
      detail =
        state.httpStatus === 401 || state.httpStatus === 403
          ? t('sessions.historySync.denied', 'Cloud history access denied')
          : t('sessions.historySync.refused', 'Cloud history unavailable (HTTP {{status}})', {
              status: state.httpStatus,
            });
      break;
  }
  if (!hasRoostHistorySyncNotice(state)) return null;
  const showingPrevious = state.source === 'streams' && state.newerVersionPending;
  return (
    <div {...stylex.props(styles.root, styles.history)} role="status">
      {detail && <span>{detail}</span>}
      {showingPrevious && (
        <span>
          {t(
            'sessions.historySync.previous',
            'Showing the previous version while the new one publishes'
          )}
        </span>
      )}
    </div>
  );
}

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
          ? t('sessions.contentSync.updating', 'Syncing')
          : t('common.syncing', 'Syncing')}
      </span>
    </span>
  );
}
