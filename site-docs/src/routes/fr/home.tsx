import { LandingRoutePage, landingHead } from '@site/src/site-pages/landing';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/fr/home')({
  head: () => landingHead('fr', { noindex: true }),
  component: () => <LandingRoutePage locale="fr" />,
});
