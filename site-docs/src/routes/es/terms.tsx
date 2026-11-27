import { preloadLegalPageContent } from '@site/components/legal-page';
import { loadLegalPageRoute } from '@site/src/pages-loader';
import { LegalRoutePage, legalPageHead } from '@site/src/site-pages/legal';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/es/terms')({
  loader: async () => {
    const data = await loadLegalPageRoute({ data: { locale: 'es', slug: 'terms' } });
    await preloadLegalPageContent('es', data.docPath);
    return data;
  },
  head: ({ loaderData }) =>
    loaderData ? legalPageHead('es', loaderData) : { meta: [{ title: 'Términos del servicio' }] },
  component: TermsPage,
});

function TermsPage() {
  const data = Route.useLoaderData();
  return <LegalRoutePage entry={data} locale="es" />;
}
