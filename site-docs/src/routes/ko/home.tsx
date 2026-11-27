import { LandingRoutePage, landingHead } from '@site/src/site-pages/landing';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/ko/home')({
  head: () => landingHead('ko', { noindex: true }),
  component: () => <LandingRoutePage locale="ko" />,
});
