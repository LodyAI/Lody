import { Spinner } from '@lody/ui/spinner';
import { useTranslation } from 'react-i18next';

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
    <span
      className="inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground"
      role="status"
      data-sync-indicator={variant}
    >
      <Spinner className="h-3 w-3" aria-hidden="true" />
      <span className={labelClassName}>
        {variant === 'updating'
          ? t('sessions.contentSync.updating', 'Updating')
          : t('common.syncing', 'Syncing')}
      </span>
    </span>
  );
}
