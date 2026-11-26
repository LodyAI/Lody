import { notFoundHead } from '@site/lib/not-found-seo';
import { loadDocsRoute } from '@site/src/docs-loader';
import { DocsRoutePage, docsHead, preloadDocsContent } from '@site/src/site-pages/docs';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/ru/docs/$')({
  loader: async ({ params }) => {
    const data = await loadDocsRoute({ data: { locale: 'ru', splat: params._splat } });
    await preloadDocsContent('ru', data.docPath);

    return data;
  },
  head: ({ loaderData }) => (loaderData ? docsHead('ru', loaderData) : notFoundHead('ru')),
  component: Docs,
});

function Docs() {
  const data = Route.useLoaderData();

  return <DocsRoutePage locale="ru" data={data} />;
}
