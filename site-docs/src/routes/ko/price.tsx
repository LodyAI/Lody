import { createFileRoute } from '@tanstack/react-router';
import { PricingRoutePage, pricingHead } from '@site/src/site-pages/pricing';

export const Route = createFileRoute('/ko/price')({
  head: () => pricingHead('ko'),
  component: () => <PricingRoutePage locale="ko" />,
});
