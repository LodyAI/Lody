import { useTranslation } from 'react-i18next';
import { Button } from '@lody/ui/button';

export function RouteMessage({
  title,
  description = '',
  onRetry,
}: {
  title: string;
  description?: string;
  onRetry?: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex min-h-[100dvh] w-full items-center justify-center bg-background p-6 text-center">
      <div className="max-w-sm space-y-1">
        <div className="text-sm font-medium text-foreground">{title}</div>
        {description ? (
          <div className="text-xs leading-5 text-muted-foreground">{description}</div>
        ) : null}
        {onRetry ? (
          <Button variant="secondary" onClick={onRetry}>
            {t('common.retry')}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
