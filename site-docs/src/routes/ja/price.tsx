import { createFileRoute } from '@tanstack/react-router';
import { PricingRoutePage, pricingHead } from '@site/src/site-pages/pricing';

export const Route = createFileRoute('/ja/price')({
  head: () => pricingHead('ja'),
  component: () => <PricingRoutePage locale="ja" />,
});
