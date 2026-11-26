import { preloadLegalPageContent } from '@site/components/legal-page';
import { loadLegalPageRoute } from '@site/src/pages-loader';
import { LegalRoutePage, legalPageHead } from '@site/src/site-pages/legal';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/ko/privacy')({
  loader: async () => {
    const data = await loadLegalPageRoute({ data: { locale: 'ko', slug: 'privacy' } });
    await preloadLegalPageContent('ko', data.docPath);
    return data;
  },
  head: ({ loaderData }) =>
    loaderData ? legalPageHead('ko', loaderData) : { meta: [{ title: '개인정보처리방침' }] },
  component: PrivacyPage,
});

function PrivacyPage() {
  const data = Route.useLoaderData();
  return <LegalRoutePage entry={data} locale="ko" />;
}
