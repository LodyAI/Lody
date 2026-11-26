import { createFileRoute } from '@tanstack/react-router';
import { PricingRoutePage, pricingHead } from '@site/src/site-pages/pricing';

export const Route = createFileRoute('/ru/price')({
  head: () => pricingHead('ru'),
  component: () => <PricingRoutePage locale="ru" />,
});
