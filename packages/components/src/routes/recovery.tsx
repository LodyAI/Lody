import { useTranslation } from 'react-i18next';
import { createFileRoute } from '@tanstack/react-router';
export const Route = createFileRoute('/recovery')({ component: Recovery });
function Recovery() {
  const { t } = useTranslation();
  const Page = Route.useRouteContext().recoveryPage;
  return Page ? <Page /> : <p>{t('e2ee.recovery.unavailable')}</p>;
}
