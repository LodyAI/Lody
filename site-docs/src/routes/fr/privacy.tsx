import { preloadLegalPageContent } from '@site/components/legal-page';
import { loadLegalPageRoute } from '@site/src/pages-loader';
import { LegalRoutePage, legalPageHead } from '@site/src/site-pages/legal';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/fr/privacy')({
  loader: async () => {
    const data = await loadLegalPageRoute({ data: { locale: 'fr', slug: 'privacy' } });
    await preloadLegalPageContent('fr', data.docPath);
    return data;
  },
  head: ({ loaderData }) =>
    loaderData
      ? legalPageHead('fr', loaderData)
      : { meta: [{ title: 'Politique de confidentialité' }] },
  component: PrivacyPage,
});

function PrivacyPage() {
  const data = Route.useLoaderData();
  return <LegalRoutePage entry={data} locale="fr" />;
}
