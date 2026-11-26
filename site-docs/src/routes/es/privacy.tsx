import { preloadLegalPageContent } from '@site/components/legal-page';
import { loadLegalPageRoute } from '@site/src/pages-loader';
import { LegalRoutePage, legalPageHead } from '@site/src/site-pages/legal';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/es/privacy')({
  loader: async () => {
    const data = await loadLegalPageRoute({ data: { locale: 'es', slug: 'privacy' } });
    await preloadLegalPageContent('es', data.docPath);
    return data;
  },
  head: ({ loaderData }) =>
    loaderData ? legalPageHead('es', loaderData) : { meta: [{ title: 'Política de privacidad' }] },
  component: PrivacyPage,
});

function PrivacyPage() {
  const data = Route.useLoaderData();
  return <LegalRoutePage entry={data} locale="es" />;
}
