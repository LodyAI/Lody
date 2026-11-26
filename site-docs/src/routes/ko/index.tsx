import { LandingRoutePage, landingHead } from '@site/src/site-pages/landing';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/ko/')({
  head: () => landingHead('ko'),
  component: () => <LandingRoutePage locale="ko" />,
});
