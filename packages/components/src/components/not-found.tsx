import { useLocation, useNavigate } from '@tanstack/react-router';
import { Button } from '@lody/ui/button';
import { useTranslation } from 'react-i18next';
import { StatusPage, StatusPageActions, StatusPageCode } from '@/components/status-page';

/**
 * The route nothing matched. It names the address it was asked for, because
 * that is the one thing a person can check — a typo, a stale link — and the
 * one thing a bare "404" does not tell them.
 */
export function NotFound() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const href = useLocation({ select: (location) => location.href });

  const handleGoBack = () => {
    if (window.history.length > 1) {
      window.history.back();
    } else {
      void navigate({ to: '/' });
    }
  };

  return (
    <StatusPage
      layout="window"
      illustration="missing"
      title={t('notFound.title', 'This page wandered off')}
      description={t(
        'notFound.description',
        'Nothing in Lody lives at this address. It may have moved, or the link is out of date.'
      )}
    >
      <StatusPageCode size="fit">{href}</StatusPageCode>
      <StatusPageActions>
        <Button size="small" onClick={() => void navigate({ to: '/' })}>
          {t('notFound.goHome', 'Go home')}
        </Button>
        <Button variant="secondary" size="small" onClick={handleGoBack}>
          {t('notFound.goBack', 'Go back')}
        </Button>
      </StatusPageActions>
    </StatusPage>
  );
}
