import { useTranslation } from 'react-i18next';
import { Button } from '@lody/ui/button';
import { LoadingPlaceholder } from '@/components/loading-placeholder';
import { StatusPage, StatusPageActions } from '@/components/status-page';

/** The session pane while its access is being decided. */
export function SessionAccessWait() {
  const { t } = useTranslation();
  return <LoadingPlaceholder variant="content" startsNow title={t('sessions.access.opening')} />;
}

/** The session pane for a conversation nobody shared with this account. */
export function SessionAccessUnavailable() {
  const { t } = useTranslation();
  return (
    <StatusPage
      layout="pane"
      role="status"
      illustration="missing"
      title={t('sessions.access.unavailable')}
      description={t('sessions.access.unavailableDescription')}
    />
  );
}

/** The session pane when the sharing check itself failed; "not shared" would be a guess. */
export function SessionAccessReadFailed({ onRetry }: { onRetry: () => void }) {
  const { t } = useTranslation();
  return (
    <StatusPage
      layout="pane"
      role="alert"
      illustration="broken"
      title={t('sessions.access.readFailedTitle')}
      description={t('sessions.access.readFailed')}
    >
      <StatusPageActions>
        <Button size="small" variant="secondary" onClick={onRetry}>
          {t('common.retry')}
        </Button>
      </StatusPageActions>
    </StatusPage>
  );
}
