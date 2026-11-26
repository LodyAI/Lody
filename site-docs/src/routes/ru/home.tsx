import { LandingRoutePage, landingHead } from '@site/src/site-pages/landing';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/ru/home')({
  head: () => landingHead('ru', { noindex: true }),
  component: () => <LandingRoutePage locale="ru" />,
});
