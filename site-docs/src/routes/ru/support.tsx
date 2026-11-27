import { preloadLegalPageContent } from '@site/components/legal-page';
import { loadLegalPageRoute } from '@site/src/pages-loader';
import { LegalRoutePage, legalPageHead } from '@site/src/site-pages/legal';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/ru/support')({
  loader: async () => {
    const data = await loadLegalPageRoute({ data: { locale: 'ru', slug: 'support' } });
    await preloadLegalPageContent('ru', data.docPath);
    return data;
  },
  head: ({ loaderData }) =>
    loaderData ? legalPageHead('ru', loaderData) : { meta: [{ title: 'Поддержка' }] },
  component: SupportPage,
});

function SupportPage() {
  const data = Route.useLoaderData();
  return <LegalRoutePage entry={data} locale="ru" />;
}
