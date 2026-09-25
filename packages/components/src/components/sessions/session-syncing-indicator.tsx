import { Spinner } from '@lody/ui/spinner';
import { useTranslation } from 'react-i18next';

export function SessionSyncingIndicator({ labelClassName }: { labelClassName?: string }) {
  const { t } = useTranslation();

  return (
    <span className="inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
      <Spinner className="h-3 w-3" aria-hidden="true" />
      <span className={labelClassName}>{t('common.syncing', 'Syncing')}</span>
    </span>
  );
}
