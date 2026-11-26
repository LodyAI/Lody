import { LandingRoutePage, landingHead } from '@site/src/site-pages/landing';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/zh-hant/')({
  head: () => landingHead('zh-hant'),
  component: () => <LandingRoutePage locale="zh-hant" />,
});
