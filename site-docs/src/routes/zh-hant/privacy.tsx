import { preloadLegalPageContent } from '@site/components/legal-page';
import { loadLegalPageRoute } from '@site/src/pages-loader';
import { LegalRoutePage, legalPageHead } from '@site/src/site-pages/legal';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/zh-hant/privacy')({
  loader: async () => {
    const data = await loadLegalPageRoute({ data: { locale: 'zh-hant', slug: 'privacy' } });
    await preloadLegalPageContent('zh-hant', data.docPath);
    return data;
  },
  head: ({ loaderData }) =>
    loaderData ? legalPageHead('zh-hant', loaderData) : { meta: [{ title: '隱私權政策' }] },
  component: PrivacyPage,
});

function PrivacyPage() {
  const data = Route.useLoaderData();
  return <LegalRoutePage entry={data} locale="zh-hant" />;
}
