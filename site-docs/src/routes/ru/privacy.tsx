import { preloadLegalPageContent } from '@site/components/legal-page';
import { loadLegalPageRoute } from '@site/src/pages-loader';
import { LegalRoutePage, legalPageHead } from '@site/src/site-pages/legal';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/ru/privacy')({
  loader: async () => {
    const data = await loadLegalPageRoute({ data: { locale: 'ru', slug: 'privacy' } });
    await preloadLegalPageContent('ru', data.docPath);
    return data;
  },
  head: ({ loaderData }) =>
    loaderData
      ? legalPageHead('ru', loaderData)
      : { meta: [{ title: 'Политика конфиденциальности' }] },
  component: PrivacyPage,
});

function PrivacyPage() {
  const data = Route.useLoaderData();
  return <LegalRoutePage entry={data} locale="ru" />;
}
