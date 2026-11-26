import { useTranslation } from 'react-i18next';
import { createFileRoute, useNavigate, useRouter } from '@tanstack/react-router';
import { RouteMessage } from '@/components/route-message';

export const Route = createFileRoute('/recovery')({ component: Recovery });

function Recovery() {
  const { t } = useTranslation();
  const router = useRouter();
  const navigate = useNavigate();
  const Page = Route.useRouteContext().recoveryPage;
  if (Page) return <Page />;
  const back = () => {
    if (router.history.canGoBack()) router.history.back();
    else void navigate({ to: '/' });
  };
  return (
    <RouteMessage
      gate={null}
      title={t('e2ee.recovery.manage')}
      description={t('e2ee.recovery.unavailable')}
      actionLabel={t('common.back')}
      onRetry={back}
    />
  );
}
