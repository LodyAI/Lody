import { LandingRoutePage, landingHead } from '@site/src/site-pages/landing';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/es/home')({
  head: () => landingHead('es', { noindex: true }),
  component: () => <LandingRoutePage locale="es" />,
});
