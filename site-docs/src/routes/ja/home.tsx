import { LandingRoutePage, landingHead } from '@site/src/site-pages/landing';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/ja/home')({
  head: () => landingHead('ja', { noindex: true }),
  component: () => <LandingRoutePage locale="ja" />,
});
