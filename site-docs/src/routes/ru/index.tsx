import { LandingRoutePage, landingHead } from '@site/src/site-pages/landing';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/ru/')({
  head: () => landingHead('ru'),
  component: () => <LandingRoutePage locale="ru" />,
});
