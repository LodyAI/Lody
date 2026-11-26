import { createFileRoute } from '@tanstack/react-router';
import { PricingRoutePage, pricingHead } from '@site/src/site-pages/pricing';

export const Route = createFileRoute('/es/price')({
  head: () => pricingHead('es'),
  component: () => <PricingRoutePage locale="es" />,
});
