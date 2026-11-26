import { createFileRoute } from '@tanstack/react-router';
import { PricingRoutePage, pricingHead } from '@site/src/site-pages/pricing';

export const Route = createFileRoute('/zh-hant/price')({
  head: () => pricingHead('zh-hant'),
  component: () => <PricingRoutePage locale="zh-hant" />,
});
