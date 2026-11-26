import { createFileRoute } from '@tanstack/react-router';
import { PricingRoutePage, pricingHead } from '@site/src/site-pages/pricing';

export const Route = createFileRoute('/fr/price')({
  head: () => pricingHead('fr'),
  component: () => <PricingRoutePage locale="fr" />,
});
