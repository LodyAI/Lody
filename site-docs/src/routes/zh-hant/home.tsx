import { LandingRoutePage, landingHead } from '@site/src/site-pages/landing';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/zh-hant/home')({
  head: () => landingHead('zh-hant', { noindex: true }),
  component: () => <LandingRoutePage locale="zh-hant" />,
});
