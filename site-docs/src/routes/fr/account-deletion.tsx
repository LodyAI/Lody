import { preloadLegalPageContent } from '@site/components/legal-page';
import { loadLegalPageRoute } from '@site/src/pages-loader';
import { LegalRoutePage, legalPageHead } from '@site/src/site-pages/legal';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/fr/account-deletion')({
  loader: async () => {
    const data = await loadLegalPageRoute({ data: { locale: 'fr', slug: 'account-deletion' } });
    await preloadLegalPageContent('fr', data.docPath);
    return data;
  },
  head: ({ loaderData }) =>
    loaderData
      ? legalPageHead('fr', loaderData)
      : { meta: [{ title: 'Suppression de compte et de données' }] },
  component: AccountDeletionPage,
});

function AccountDeletionPage() {
  const data = Route.useLoaderData();
  return <LegalRoutePage entry={data} locale="fr" />;
}
