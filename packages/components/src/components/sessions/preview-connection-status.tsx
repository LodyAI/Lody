import type { PreviewConnection } from '@lody/shared';
import { useTranslation } from 'react-i18next';
import { Button } from '@/ui/button';
import { cn } from '@/lib/utils';

export type PreviewConnectionStatusProps = {
  local: boolean;
  connection?: PreviewConnection;
  checking?: boolean;
  busy?: boolean;
  unavailableReason?: string;
  error?: string | null;
  placeholder?: boolean;
  onRestore?: () => void;
};

/** The same textual state/action is used by the toolbar, placeholder and stories. */
export function PreviewConnectionStatus({
  local,
  connection,
  checking,
  busy,
  unavailableReason,
  error,
  placeholder,
  onRestore,
}: PreviewConnectionStatusProps) {
  const { t } = useTranslation();
  const expired = connection?.status === 'closed' && connection.closedReason === 'idle_timeout';
  const failed = connection?.status === 'failed' || Boolean(error);
  const closed = connection?.status === 'closed';
  const label =
    busy || connection?.status === 'creating'
      ? t('sessions.browser.connection.connecting', 'Connecting remote preview…')
      : checking
        ? t('sessions.browser.connection.checking', 'Checking preview connection…')
        : unavailableReason
          ? unavailableReason
          : expired
            ? t('sessions.browser.connection.expired', 'Preview expired: idle for 1 hour')
            : failed
              ? t('sessions.browser.connection.failed', 'Preview connection failed')
              : closed
                ? t('sessions.browser.connection.closed', 'Remote preview is closed')
                : connection?.status === 'active'
                  ? t('sessions.browser.connection.active', 'Remote preview · Connected')
                  : t('sessions.browser.connection.inactive', 'Remote preview is not open');
  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        'text-xs text-muted-foreground',
        placeholder
          ? 'flex min-h-40 flex-1 flex-col items-center justify-center gap-3 px-6 text-center'
          : 'flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-3 py-2'
      )}
    >
      {local && (
        <span className="text-foreground">
          {t('sessions.browser.connection.local', 'Local direct preview')}
        </span>
      )}
      <span>
        {local
          ? t('sessions.browser.connection.shareStatus', 'Remote sharing: {{status}}', {
              status: label,
            })
          : label}
      </span>
      {connection?.status === 'active' && !checking && !busy && !failed && (
        <span>
          {t('sessions.browser.connection.idlePolicy', 'Closes after 1 hour of inactivity')}
        </span>
      )}
      {placeholder && (error || connection?.error?.message) && (
        <p className="max-w-lg break-words">{error || connection?.error?.message}</p>
      )}
      {onRestore && (closed || failed || placeholder) && (
        <Button
          size="sm"
          variant="outline"
          disabled={Boolean(busy || checking || unavailableReason)}
          onClick={onRestore}
        >
          {connection?.closedReason === 'revoked'
            ? t('sessions.browser.connection.reopen', 'Reopen preview')
            : t('sessions.browser.connection.restore', 'Restore preview')}
        </Button>
      )}
    </div>
  );
}
