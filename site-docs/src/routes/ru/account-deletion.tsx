import { preloadLegalPageContent } from '@site/components/legal-page';
import { loadLegalPageRoute } from '@site/src/pages-loader';
import { LegalRoutePage, legalPageHead } from '@site/src/site-pages/legal';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/ru/account-deletion')({
  loader: async () => {
    const data = await loadLegalPageRoute({ data: { locale: 'ru', slug: 'account-deletion' } });
    await preloadLegalPageContent('ru', data.docPath);
    return data;
  },
  head: ({ loaderData }) =>
    loaderData
      ? legalPageHead('ru', loaderData)
      : { meta: [{ title: 'Удаление аккаунта и данных' }] },
  component: AccountDeletionPage,
});

function AccountDeletionPage() {
  const data = Route.useLoaderData();
  return <LegalRoutePage entry={data} locale="ru" />;
}
