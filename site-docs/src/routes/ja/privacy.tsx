import { preloadLegalPageContent } from '@site/components/legal-page';
import { loadLegalPageRoute } from '@site/src/pages-loader';
import { LegalRoutePage, legalPageHead } from '@site/src/site-pages/legal';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/ja/privacy')({
  loader: async () => {
    const data = await loadLegalPageRoute({ data: { locale: 'ja', slug: 'privacy' } });
    await preloadLegalPageContent('ja', data.docPath);
    return data;
  },
  head: ({ loaderData }) =>
    loaderData ? legalPageHead('ja', loaderData) : { meta: [{ title: 'プライバシーポリシー' }] },
  component: PrivacyPage,
});

function PrivacyPage() {
  const data = Route.useLoaderData();
  return <LegalRoutePage entry={data} locale="ja" />;
}
