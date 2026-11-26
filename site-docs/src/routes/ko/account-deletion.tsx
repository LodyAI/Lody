import { preloadLegalPageContent } from '@site/components/legal-page';
import { loadLegalPageRoute } from '@site/src/pages-loader';
import { LegalRoutePage, legalPageHead } from '@site/src/site-pages/legal';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/ko/account-deletion')({
  loader: async () => {
    const data = await loadLegalPageRoute({ data: { locale: 'ko', slug: 'account-deletion' } });
    await preloadLegalPageContent('ko', data.docPath);
    return data;
  },
  head: ({ loaderData }) =>
    loaderData ? legalPageHead('ko', loaderData) : { meta: [{ title: '계정 및 데이터 삭제' }] },
  component: AccountDeletionPage,
});

function AccountDeletionPage() {
  const data = Route.useLoaderData();
  return <LegalRoutePage entry={data} locale="ko" />;
}
