import { LandingRoutePage, landingHead } from '@site/src/site-pages/landing';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/ja/')({
  head: () => landingHead('ja'),
  component: () => <LandingRoutePage locale="ja" />,
});
