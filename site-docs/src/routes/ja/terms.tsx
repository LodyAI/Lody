import { preloadLegalPageContent } from '@site/components/legal-page';
import { loadLegalPageRoute } from '@site/src/pages-loader';
import { LegalRoutePage, legalPageHead } from '@site/src/site-pages/legal';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/ja/terms')({
  loader: async () => {
    const data = await loadLegalPageRoute({ data: { locale: 'ja', slug: 'terms' } });
    await preloadLegalPageContent('ja', data.docPath);
    return data;
  },
  head: ({ loaderData }) =>
    loaderData ? legalPageHead('ja', loaderData) : { meta: [{ title: '利用規約' }] },
  component: TermsPage,
});

function TermsPage() {
  const data = Route.useLoaderData();
  return <LegalRoutePage entry={data} locale="ja" />;
}
