import { LandingRoutePage, landingHead } from '@site/src/site-pages/landing';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/es/')({
  head: () => landingHead('es'),
  component: () => <LandingRoutePage locale="es" />,
});
